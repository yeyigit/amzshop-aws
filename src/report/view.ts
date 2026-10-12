import { zonedMidnight } from "../util.js";
import { r2, sumDays, sumTotals } from "./aggregate.js";
import { TYPE_NAMES, addDays, comparisons, daysBetween, periodDays, periodLabel, periodOf, periodShortLabel, shiftMonth, shiftPeriod, type Period, type ReportType } from "./periods.js";
import type { DayFacts, FeeKind, FeeLine, InventoryPart, MonthFacts, PeriodTotals, ReasonLine, ReportMeta } from "./types.js";

// 报告页面与飞书消息共用的视图：输入已存的日数据与月数据，输出页面要展示的数字、对比、要点与消息文字。纯函数，无 IO。
export interface CatalogEntry { title: string; image: string; asin: string }
export interface ReportEvent { kind: string; at: string; title: string; details: string[] }
export interface ReportInput {
  period: Period; today: string; nowMs: number;
  days: Map<string, DayFacts>; months: Map<string, MonthFacts>;
  events?: ReportEvent[]; catalog?: Record<string, CatalogEntry>; meta?: ReportMeta | null;
}

export type KpiKey = "units" | "sales" | "orderProfit" | "adSpend" | "expectedProfit";
export interface CompareCell { label: string; prev: number | null; diff: number | null; pct: number | null }
export interface KpiCell { key: KpiKey; label: string; value: number | null; format: "int" | "usd"; estimate: boolean; note: string; compare: CompareCell[] }
export interface MetricCell { key: string; label: string; value: number | null; format: "int" | "usd" | "pct" | "pp"; note?: string; compare?: CompareCell[] }
export interface WaterfallStep { label: string; value: number; kind: "start" | "minus" | "plus" | "result"; note?: string }
export interface SkuRow {
  sku: string; asin: string; title: string; image: string; clearance: boolean;
  units: number; sales: number; share: number | null; promo: number; orderProfit: number; adSpend: number | null; adSales: number | null; acos: number | null; tacos: number | null;
  expectedProfit: number | null; margin: number | null; sessions: number | null; conversion: number | null; sharedAsin: boolean; refundUnits: number; unitsDiff: number | null;
  estimatedLines: number; costMissing: number; adEstimate: boolean;
}
export interface TrendPoint { key: string; label: string; sales: number | null; expectedProfit: number | null; adSpend: number | null; units: number | null; current: boolean; partial: boolean }
export interface TableRow { key: string; label: string; units: number | null; orders: number | null; sales: number | null; orderProfit: number | null; adSpend: number | null; adEstimate: boolean; expectedProfit: number | null; sessions: number | null; conversion: number | null; refundUnits: number | null; status: string }
export interface FeeView { lines: Array<{ kind: FeeKind; label: string; amount: number; currency: string; months: string }>; usdTotal: number; reimbursements: number; nonUsd: Array<{ label: string; amount: number; currency: string }>; unclassified: Array<{ label: string; amount: number; currency: string }>; storagePending: string[]; adsInvoice: number }
export interface NetView { expectedProfit: number | null; refundLoss: number; reimbursements: number; fees: number; storageAddBack: number; netProfit: number | null; pendingNote: string }
export interface InventoryRow { sku: string; title: string; fba: number | null; inbound: number | null; awd: number | null; days: number | null; level: string }
export interface ReportView {
  type: ReportType; typeName: string; key: string; from: string; to: string; label: string; shortLabel: string;
  through: string | null; inProgress: boolean; empty: boolean; currency: string;
  status: { label: string; tone: "final" | "draft" | "estimate"; details: string[] };
  updatedAt: string | null;
  nav: { prev: string | null; next: string | null; earliest: string | null; latest: string | null; switchTo: Record<ReportType, string>; options: Array<{ key: string; label: string }> };
  kpis: KpiCell[]; metrics: MetricCell[]; highlights: string[];
  waterfall: { steps: WaterfallStep[]; note: string } | null;
  traffic: MetricCell[] | null; ads: MetricCell[] | null; refunds: { metrics: MetricCell[]; reasons: ReasonLine[] } | null;
  other: { lines: number; units: number; sales: number; profit: number } | null;
  skus: SkuRow[]; unattributedAds: number | null;
  trend: { unit: "day" | "week" | "month"; points: TrendPoint[] };
  rows: TableRow[];
  fees: FeeView | null; net: NetView | null;
  inventory: { at: string; rows: InventoryRow[] } | null;
  events: { counts: Array<{ kind: string; label: string; count: number }>; items: ReportEvent[] } | null;
  checks: string[];
}

const FEE_LABELS: Record<FeeKind, string> = {
  storage: "FBA 月度仓储费", awdStorage: "AWD 仓储费", ltsf: "长期仓储费", subscription: "月度服务费", vine: "Vine 费用", disposal: "弃置费", awd: "AWD 运输与处理",
  other: "其他平台费用", reimbursement: "赔偿与补偿", unclassified: "待分类", adsInvoice: "广告扣款",
};
const EVENT_LABELS: Record<string, string> = {
  "competitor-price": "竞品价格变化", "competitor-promo": "竞品开始促销", "competitor-sale": "大促竞品动态", "hijacker-in": "跟卖出现", "hijacker-out": "跟卖离开",
  "buybox-lost": "购物车丢失", "buybox-back": "购物车恢复", traffic: "流量/转化预警", inventory: "库存预警", brand: "品牌冒用",
};
const KPI_LABELS: Record<KpiKey, string> = { units: "销售数量", sales: "销售金额", orderProfit: "订单毛利", adSpend: "广告花费", expectedProfit: "预期毛利" };

const ratio = (top: number | null | undefined, bottom: number | null | undefined): number | null => top === null || top === undefined || !bottom ? null : top / bottom;
const change = (value: number | null, prev: number | null): CompareCell["pct"] => value === null || prev === null || prev <= 0 ? null : (value - prev) / prev;

// ---------- 取数 ----------

function daysIn(input: ReportInput, from: string, to: string): DayFacts[] {
  const output: DayFacts[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) { const day = input.days.get(date); if (day) output.push(day); }
  return output;
}

// 按月份分段合计：整月且有月汇总时用月汇总（年报不逐天读），不完整的月逐天合计。
function totalsFor(input: ReportInput, from: string, to: string, useRollups: boolean): PeriodTotals {
  if (!useRollups) return sumDays(daysIn(input, from, to));
  const parts: PeriodTotals[] = [];
  for (let month = from.slice(0, 7); month <= to.slice(0, 7); month = shiftMonth(month, 1)) {
    const whole = periodOf("month", `${month}-01`);
    const start = whole.from > from ? whole.from : from, end = whole.to < to ? whole.to : to;
    const facts = input.months.get(month);
    if (start === whole.from && end === whole.to && facts?.rollup && facts.rollupThrough === whole.to) parts.push(facts.rollup);
    else parts.push(sumDays(daysIn(input, start, end)));
  }
  return sumTotals(parts);
}

export function expectedProfit(totals: PeriodTotals): number | null {
  if (!totals.lines || !totals.ads) return null;
  return r2(totals.lines.profit - totals.ads.spend);
}

// 对比期这一项每天都有数才比（例如某天订单逐行没取到，就不拿缺一天的订单毛利去比）。
function kpiCovered(totals: PeriodTotals, key: KpiKey): boolean {
  const { coverage, days } = totals;
  if (key === "units" || key === "sales") return coverage.sales === days;
  if (key === "orderProfit") return coverage.lines === days;
  if (key === "adSpend") return coverage.ads === days;
  return coverage.lines === days && coverage.ads === days;
}

function kpiValue(totals: PeriodTotals, key: KpiKey): number | null {
  if (key === "units") return totals.sales?.units ?? null;
  if (key === "sales") return totals.sales?.sales ?? null;
  if (key === "orderProfit") return totals.lines?.profit ?? null;
  if (key === "adSpend") return totals.ads?.spend ?? null;
  return expectedProfit(totals);
}

// ---------- 费用与净利润（月、年） ----------

function feeView(months: MonthFacts[], today: string): FeeView | null {
  const withFees = months.filter((month) => month.fees);
  if (!withFees.length) return null;
  const grouped = new Map<string, { kind: FeeKind; label: string; amount: number; currency: string; months: Set<string> }>();
  const view: FeeView = { lines: [], usdTotal: 0, reimbursements: 0, nonUsd: [], unclassified: [], storagePending: [], adsInvoice: 0 };
  for (const month of withFees) {
    for (const line of month.fees!.lines as FeeLine[]) {
      if (line.kind === "adsInvoice") { if (line.currency === "USD") view.adsInvoice = r2(view.adsInvoice + line.amount); continue; }
      if (line.kind === "unclassified") { view.unclassified.push({ label: line.name, amount: line.amount, currency: line.currency }); continue; }
      if (line.currency !== "USD") { view.nonUsd.push({ label: `${FEE_LABELS[line.kind]}｜${line.name}`, amount: line.amount, currency: line.currency }); continue; }
      if (line.kind === "reimbursement") { view.reimbursements = r2(view.reimbursements + line.amount); continue; }
      const key = `${line.kind}|${line.kind === "other" ? line.name : ""}`;
      const entry = grouped.get(key) ?? { kind: line.kind, label: line.kind === "other" ? line.name : FEE_LABELS[line.kind], amount: 0, currency: "USD", months: new Set<string>() };
      entry.amount = r2(entry.amount + line.amount);
      entry.months.add(month.month);
      grouped.set(key, entry);
    }
    // 次月 7 日扣上月仓储费：还没扣到时写明预计时间。
    // 过了次月 21 日仍没有，说明这个月没有仓储费（定稿时按 0）。
    if (!month.fees!.storagePosted && today <= `${shiftMonth(month.month, 1)}-21`) view.storagePending.push(`${Number(month.month.slice(5))} 月仓储费约 ${Number(shiftMonth(month.month, 1).slice(5))}/7 扣费`);
  }
  view.lines = [...grouped.values()].map((entry) => ({ kind: entry.kind, label: entry.label, amount: entry.amount, currency: entry.currency, months: [...entry.months].sort().join("、") })).sort((a, b) => a.amount - b.amount);
  view.usdTotal = r2(view.lines.reduce((sum, line) => sum + line.amount, 0));
  return view;
}

function netView(totals: PeriodTotals, fees: FeeView | null): NetView | null {
  if (!fees) return null;
  const expected = expectedProfit(totals);
  const refundLoss = totals.refunds?.loss ?? 0;
  const storageAddBack = totals.lines?.storageEst ?? 0;
  const pending = fees.storagePending.length ? `${fees.storagePending.join("；")}，扣费后再算净利润` : "";
  const netProfit = expected === null || pending ? null : r2(expected + refundLoss + fees.reimbursements + fees.usdTotal + storageAddBack);
  return { expectedProfit: expected, refundLoss, reimbursements: fees.reimbursements, fees: fees.usdTotal, storageAddBack, netProfit, pendingNote: pending };
}

// ---------- 要点（规则生成，最多 4 条） ----------

function money(value: number): string {
  const sign = value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const signedMoney = (value: number): string => `${value > 0 ? "+" : value < 0 ? "−" : "±"}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctText = (value: number | null, digits = 1): string => value === null ? "—" : `${value < 0 ? "−" : ""}${Math.abs(value * 100).toFixed(digits)}%`;
// 按显示的位数取整后再定正负；取整后为 0 写“持平”（10/09 日报曾显示“−0.0%”）。
const signedPct = (value: number): string => {
  const digits = Math.abs(value) >= 1 ? 0 : 1;
  const shown = Math.round(value * 100 * 10 ** digits) / 10 ** digits;
  return shown === 0 ? "持平" : `${shown > 0 ? "+" : "−"}${Math.abs(shown).toFixed(digits)}%`;
};

function highlights(totals: PeriodTotals, compare: { label: string; totals: PeriodTotals } | null, skus: SkuRow[], trailingRefundRate: number | null, inventory: InventoryRow[]): string[] {
  const output: string[] = [];
  const expected = expectedProfit(totals);
  // 1. 亏损的款：单款预期毛利亏 $10 以上，写出它与其余款的合计。
  const losers = skus.filter((row) => row.expectedProfit !== null && row.expectedProfit <= -10).sort((a, b) => (a.expectedProfit ?? 0) - (b.expectedProfit ?? 0));
  if (losers.length && expected !== null) {
    const worst = losers[0]!;
    const rest = r2(expected - (worst.expectedProfit ?? 0));
    const others = skus.filter((row) => row.sku !== worst.sku && (row.units > 0 || (row.adSpend ?? 0) > 0)).length;
    output.push(`⚠ ${worst.clearance ? "清货款 " : ""}${worst.sku} 亏 ${money(-(worst.expectedProfit ?? 0))}，其余 ${others} 款合计 ${signedMoney(rest)}`);
  } else if (expected !== null && expected < 0) {
    output.push(`⚠ 预期毛利为负（${money(expected)}）：广告花费占销售金额 ${pctText(ratio(totals.ads?.spend, totals.sales?.sales))}`);
  }
  // 2. 销售金额较对比期变化 ≥ 15%：写出贡献最大的两款。
  const sales = totals.sales?.sales ?? null, prevSales = compare?.totals.sales?.sales ?? null;
  if (compare && sales !== null && prevSales !== null && prevSales >= 50) {
    const pct = (sales - prevSales) / prevSales;
    if (Math.abs(pct) >= 0.15) {
      const movers = skus.filter((row) => row.unitsDiff !== null && row.unitsDiff !== 0).sort((a, b) => Math.sign(pct) * ((b.unitsDiff ?? 0) - (a.unitsDiff ?? 0))).slice(0, 2);
      output.push(`销售金额${compare.label} ${signedPct(pct)}（${signedMoney(r2(sales - prevSales))}）${movers.length ? `，主要来自 ${movers.map((row) => `${row.sku}（${(row.unitsDiff ?? 0) > 0 ? "+" : ""}${row.unitsDiff} 件）`).join("、")}` : ""}`);
    }
  }
  // 3. TACOS 较对比期升高 ≥ 2 个百分点。
  const tacos = ratio(totals.ads?.spend, totals.sales?.sales), prevTacos = compare ? ratio(compare.totals.ads?.spend, compare.totals.sales?.sales) : null;
  if (tacos !== null && prevTacos !== null && tacos - prevTacos >= 0.02) output.push(`TACOS ${pctText(tacos)}，${compare!.label} +${((tacos - prevTacos) * 100).toFixed(1)} 个百分点`);
  // 4. 退款率高于近期均值 1.5 倍且至少 2 件。
  const refunds = totals.traffic?.unitsRefunded ?? null, rate = totals.traffic?.refundRate ?? null;
  if (refunds !== null && refunds >= 2 && rate !== null && trailingRefundRate !== null && rate / 100 >= trailingRefundRate * 1.5) output.push(`退款 ${refunds} 件（${(rate).toFixed(1)}%），高于近期均值 ${pctText(trailingRefundRate)}`);
  // 5. 转化率较对比期变化 ≥ 20%（会话 ≥ 100）。
  const conversion = totals.traffic?.unitSessionPct ?? null, prevConversion = compare?.totals.traffic?.unitSessionPct ?? null;
  if (compare && conversion !== null && prevConversion !== null && prevConversion > 0 && (totals.traffic?.sessions ?? 0) >= 100 && Math.abs(conversion - prevConversion) / prevConversion >= 0.2) {
    output.push(`转化率 ${conversion.toFixed(1)}%，${compare.label} ${conversion > prevConversion ? "+" : "−"}${Math.abs(conversion - prevConversion).toFixed(1)} 个百分点（会话 ${totals.traffic!.sessions}）`);
  }
  // 6. FBA 可售不足 14 天。
  const short = inventory.filter((row) => row.days !== null && row.days < 14 && row.level !== "已停用").sort((a, b) => (a.days ?? 0) - (b.days ?? 0));
  if (short.length) output.push(`库存：${short.slice(0, 3).map((row) => `${row.sku} 可售 ${Math.round(row.days ?? 0)} 天`).join("、")}`);
  return output.slice(0, 4);
}

// ---------- 主函数 ----------

export function buildReportView(input: ReportInput): ReportView {
  const { period, today } = input;
  const yesterday = addDays(today, -1);
  const through = period.to < yesterday ? period.to : yesterday >= period.from ? yesterday : null;
  const inProgress = period.to > yesterday;
  // 月报、年报：整月用月汇总（去年同月、年报各月不逐天读），不完整的月逐天合计。
  const rollups = period.type === "year" || period.type === "month";
  const current = through ? totalsFor(input, period.from, through, rollups) : sumDays([]);
  const dayList = through ? daysIn(input, period.from, through) : [];
  const currency = current.sales?.currency || "USD";
  const empty = current.days === 0;

  // 对比期必须每天都有数据：报告刚开始有数时，对比期往往只有部分天数，拿来比会得出 +150% 这种假象，宁可不比。
  const compareList = through ? comparisons(period, through).map((item) => ({ ...item, totals: totalsFor(input, item.from, item.to, rollups) })).filter((item) => item.totals.days > 0 && item.totals.days === daysBetween(item.from, item.to) + 1) : [];
  // 日报的要点与商品件数变化按“上周同日”比（消除周几的差异），其余按上一期。
  const primary = compareList.find((item) => item.key === "lastWeek") ?? compareList[0] ?? null;

  // 5 个核心数
  const anyEstimate = (current.ads?.estimateDays ?? 0) > 0;
  const kpis: KpiCell[] = (["units", "sales", "orderProfit", "adSpend", "expectedProfit"] as KpiKey[]).map((key) => {
    const value = kpiValue(current, key);
    const estimate = (key === "adSpend" || key === "expectedProfit") && anyEstimate;
    let note = "";
    if (key === "orderProfit" && current.lines) note = current.lines.estimatedLines ? `${current.lines.lines - current.lines.estimatedLines}/${current.lines.lines} 行费用已到账，其余按成本表预估` : "费用全部到账";
    if (key === "adSpend" && current.ads) note = anyEstimate ? `含 ${current.ads.estimateDays} 天预算表估算（报表到后自动换成实际值）` : "SP 广告报表";
    if (key === "expectedProfit" && value !== null && current.sales?.sales) note = `毛利率 ${pctText(value / current.sales.sales)}`;
    return {
      key, label: KPI_LABELS[key], value, format: key === "units" ? "int" : "usd", estimate, note,
      compare: compareList.map((item) => { const prev = kpiCovered(item.totals, key) ? kpiValue(item.totals, key) : null; return { label: item.label, prev, diff: value === null || prev === null ? null : r2(value - prev), pct: key === "expectedProfit" ? null : change(value, prev) }; }),
    };
  });

  // 其它常用指标
  const sessions = current.traffic?.sessions ?? null;
  const metric = (key: string, label: string, value: number | null, format: MetricCell["format"], prevOf?: (totals: PeriodTotals) => number | null, note?: string): MetricCell => ({
    key, label, value, format, ...(note ? { note } : {}),
    ...(prevOf ? { compare: compareList.map((item) => { const prev = prevOf(item.totals); return { label: item.label, prev, diff: value === null || prev === null ? null : r2(value - prev), pct: format === "pct" || format === "pp" ? null : change(value, prev) }; }) } : {}),
  });
  const aov = (totals: PeriodTotals): number | null => totals.sales && totals.sales.orders ? r2(totals.sales.sales / totals.sales.orders) : null;
  const metrics: MetricCell[] = [
    metric("orders", "订单数", current.sales?.orders ?? null, "int", (totals) => totals.sales?.orders ?? null),
    metric("aov", "客单价", aov(current), "usd", aov),
    metric("sessions", "会话", sessions, "int", (totals) => totals.traffic?.sessions ?? null, current.traffic ? (period.type === "day" ? "" : `${current.coverage.traffic} 天`) : "亚马逊次日出数"),
    metric("conversion", "转化率", current.traffic?.unitSessionPct === undefined || current.traffic?.unitSessionPct === null ? null : current.traffic.unitSessionPct / 100, "pct", (totals) => totals.traffic?.unitSessionPct === undefined || totals.traffic?.unitSessionPct === null ? null : totals.traffic.unitSessionPct / 100),
    metric("tacos", "TACOS", ratio(current.ads?.spend, current.sales?.sales), "pct", (totals) => ratio(totals.ads?.spend, totals.sales?.sales)),
    metric("refunds", "退款件数", current.traffic?.unitsRefunded ?? null, "int", (totals) => totals.traffic?.unitsRefunded ?? null, current.traffic?.refundRate !== null && current.traffic?.refundRate !== undefined ? `退款率 ${current.traffic.refundRate.toFixed(1)}%` : ""),
  ];

  // 商品明细
  const compareSkus = primary?.totals.skus ?? {};
  const latestWithSkuAsins = [...dayList].reverse().find((day) => day.skuAsins);
  const skuAsins = latestWithSkuAsins?.skuAsins ?? {};
  const clearance = new Set([...dayList].reverse().find((day) => day.clearanceSkus)?.clearanceSkus ?? []);
  const asinOwners = new Map<string, string[]>();
  for (const [sku, asin] of Object.entries(skuAsins)) asinOwners.set(asin, [...(asinOwners.get(asin) ?? []), sku]);
  const lastInventoryDay = [...dayList].reverse().find((day) => day.inventory);
  const inventoryRows: InventoryRow[] = lastInventoryDay ? Object.entries(lastInventoryDay.inventory!).map(([sku, part]: [string, InventoryPart]) => ({ sku, title: input.catalog?.[sku]?.title ?? "", fba: part.fbaAvailable, inbound: part.inbound, awd: part.awd, days: part.daysOfCover, level: part.level })).sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999)) : [];
  const totalSales = current.lines?.revenue ?? 0;
  const skuKeys = new Set([...Object.keys(current.skus), ...Object.keys(compareSkus)]);
  const skus: SkuRow[] = [...skuKeys].map((sku) => {
    const part = current.skus[sku];
    const asin = skuAsins[sku] ?? input.catalog?.[sku]?.asin ?? "";
    const traffic = asin ? current.asinTraffic?.[asin] : undefined;
    const prevUnits = compareSkus[sku]?.units ?? (primary ? 0 : null);
    const adSpend = part?.adSpend ?? null;
    const units = part?.units ?? 0, sales = part?.revenue ?? 0, profit = part?.profit ?? 0;
    return {
      sku, asin, title: input.catalog?.[sku]?.title ?? "", image: input.catalog?.[sku]?.image ?? "", clearance: clearance.has(sku),
      units, sales, share: totalSales > 0 ? sales / totalSales : null, promo: part?.promo ?? 0, orderProfit: profit,
      adSpend, adSales: part?.adSales ?? null, acos: ratio(adSpend, part?.adSales ?? null), tacos: ratio(adSpend, sales),
      expectedProfit: part ? r2(profit - (adSpend ?? 0)) : adSpend !== null ? r2(-adSpend) : null, margin: sales > 0 ? (profit - (adSpend ?? 0)) / sales : null,
      sessions: traffic ? traffic.sessions : null, conversion: traffic && traffic.sessions ? traffic.units / traffic.sessions : null, sharedAsin: (asinOwners.get(asin)?.length ?? 0) > 1,
      refundUnits: part?.refundUnits ?? 0, unitsDiff: prevUnits === null ? null : units - prevUnits,
      estimatedLines: part?.estimatedLines ?? 0, costMissing: part?.costMissing ?? 0, adEstimate: part?.adEstimate ?? false,
    };
  }).filter((row) => row.units > 0 || (row.adSpend ?? 0) > 0 || row.unitsDiff !== 0).sort((a, b) => b.sales - a.sales || (b.adSpend ?? 0) - (a.adSpend ?? 0));

  // 利润拆解
  const lines = current.lines;
  let waterfall: ReportView["waterfall"] = null;
  if (lines) {
    const steps: WaterfallStep[] = [
      { label: "销售金额（订单行）", value: lines.revenue, kind: "start" }, { label: "促销折扣", value: -lines.promo, kind: "minus" },
      { label: "亚马逊佣金", value: -lines.commission, kind: "minus" }, { label: "FBA 配送费", value: -lines.fba, kind: "minus" },
      { label: "商品成本", value: -lines.cogs, kind: "minus", note: "采购、头程、国内物流、杂项、耗材" }, { label: "按件仓储费", value: -lines.storageEst, kind: "minus", note: "毛利润预估的按件预估，按下单月份费率" },
      { label: "订单毛利", value: lines.profit, kind: "result" },
    ];
    if (current.ads) steps.push({ label: anyEstimate ? "广告花费（含估算）" : "广告花费", value: -current.ads.spend, kind: "minus" }, { label: "预期毛利", value: r2(lines.profit - current.ads.spend), kind: "result" });
    const notes: string[] = [];
    if (current.sales && Math.abs(current.sales.sales - lines.revenue) >= 0.01) notes.push(`订单行合计与亚马逊销售接口相差 ${signedMoney(r2(lines.revenue - current.sales.sales))}（待处理订单价格、换货单等）`);
    if (lines.costMissingLines) notes.push(`${lines.costMissingLines} 行缺成本参数，未计入`);
    waterfall = { steps, note: notes.join("；") };
  }

  // 流量、广告、退款
  const traffic: MetricCell[] | null = current.traffic ? [
    metric("sessions", "会话", current.traffic.sessions, "int", (totals) => totals.traffic?.sessions ?? null),
    metric("pageViews", "页面浏览", current.traffic.pageViews, "int", (totals) => totals.traffic?.pageViews ?? null),
    metric("conversion", "转化率", current.traffic.unitSessionPct === null ? null : current.traffic.unitSessionPct / 100, "pct", (totals) => totals.traffic?.unitSessionPct === undefined || totals.traffic?.unitSessionPct === null ? null : totals.traffic.unitSessionPct / 100),
    metric("buyBox", "购物车占比", current.traffic.buyBoxPct === null ? null : current.traffic.buyBoxPct / 100, "pct", (totals) => totals.traffic?.buyBoxPct === undefined || totals.traffic?.buyBoxPct === null ? null : totals.traffic.buyBoxPct / 100),
    metric("shipped", "发货件数", current.traffic.unitsShipped, "int"),
    metric("feedback", "买家反馈", current.traffic.feedback, "int", undefined, current.traffic.negativeFeedback !== null ? `差评 ${current.traffic.negativeFeedback}` : ""),
  ] : null;
  const adsTotals = current.ads;
  const ads: MetricCell[] | null = adsTotals ? [
    metric("spend", anyEstimate ? "花费（含估算）" : "花费", adsTotals.spend, "usd", (totals) => totals.ads?.spend ?? null),
    metric("adSales", "广告销售额", current.coverage.adsReport ? adsTotals.sales : null, "usd", (totals) => totals.coverage.adsReport ? totals.ads?.sales ?? null : null, "7 天归因，之后几天还会涨"),
    metric("adOrders", "广告订单", current.coverage.adsReport ? adsTotals.orders : null, "int", (totals) => totals.coverage.adsReport ? totals.ads?.orders ?? null : null),
    metric("acos", "ACOS", current.coverage.adsReport ? ratio(adsTotals.spend, adsTotals.sales) : null, "pct", (totals) => totals.coverage.adsReport ? ratio(totals.ads?.spend, totals.ads?.sales) : null),
    metric("tacos", "TACOS", ratio(adsTotals.spend, current.sales?.sales), "pct", (totals) => ratio(totals.ads?.spend, totals.sales?.sales)),
    metric("roas", "ROAS", current.coverage.adsReport ? ratio(adsTotals.sales, adsTotals.spend) : null, "int"),
    metric("impressions", "曝光", current.coverage.adsReport ? adsTotals.impressions : null, "int", (totals) => totals.coverage.adsReport ? totals.ads?.impressions ?? null : null),
    metric("clicks", "点击", current.coverage.adsReport ? adsTotals.clicks : null, "int", (totals) => totals.coverage.adsReport ? totals.ads?.clicks ?? null : null),
    metric("cpc", "CPC", current.coverage.adsReport ? ratio(adsTotals.spend, adsTotals.clicks) : null, "usd"),
    metric("ctr", "CTR", current.coverage.adsReport ? ratio(adsTotals.clicks, adsTotals.impressions) : null, "pct"),
    metric("adCvr", "广告转化率", current.coverage.adsReport ? ratio(adsTotals.orders, adsTotals.clicks) : null, "pct"),
    metric("adShare", "广告订单占比", current.coverage.adsReport ? ratio(adsTotals.orders, current.sales?.orders ?? null) : null, "pct", undefined, current.sales && current.coverage.adsReport ? `自然订单约 ${Math.max(0, current.sales.orders - adsTotals.orders)}` : ""),
  ] : null;
  const reasons = dayList.flatMap((day) => day.reasons ?? []).slice(0, 12);
  const refunds = current.refunds || current.traffic ? { metrics: [
    metric("units", "退款件数（业务报告）", current.traffic?.unitsRefunded ?? null, "int", (totals) => totals.traffic?.unitsRefunded ?? null, current.traffic?.refundRate !== null && current.traffic?.refundRate !== undefined ? `退款率 ${current.traffic.refundRate.toFixed(1)}%` : ""),
    metric("events", "退款笔数（退款明细）", current.refunds?.events ?? null, "int"),
    metric("principal", "退给买家（不含税）", current.refunds ? current.refunds.principal : null, "usd"),
    metric("feeBack", "退回费用", current.refunds ? current.refunds.feeBack : null, "usd", undefined, "退回的佣金减退款手续费"),
    metric("promoBack", "冲回促销", current.refunds ? current.refunds.promoBack : null, "usd"),
    metric("loss", "净退款损失", current.refunds ? current.refunds.loss : null, "usd", (totals) => totals.refunds?.loss ?? null, "退回可售的货值未加回（偏保守）"),
  ], reasons } : null;

  // 趋势与逐日/逐月表
  const trendUnit: "day" | "week" | "month" = period.type === "day" || period.type === "month" ? "day" : period.type === "week" ? "week" : "month";
  const trendPeriods: Period[] = period.type === "day" ? Array.from({ length: 14 }, (_, index) => periodOf("day", addDays(period.from, index - 13)))
    : period.type === "week" ? Array.from({ length: 8 }, (_, index) => shiftPeriod(period, index - 7))
    : period.type === "month" ? periodDays(period).map((date) => periodOf("day", date))
    : Array.from({ length: 12 }, (_, index) => periodOf("month", `${period.key}-${String(index + 1).padStart(2, "0")}-01`));
  const pointOf = (item: Period): TrendPoint => {
    const last = item.to < yesterday ? item.to : yesterday;
    const totals = last >= item.from ? totalsFor(input, item.from, last, item.type === "month") : sumDays([]);
    const label = item.type === "day" ? `${Number(item.key.slice(5, 7))}/${Number(item.key.slice(8, 10))}` : item.type === "week" ? `W${item.key.slice(6)}` : `${Number(item.key.slice(5, 7))}月`;
    return { key: item.key, label, sales: totals.sales?.sales ?? null, expectedProfit: expectedProfit(totals), adSpend: totals.ads?.spend ?? null, units: totals.sales?.units ?? null, current: item.key === period.key, partial: last < item.to && last >= item.from };
  };
  const trend = { unit: trendUnit, points: trendPeriods.filter((item) => item.from <= yesterday).map(pointOf) };
  const rowPeriods: Period[] = period.type === "week" || period.type === "month" ? periodDays(period, through ?? period.from).filter(() => !!through).map((date) => periodOf("day", date))
    : period.type === "year" ? Array.from({ length: 12 }, (_, index) => periodOf("month", `${period.key}-${String(index + 1).padStart(2, "0")}-01`)).filter((item) => item.from <= yesterday) : [];
  const rows: TableRow[] = rowPeriods.map((item) => {
    const last = item.to < yesterday ? item.to : yesterday;
    const totals = totalsFor(input, item.from, last, item.type === "month");
    const day = item.type === "day" ? input.days.get(item.key) : undefined;
    const month = item.type === "month" ? input.months.get(item.key) : undefined;
    return {
      key: item.key, label: item.type === "day" ? `${item.key.slice(5)} ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(`${item.key}T00:00:00Z`).getUTCDay()]}` : `${Number(item.key.slice(5, 7))} 月`,
      units: totals.sales?.units ?? null, orders: totals.sales?.orders ?? null, sales: totals.sales?.sales ?? null, orderProfit: totals.lines?.profit ?? null, adSpend: totals.ads?.spend ?? null,
      adEstimate: (totals.ads?.estimateDays ?? 0) > 0, expectedProfit: expectedProfit(totals), sessions: totals.traffic?.sessions ?? null,
      conversion: totals.traffic?.unitSessionPct === undefined || totals.traffic?.unitSessionPct === null ? null : totals.traffic.unitSessionPct / 100, refundUnits: totals.traffic?.unitsRefunded ?? null,
      status: day ? (day.status === "final" ? "已定稿" : "未定稿") : month ? (month.status === "final" ? "已定稿" : "未定稿") : totals.days ? "" : "无数据",
    };
  });

  // 店铺费用与净利润（月、年）
  const monthKeys: string[] = period.type === "month" ? [period.key] : period.type === "year" ? Array.from({ length: 12 }, (_, index) => `${period.key}-${String(index + 1).padStart(2, "0")}`).filter((month) => `${month}-01` <= yesterday) : [];
  const monthList = monthKeys.map((key) => input.months.get(key)).filter((item): item is MonthFacts => !!item);
  const fees = monthKeys.length ? feeView(monthList, today) : null;
  const net = fees ? netView(current, fees) : null;

  // 本期动态（系统已发出的业务消息）
  const fromMs = Date.parse(zonedMidnight(period.from, "America/Los_Angeles")), toMs = Date.parse(zonedMidnight(addDays(period.to, 1), "America/Los_Angeles"));
  const periodEvents = (input.events ?? []).filter((item) => { const at = Date.parse(item.at); return at >= fromMs && at < toMs; });
  const counts = new Map<string, number>();
  for (const item of periodEvents) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const events = input.events ? { counts: [...counts].map(([kind, count]) => ({ kind, label: EVENT_LABELS[kind] ?? kind, count })).sort((a, b) => b.count - a.count), items: periodEvents.sort((a, b) => b.at.localeCompare(a.at)).slice(0, period.type === "year" ? 0 : 20) } : null;

  // 状态
  const allFinal = !inProgress && dayList.length > 0 && dayList.every((day) => day.status === "final") && (period.type === "day" || period.type === "week" || monthList.every((month) => month.status === "final"));
  const details: string[] = [];
  if (anyEstimate) details.push("广告花费含预算表估算，报表到后（洛杉矶约 01:45）自动换成实际值");
  if (lines?.estimatedLines) details.push(`${lines.estimatedLines}/${lines.lines} 行订单费用未到账，按毛利润预估估算（历史上与实际差约 0.3%），促销折扣已按订单报告实扣`);
  if (period.type !== "year" && through && !current.traffic) details.push("会话与转化：亚马逊次日出数");
  if (fees?.storagePending.length) details.push(fees.storagePending.join("；"));
  if (inProgress && through) details.push(`进行中：截至 ${through}（洛杉矶），对比上一期的同样天数`);
  const finalDate = period.type === "day" || period.type === "week" ? addDays(period.to, 21) : `${shiftMonth(period.to.slice(0, 7), 1)}-22`;
  if (!allFinal && !inProgress) details.push(`${finalDate} 定稿，之后数字不再变化`);
  const status = allFinal ? { label: "已定稿", tone: "final" as const, details } : { label: anyEstimate ? "初版（广告为估算）" : "未定稿", tone: anyEstimate ? "estimate" as const : "draft" as const, details };

  // 核对
  const checks: string[] = [];
  if (period.type === "day" && dayList[0]?.checks) {
    const check = dayList[0].checks;
    if (check.reportLines !== null) checks.push(`订单报告 ${check.reportLines} 行、飞书订单表 ${check.feishuLines} 行，逐行对上 ${check.matched} 行${lines?.missingInFeishu ? `；飞书缺 ${lines.missingInFeishu} 行（已按成本表估算）` : ""}${lines?.missingInReport ? `；报告缺 ${lines.missingInReport} 行` : ""}`);
    if (check.salesVsLines !== null) checks.push(Math.abs(check.salesVsLines) < 0.01 ? "销售接口与订单行金额一致" : `销售接口与订单行相差 ${signedMoney(check.salesVsLines)}`);
    if (check.kioskVsSales !== null) checks.push(Math.abs(check.kioskVsSales) < 0.01 ? "业务报告销售额与销售接口一致" : `业务报告销售额与销售接口相差 ${signedMoney(check.kioskVsSales)}`);
  }
  if (lines?.duplicateKeys) checks.push(`飞书订单表有 ${lines.duplicateKeys} 组重复行（按订单报告计算）`);
  if (current.other) checks.push(`多渠道配送单 ${current.other.lines} 单 ${current.other.units} 件、按售价约 ${money(current.other.sales)}，不计入 5 个数`);
  if (current.coverage.sales && current.days > current.coverage.sales) checks.push(`销售数据只含 ${current.coverage.sales} 天`);
  if (period.type !== "day" && current.days && current.coverage.lines < current.days) checks.push(`订单毛利只含 ${current.coverage.lines} 天（其余日子飞书订单表没有逐单数据）`);
  if (period.type !== "day" && current.days && current.coverage.ads < current.days) checks.push(`广告只含 ${current.coverage.ads} 天（其余日子广告每日总览没有数据）${fees?.adsInvoice ? `；同期广告扣款 ${money(-fees.adsInvoice)}（按扣款日）` : ""}`);

  // 导航
  const latest = input.meta?.latest ?? yesterday;
  const earliest = input.meta?.earliest ?? null;
  const prev = shiftPeriod(period, -1), next = shiftPeriod(period, 1);
  const anchor = through ?? period.to;
  const switchTo = Object.fromEntries((["day", "week", "month", "year"] as ReportType[]).map((type) => [type, periodOf(type, anchor > latest ? latest : anchor).key])) as Record<ReportType, string>;
  const options: Array<{ key: string; label: string }> = [];
  for (let item = periodOf(period.type, latest), count = 0; count < (period.type === "day" ? 0 : period.type === "week" ? 26 : period.type === "month" ? 24 : 5) && (!earliest || item.to >= earliest); item = shiftPeriod(item, -1), count += 1) options.push({ key: item.key, label: periodLabel(item) });

  const trailingRefund = (() => {
    const window = [...input.days.values()].filter((day) => day.traffic && day.date < period.from && day.date >= addDays(period.from, -30));
    const units = window.reduce((sum, day) => sum + (day.traffic?.unitsRefunded ?? 0), 0), ordered = window.reduce((sum, day) => sum + (day.traffic?.unitsOrdered ?? 0), 0);
    return ordered > 0 && window.length >= 7 ? units / ordered : null;
  })();

  return {
    type: period.type, typeName: TYPE_NAMES[period.type], key: period.key, from: period.from, to: period.to, label: periodLabel(period), shortLabel: periodShortLabel(period),
    through, inProgress, empty, currency, status,
    updatedAt: dayList.map((day) => day.computedAt).sort().at(-1) ?? null,
    nav: { prev: prev.to >= (earliest ?? "0000") ? prev.key : null, next: next.from <= latest ? next.key : null, earliest, latest, switchTo, options },
    kpis, metrics, highlights: highlights(current, primary ? { label: primary.label, totals: primary.totals } : null, skus, trailingRefund, inventoryRows),
    waterfall, traffic, ads, refunds, other: current.other ?? null, skus, unattributedAds: current.unattributedAds?.spend ?? null,
    trend, rows, fees, net,
    inventory: lastInventoryDay && (period.type === "month" || period.type === "year" || period.type === "week") ? { at: lastInventoryDay.inventoryAt ?? lastInventoryDay.date, rows: inventoryRows } : null,
    events, checks,
  };
}

// ---------- 飞书消息（与页面同一份数字） ----------

export interface ReportMessage { title: string; lines: string[]; linkText: string }
const fmtUsd = (value: number | null, estimate = false): string => value === null ? "—" : `${estimate ? "≈" : ""}${money(value)}`;

export function buildMessage(view: ReportView, kind: "draft" | "final" = "draft"): ReportMessage {
  const kpi = (key: KpiKey): KpiCell => view.kpis.find((item) => item.key === key)!;
  const units = kpi("units"), sales = kpi("sales"), order = kpi("orderProfit"), ad = kpi("adSpend"), expected = kpi("expectedProfit");
  const margin = expected.value !== null && sales.value ? `（毛利率 ${pctText(expected.value / sales.value)}）` : "";
  const head = view.type === "day" ? `📊 日报已生成｜${view.shortLabel}（洛杉矶）`
    : view.type === "week" ? `📊 周报已生成｜${view.shortLabel}`
    : kind === "final" ? `📊 ${view.typeName}已定稿｜${view.shortLabel}` : `📊 ${view.typeName}已生成（初版）｜${view.shortLabel}`;
  const lines = [
    `销售数量 ${units.value === null ? "—" : units.value}　销售金额 ${fmtUsd(sales.value)}`,
    `订单毛利 ${fmtUsd(order.value)}　广告花费 ${fmtUsd(ad.value, ad.estimate)}${ad.estimate ? "（估）" : ""}`,
    `预期毛利 ${fmtUsd(expected.value, expected.estimate)}${margin}`,
  ];
  const compare = view.type === "day" ? sales.compare.find((item) => item.label === "较上周同日") ?? sales.compare[0] : sales.compare[0];
  if (compare && compare.pct !== null) {
    const expectedCompare = expected.compare.find((item) => item.label === compare.label);
    lines.push(`${compare.label}：销售金额 ${signedPct(compare.pct)}${expectedCompare?.diff !== null && expectedCompare?.diff !== undefined ? `，预期毛利 ${signedMoney(expectedCompare.diff)}` : ""}`);
  }
  if (view.net) lines.push(view.net.netProfit !== null ? `净利润（估）${money(view.net.netProfit)}` : `净利润：${view.net.pendingNote}`);
  if (view.highlights[0]) lines.push(view.highlights[0]);
  const linkText = `查看${view.typeName} ›${ad.estimate && view.type === "day" ? "（约 1.5 小时后广告换成实际值）" : ""}`;
  return { title: head, lines, linkText };
}

// 月报定稿消息：与初版快照对比净利润变化。
export function finalNote(firstDraft: MonthFacts["firstDraft"], view: ReportView): string {
  const now = view.net?.netProfit ?? null;
  if (!firstDraft || now === null) return "";
  const before = firstDraft.netProfit ?? firstDraft.expectedProfit;
  return before === null ? "" : `较初版 ${signedMoney(r2(now - before))}`;
}
