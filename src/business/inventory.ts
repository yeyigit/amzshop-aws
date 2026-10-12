import type { AppConfig, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { flushNotification, prepareNotification } from "../notifications.js";
import { addDaysYmd, feishuFieldText, ymdInZone, zonedMidnight } from "../util.js";

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
const text = (value: unknown): string => String(value ?? "").trim();
const number = (value: unknown): number => { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; };

interface Stock { sku: string; asin: string; name: string; fulfillable: number; working: number; shipped: number; receiving: number; reserved: number; unfulfillable: number; researching: number; awdAvailable: number; awdInbound: number; awdReplenishment: number; fullChain: number }
interface Parameters { enabled: boolean; domestic: number; international: number; receiving: number; safety: number; target: number; carton: number; moq: number }

function blankStock(sku: string): Stock {
  return { sku, asin: "", name: "", fulfillable: 0, working: 0, shipped: 0, receiving: 0, reserved: 0, unfulfillable: 0, researching: 0, awdAvailable: 0, awdInbound: 0, awdReplenishment: 0, fullChain: 0 };
}

function aggregate(fba: Row[], awd: Row[]): Map<string, Stock> {
  const result = new Map<string, Stock>();
  for (const source of fba) {
    const sku = text(source.sellerSku);
    if (!sku) continue;
    const target = result.get(sku) ?? blankStock(sku);
    const detail = (source.inventoryDetails ?? {}) as Row;
    target.asin ||= text(source.asin);
    target.name ||= text(source.productName);
    target.fulfillable += Math.max(0, number(detail.fulfillableQuantity));
    target.working += Math.max(0, number(detail.inboundWorkingQuantity));
    target.shipped += Math.max(0, number(detail.inboundShippedQuantity));
    target.receiving += Math.max(0, number(detail.inboundReceivingQuantity));
    target.reserved += Math.max(0, number((detail.reservedQuantity as Row | undefined)?.totalReservedQuantity ?? detail.reservedQuantity));
    target.unfulfillable += Math.max(0, number((detail.unfulfillableQuantity as Row | undefined)?.totalUnfulfillableQuantity ?? detail.unfulfillableQuantity));
    target.researching += Math.max(0, number((detail.researchingQuantity as Row | undefined)?.totalResearchingQuantity ?? detail.researchingQuantity));
    result.set(sku, target);
  }
  for (const source of awd) {
    const sku = text(source.sku);
    if (!sku) continue;
    const target = result.get(sku) ?? blankStock(sku);
    const detail = (source.inventoryDetails ?? {}) as Row;
    target.awdAvailable += Math.max(0, number(detail.availableDistributableQuantity));
    target.awdInbound += Math.max(0, number(source.totalInboundQuantity));
    target.awdReplenishment += Math.max(0, number(detail.replenishmentQuantity));
    result.set(sku, target);
  }
  for (const stock of result.values()) stock.fullChain = stock.fulfillable + stock.working + stock.shipped + stock.receiving + stock.awdAvailable + stock.awdInbound;
  return result;
}

async function fetchFba(amazon: AmazonClient): Promise<Row[]> {
  const output: Row[] = [];
  let nextToken = "";
  const seen = new Set<string>();
  do {
    const response = await amazon.sp<JsonObject>("/fba/inventory/v1/summaries", { query: { granularityType: "Marketplace", granularityId: "ATVPDKIKX0DER", marketplaceIds: "ATVPDKIKX0DER", details: true, ...(nextToken ? { nextToken } : {}) } });
    const payload = (response.payload ?? {}) as JsonObject;
    if (!Array.isArray(payload.inventorySummaries)) throw new Error("FBA Inventory 响应缺少 inventorySummaries。 ");
    output.push(...rows(payload.inventorySummaries));
    // 官方 GetInventorySummariesResponse 的 pagination 在响应顶层（与 payload 并列），GAS 版即按此翻页。
    nextToken = text((response.pagination as JsonObject | undefined)?.nextToken ?? (payload.pagination as JsonObject | undefined)?.nextToken ?? payload.nextToken);
    if (nextToken && seen.has(nextToken)) throw new Error("FBA Inventory nextToken 重复。 ");
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return output;
}

async function fetchAwd(amazon: AmazonClient): Promise<Row[]> {
  const output: Row[] = [];
  let nextToken = "";
  const seen = new Set<string>();
  do {
    // details 缺省为 HIDE，只回汇总；SHOW 才带 inventoryDetails（AWD 可用、补货中）。
    const response = await amazon.sp<JsonObject>("/awd/2024-05-09/inventory", { query: { details: "SHOW", marketplaceId: "ATVPDKIKX0DER", maxResults: 100, ...(nextToken ? { nextToken } : {}) } });
    if (!Array.isArray(response.inventory)) throw new Error("AWD Inventory 响应缺少 inventory。 ");
    output.push(...rows(response.inventory));
    nextToken = text(response.nextToken);
    if (nextToken && seen.has(nextToken)) throw new Error("AWD Inventory nextToken 重复。 ");
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return output;
}

async function salesDaily(amazon: AmazonClient, sku: string, start: string, end: string): Promise<Map<string, number>> {
  // FBA 补货只看 Amazon 履约销量（GAS 口径）；官方缺省 fulfillmentNetwork 时返回全部履约网络。
  const response = await amazon.sp<JsonObject>("/sales/v1/orderMetrics", { query: { marketplaceIds: "ATVPDKIKX0DER", interval: `${zonedMidnight(start, "America/Los_Angeles")}--${zonedMidnight(addDaysYmd(end, 1), "America/Los_Angeles")}`, granularity: "Day", granularityTimeZone: "America/Los_Angeles", fulfillmentNetwork: "AFN", sku } });
  const metrics = rows(response.payload);
  const result = new Map<string, number>();
  for (const metric of metrics) {
    const day = text(metric.interval).slice(0, 10);
    if (day) result.set(day, number(metric.unitCount));
  }
  return result;
}

// 预测日均＝30/60/90 日日均按 0.5/0.3/0.2 加权（不做季节调整）。
function salesSummary(daily: Map<string, number>, end: string): { sales30: number; sales60: number; sales90: number; baseDaily: number } {
  const sums = new Map<number, number>();
  for (const days of [30, 60, 90]) {
    let sum = 0;
    for (let offset = 0; offset < days; offset += 1) sum += daily.get(addDaysYmd(end, -offset)) ?? 0;
    sums.set(days, sum);
  }
  const sales30 = sums.get(30) ?? 0, sales60 = sums.get(60) ?? 0, sales90 = sums.get(90) ?? 0;
  return { sales30, sales60, sales90, baseDaily: (sales30 / 30) * 0.5 + (sales60 / 60) * 0.3 + (sales90 / 90) * 0.2 };
}

function parameter(fields: Record<string, unknown>): Parameters {
  const value = (name: string, fallback: number): number => { const raw = feishuFieldText(fields[name]); const candidate = raw ? Number(raw) : NaN; return Number.isFinite(candidate) && candidate >= 0 ? candidate : fallback; };
  const enabled = feishuFieldText(fields["启用"]).toLowerCase();
  return {
    enabled: !["0", "false", "否", "未启用"].includes(enabled),
    domestic: value("国内备货天数", 15),
    international: value("国际运输天数", 35),
    receiving: value("入仓天数", 10),
    safety: value("安全天数", 14),
    target: value("目标覆盖天数", 90),
    carton: value("装箱数", 0),
    moq: value("MOQ", 0),
  };
}

function roundQuantity(value: number, carton: number, moq: number): number {
  if (value <= 0) return 0;
  let result = Math.max(Math.ceil(value), Math.ceil(moq));
  if (carton > 0) result = Math.ceil(result / Math.ceil(carton)) * Math.ceil(carton);
  return result;
}

function risk(stock: Stock, baseDaily: number, params: Parameters): { level: string; reason: string; fbaDays: number | null; chainDays: number | null; quantity: number; orderDate: string } {
  if (!params.enabled) return { level: "已停用", reason: "库存参数已停用", fbaDays: null, chainDays: null, quantity: 0, orderDate: "" };
  if (baseDaily <= 0) return { level: "正常", reason: "近90日销量为0", fbaDays: null, chainDays: null, quantity: 0, orderDate: "" };
  const fbaDays = stock.fulfillable / baseDaily;
  const chainDays = stock.fullChain / baseDaily;
  const lead = params.domestic + params.international + params.receiving;
  const quantity = roundQuantity(baseDaily * (lead + params.target) - stock.fullChain, params.carton, params.moq);
  const daysUntilOrder = Math.floor(chainDays - lead - params.safety);
  const today = ymdInZone(new Date(), "America/Los_Angeles");
  const orderDate = addDaysYmd(today, daysUntilOrder);
  if (stock.fulfillable <= 0 || fbaDays <= lead + params.safety) return { level: "FBA断货风险", reason: stock.fulfillable <= 0 ? "FBA当前无可售库存" : `FBA可售仅覆盖 ${fbaDays.toFixed(1)} 天`, fbaDays, chainDays, quantity, orderDate };
  if (quantity && daysUntilOrder <= 0) return { level: "紧急补货", reason: daysUntilOrder < 0 ? `建议下单日已逾期 ${Math.abs(daysUntilOrder)} 天` : "建议今天下单", fbaDays, chainDays, quantity, orderDate };
  if (quantity && daysUntilOrder <= 7) return { level: "即将补货", reason: `距建议下单日 ${daysUntilOrder} 天`, fbaDays, chainDays, quantity, orderDate };
  return { level: "正常", reason: quantity ? `距建议下单日 ${daysUntilOrder} 天` : "当前无需补货", fbaDays, chainDays, quantity, orderDate };
}

function rank(level: string): number { return ({ 正常: 0, 已停用: 0, 即将补货: 1, 紧急补货: 2, FBA断货风险: 3 } as Record<string, number>)[level] ?? 0; }

export async function runInventory(_event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient): Promise<JsonObject> {
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const parametersTable = config.get("FEISHU_BITABLE_TABLE_ID_INVENTORY_PARAMETERS");
  const alertsTable = config.get("FEISHU_BITABLE_TABLE_ID_INVENTORY_ALERTS");
  const mappings = config.asins();
  const existingAlerts = await feishu.listRecords(app, alertsTable);
  const existingBySku = new Map<string, (typeof existingAlerts)[number]>();
  for (const record of existingAlerts) {
    const sku = feishuFieldText(record.fields.SKU);
    if (!sku) continue;
    if (existingBySku.has(sku)) throw new Error(`库存预警存在重复 SKU: ${sku}`);
    existingBySku.set(sku, record);
  }
  // 复用已读取的预警行直接更新，缺失才创建。
  const writeAlert = (sku: string, fields: Record<string, unknown>): Promise<string> => {
    const previous = existingBySku.get(sku);
    return feishu.upsert(app, alertsTable, { SKU: sku }, fields, {}, { existing: previous ? [previous] : [] });
  };
  let fba: Row[];
  let awd: Row[];
  try { [fba, awd] = await Promise.all([fetchFba(amazon), fetchAwd(amazon)]); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const item of mappings) await writeAlert(item.sku, { SKU: item.sku, ASIN: item.asin, "数据状态": "数据已过期", "降级原因": reason.slice(0, 500), "同步时间": Date.now() });
    throw new Error(`库存源数据获取失败，已保留旧值并标记过期：${reason}`);
  }
  const stock = aggregate(fba, awd);
  const parameterRecords = await feishu.listRecords(app, parametersTable);
  const parameterGroups = new Map<string, Record<string, unknown>[]>();
  for (const record of parameterRecords) {
    const sku = feishuFieldText(record.fields.SKU);
    if (!sku) continue;
    const group = parameterGroups.get(sku) ?? [];
    group.push(record.fields);
    parameterGroups.set(sku, group);
  }
  const end = addDaysYmd(ymdInZone(new Date(), "America/Los_Angeles"), -1);
  const start = addDaysYmd(end, -89);
  const notificationKey = `inventory|${end}`;
  const notifications: string[] = [];
  const failures: string[] = [];
  const planned: Array<{ sku: string; fields: Record<string, unknown>; pending: boolean; counted: boolean }> = [];
  for (const item of mappings) {
    if ((parameterGroups.get(item.sku)?.length ?? 0) !== 1) {
      planned.push({ sku: item.sku, fields: { SKU: item.sku, ASIN: item.asin, "数据状态": "数据已过期", "降级原因": "库存参数缺失或 SKU 重复，保留上次业务结果", "同步时间": Date.now() }, pending: false, counted: false });
      continue;
    }
    try {
      const daily = await salesDaily(amazon, item.sku, start, end);
      const sales = salesSummary(daily, end);
      const currentStock = stock.get(item.sku) ?? blankStock(item.sku);
      const params = parameter(parameterGroups.get(item.sku)![0]!);
      const currentRisk = risk(currentStock, sales.baseDaily, params);
      const previous = existingBySku.get(item.sku);
      const previousLevel = feishuFieldText(previous?.fields["预警等级"]);
      const triggered = (!rank(previousLevel) && !!rank(currentRisk.level)) || rank(currentRisk.level) > rank(previousLevel) || (!!rank(previousLevel) && !rank(currentRisk.level));
      if (triggered) notifications.push(`${item.sku}：${previousLevel || "无"} → ${currentRisk.level}（${currentRisk.reason}）`);
      // 通知状态按本 SKU 是否触发；同日重试时沿用尚未送达的“待发送”（前一次已写入新等级，本次不会再触发）。
      const pending = triggered || (feishuFieldText(previous?.fields["通知状态"]) === "待发送" && feishuFieldText(previous?.fields["数据时间"]) === `Sales 截止 ${end}`);
      const lead = params.domestic + params.international + params.receiving;
      planned.push({ sku: item.sku, pending, counted: true, fields: {
        SKU: item.sku, ASIN: currentStock.asin || item.asin, "品名": currentStock.name,
        "FBA可售": currentStock.fulfillable, "FBA Working": currentStock.working, "FBA Shipped": currentStock.shipped,
        "FBA Receiving": currentStock.receiving, "FBA预留": currentStock.reserved, "FBA不可售": currentStock.unfulfillable,
        "FBA调查中": currentStock.researching, "AWD可用": currentStock.awdAvailable, "去AWD在途": currentStock.awdInbound,
        "AWD补货中（仅展示）": currentStock.awdReplenishment, "全链路库存": currentStock.fullChain,
        "30日销量": sales.sales30, "60日销量": sales.sales60, "90日销量": sales.sales90,
        "反季节化预测日均": sales.baseDaily,
        "FBA可售覆盖天数": currentRisk.fbaDays, "全链路覆盖天数": currentRisk.chainDays,
        "FBA可售断货日": currentRisk.fbaDays === null ? null : Date.parse(`${addDaysYmd(end, Math.floor(currentRisk.fbaDays))}T00:00:00Z`),
        "全链路断货日": currentRisk.chainDays === null ? null : Date.parse(`${addDaysYmd(end, Math.floor(currentRisk.chainDays))}T00:00:00Z`),
        "建议下单日": currentRisk.orderDate ? Date.parse(`${currentRisk.orderDate}T00:00:00Z`) : null,
        "建议到仓日": currentRisk.orderDate ? Date.parse(`${addDaysYmd(currentRisk.orderDate, lead)}T00:00:00Z`) : null,
        "建议数量": currentRisk.quantity, "预警等级": currentRisk.level, "预警原因": currentRisk.reason,
        "数据时间": `Sales 截止 ${end}`, "降级原因": "", "数据状态": "最新", "同步时间": Date.now(), "通知状态": pending ? "待发送" : "未触发",
      } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${item.sku}: ${reason}`);
      planned.push({ sku: item.sku, fields: { SKU: item.sku, ASIN: item.asin, "数据状态": "数据已过期", "降级原因": reason.slice(0, 500), "同步时间": Date.now() }, pending: false, counted: false });
    }
  }
  // 汇总通知意图先持久化，表记录写完再发送（避免收到通知后找不到对应数据）；发送成功后把待发送行批量改为“已发送”。
  const prepared = notifications.length ? await prepareNotification(config, state, notificationKey, ["📦 库存风险变化", ...notifications]) : undefined;
  let updated = 0;
  const pendingIds: string[] = [];
  for (const plan of planned) {
    const recordId = await writeAlert(plan.sku, plan.fields);
    if (plan.counted) updated += 1;
    if (plan.pending) pendingIds.push(recordId);
  }
  const outcome = pendingIds.length ? await flushNotification(state, feishu, notificationKey, prepared) : "none";
  if ((outcome === "sent" || outcome === "done") && pendingIds.length) await feishu.batchUpdate(app, alertsTable, pendingIds.map((recordId) => ({ recordId, fields: { "通知状态": "已发送" } })));
  if (failures.length) throw new Error(`库存同步有 ${failures.length} 个 SKU 失败，已保留旧值：${failures.join("；").slice(0, 900)}`);
  return { status: "done", updated, notifications: notifications.length, notification: outcome, salesEnd: end };
}
