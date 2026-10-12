import { feishuFieldText, feishuRelationRecordIds, ymdInZone } from "../util.js";
import { r2 } from "./aggregate.js";
import type { AdsPart, AsinTraffic, FeeKind, FeeLine, InventoryPart, LinePart, OtherChannelPart, ReasonLine, RefundPart, SalesPart, SkuDay, TrafficPart } from "./types.js";

// 店铺报告的口径计算（纯函数，Jobs 用）。口径见 docs/模块说明.md「店铺报告」。
type Row = Record<string, unknown>;
export const SITE_ZONE = "America/Los_Angeles";
const AMAZON_ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;
const text = (value: unknown): string => feishuFieldText(value);
// 飞书数字、公式与查找列：取第一个值；空、非数字返回 null（不当 0）。
export function cell(value: unknown): number | null {
  const raw = text(value).split(",")[0]?.trim() ?? "";
  if (raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
const siteDay = (ms: number): string => ymdInZone(new Date(ms), SITE_ZONE);
const lineKey = (orderId: string, sku: string): string => `${orderId}|${sku.trim().toLowerCase()}`;

// ---------- 成本参数（毛利润预估，经 SKU信息表关联到 SKU） ----------

export interface SkuCost {
  sku: string; price: number | null; fba: number | null; commission: number | null; fixedCost: number | null; margin: number | null; marginRate: number | null;
  storage19: number; storage1012: number;
}

// 与订单表公式一致：TODAY().MONTH() < 10 用 1–9 月费率，否则 10–12 月。month 为 1–12。
export function storageRate(cost: Pick<SkuCost, "storage19" | "storage1012"> | undefined, month: number): number {
  if (!cost) return 0;
  return month < 10 ? cost.storage19 : cost.storage1012;
}

// 关联字段：列表接口给 [{ record_ids: [...], text }]，查询接口可能给 { record_id }；两种都认。
function linkedIds(value: unknown): string[] {
  const ids = new Set(feishuRelationRecordIds(value));
  for (const item of Array.isArray(value) ? value : [value]) {
    const list = item && typeof item === "object" ? (item as Row).record_ids ?? (item as Row).link_record_ids : undefined;
    if (Array.isArray(list)) for (const id of list) if (typeof id === "string" && id) ids.add(id);
  }
  return [...ids];
}

// 同一 SKU 关联到多行毛利润预估时视为成本不明（与广告任务“毛利率存在多条记录”同一规则）。
export function skuCosts(profitRecords: Array<{ record_id?: string; fields: Row }>, skuRecords: Array<{ record_id: string; fields: Row }>): Map<string, SkuCost> {
  const skuById = new Map(skuRecords.map((record) => [record.record_id, text(record.fields["SKU编号"])]));
  const found = new Map<string, SkuCost[]>();
  for (const record of profitRecords) {
    const raw = record.fields["SKU编号"];
    const related = [...new Set(linkedIds(raw).map((id) => skuById.get(id) ?? "").filter(Boolean))];
    const sku = related.length === 1 ? related[0]! : related.length ? "" : text(raw);
    if (!sku) continue;
    let marginRate = cell(record.fields["毛利率"]);
    if (marginRate !== null && Math.abs(marginRate) > 1) marginRate /= 100;
    found.set(sku, [...(found.get(sku) ?? []), {
      sku, price: cell(record.fields["AMZ售价"]), fba: cell(record.fields["AMZ-FBA配送费"]), commission: cell(record.fields["预估佣金"]),
      fixedCost: cell(record.fields["计算用-固定成本-不含佣金配送费"]), margin: cell(record.fields["毛利"]), marginRate,
      storage19: cell(record.fields["预估仓储费1-9月"]) ?? 0, storage1012: cell(record.fields["预估仓储费10-12月"]) ?? 0,
    }]);
  }
  const output = new Map<string, SkuCost>();
  for (const [sku, list] of found) if (list.length === 1) output.set(sku, list[0]!);
  return output;
}

// ---------- 飞书订单表 ----------

export const ORDER_FIELDS = ["订单编号", "SKU", "ASIN", "数量", "订单状态", "下单时间", "付款金额", "金额", "预期毛利", "佣金", "配送费", "促销费用", "企业买家", "换货单", "AMZ售价", "毛利", "企业价毛利", "计算用-固定成本-不含佣金配送费", "预估佣金"];

export interface FeishuLine {
  orderId: string; sku: string; asin: string; qty: number; date: string; cancelled: boolean; paid: number | null; amount: number | null; profit: number | null;
  commission: number | null; fba: number | null; promo: number | null; business: boolean; replacement: boolean;
  price: number | null; margin: number | null; fixedCost: number | null; estCommission: number | null;
}

// 下单时间是洛杉矶本地时间文本（飞书文本时间规则）；取不到日期的行不要。
export function feishuLine(fields: Row): FeishuLine | null {
  const date = text(fields["下单时间"]).slice(0, 10);
  const orderId = text(fields["订单编号"]);
  const sku = text(fields.SKU);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !orderId || !sku) return null;
  return {
    orderId, sku, asin: text(fields.ASIN).toUpperCase(), qty: cell(fields["数量"]) ?? 1, date, cancelled: /取消|cancel/i.test(text(fields["订单状态"])),
    paid: cell(fields["付款金额"]), amount: cell(fields["金额"]), profit: cell(fields["预期毛利"]),
    commission: cell(fields["佣金"]), fba: cell(fields["配送费"]), promo: cell(fields["促销费用"]),
    business: text(fields["企业买家"]) === "true", replacement: text(fields["换货单"]) === "true",
    price: cell(fields["AMZ售价"]), margin: cell(fields["毛利"]), fixedCost: cell(fields["计算用-固定成本-不含佣金配送费"]), estCommission: cell(fields["预估佣金"]),
  };
}

// ---------- 全部订单报告（与 order-prices 同一种，制表符文本，商品名里的英寸号原样出现，逐行逐列切分） ----------

export interface ReportLine { orderId: string; sku: string; asin: string; date: string; qty: number; price: number | null; promo: number; cancelled: boolean; business: boolean; currency: string }
const REPORT_COLUMNS = ["amazon-order-id", "purchase-date", "order-status", "item-status", "sku", "quantity", "item-price", "currency", "item-promotion-discount", "ship-promotion-discount", "sales-channel"];

// 只收亚马逊站内订单（多渠道配送单不是销售）；同一订单同一 SKU 多行合并，整单或全部行取消记已取消；列数不符的整单不收（计 malformed）。
export function parseOrderReport(source: string): { rows: number; malformed: number; lines: ReportLine[] } {
  const rows = source.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!rows.length) return { rows: 0, malformed: 0, lines: [] };
  const header = rows[0]!.split("\t").map((name) => name.trim());
  const missing = REPORT_COLUMNS.filter((name) => !header.includes(name));
  if (missing.length) throw new Error(`全部订单报告缺少列：${missing.join(",")}`);
  const col = (cells: string[], name: string): string => (cells[header.indexOf(name)] ?? "").trim();
  const byKey = new Map<string, ReportLine & { live: number; priced: boolean }>();
  const malformed = new Set<string>();
  for (const line of rows.slice(1)) {
    const cells = line.split("\t");
    const orderId = col(cells, "amazon-order-id");
    if (cells.length !== header.length) { if (orderId) malformed.add(orderId); continue; }
    if (!AMAZON_ORDER_ID.test(orderId) || !/^amazon\./i.test(col(cells, "sales-channel"))) continue;
    const at = Date.parse(col(cells, "purchase-date"));
    const sku = col(cells, "sku");
    if (!Number.isFinite(at) || !sku) { malformed.add(orderId); continue; }
    const key = lineKey(orderId, sku);
    const entry = byKey.get(key) ?? { orderId, sku, asin: col(cells, "asin").toUpperCase(), date: siteDay(at), qty: 0, price: null, promo: 0, cancelled: false, business: col(cells, "is-business-order").toLowerCase() === "true", currency: col(cells, "currency"), live: 0, priced: false };
    byKey.set(key, entry);
    if (/cancel/i.test(col(cells, "order-status"))) { entry.cancelled = true; continue; }
    if (/cancel/i.test(col(cells, "item-status"))) continue;
    entry.live += 1;
    entry.qty += Number(col(cells, "quantity")) || 0;
    const price = col(cells, "item-price");
    if (price !== "" && Number.isFinite(Number(price))) { entry.price = r2((entry.price ?? 0) + Number(price)); entry.priced = true; }
    entry.promo = r2(entry.promo + Math.abs(Number(col(cells, "item-promotion-discount")) || 0) + Math.abs(Number(col(cells, "ship-promotion-discount")) || 0));
    if (!entry.currency) entry.currency = col(cells, "currency");
  }
  const lines: ReportLine[] = [];
  for (const entry of byKey.values()) {
    if (malformed.has(entry.orderId)) continue;
    const { live, priced: _priced, ...line } = entry;
    lines.push({ ...line, cancelled: line.cancelled || live === 0 });
  }
  return { rows: rows.length - 1, malformed: malformed.size, lines };
}

// ---------- 逐行毛利 ----------

export interface DayLinesResult {
  lines: LinePart; skus: Record<string, SkuDay>; other: OtherChannelPart | undefined;
  checks: { reportLines: number | null; feishuLines: number; matched: number };
}

const emptyLines = (): LinePart => ({ lines: 0, units: 0, revenue: 0, promo: 0, commission: 0, fba: 0, cogs: 0, storageEst: 0, profit: 0, estimatedLines: 0, costMissingLines: 0, costMissingUnits: 0, missingInFeishu: 0, missingInReport: 0, duplicateKeys: 0 });
const emptySku = (): SkuDay => ({ units: 0, revenue: 0, promo: 0, commission: 0, fba: 0, cogs: 0, storageEst: 0, profit: 0, lines: 0, estimatedLines: 0, costMissing: 0 });

// 一天的订单行：
// - 费用已到账（付款金额、佣金、配送费都有值）：订单表「预期毛利」就是实际毛利，只把仓储费从“今天月份的费率”改成“下单月份的费率”。
// - 费用未到账：按订单表同一预估公式（售价、毛利、预估佣金取订单表查找列，缺时取毛利润预估），再扣全部订单报告里的实际促销折扣；免费换货单佣金与配送费为 0。
// - 报告有而飞书没有的行：按毛利润预估估算；成本缺失的行不计入毛利，单独计数。
// - 已取消以报告为准（报告缺时看飞书）；多渠道单（非亚马逊订单号）单列。
export function computeDayLines(date: string, input: { reportLines?: ReportLine[]; feishuLines: FeishuLine[]; costs: Map<string, SkuCost>; todayMonth: number }): DayLinesResult {
  const month = Number(date.slice(5, 7));
  const totals = emptyLines();
  const skus: Record<string, SkuDay> = {};
  let other: OtherChannelPart | undefined;
  const feishu = new Map<string, FeishuLine[]>();
  for (const line of input.feishuLines) {
    if (line.date !== date) continue;
    if (!AMAZON_ORDER_ID.test(line.orderId)) {
      if (line.cancelled) continue;
      other ??= { lines: 0, units: 0, sales: 0, profit: 0 };
      other.lines += 1; other.units += line.qty; other.sales = r2(other.sales + (line.amount ?? line.paid ?? 0)); other.profit = r2(other.profit + (line.profit ?? 0));
      continue;
    }
    const key = lineKey(line.orderId, line.sku);
    feishu.set(key, [...(feishu.get(key) ?? []), line]);
  }
  const report = input.reportLines ? new Map(input.reportLines.filter((line) => line.date === date).map((line) => [lineKey(line.orderId, line.sku), line])) : undefined;
  const keys = new Set([...feishu.keys(), ...(report?.keys() ?? [])]);
  let reportLines = 0, feishuLines = 0, matched = 0;
  for (const key of keys) {
    const rows = feishu.get(key) ?? [];
    const fromReport = report?.get(key);
    const cancelled = fromReport ? fromReport.cancelled : rows.every((row) => row.cancelled);
    if (cancelled) continue;
    if (fromReport) reportLines += 1;
    if (rows.some((row) => !row.cancelled) || (fromReport && rows.length)) feishuLines += 1;
    if (fromReport && rows.length) matched += 1;
    if (report && !fromReport) totals.missingInReport += 1;
    if (report && fromReport && !rows.length) totals.missingInFeishu += 1;
    if (rows.length > 1) totals.duplicateKeys += 1;
    const row = rows.length === 1 || !fromReport ? rows[0] : undefined;
    const sku = row?.sku ?? fromReport!.sku;
    const qty = fromReport?.qty || row?.qty || 1;
    const cost = input.costs.get(sku) ?? [...input.costs.values()].find((item) => item.sku.toLowerCase() === sku.toLowerCase());
    const storageNow = storageRate(cost, input.todayMonth), storageThen = storageRate(cost, month);
    const target = (skus[sku] ??= emptySku());
    const feesPosted = !!row && row.paid !== null && row.commission !== null && row.fba !== null && row.profit !== null;
    let revenue: number, promo: number, commission: number, fba: number, profit: number, estimated = false;
    if (feesPosted) {
      revenue = row.paid!; promo = Math.abs(row.promo ?? 0); commission = Math.abs(row.commission!); fba = Math.abs(row.fba!);
      profit = row.profit! + (storageNow - storageThen) * row.qty;
    } else {
      const unitPrice = row?.price ?? cost?.price ?? null;
      const margin = row?.margin ?? cost?.margin ?? null;
      const fixed = row?.fixedCost ?? cost?.fixedCost ?? null;
      const estCommission = row?.estCommission ?? cost?.commission ?? 0;
      const price = row?.paid ?? fromReport?.price ?? null;
      if (unitPrice === null || margin === null || fixed === null || price === null) {
        totals.costMissingLines += 1; totals.costMissingUnits += qty; target.costMissing += 1;
        continue;
      }
      const replacement = row?.replacement ?? price === 0;
      revenue = price; promo = Math.abs(fromReport?.promo ?? 0);
      commission = replacement ? 0 : unitPrice > 0 ? estCommission * price / unitPrice : 0;
      fba = replacement ? 0 : (unitPrice - margin - estCommission - fixed) * qty;
      profit = price - promo - commission - fba - (fixed - storageNow) * qty - storageThen * qty;
      estimated = true;
    }
    const storageEst = storageThen * qty;
    // 商品成本取差额，保证“售价 − 促销 − 佣金 − 配送费 − 商品成本 − 按件仓储费＝毛利”逐行成立。
    const cogs = revenue - promo - commission - fba - storageEst - profit;
    // 逐行按全精度累加、最后统一保留两位（公式值小数位多，逐行四舍五入 48 行会差出几毛）。
    for (const entry of [totals, target] as Array<LinePart | SkuDay>) {
      entry.lines += 1; entry.units += qty;
      entry.revenue += revenue; entry.promo += promo; entry.commission += commission; entry.fba += fba; entry.cogs += cogs; entry.storageEst += storageEst; entry.profit += profit;
      if (estimated) entry.estimatedLines += 1;
    }
  }
  const money = ["revenue", "promo", "commission", "fba", "cogs", "storageEst", "profit"] as const;
  for (const entry of [totals, ...Object.values(skus)] as Array<LinePart | SkuDay>) for (const key of money) entry[key] = r2(entry[key]);
  return { lines: totals, skus, other, checks: { reportLines: report ? reportLines : null, feishuLines, matched } };
}

// ---------- 亚马逊销售接口（按天，洛杉矶时区；区间起点就是洛杉矶日期） ----------

export function salesDays(payload: unknown): Map<string, SalesPart> {
  const output = new Map<string, SalesPart>();
  for (const row of Array.isArray(payload) ? payload as Row[] : []) {
    const date = text(row.interval).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const total = (row.totalSales ?? {}) as Row;
    output.set(date, { units: Number(row.unitCount) || 0, orders: Number(row.orderCount) || 0, sales: r2(Number(total.amount) || 0), currency: text(total.currencyCode) || "USD" });
  }
  return output;
}

export function withB2b(sales: Map<string, SalesPart>, b2b: Map<string, SalesPart>): void {
  for (const [date, part] of sales) {
    const business = b2b.get(date);
    if (business) Object.assign(part, { b2bSales: business.sales, b2bUnits: business.units });
  }
}

// ---------- 广告 ----------

const overviewDate = (value: unknown): string => { const ms = cell(value); return ms === null ? "" : new Date(ms).toISOString().slice(0, 10); };

// 广告每日总览：「花费」有值才算报表已到（只有总销售的行是“等待广告报表”）。
export function overviewAds(records: Array<{ fields: Row }>): Map<string, AdsPart> {
  const output = new Map<string, AdsPart>();
  for (const { fields } of records) {
    const date = overviewDate(fields["站点日期"]);
    const spend = cell(fields["花费"]);
    if (!date || spend === null) continue;
    output.set(date, { source: "report", spend: r2(spend), sales: r2(cell(fields["广告销售额"]) ?? 0), orders: cell(fields["广告订单"]) ?? 0, units: cell(fields["广告销量"]) ?? 0, impressions: cell(fields["曝光"]) ?? 0, clicks: cell(fields["点击"]) ?? 0 });
  }
  return output;
}

export interface BudgetDay { total: number; campaigns: Array<{ campaignId: string; spend: number; skuHint: string }> }
export function budgetDays(records: Array<{ fields: Row }>): Map<string, BudgetDay> {
  const output = new Map<string, BudgetDay>();
  for (const { fields } of records) {
    const date = text(fields["预算日期"]).slice(0, 10);
    const spend = cell(fields["已花费预算"]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || spend === null) continue;
    const day = output.get(date) ?? { total: 0, campaigns: [] };
    day.total = r2(day.total + spend);
    day.campaigns.push({ campaignId: text(fields["广告活动ID"]), spend, skuHint: text(fields["所属SKU"]) });
    output.set(date, day);
  }
  return output;
}

export const AD_RATIO_DAYS = 14;
export const AD_RATIO_MIN_PAIRS = 7;
export const AD_RATIO_RANGE: [number, number] = [1, 1.6];
// 预算表是亚马逊推送的预算快讯，比计费的广告报表偏低（实测约低两成）：用当天之前 14 天里两边都有的日子求比例，限 1.0–1.6；不足 7 天按 1.0。
export function adRatio(report: Map<string, AdsPart>, budget: Map<string, BudgetDay>, before: string, addDays: (date: string, days: number) => string): number {
  let reported = 0, budgeted = 0, pairs = 0;
  for (let offset = 1; offset <= AD_RATIO_DAYS; offset += 1) {
    const date = addDays(before, -offset);
    const ads = report.get(date), day = budget.get(date);
    if (!ads || ads.source !== "report" || !day || day.total <= 0) continue;
    reported += ads.spend; budgeted += day.total; pairs += 1;
  }
  if (pairs < AD_RATIO_MIN_PAIRS || budgeted <= 0) return 1;
  return Math.round(Math.min(AD_RATIO_RANGE[1], Math.max(AD_RATIO_RANGE[0], reported / budgeted)) * 10_000) / 10_000;
}

export interface SkuAdsDay { bySku: Map<string, { spend: number; sales: number; orders: number; clicks: number; impressions: number }>; unattributed: { spend: number; sales: number; orders: number } }
const emptyAds = (): SkuAdsDay => ({ bySku: new Map(), unattributed: { spend: 0, sales: 0, orders: 0 } });
function addAds(day: SkuAdsDay, sku: string | undefined, spend: number, sales: number, orders: number, clicks: number, impressions: number): void {
  if (!sku) { day.unattributed.spend = r2(day.unattributed.spend + spend); day.unattributed.sales = r2(day.unattributed.sales + sales); day.unattributed.orders += orders; return; }
  const entry = day.bySku.get(sku) ?? { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
  entry.spend = r2(entry.spend + spend); entry.sales = r2(entry.sales + sales); entry.orders += orders; entry.clicks += clicks; entry.impressions += impressions;
  day.bySku.set(sku, entry);
}

// 广告活动日报：一个活动一个 SKU 时「SKU编号」有值；空的记“未归属 SKU”。
export function campaignSkuAds(records: Array<{ fields: Row }>): Map<string, SkuAdsDay> {
  const output = new Map<string, SkuAdsDay>();
  for (const { fields } of records) {
    const date = overviewDate(fields["站点日期"]);
    if (!date) continue;
    const day = output.get(date) ?? emptyAds();
    addAds(day, text(fields["SKU编号"]) || undefined, cell(fields["花费"]) ?? 0, cell(fields["广告销售额"]) ?? 0, cell(fields["广告订单"]) ?? 0, cell(fields["点击"]) ?? 0, cell(fields["曝光"]) ?? 0);
    output.set(date, day);
  }
  return output;
}

// 广告快照（投放层、按广告组归属 SKU）：多 SKU 活动也能拆开。owners 由调用方用 adGroupSkus 求出，唯一时归属。
export function snapshotSkuAds(series: Array<{ owners: string[]; days: Record<string, number[]> }>, dates: string[]): Map<string, SkuAdsDay> {
  const output = new Map<string, SkuAdsDay>();
  for (const date of dates) {
    const day = emptyAds();
    let any = false;
    for (const item of series) {
      const value = item.days[date];
      if (!value) continue;
      any = true;
      addAds(day, item.owners.length === 1 ? item.owners[0] : undefined, value[2] ?? 0, value[3] ?? 0, value[4] ?? 0, value[1] ?? 0, value[0] ?? 0);
    }
    if (any) output.set(date, day);
  }
  return output;
}

// 预算表估算按 SKU 拆：活动对应唯一 SKU 才归属（先看广告目录，再看预算表「所属SKU」）。
export function budgetSkuAds(day: BudgetDay, ratio: number, campaignSkus: Map<string, string[]>): SkuAdsDay {
  const output = emptyAds();
  for (const campaign of day.campaigns) {
    const fromCatalog = campaignSkus.get(campaign.campaignId) ?? [];
    const hint = campaign.skuHint.split(/[,，]\s*/).map((item) => item.trim()).filter(Boolean);
    const owner = fromCatalog.length === 1 ? fromCatalog[0] : !fromCatalog.length && hint.length === 1 ? hint[0] : undefined;
    addAds(output, owner, r2(campaign.spend * ratio), 0, 0, 0, 0);
  }
  return output;
}

// ---------- Data Kiosk ----------

const amountOf = (value: unknown): number => Number(((value ?? {}) as Row).amount) || 0;
const nullableNumber = (value: unknown): number | null => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

export function kioskStoreDays(rows: Row[]): Map<string, TrafficPart> {
  const output = new Map<string, TrafficPart>();
  for (const row of rows) {
    const date = text(row.startDate).slice(0, 10);
    if (!date) continue;
    const sales = (row.sales ?? {}) as Row, traffic = (row.traffic ?? {}) as Row;
    output.set(date, {
      sessions: Number(traffic.sessions) || 0, pageViews: Number(traffic.pageViews) || 0, buyBoxPct: nullableNumber(traffic.buyBoxPercentage), unitSessionPct: nullableNumber(traffic.unitSessionPercentage),
      unitsOrdered: Number(sales.unitsOrdered) || 0, orderedSales: r2(amountOf(sales.orderedProductSales)),
      unitsRefunded: nullableNumber(sales.unitsRefunded), refundRate: nullableNumber(sales.refundRate), unitsShipped: nullableNumber(sales.unitsShipped),
      shippedSales: sales.shippedProductSales === undefined ? null : r2(amountOf(sales.shippedProductSales)),
      feedback: nullableNumber(traffic.feedbackReceived), negativeFeedback: nullableNumber(traffic.negativeFeedbackReceived),
    });
  }
  return output;
}

export function kioskAsinDays(rows: Row[]): Map<string, Record<string, AsinTraffic>> {
  const output = new Map<string, Record<string, AsinTraffic>>();
  for (const row of rows) {
    const date = text(row.startDate).slice(0, 10);
    const asin = text(row.childAsin).toUpperCase();
    if (!date || !asin) continue;
    const sales = (row.sales ?? {}) as Row, traffic = (row.traffic ?? {}) as Row;
    const day = output.get(date) ?? {};
    day[asin] = { sessions: Number(traffic.sessions) || 0, pageViews: Number(traffic.pageViews) || 0, buyBoxPct: nullableNumber(traffic.buyBoxPercentage), unitSessionPct: nullableNumber(traffic.unitSessionPercentage), units: Number(sales.unitsOrdered) || 0, sales: r2(amountOf(sales.orderedProductSales)) };
    output.set(date, day);
  }
  return output;
}

// ---------- 退款（REFUND_FACTS 逐笔） ----------

const money = (value: unknown): number => Number(((value ?? {}) as Row).CurrencyAmount ?? ((value ?? {}) as Row).currencyAmount) || 0;
export interface RefundDay { part: RefundPart; bySku: Map<string, { units: number; loss: number }> }

// 收费里的销售税（Tax、ShippingTax 等）是代收代缴，不计；本金、运费、补货费、退回费用与冲回促销都计。多次入账的一笔按各次退款额比例拆到各天。
export function refundDays(items: Row[]): Map<string, RefundDay> {
  const output = new Map<string, RefundDay>();
  for (const item of items) {
    for (const fact of (Array.isArray(item.facts) ? item.facts : []) as Row[]) {
      const sku = text(fact.sku ?? item.sku);
      const currencies = (Array.isArray(fact.currencies) ? fact.currencies : []).map(String);
      const charges = (Array.isArray(fact.charges) ? fact.charges : []) as Row[];
      const principal = charges.filter((charge) => !/tax/i.test(text(charge.ChargeType ?? charge.chargeType))).reduce((sum, charge) => sum + money(charge.ChargeAmount ?? charge.chargeAmount), 0);
      const feeBack = ((Array.isArray(fact.fees) ? fact.fees : []) as Row[]).reduce((sum, fee) => sum + money(fee.FeeAmount ?? fee.feeAmount), 0);
      const promoBack = ((Array.isArray(fact.promotions) ? fact.promotions : []) as Row[]).reduce((sum, promo) => sum + money(promo.PromotionAmount ?? promo.promotionAmount), 0);
      const events = (Array.isArray(fact.events) && fact.events.length ? fact.events : [{ postedDate: fact.postedDate, refundAmount: fact.refundAmount, quantity: fact.quantity }]) as Row[];
      const total = events.reduce((sum, event) => sum + Number(event.refundAmount ?? 0), 0);
      for (const event of events) {
        const at = Date.parse(text(event.postedDate));
        if (!Number.isFinite(at)) continue;
        const date = siteDay(at);
        const share = events.length === 1 ? 1 : total !== 0 ? Number(event.refundAmount ?? 0) / total : 1 / events.length;
        const day = output.get(date) ?? { part: { events: 0, units: 0, principal: 0, feeBack: 0, promoBack: 0, loss: 0, nonUsd: 0 }, bySku: new Map() };
        output.set(date, day);
        day.part.events += 1;
        if (currencies.some((currency) => currency !== "USD")) { day.part.nonUsd += 1; continue; }
        const units = Number(event.quantity ?? fact.quantity ?? 0) || 0;
        const loss = (principal + feeBack + promoBack) * share;
        day.part.units += units;
        day.part.principal = r2(day.part.principal + principal * share); day.part.feeBack = r2(day.part.feeBack + feeBack * share); day.part.promoBack = r2(day.part.promoBack + promoBack * share);
        day.part.loss = r2(day.part.loss + loss);
        if (sku) { const entry = day.bySku.get(sku) ?? { units: 0, loss: 0 }; entry.units += units; entry.loss = r2(entry.loss + loss); day.bySku.set(sku, entry); }
      }
    }
  }
  return output;
}

// ---------- 售后原因（订单表「售后原因中文」与「售后原因时间」，时间是洛杉矶本地文本，可能多行各带前缀） ----------

export function reasonDays(records: Array<{ fields: Row }>, dates: Set<string>): Map<string, ReasonLine[]> {
  const output = new Map<string, ReasonLine[]>();
  for (const { fields } of records) {
    const sku = text(fields.SKU);
    const reasons = text(fields["售后原因中文"]).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const times = text(fields["售后原因时间"]).split(/\r?\n/).map((line) => line.trim());
    reasons.forEach((reason, index) => {
      const date = (times[index] ?? times[0] ?? "").replace(/^[^0-9]*/, "").slice(0, 10);
      if (!dates.has(date)) return;
      const list = output.get(date) ?? [];
      if (list.length < 8) list.push({ sku, text: reason.slice(0, 80) });
      output.set(date, list);
    });
  }
  return output;
}

// ---------- 库存预警（每天北京 09:00 同步） ----------

export function inventoryFacts(records: Array<{ fields: Row }>): Record<string, InventoryPart> {
  const output: Record<string, InventoryPart> = {};
  for (const { fields } of records) {
    const sku = text(fields.SKU);
    const level = text(fields["预警等级"]);
    if (!sku || level === "已停用") continue;
    const inbound = ["FBA Working", "FBA Shipped", "FBA Receiving"].map((name) => cell(fields[name]));
    output[sku] = {
      fbaAvailable: cell(fields["FBA可售"]), inbound: inbound.every((value) => value === null) ? null : inbound.reduce<number>((sum, value) => sum + (value ?? 0), 0),
      awd: cell(fields["AWD可用"]), daysOfCover: cell(fields["FBA可售覆盖天数"]), level,
    };
  }
  return output;
}

// ---------- 月度店铺费用（账户其他资金流水） ----------

// FBA 月度仓储费与 AWD 仓储费在次月 7 日扣，归属扣费月的上一个月；其余按扣费日（洛杉矶）所在月。暂缓（DEFERRED）的不计，等放款后再算。
export function feeKind(category: string, description: string): FeeKind | "skip" {
  if (category === "账户划转") return "skip";
  if (category === "广告费用") return "adsInvoice";
  if (category === "赔偿与补偿") return "reimbursement";
  if (category === "待分类") return "unclassified";
  if (/^FBAStorageBilling$/i.test(description)) return "storage";
  if (/^STARStorageBilling$/i.test(description)) return "awdStorage";
  if (/LongTermStorage/i.test(description)) return "ltsf";
  if (/^Subscription$/i.test(description)) return "subscription";
  if (/vine/i.test(description)) return "vine";
  if (/disposal/i.test(description)) return "disposal";
  if (/^AWD/i.test(description)) return "awd";
  return "other";
}

const previousMonth = (month: string): string => { const [year, number] = month.split("-").map(Number); const date = new Date(Date.UTC(year!, number! - 2, 1)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; };

export function ledgerFeeLines(records: Array<{ fields: Row }>): FeeLine[] {
  const output: FeeLine[] = [];
  for (const { fields } of records) {
    if (text(fields["交易状态"]) === "暂缓") continue;
    const at = cell(fields["交易时间"]);
    const amount = cell(fields["原币金额"]);
    if (at === null || amount === null) continue;
    const kind = feeKind(text(fields["业务分类"]), text(fields["原始描述"]));
    if (kind === "skip") continue;
    const postedMonth = siteDay(at).slice(0, 7);
    output.push({ kind, name: text(fields["流水名称"]) || kind, amount: r2(amount), currency: text(fields["币种"]) || "USD", postedMonth: kind === "storage" || kind === "awdStorage" ? `${postedMonth}>${previousMonth(postedMonth)}` : postedMonth });
  }
  return output;
}

// 归属到某月的费用行（仓储类按“扣费月>归属月”的后半段匹配）。
export function feesForMonth(lines: FeeLine[], month: string): FeeLine[] {
  return lines.filter((line) => (line.postedMonth.includes(">") ? line.postedMonth.split(">")[1] : line.postedMonth) === month);
}
