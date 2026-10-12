import type { AsinTraffic, CoverageKey, DayFacts, LinePart, OtherChannelPart, PeriodTotals, RefundPart, SalesPart, SkuDay, TrafficPart } from "./types.js";

// 多天合计：金额按分累加并保留两位小数；比率（购物车占比按页面浏览加权、转化率＝订购件数÷会话、退款率＝退款件数÷订购件数）由合计重算，不平均百分比。
export const r2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const add = (a: number | undefined, b: number | undefined): number => r2((a ?? 0) + (b ?? 0));
const addNullable = (a: number | null | undefined, b: number | null | undefined): number | null => a === null || a === undefined ? (b ?? null) : b === null || b === undefined ? a : r2(a + b);

export function emptyTotals(): PeriodTotals {
  return { days: 0, coverage: { sales: 0, lines: 0, ads: 0, adsReport: 0, traffic: 0, refunds: 0 }, skus: {} };
}

function addSales(into: SalesPart | undefined, part: SalesPart): SalesPart {
  if (!into) return { ...part };
  return {
    units: into.units + part.units, orders: into.orders + part.orders, sales: add(into.sales, part.sales), currency: into.currency || part.currency,
    ...(into.b2bSales !== undefined || part.b2bSales !== undefined ? { b2bSales: add(into.b2bSales, part.b2bSales), b2bUnits: (into.b2bUnits ?? 0) + (part.b2bUnits ?? 0) } : {}),
  };
}

const LINE_SUMS: Array<keyof LinePart> = ["lines", "units", "revenue", "promo", "commission", "fba", "cogs", "storageEst", "profit", "estimatedLines", "costMissingLines", "costMissingUnits", "missingInFeishu", "missingInReport", "duplicateKeys"];
function addLines(into: LinePart | undefined, part: LinePart): LinePart {
  if (!into) return { ...part };
  const output = { ...into };
  for (const key of LINE_SUMS) output[key] = add(into[key], part[key]);
  return output;
}

function weighted(a: number | null, aw: number, b: number | null, bw: number): number | null {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return aw + bw > 0 ? r2((a * aw + b * bw) / (aw + bw)) : r2((a + b) / 2);
}
const pctOf = (top: number, bottom: number): number | null => bottom > 0 ? r2((top / bottom) * 100) : null;

export function addTraffic(into: TrafficPart | undefined, part: TrafficPart): TrafficPart {
  if (!into) return { ...part };
  const sessions = into.sessions + part.sessions, unitsOrdered = into.unitsOrdered + part.unitsOrdered;
  const unitsRefunded = addNullable(into.unitsRefunded, part.unitsRefunded);
  return {
    sessions, pageViews: into.pageViews + part.pageViews, buyBoxPct: weighted(into.buyBoxPct, into.pageViews, part.buyBoxPct, part.pageViews),
    unitSessionPct: pctOf(unitsOrdered, sessions), unitsOrdered, orderedSales: add(into.orderedSales, part.orderedSales),
    unitsRefunded, refundRate: unitsRefunded === null ? null : pctOf(unitsRefunded, unitsOrdered),
    unitsShipped: addNullable(into.unitsShipped, part.unitsShipped), shippedSales: addNullable(into.shippedSales, part.shippedSales),
    feedback: addNullable(into.feedback, part.feedback), negativeFeedback: addNullable(into.negativeFeedback, part.negativeFeedback),
  };
}

function addRefunds(into: RefundPart | undefined, part: RefundPart): RefundPart {
  if (!into) return { ...part };
  return { events: into.events + part.events, units: into.units + part.units, principal: add(into.principal, part.principal), feeBack: add(into.feeBack, part.feeBack), promoBack: add(into.promoBack, part.promoBack), loss: add(into.loss, part.loss), nonUsd: into.nonUsd + part.nonUsd };
}

function addOther(into: OtherChannelPart | undefined, part: OtherChannelPart): OtherChannelPart {
  if (!into) return { ...part };
  return { lines: into.lines + part.lines, units: into.units + part.units, sales: add(into.sales, part.sales), profit: add(into.profit, part.profit) };
}

const SKU_SUMS: Array<keyof SkuDay> = ["units", "revenue", "promo", "commission", "fba", "cogs", "storageEst", "profit", "lines", "estimatedLines", "costMissing"];
const SKU_OPTIONAL: Array<keyof SkuDay> = ["adSpend", "adSales", "adOrders", "adClicks", "adImpressions", "refundUnits", "refundLoss"];
export function addSku(into: SkuDay | undefined, part: SkuDay): SkuDay {
  if (!into) return { ...part };
  const output: SkuDay = { ...into };
  for (const key of SKU_SUMS) (output[key] as number) = add(into[key] as number, part[key] as number);
  for (const key of SKU_OPTIONAL) if (into[key] !== undefined || part[key] !== undefined) (output[key] as number) = add(into[key] as number | undefined, part[key] as number | undefined);
  if (into.adEstimate || part.adEstimate) output.adEstimate = true;
  return output;
}

function addAsin(into: AsinTraffic | undefined, part: AsinTraffic): AsinTraffic {
  if (!into) return { ...part };
  const sessions = into.sessions + part.sessions, units = into.units + part.units;
  return { sessions, pageViews: into.pageViews + part.pageViews, buyBoxPct: weighted(into.buyBoxPct, into.pageViews, part.buyBoxPct, part.pageViews), unitSessionPct: pctOf(units, sessions), units, sales: add(into.sales, part.sales) };
}

type Mergeable = Pick<PeriodTotals, "sales" | "lines" | "traffic" | "refunds" | "other" | "unattributedAds" | "asinTraffic"> & { skus?: Record<string, SkuDay>; days?: number; coverage?: Partial<Record<CoverageKey, number>> };

// 把一批天（或月汇总）合进 total；同一天只能出现一次（由调用方保证）。
function merge(total: PeriodTotals, item: Mergeable, single: boolean): void {
  total.days += single ? 1 : item.days ?? 0;
  const bump = (key: CoverageKey, present: boolean, count = 1): void => { if (present) total.coverage[key] += single ? 1 : count; };
  if (item.sales) { total.sales = addSales(total.sales, item.sales); bump("sales", true, item.coverage?.sales); }
  if (item.lines) { total.lines = addLines(total.lines, item.lines); bump("lines", true, item.coverage?.lines); }
  if (item.traffic) { total.traffic = addTraffic(total.traffic, item.traffic); bump("traffic", true, item.coverage?.traffic); }
  if (item.refunds) { total.refunds = addRefunds(total.refunds, item.refunds); bump("refunds", true, item.coverage?.refunds); }
  if (item.other) total.other = addOther(total.other, item.other);
  for (const [sku, part] of Object.entries(item.skus ?? {})) total.skus[sku] = addSku(total.skus[sku], part);
  if (item.unattributedAds) total.unattributedAds = { spend: add(total.unattributedAds?.spend, item.unattributedAds.spend), sales: add(total.unattributedAds?.sales, item.unattributedAds.sales), orders: (total.unattributedAds?.orders ?? 0) + item.unattributedAds.orders };
  for (const [asin, part] of Object.entries(item.asinTraffic ?? {})) (total.asinTraffic ??= {})[asin] = addAsin(total.asinTraffic?.[asin], part);
}

export function sumDays(days: DayFacts[]): PeriodTotals {
  const total = emptyTotals();
  for (const day of days) {
    merge(total, day, true);
    if (day.ads) {
      const ads = (total.ads ??= { spend: 0, sales: 0, orders: 0, units: 0, impressions: 0, clicks: 0, estimateDays: 0 });
      ads.spend = add(ads.spend, day.ads.spend);
      ads.sales = add(ads.sales, day.ads.sales); ads.orders += day.ads.orders ?? 0; ads.units += day.ads.units ?? 0; ads.impressions += day.ads.impressions ?? 0; ads.clicks += day.ads.clicks ?? 0;
      if (day.ads.source === "estimate") ads.estimateDays += 1;
      total.coverage.ads += 1;
      if (day.ads.source === "report") total.coverage.adsReport += 1;
    }
  }
  return total;
}

// 月汇总合成年：直接累加各月的合计与覆盖天数。
export function sumTotals(list: PeriodTotals[]): PeriodTotals {
  const total = emptyTotals();
  for (const item of list) {
    merge(total, item, false);
    if (item.ads) {
      const ads = (total.ads ??= { spend: 0, sales: 0, orders: 0, units: 0, impressions: 0, clicks: 0, estimateDays: 0 });
      ads.spend = add(ads.spend, item.ads.spend); ads.sales = add(ads.sales, item.ads.sales); ads.orders += item.ads.orders; ads.units += item.ads.units;
      ads.impressions += item.ads.impressions; ads.clicks += item.ads.clicks; ads.estimateDays += item.ads.estimateDays;
    }
    total.coverage.ads += item.coverage.ads; total.coverage.adsReport += item.coverage.adsReport;
  }
  return total;
}
