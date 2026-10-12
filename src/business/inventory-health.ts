import type { AppConfig, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { flushNotification, prepareNotification, type PreparedNotification } from "../notifications.js";
import { ensureOneTimeSchedule } from "../scheduling.js";
import { log } from "../log.js";
import { addDaysYmd, sha256, ymdInZone } from "../util.js";
import { skuCosts, type SkuCost } from "../report/facts.js";
import { awaitReport, createReport, parseTsv } from "./reports.js";

// 库龄与仓储成本（docs/模块说明.md「店铺健康、库龄与 SQP」）：每天申请美国站库存健康报告，
// 提醒冗余（Excess）进出、单款超龄附加费、低库存费，每月预告 15 日的超龄附加费；给调广告的清库存口径。
// 对亚马逊只读，飞书只读毛利润预估与 SKU信息表；状态只写 INVENTORY_HEALTH/。
type Row = Record<string, unknown>;
const text = (value: unknown): string => String(value ?? "").trim();
const r2 = (value: number): number => Math.round(value * 100) / 100;
export const INVENTORY_HEALTH_PK = "INVENTORY_HEALTH";
export const PLANNING_REPORT_TYPE = "GET_FBA_INVENTORY_PLANNING_DATA";
const MARKETPLACE_US = "ATVPDKIKX0DER";
const CONTINUE_AFTER_MS = 5 * 60_000;
const DAY_TTL_DAYS = 400;
const AGE_COLUMNS = ["inv-age-0-to-90-days", "inv-age-91-to-180-days", "inv-age-181-to-270-days", "inv-age-271-to-365-days", "inv-age-366-to-455-days", "inv-age-456-plus-days"] as const;
const AIS_BUCKETS = ["181-210", "211-240", "241-270", "271-300", "301-330", "331-365", "366-455", "456-plus"] as const;
// 佣金率取 毛利润预估「预估佣金」÷「AMZ售价」；不在 5%–20% 之间（如售价改了而预估佣金没改）时按玩具类目 15%。
const COMMISSION_MIN = 0.05, COMMISSION_MAX = 0.2, COMMISSION_DEFAULT = 0.15;

export interface InventoryHealthSettings { aisMin: number; previewDay: number }

export function inventoryHealthSettings(config: AppConfig): InventoryHealthSettings {
  const read = (key: string, fallback: number, min: number, max: number): number => {
    const value = Number(text(config.optional(key, String(fallback))));
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min}–${max} 之间的数字。`);
    return value;
  };
  return { aisMin: read("INVENTORY_HEALTH_AIS_MIN", 10, 0, 100_000), previewDay: Math.round(read("INVENTORY_HEALTH_PREVIEW_DAY", 5, 1, 14)) };
}

export interface SkuInventoryHealth {
  sku: string; asin: string; status: string; action: string; available: number; inbound: number;
  ages: number[]; aged181: number; aged91to180: number; newAged90: number; willAge90: number;
  shipped30: number; shipped90: number; daysOfSupply: number | null; excess: number;
  storageNextMonth: number | null; aisNextMonth: number | null; aisUnits: number;
  holdingPerUnit: number | null; monthsToClear: number | null;
  price: number | null; commissionRate: number; fbaFee: number | null; cashPerUnit: number | null; cashAcos: number | null;
  lowInventoryFee: boolean; seasonal: string;
}

const count = (value: string | undefined): number => { const parsed = Number(value ?? ""); return Number.isFinite(parsed) && parsed > 0 ? parsed : 0; };
const money = (value: string | undefined): number | null => { const raw = text(value); if (!raw) return null; const parsed = Number(raw); return Number.isFinite(parsed) ? parsed : null; };

// 先进先出：近 90 天的发货量 S 先消化超 180 天的 A，剩下再消化 91–180 天的 B。
// 3 个月后仍在库且超 180 天 ≈ max(0, A − S) + max(0, B − max(0, S − A))；其中 willAge90 是 B 里会新进入超龄的部分。
export function agingForecast(aged181: number, aged91to180: number, shipped90: number): { newAged90: number; willAge90: number } {
  const remainingOld = Math.max(0, aged181 - shipped90);
  const willAge90 = Math.max(0, aged91to180 - Math.max(0, shipped90 - aged181));
  return { newAged90: remainingOld + willAge90, willAge90 };
}

export function cashBasis(price: number | null, cost: SkuCost | undefined): { commissionRate: number; fbaFee: number | null; cashPerUnit: number | null; cashAcos: number | null } {
  const rate = cost?.price && cost.commission !== null && cost.price > 0 ? cost.commission / cost.price : NaN;
  const commissionRate = Number.isFinite(rate) && rate >= COMMISSION_MIN && rate <= COMMISSION_MAX ? Math.round(rate * 10_000) / 10_000 : COMMISSION_DEFAULT;
  const fbaFee = cost?.fba ?? null;
  if (!price || price <= 0 || fbaFee === null) return { commissionRate, fbaFee, cashPerUnit: null, cashAcos: null };
  const cashPerUnit = r2(price * (1 - commissionRate) - fbaFee);
  return { commissionRate, fbaFee, cashPerUnit, cashAcos: Math.round((cashPerUnit / price) * 10_000) / 10_000 };
}

export function inventoryHealthRows(rows: Array<Record<string, string>>, costs: Map<string, SkuCost>): SkuInventoryHealth[] {
  const output: SkuInventoryHealth[] = [];
  for (const row of rows) {
    const sku = text(row.sku);
    const condition = text(row.condition);
    if (!sku || (condition && condition.toLowerCase() !== "new")) continue;
    const ages = AGE_COLUMNS.map((column) => count(row[column]));
    const available = count(row.available), inbound = count(row["inbound-quantity"]);
    const aged181 = ages[2]! + ages[3]! + ages[4]! + ages[5]!;
    const aged91to180 = ages[1]!;
    if (!available && !inbound && !aged181 && !aged91to180) continue;
    const shipped30 = count(row["units-shipped-t30"]), shipped90 = count(row["units-shipped-t90"]);
    const aisValues = AIS_BUCKETS.map((bucket) => money(row[`estimated-ais-${bucket}-days`]));
    const aisNextMonth = aisValues.some((value) => value !== null) ? r2(aisValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)) : null;
    const storageNextMonth = money(row["estimated-storage-cost-next-month"]);
    const price = money(row["featuredoffer-price"]) || money(row["your-price"]) || null;
    const stock = available + inbound;
    output.push({
      sku, asin: text(row.asin).toUpperCase(), status: text(row["fba-inventory-level-health-status"]) || "—", action: text(row["recommended-action"]),
      available, inbound, ages, aged181, aged91to180, ...agingForecast(aged181, aged91to180, shipped90),
      shipped30, shipped90, daysOfSupply: money(row["days-of-supply"]), excess: count(row["estimated-excess-quantity"]),
      storageNextMonth, aisNextMonth, aisUnits: AIS_BUCKETS.reduce((sum, bucket) => sum + count(row[`quantity-to-be-charged-ais-${bucket}-days`]), 0),
      holdingPerUnit: storageNextMonth !== null && stock > 0 ? r2(storageNextMonth / stock) : null,
      monthsToClear: shipped30 > 0 ? Math.round((available / shipped30) * 10) / 10 : null,
      price, ...cashBasis(price, costs.get(sku)),
      lowInventoryFee: /^y/i.test(text(row["Low-Inventory-Level fee applied in current week?"])),
      seasonal: /^y/i.test(text(row["is-seasonal-in-next-3-months"])) ? text(row["season-name"]) || "是" : "",
    });
  }
  return output.sort((a, b) => (b.storageNextMonth ?? 0) - (a.storageNextMonth ?? 0));
}

export interface InventoryTotals { storageNextMonth: number; aisNextMonth: number; excessSkus: number; aged181: number }

export function inventoryTotals(skus: SkuInventoryHealth[]): InventoryTotals {
  return {
    storageNextMonth: r2(skus.reduce((sum, item) => sum + (item.storageNextMonth ?? 0), 0)), aisNextMonth: r2(skus.reduce((sum, item) => sum + (item.aisNextMonth ?? 0), 0)),
    excessSkus: skus.filter((item) => item.status === "Excess").length, aged181: skus.reduce((sum, item) => sum + item.aged181, 0),
  };
}

// ---------- 提醒 ----------

export interface AlertMark { status: string; aisMonth?: string; lowFeeWeek?: string }
export interface AlertState { skus: Record<string, AlertMark>; previewMonth?: string }

const usd = (value: number | null): string => value === null ? "—" : `$${value.toFixed(value >= 100 ? 0 : 2)}`;
const pct = (value: number | null): string => value === null ? "—" : `${Math.round(value * 100)}%`;

export function excessLine(item: SkuInventoryHealth): string {
  const pace = item.shipped30 > 0 ? `按近 30 天 ${item.shipped30} 件约 ${item.monthsToClear} 个月卖完` : "近 30 天没有发货";
  const storage = item.storageNextMonth === null ? "" : `；下月仓储约 ${usd(item.storageNextMonth)}${item.aisNextMonth ? `（含超龄 ${usd(item.aisNextMonth)}）` : ""}${item.holdingPerUnit !== null ? `，每件每月 ${usd(item.holdingPerUnit)}` : ""}`;
  const cash = item.cashPerUnit === null ? "" : `；现价每件回款约 ${usd(item.cashPerUnit)}（不计采购与头程），广告 ACOS 低于 ${pct(item.cashAcos)} 就比放着强`;
  return `🔴 ${item.sku} 被亚马逊标为冗余：可售 ${item.available} 件，${pace}${storage}${cash}`;
}

export const aisLine = (item: SkuInventoryHealth): string => `⚠️ ${item.sku} 下月超龄附加费约 ${usd(item.aisNextMonth)}（${item.aged181} 件超 180 天）`;

// 周键＝北京日期所在周的周一。
export function weekKey(beijingDay: string): string {
  const dow = new Date(`${beijingDay}T00:00:00Z`).getUTCDay();
  return addDaysYmd(beijingDay, -((dow + 6) % 7));
}

export function inventoryAlerts(previous: AlertState | undefined, skus: SkuInventoryHealth[], settings: InventoryHealthSettings, beijingDay: string): { lines: string[]; next: AlertState } {
  const month = beijingDay.slice(0, 7), week = weekKey(beijingDay);
  const lines: string[] = [];
  const marks: Record<string, AlertMark> = { ...(previous?.skus ?? {}) };
  for (const item of skus) {
    const before = previous?.skus[item.sku];
    const mark: AlertMark = { ...(before ?? {}), status: item.status };
    if (item.status === "Excess" && before?.status !== "Excess") lines.push(excessLine(item));
    if (item.status !== "Excess" && before?.status === "Excess") lines.push(`✅ ${item.sku} 不再是冗余（亚马逊状态 ${item.status}）`);
    if (item.aisNextMonth !== null && item.aisNextMonth >= settings.aisMin && item.aisNextMonth > 0 && before?.aisMonth !== month) { lines.push(aisLine(item)); mark.aisMonth = month; }
    if (item.lowInventoryFee && before?.lowFeeWeek !== week) { lines.push(`⚠️ ${item.sku} 本周被收低库存费（库存相对销量偏低）`); mark.lowFeeWeek = week; }
    marks[item.sku] = mark;
  }
  return { lines, next: { skus: marks, ...(previous?.previewMonth ? { previewMonth: previous.previewMonth } : {}) } };
}

// 每月预告：北京日期 previewDay–14 日之间、本月还没发过时发一次（15 日按库龄计费，之后再发没意义）。
export function previewDue(previous: AlertState | undefined, settings: InventoryHealthSettings, beijingDay: string): boolean {
  const day = Number(beijingDay.slice(8, 10));
  return day >= settings.previewDay && day <= 14 && previous?.previewMonth !== beijingDay.slice(0, 7);
}

export function previewLines(skus: SkuInventoryHealth[], totals: InventoryTotals, snapshotDate: string): string[] {
  const charged = skus.filter((item) => (item.aisNextMonth ?? 0) > 0).sort((a, b) => (b.aisNextMonth ?? 0) - (a.aisNextMonth ?? 0));
  const aging = skus.filter((item) => item.willAge90 > 0).sort((a, b) => b.willAge90 - a.willAge90);
  return [
    "📦 本月 15 日超龄附加费预告",
    `下月仓储估算合计 ${usd(totals.storageNextMonth)}，其中超龄附加费 ${usd(totals.aisNextMonth)}`,
    ...(charged.length ? charged.map((item) => `· ${item.sku}：超 180 天 ${item.aged181} 件，约 ${usd(item.aisNextMonth)}`) : ["· 本月没有预计收超龄附加费的商品"]),
    ...(aging.length ? [`3 个月内会新进入超龄（估）：${aging.map((item) => `${item.sku} ${item.willAge90} 件`).join("、")}`] : []),
    "亚马逊按 15 日的库龄计费；是否降价、加推广或移除由你决定。",
    `数据：亚马逊库存健康报告 ${snapshotDate}`,
  ];
}

// ---------- 任务 ----------

// now：本轮的业务时间；clock：报告轮询预算用的时钟（测试里随 sleep 前进）。
export interface InventoryHealthDeps { sleep?: (ms: number) => Promise<void>; schedule?: typeof ensureOneTimeSchedule; pollBudgetMs?: number; pollIntervalMs?: number; now?: () => number; clock?: () => number }

export async function runInventoryHealth(event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient, deps: InventoryHealthDeps = {}): Promise<JsonObject> {
  if (!config.bool("INVENTORY_HEALTH_ENABLED", true)) return { status: "done", disabled: true };
  const schedule = deps.schedule ?? ensureOneTimeSchedule;
  const now = deps.now?.() ?? Date.now();
  const taskId = event.taskId ?? `inventory-health|${event.scheduledAt ?? new Date(now).toISOString()}`;
  const saved = await state.task("inventory-health", taskId);
  if (saved?.status === "done") return { status: "done", taskId, alreadyDone: true };
  const settings = inventoryHealthSettings(config);
  let reportId = text((saved?.state as Row | undefined)?.reportId);
  if (!reportId) {
    reportId = await createReport(amazon, { reportType: PLANNING_REPORT_TYPE, marketplaceIds: [MARKETPLACE_US] });
    await state.saveTask("inventory-health", taskId, { reportId, requestedAt: new Date(now).toISOString() }, "waiting_report");
  }
  const outcome = await awaitReport(amazon, reportId, { budgetMs: deps.pollBudgetMs ?? 8 * 60_000, intervalMs: deps.pollIntervalMs ?? 15_000, ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.clock ? { now: deps.clock } : {}) });
  if (outcome.status === "pending") {
    const nextAt = new Date(Date.now() + CONTINUE_AFTER_MS);
    await state.saveTask("inventory-health", taskId, { reportId }, "waiting_report", nextAt.toISOString());
    await schedule({ taskType: "inventory-health", taskId, ...(event.scheduledAt ? { scheduledAt: event.scheduledAt } : {}) }, nextAt);
    return { status: "waiting_report", taskId, reportId, nextAt: nextAt.toISOString() };
  }
  if (outcome.status !== "done") {
    await state.saveTask("inventory-health", taskId, { reportId, outcome: outcome.status }, "failed");
    throw new Error(`库存健康报告 ${outcome.status}${outcome.detail ? `：${outcome.detail.slice(0, 200)}` : ""}`);
  }
  const rows = parseTsv(outcome.body);
  if (rows.length && !("available" in rows[0]!)) throw new Error("库存健康报告缺少 available 列，格式可能变了。");
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const [profit, skuRecords] = await Promise.all([feishu.listRecords(app, config.get("FEISHU_BITABLE_TABLE_ID_PROFIT_ESTIMATE")), feishu.listRecords(app, config.get("FEISHU_BITABLE_TABLE_ID_SKUS"))]);
  const skus = inventoryHealthRows(rows, skuCosts(profit, skuRecords));
  const totals = inventoryTotals(skus);
  const snapshotDate = text(rows[0]?.["snapshot-date"]) || ymdInZone(new Date(now), "America/Los_Angeles");
  const beijingDay = ymdInZone(new Date(now), "Asia/Shanghai");
  const previous = await state.get(INVENTORY_HEALTH_PK, "alerts") as AlertState | undefined;
  const { lines, next } = inventoryAlerts(previous, skus, settings, beijingDay);
  const preview = previewDue(previous, settings, beijingDay);
  // 一轮最多一条消息：同一轮既有每日提醒又到了每月预告时，预告作为第二段并进每日提醒（预告的数据来源行省掉，结尾统一写一次）。
  const previewBody = preview ? previewLines(skus, totals, snapshotDate) : [];
  const dailyLines = lines.length ? ["📦 压货与仓储费", ...lines, ...(preview ? ["", ...previewBody.slice(0, -1)] : []), `数据：亚马逊库存健康报告 ${snapshotDate}`] : [];
  // 先持久化通知意图，再写状态，再发送。
  const dailyKey = dailyLines.length ? `inventory-health|${beijingDay}|${sha256(dailyLines.join("\n")).slice(0, 16)}` : "";
  const previewKey = preview && !dailyLines.length ? `inventory-health-month|${beijingDay.slice(0, 7)}` : "";
  const daily: PreparedNotification | undefined = dailyKey ? await prepareNotification(config, state, dailyKey, dailyLines) : undefined;
  const monthly: PreparedNotification | undefined = previewKey ? await prepareNotification(config, state, previewKey, previewBody) : undefined;
  const at = new Date().toISOString();
  await state.put({ pk: INVENTORY_HEALTH_PK, sk: "latest", snapshotDate, reportId, totals, skus: skus as unknown as JsonObject[], updatedAt: at });
  await state.put({ pk: INVENTORY_HEALTH_PK, sk: `day|${beijingDay}`, snapshotDate, totals, skus: skus.map((item) => ({ sku: item.sku, status: item.status, available: item.available, aged181: item.aged181, storageNextMonth: item.storageNextMonth, aisNextMonth: item.aisNextMonth })), updatedAt: at, expiresAt: Math.floor(now / 1000) + DAY_TTL_DAYS * 86_400 });
  await state.put({ pk: INVENTORY_HEALTH_PK, sk: "alerts", ...next, ...(preview ? { previewMonth: beijingDay.slice(0, 7) } : {}), updatedAt: at });
  await state.saveTask("inventory-health", taskId, { reportId, skus: skus.length, alerts: lines.length, preview }, "done");
  const sentDaily = dailyKey ? await flushNotification(state, feishu, dailyKey, daily) : "none";
  const sentMonthly = previewKey ? await flushNotification(state, feishu, previewKey, monthly) : "none";
  log("INFO", "inventory_health_done", { skus: skus.length, alerts: lines.length, preview, storage: totals.storageNextMonth, ais: totals.aisNextMonth });
  return { status: "done", taskId, snapshotDate, skus: skus.length, excessSkus: totals.excessSkus, storageNextMonth: totals.storageNextMonth, aisNextMonth: totals.aisNextMonth, alerts: lines.length, notified: sentDaily === "sent" || sentMonthly === "sent", preview };
}
