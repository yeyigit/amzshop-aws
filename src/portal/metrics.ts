import { addDaysYmd, feishuFieldText, zonedMidnight } from "../util.js";
import { SITE_ZONE, dayLabel, zonedParts } from "./clock.js";

// 店铺中台的纯计算：输入为各数据源的原始结果，输出为页面要展示的数字。全部无 IO，便于回归测试。
type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
const text = (value: unknown): string => feishuFieldText(value);
const num = (value: unknown): number | undefined => {
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === null || raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
const round = (value: number, digits = 2): number => Math.round(value * 10 ** digits) / 10 ** digits;

// ---------- 销售（Sales API 按小时） ----------

// 每个站点日 24 个小时桶，每桶 [件数, 订单数, 销售额]。秋季回拨那天同一钟点的两个桶相加，春季跳过的钟点为 0。
export interface SalesData { currency: string; days: Record<string, number[][]> }
export const METRIC = { units: 0, orders: 1, sales: 2 } as const;
export type MetricIndex = 0 | 1 | 2;

export function parseSalesBuckets(payload: unknown): SalesData {
  const days: Record<string, number[][]> = {};
  let currency = "";
  for (const row of rows(payload)) {
    const start = text(row.interval).split("--")[0] ?? "";
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(start);
    if (!match) continue;
    const day = match[1]!;
    const hour = Number(match[2]) % 24;
    const bucket = (days[day] ??= Array.from({ length: 24 }, () => [0, 0, 0]))[hour]!;
    const total = (row.totalSales ?? {}) as Row;
    bucket[0]! += num(row.unitCount) ?? 0;
    bucket[1]! += num(row.orderCount) ?? 0;
    bucket[2]! += num(total.amount) ?? 0;
    currency ||= text(total.currencyCode);
  }
  return { currency: currency || "USD", days };
}

export type PaceStatus = "early" | "fast" | "normal" | "slow" | "very-slow" | "unknown";
export interface PaceResult { value: number; avgSameTime: number | null; avgDay: number | null; share: number | null; pace: number | null; projection: number | null; yesterday: number | null; status: PaceStatus }

// 时间尚早（平时此刻不到全天 15%）时不判快慢、不给全天预估：样本太少，判断不可靠。
export const EARLY_SHARE = 0.15;
const MIN_HISTORY_DAYS = 3;

function hourlyAverage(data: SalesData, today: string, metric: MetricIndex): number[] | undefined {
  const history = [1, 2, 3, 4, 5, 6, 7].map((offset) => data.days[addDaysYmd(today, -offset)]).filter((day): day is number[][] => !!day);
  if (history.length < MIN_HISTORY_DAYS) return undefined;
  return Array.from({ length: 24 }, (_, hour) => sum(history.map((day) => day[hour]?.[metric] ?? 0)) / history.length);
}

export function paceFor(data: SalesData, today: string, nowHour: number, metric: MetricIndex): PaceResult {
  const current = data.days[today];
  const value = current ? sum(current.map((bucket) => bucket[metric] ?? 0)) : 0;
  const yesterdayBuckets = data.days[addDaysYmd(today, -1)];
  const yesterday = yesterdayBuckets ? sum(yesterdayBuckets.map((bucket) => bucket[metric] ?? 0)) : null;
  const average = hourlyAverage(data, today, metric);
  if (!average) return { value, avgSameTime: null, avgDay: null, share: null, pace: null, projection: null, yesterday, status: "unknown" };
  const hour = Math.min(23, Math.max(0, Math.floor(nowHour)));
  const fraction = Math.min(1, Math.max(0, nowHour - hour));
  const avgDay = sum(average);
  const avgSameTime = sum(average.slice(0, hour)) + (average[hour] ?? 0) * fraction;
  const share = avgDay > 0 ? avgSameTime / avgDay : null;
  const projection = share !== null && share >= EARLY_SHARE ? value / share : null;
  const pace = avgSameTime > 0 ? (value - avgSameTime) / avgSameTime : null;
  let status: PaceStatus = "unknown";
  if (avgDay > 0 && share !== null) {
    if (share < EARLY_SHARE) status = "early";
    else if (pace === null) status = "unknown";
    else if (pace >= 0.15) status = "fast";
    else if (pace >= -0.1) status = "normal";
    else if (pace >= -0.3) status = "slow";
    else status = "very-slow";
  }
  return { value, avgSameTime, avgDay, share, pace, projection, yesterday, status };
}

// 折线图：均值按整点累计 0..24 共 25 点；今天从 0 点到现在（最后一点是此刻累计）。
export function paceSeries(data: SalesData, today: string, nowHour: number, metric: MetricIndex = METRIC.sales): { avg: number[] | null; today: Array<[number, number]> } {
  const average = hourlyAverage(data, today, metric);
  const avg = average ? average.reduce<number[]>((points, value) => { points.push(points.at(-1)! + value); return points; }, [0]).map((value) => round(value)) : null;
  const current = data.days[today] ?? Array.from({ length: 24 }, () => [0, 0, 0]);
  const hour = Math.min(23, Math.max(0, Math.floor(nowHour)));
  const points: Array<[number, number]> = [];
  let running = 0;
  for (let boundary = 0; boundary <= hour; boundary += 1) {
    points.push([boundary, round(running)]);
    running += current[boundary]?.[metric] ?? 0;
  }
  points.push([Math.min(24, round(nowHour, 3)), round(running)]);
  return { avg, today: points };
}

export interface DailyPoint { date: string; label: string; units: number; orders: number; sales: number; partial: boolean }

// “销售额”格的小图：含今天在内共 7 天，与后台一致（10/08 用户指出原来画了 8 天）。“比近 7 日同一时刻”另用今天之前的 7 个完整日。
export const SPARK_DAYS = 7;

export function dailySeries(data: SalesData, today: string): DailyPoint[] {
  const output: DailyPoint[] = [];
  for (let offset = SPARK_DAYS - 1; offset >= 0; offset -= 1) {
    const date = addDaysYmd(today, -offset);
    const buckets = data.days[date];
    if (!buckets) continue;
    output.push({ date, label: offset === 0 ? "今天" : dayLabel(date), units: sum(buckets.map((bucket) => bucket[0] ?? 0)), orders: sum(buckets.map((bucket) => bucket[1] ?? 0)), sales: round(sum(buckets.map((bucket) => bucket[2] ?? 0))), partial: offset === 0 });
  }
  return output;
}

// ---------- 商品（飞书订单表近 31 天：今天 + 前 30 天） ----------

// 每个 SKU 按洛杉矶下单日的件数 u、金额 s、订单行数 o（与 days 一一对应，最后一格是今天）；pendingOrders 为待处理订单数（按订单号去重）。
export interface OrdersData { days: string[]; skus: Record<string, { u: number[]; s: number[]; o: number[]; last: string }>; pendingOrders: number }
const CANCELLED = /取消|cancel/i;
const PENDING = /待处理|pending/i;

// 订单表「金额」是用户公式（优先付款金额，空时按售价估算），查询接口返回 {type, value: [数]}；取不到再用「付款金额」，都没有记 0。
export function orderAmount(fields: Row): number {
  const formula = fields["金额"];
  const value = formula && typeof formula === "object" && !Array.isArray(formula) ? (formula as Row).value : formula;
  const first = Array.isArray(value) ? value[0] : value;
  return num(first) ?? num(text(fields["付款金额"])) ?? 0;
}

// 按 SKU、按洛杉矶下单日汇总；已取消的不计。只保留汇总与计数，不保留订单号与任何买家信息。
export function aggregateOrders(records: Array<{ fields: Row }>, days: string[]): OrdersData {
  const index = new Map(days.map((day, position) => [day, position]));
  const skus: OrdersData["skus"] = {};
  const pending = new Set<string>();
  for (const record of records) {
    const fields = record.fields ?? {};
    const status = text(fields["订单状态"]);
    if (CANCELLED.test(status)) continue;
    const placed = text(fields["下单时间"]);
    const position = index.get(placed.slice(0, 10));
    const sku = text(fields.SKU);
    if (position === undefined || !sku) continue;
    if (PENDING.test(status)) pending.add(text(fields["订单编号"]) || `${sku}|${placed}`);
    const entry = (skus[sku] ??= { u: days.map(() => 0), s: days.map(() => 0), o: days.map(() => 0), last: "" });
    entry.u[position]! += num(text(fields["数量"])) ?? 1;
    entry.s[position] = round(entry.s[position]! + orderAmount(fields));
    entry.o[position]! += 1;
    if (placed > entry.last) entry.last = placed;
  }
  return { days, skus, pendingOrders: pending.size };
}

// 最近 30 天（不含今天，与后台“最近 30 天”口径一致取前 30 个完整日）件数与金额。
export function last30(entry: OrdersData["skus"][string] | undefined): { units: number; sales: number } {
  return { units: sum((entry?.u ?? []).slice(-31, -1)), sales: round(sum((entry?.s ?? []).slice(-31, -1))) };
}

export type SkuFlag = "due" | "slow" | "ok" | "quiet";
export interface SkuPace { todayUnits: number; todayOrders: number; avgDailyUnits: number; expectedSoFar: number | null; flag: SkuFlag }

// 按全店“平时此刻已卖出全天的比例”折算该款此刻应出件数：应出 ≥2 却 0 件为“该出未出”，应出 ≥3 却不足一半为“偏慢”。
export function skuPace(entry: OrdersData["skus"][string] | undefined, unitsShare: number | null): SkuPace {
  const units = entry?.u ?? [];
  const todayUnits = units.at(-1) ?? 0;
  const todayOrders = entry?.o.at(-1) ?? 0;
  const avgDailyUnits = round(sum(units.slice(-8, -1)) / 7, 2);
  const expectedSoFar = unitsShare === null ? null : round(avgDailyUnits * unitsShare, 1);
  let flag: SkuFlag = "ok";
  if (avgDailyUnits === 0) flag = "quiet";
  else if (expectedSoFar !== null && expectedSoFar >= 2 && todayUnits === 0) flag = "due";
  else if (expectedSoFar !== null && expectedSoFar >= 3 && todayUnits < expectedSoFar / 2) flag = "slow";
  return { todayUnits, todayOrders, avgDailyUnits, expectedSoFar, flag };
}

// ---------- 库存（飞书「库存预警」） ----------

export interface InventoryRow { sku: string; asin: string; name: string; sales30: number; fbaAvailable: number | null; fbaDays: number | null; level: string; reason: string; dataTime: string; stale: boolean }

export function inventoryRows(records: Array<{ fields: Row }>): InventoryRow[] {
  return records.map(({ fields }) => ({
    sku: text(fields.SKU), asin: text(fields.ASIN), name: text(fields["品名"]).slice(0, 120),
    sales30: num(text(fields["30日销量"])) ?? 0, fbaAvailable: num(text(fields["FBA可售"])) ?? null, fbaDays: num(text(fields["FBA可售覆盖天数"])) ?? null,
    level: text(fields["预警等级"]), reason: text(fields["预警原因"]).slice(0, 120), dataTime: text(fields["数据时间"]), stale: text(fields["数据状态"]) === "数据已过期",
  })).filter((row) => row.sku);
}

// ---------- 货件（飞书「货件表」，10/07 晚追加） ----------

// 状态名由货件同步写入（见 business/shipments.ts），按货件流程排序；不在列表里的状态排最后。已结束的与空状态不计。
export const SHIPMENT_STEPS = ["未确认", "处理中", "已创建", "待发货", "已发货", "运输中", "已送达", "已登记入仓", "接收中", "进行中", "异常", "错误"];
const SHIPMENT_DONE = new Set(["已完成", "已取消", "已删除", "已放弃", "已作废"]);
export interface ShipmentSummary { active: number; statuses: Array<{ status: string; count: number }> }

export function shipmentSummary(records: Array<{ fields: Row }>): ShipmentSummary {
  const counts = new Map<string, number>();
  for (const record of records) {
    const status = text((record.fields ?? {})["当前状态"]);
    if (!status || SHIPMENT_DONE.has(status)) continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const rank = (status: string): number => { const index = SHIPMENT_STEPS.indexOf(status); return index < 0 ? SHIPMENT_STEPS.length : index; };
  const statuses = [...counts].map(([status, count]) => ({ status, count })).sort((a, b) => rank(a.status) - rank(b.status) || a.status.localeCompare(b.status));
  return { active: sum(statuses.map((item) => item.count)), statuses };
}

// ---------- 商品资料（Listings 摘要与报价）与实时 FBA 库存 ----------

export interface CatalogItem { sku: string; asin: string; title: string; image: string; buyable: boolean; price: number | null }

// searchListingsItems（includedData=summaries,offers）：状态含 BUYABLE 为在售；价格取 B2C 报价。父体（无报价、只 DISCOVERABLE）也列出，由页面按“在售”过滤。
export function catalogItems(items: Row[], marketplaceId = "ATVPDKIKX0DER"): CatalogItem[] {
  const output: CatalogItem[] = [];
  for (const item of items) {
    const summary = rows(item.summaries).find((entry) => text(entry.marketplaceId) === marketplaceId) ?? rows(item.summaries)[0];
    const sku = text(item.sku);
    if (!sku || !summary) continue;
    const statuses = Array.isArray(summary.status) ? (summary.status as unknown[]).map((value) => String(value).toUpperCase()) : [];
    const offer = rows(item.offers).find((entry) => text(entry.offerType).toUpperCase() === "B2C" && (!entry.marketplaceId || text(entry.marketplaceId) === marketplaceId));
    const image = text((summary.mainImage as Row | undefined)?.link);
    output.push({
      sku, asin: text(summary.asin).toUpperCase(), title: text(summary.itemName).slice(0, 200),
      image: /^https:\/\/[\w.-]+\.(media-amazon|ssl-images-amazon)\.com\//.test(image) ? image : "",
      buyable: statuses.includes("BUYABLE"), price: num(((offer?.price ?? {}) as Row).amount) ?? null,
    });
  }
  return output;
}

export interface StockFact { fulfillable: number; inbound: number; reserved: number }

// getInventorySummaries（details=true）：可售＝fulfillableQuantity（与后台“亚马逊物流”库存同源）；在途＝入库中三项之和。
export function stockFacts(summaries: Row[]): Record<string, StockFact> {
  const output: Record<string, StockFact> = {};
  for (const summary of summaries) {
    const sku = text(summary.sellerSku);
    const details = (summary.inventoryDetails ?? {}) as Row;
    if (!sku) continue;
    output[sku] = {
      fulfillable: num(details.fulfillableQuantity) ?? 0,
      inbound: (num(details.inboundWorkingQuantity) ?? 0) + (num(details.inboundShippedQuantity) ?? 0) + (num(details.inboundReceivingQuantity) ?? 0),
      reserved: num(((details.reservedQuantity ?? {}) as Row).totalReservedQuantity) ?? 0,
    };
  }
  return output;
}

// ---------- 广告（「广告每日总览」「广告活动日报」，均为已完成的站点日） ----------

// 缺失（undefined）表示该日没有这项数据，不当 0。
export interface OverviewRow { date: string; spend: number | undefined; adSales: number | undefined; adOrders: number | undefined; impressions: number | undefined; clicks: number | undefined; totalSales: number | undefined }
export interface CampaignDayRow { date: string; id: string; name: string; status: string; spend: number; orders: number; sales: number; impressions: number; clicks: number }
const siteDate = (value: unknown): string => { const ms = num(value); return ms === undefined ? "" : new Date(ms).toISOString().slice(0, 10); };

export function overviewRows(records: Array<{ fields: Row }>): OverviewRow[] {
  return records.map(({ fields }) => ({
    date: siteDate(fields["站点日期"]), spend: num(fields["花费"]), adSales: num(fields["广告销售额"]), adOrders: num(fields["广告订单"]),
    impressions: num(fields["曝光"]), clicks: num(fields["点击"]), totalSales: num(fields["总销售额"]),
  })).filter((row) => row.date);
}

export function campaignRows(records: Array<{ fields: Row }>): CampaignDayRow[] {
  return records.map(({ fields }) => ({
    date: siteDate(fields["站点日期"]), id: text(fields["活动ID"]), name: text(fields["活动名称"]).slice(0, 120), status: text(fields["活动状态"]).toUpperCase(),
    spend: num(fields["花费"]) ?? 0, orders: num(fields["广告订单"]) ?? 0, sales: num(fields["广告销售额"]) ?? 0, impressions: num(fields["曝光"]) ?? 0, clicks: num(fields["点击"]) ?? 0,
  })).filter((row) => row.date && row.id);
}

export type Better = "up" | "down" | "neutral";
export interface AdsMetric { key: string; label: string; value: number | null; prev: number | null; delta: number | null; better: Better; format: "usd" | "pct" | "int" }
export interface CampaignStat { id: string; name: string; status: string; spend: number; orders: number; sales: number; impressions: number; clicks: number; prevImpressions: number; drop: number | null }
// day：最近一个完整站点日（给“全局快照”的广告销售、广告曝光量格用）。
export interface AdsDay { date: string; spend: number | null; sales: number | null; orders: number | null; impressions: number | null; clicks: number | null; acos: number | null }
export interface AdsView { latest: string; from: string; prevFrom: string; prevTo: string; days: number; prevDays: number; metrics: AdsMetric[]; noOrder: CampaignStat[]; drops: CampaignStat[]; avgDailySpend: number | null; day: AdsDay | null }

const ratio = (top: number, bottom: number): number | null => bottom > 0 ? top / bottom : null;
const change = (value: number | null, prev: number | null): number | null => value === null || prev === null || prev === 0 ? null : (value - prev) / prev;

export function adsSummary(overview: OverviewRow[], campaigns: CampaignDayRow[], today: string, spendThreshold: number): AdsView | null {
  const complete = overview.filter((row) => row.date < today && row.spend !== undefined);
  const latest = complete.map((row) => row.date).sort().at(-1);
  if (!latest) return null;
  const from = addDaysYmd(latest, -6), prevTo = addDaysYmd(latest, -7), prevFrom = addDaysYmd(latest, -13);
  const recent = complete.filter((row) => row.date >= from && row.date <= latest);
  const prior = complete.filter((row) => row.date >= prevFrom && row.date <= prevTo);
  const total = (items: OverviewRow[], key: keyof Omit<OverviewRow, "date">): number => sum(items.map((row) => row[key] ?? 0));
  const both = (items: OverviewRow[]): OverviewRow[] => items.filter((row) => row.totalSales !== undefined);
  const facts = (items: OverviewRow[]): Record<string, number | null> => items.length ? {
    spend: total(items, "spend"), adSales: total(items, "adSales"), adOrders: total(items, "adOrders"), impressions: total(items, "impressions"), clicks: total(items, "clicks"),
    acos: ratio(total(items, "spend"), total(items, "adSales")), tacos: ratio(total(both(items), "spend"), total(both(items), "totalSales")),
  } : { spend: null, adSales: null, adOrders: null, impressions: null, clicks: null, acos: null, tacos: null };
  const now = facts(recent), before = prior.length === 7 ? facts(prior) : facts([]);
  const metric = (key: string, label: string, better: Better, format: AdsMetric["format"]): AdsMetric => {
    const value = now[key] ?? null, prev = before[key] ?? null;
    return { key, label, value: value === null ? null : round(value, 4), prev: prev === null ? null : round(prev, 4), delta: change(value, prev), better, format };
  };
  const metrics = [
    metric("spend", "花费", "neutral", "usd"), metric("adSales", "广告销售额", "up", "usd"), metric("adOrders", "广告订单", "up", "int"),
    metric("acos", "ACOS", "down", "pct"), metric("tacos", "TACOS", "down", "pct"), metric("impressions", "曝光", "up", "int"), metric("clicks", "点击", "up", "int"),
  ];
  const byId = new Map<string, CampaignStat & { latestDate: string }>();
  for (const row of campaigns) {
    if (row.date < prevFrom || row.date > latest) continue;
    const stat = byId.get(row.id) ?? { id: row.id, name: row.name, status: row.status, spend: 0, orders: 0, sales: 0, impressions: 0, clicks: 0, prevImpressions: 0, drop: null, latestDate: "" };
    if (row.date >= stat.latestDate) Object.assign(stat, { name: row.name || stat.name, status: row.status || stat.status, latestDate: row.date });
    if (row.date >= from) { stat.spend += row.spend; stat.orders += row.orders; stat.sales += row.sales; stat.impressions += row.impressions; stat.clicks += row.clicks; }
    else stat.prevImpressions += row.impressions;
    byId.set(row.id, stat);
  }
  const stats = [...byId.values()].map(({ latestDate: _latest, ...stat }) => ({ ...stat, spend: round(stat.spend), sales: round(stat.sales), drop: stat.prevImpressions > 0 ? round(1 - stat.impressions / stat.prevImpressions, 4) : null }));
  const noOrder = stats.filter((stat) => stat.spend >= spendThreshold && stat.orders === 0).sort((a, b) => b.spend - a.spend).slice(0, 8);
  const drops = stats.filter((stat) => stat.status === "ENABLED" && stat.prevImpressions >= 1000 && stat.drop !== null && stat.drop > 0.3).sort((a, b) => (b.drop ?? 0) - (a.drop ?? 0)).slice(0, 8);
  const spend = now.spend ?? null;
  const last = complete.find((row) => row.date === latest);
  const day: AdsDay | null = last ? {
    date: latest, spend: last.spend ?? null, sales: last.adSales ?? null, orders: last.adOrders ?? null, impressions: last.impressions ?? null, clicks: last.clicks ?? null,
    acos: last.spend !== undefined && last.adSales ? round(last.spend / last.adSales, 4) : null,
  } : null;
  return { latest, from, prevFrom, prevTo, days: recent.length, prevDays: prior.length, metrics, noOrder, drops, avgDailySpend: spend === null || !recent.length ? null : round(spend / recent.length), day };
}

// ---------- 状态表：购物车/跟卖、流量、竞品、动态 ----------

export interface OfferFact { buyBox: "won" | "lost" | "unknown"; holder: string; ownPrice: number | null; selling: boolean; hijackers: number; lostAt: string }

// 只看美国站：购物车状态、当前在售跟卖数（未离开的卖家）、本店到手价。
export function offerFacts(items: Row[], marketplaceId = "ATVPDKIKX0DER"): Map<string, OfferFact> {
  const output = new Map<string, OfferFact>();
  for (const item of items) {
    if (text(item.marketplaceId) !== marketplaceId) continue;
    const buyBox = (item.buyBox ?? {}) as Row;
    const own = (item.own ?? null) as Row | null;
    const sellers = Object.values((item.sellers ?? {}) as Record<string, Row>);
    const status = text(buyBox.status);
    output.set(text(item.asin).toUpperCase(), {
      buyBox: status === "won" || status === "lost" ? status : "unknown", holder: text(buyBox.holder), ownPrice: own ? num(own.landed) ?? null : null,
      selling: !!own, hijackers: sellers.filter((seller) => !text(seller.leftAt)).length, lostAt: text(buyBox.lostAt),
    });
  }
  return output;
}

export interface TrafficMetric { status: string; current: number | null; baseline: number | null; drop: number | null; evalDay: string }

export function trafficFacts(items: Row[]): Map<string, { sessions?: TrafficMetric; conversion?: TrafficMetric }> {
  const output = new Map<string, { sessions?: TrafficMetric; conversion?: TrafficMetric }>();
  for (const item of items) {
    const [asin = "", metric = ""] = text(item.sk).split("|");
    if (!asin || (metric !== "sessions" && metric !== "conversion")) continue;
    const entry = output.get(asin.toUpperCase()) ?? {};
    entry[metric] = { status: text(item.status), current: num(item.current) ?? null, baseline: num(item.baseline) ?? null, drop: num(item.drop) ?? null, evalDay: text(item.evalDay) };
    output.set(asin.toUpperCase(), entry);
  }
  return output;
}

export interface FeedItem { kind: string; at: string; title: string; details: string[] }
// 复用系统已发出的业务消息（状态表 NOTIFICATION），按前缀归类；旧 buybox-watch 与新购物车提醒重复，不收。
// 大促期间竞品变化不逐条发，而是每轮合并成一条（competitor-sale|<计划时间>，数据触发另有 competitor-sale-trigger|）。
export const FEED_PREFIXES: Array<[string, string]> = [
  ["competitor|", "competitor-price"], ["competitor-promo|", "competitor-promo"], ["competitor-sale|", "competitor-sale"], ["competitor-sale-trigger|", "competitor-sale"],
  ["offer-seller|", "hijacker-in"], ["offer-seller-left|", "hijacker-out"], ["offer-buybox|", "buybox-lost"], ["offer-buybox-back|", "buybox-back"],
  ["traffic|", "traffic"], ["inventory|", "inventory"], ["brand-watch|", "brand"],
  ["store-health|", "store-health"], ["inventory-health|", "inventory-health"], ["inventory-health-month|", "inventory-health"],
];
export const FEED_DAYS = 7;
const SALE_FOOTER = /^大促期间每 2 小时比价/;
// 合并消息里的一行：【SKU】竞品ASIN 品牌：旧价 → 新价｜促销……
const SALE_LINE = /】([A-Z0-9]{10})[^：]*：([\d.]+) → ([\d.]+)/;

export function feedItems(items: Row[], nowMs: number, limit = 40): FeedItem[] {
  const since = nowMs - FEED_DAYS * 86_400_000;
  const output: FeedItem[] = [];
  for (const item of items) {
    const sk = text(item.sk);
    const kind = FEED_PREFIXES.find(([prefix]) => sk.startsWith(prefix))?.[1];
    const at = text(item.createdAt) || text(item.updatedAt);
    const atMs = Date.parse(at);
    const lines = Array.isArray(item.lines) ? (item.lines as unknown[]).map((line) => String(line ?? "").trim()).filter(Boolean) : [];
    if (!kind || !Number.isFinite(atMs) || atMs < since || atMs > nowMs + 3_600_000 || !lines.length) continue;
    const details = lines.slice(1).filter((line) => !SALE_FOOTER.test(line)).slice(0, kind === "competitor-sale" ? 5 : 3);
    output.push({ kind, at: new Date(atMs).toISOString(), title: lines[0]!.slice(0, 60), details: details.map((line) => line.slice(0, 100)) });
  }
  return output.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

// 竞品近 7 天降价次数（新价低于旧价才算）：平时看消息键 competitor|<ASIN>|<旧价>-><新价>|<北京日期>，大促期间看合并消息的逐行内容。
export function competitorDrops(items: Row[], nowMs: number): Map<string, number> {
  const since = nowMs - FEED_DAYS * 86_400_000;
  const output = new Map<string, number>();
  const add = (asin: string, before: string, after: string): void => { if (Number(after) < Number(before)) output.set(asin, (output.get(asin) ?? 0) + 1); };
  for (const item of items) {
    if (!(Date.parse(text(item.createdAt)) >= since)) continue;
    const sk = text(item.sk);
    const single = /^competitor\|([A-Z0-9]{10})\|([\d.]+)->([\d.]+)\|/.exec(sk);
    if (single) { add(single[1]!, single[2]!, single[3]!); continue; }
    if (!sk.startsWith("competitor-sale|") || !Array.isArray(item.lines)) continue;
    for (const line of item.lines as unknown[]) {
      const match = SALE_LINE.exec(String(line ?? ""));
      if (match) add(match[1]!, match[2]!, match[3]!);
    }
  }
  return output;
}

// ---------- 资金（Finances listBalances、Transfers listExpectedPayouts） ----------

export interface BalanceLine { accountType: string; currency: string; total: number | null; available: number | null }
export interface PayoutLine { amount: number | null; currency: string; date: string; status: string }
export interface FundsData { balances: BalanceLine[]; next: PayoutLine | null }

// Transfers 实际返回 {unit, value}，Finances 返回 {currencyCode, currencyAmount}；两种都认，缺失不补 0。
function money(value: unknown): { amount: number | null; currency: string } {
  const source = (value ?? {}) as Row;
  const amount = num(source.value ?? source.currencyAmount ?? source.amount);
  return { amount: amount ?? null, currency: text(source.unit ?? source.currencyCode).toUpperCase() };
}

export function parseFunds(balances: unknown, expected: unknown, nowMs: number): FundsData {
  const balancePayload = ((balances as Row | undefined)?.payload ?? balances ?? {}) as Row;
  const lines: BalanceLine[] = [];
  for (const total of rows(balancePayload.balances)) {
    const line: BalanceLine = { accountType: text((total.partnerMetadata as Row | undefined)?.accountType) || "UNKNOWN", currency: money(total.amount).currency, total: null, available: null };
    const visit = (node: Row): void => {
      const type = text(node.balanceType).toUpperCase();
      const value = money(node.amount);
      if (!line.currency && value.currency) line.currency = value.currency;
      if (type === "TOTAL" && value.amount !== null) line.total = value.amount;
      if (type === "AVAILABLE" && value.amount !== null) line.available = value.amount;
      for (const child of rows(node.balances)) visit(child);
    };
    visit(total);
    if (line.total === null) line.total = money(total.amount).amount;
    lines.push(line);
  }
  const expectedPayload = ((expected as Row | undefined)?.payload ?? expected ?? {}) as Row;
  const upcoming = rows(expectedPayload.expectedPayouts)
    .map((item) => ({ ...money(item.amount), date: text(item.scheduledDate), status: text(item.status).toUpperCase() }))
    .filter((item) => item.status !== "NO_PAYOUT_EXPECTED" && item.amount !== null && item.amount !== 0)
    .sort((a, b) => (Date.parse(a.date) || nowMs) - (Date.parse(b.date) || nowMs));
  const next = upcoming[0];
  return { balances: lines, next: next ? { amount: next.amount, currency: next.currency, date: next.date, status: next.status } : null };
}

// ---------- 广告账单（广告 API GET /invoices） ----------

// 发票日期是广告账户时区（洛杉矶）的 YYYYMMDD，转成 YYYY-MM-DD；remaining＝还没扣完的金额。
export interface AdsInvoice { status: string; from: string; date: string; amount: number | null; remaining: number | null; currency: string }
// accumulating：累积中、还没开票的费用（后台“累积费用”）；invoices：已开票的，开票日新的在前。
export interface AdsBillingData { accumulating: { amount: number; currency: string; since: string } | null; invoices: AdsInvoice[] }

const invoiceYmd = (value: unknown): string => {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text(value));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
};

export function parseAdsInvoices(response: unknown): AdsBillingData {
  const payload = ((response as Row | undefined)?.payload ?? response ?? {}) as Row;
  const all = rows(payload.invoiceSummaries).map((item): AdsInvoice => {
    const due = money(item.amountDue), left = money(item.remainingAmountDue);
    return { status: text(item.status).toUpperCase(), from: invoiceYmd(item.fromDate), date: invoiceYmd(item.invoiceDate) || invoiceYmd(item.toDate), amount: due.amount, remaining: left.amount, currency: due.currency || left.currency };
  });
  // 累积中的发票只有起始日和金额；万一有几张（不同广告产品）就合计，起始日取最早。
  const open = all.filter((item) => item.status === "ACCUMULATING" && item.amount !== null);
  return {
    accumulating: open.length ? { amount: round(sum(open.map((item) => item.amount!))), currency: open[0]!.currency, since: open.map((item) => item.from).filter(Boolean).sort()[0] ?? "" } : null,
    invoices: all.filter((item) => item.status !== "ACCUMULATING").sort((a, b) => b.date.localeCompare(a.date)),
  };
}

// 预计扣款：due＝已满门槛、随时扣；closing＝已到月结日、随时扣；month＝月结日；threshold＝按日均推算满门槛的日子。
export type AdsChargeKind = "due" | "closing" | "month" | "threshold";
export interface AdsBillingView {
  // rate：推算用的日均花费；monthClose：本期最迟的月结日。
  accrued: number | null; currency: string; since: string; threshold: number | null; rate: number | null; monthClose: string;
  next: { date: string; kind: AdsChargeKind } | null;
  // 已开票还没扣完的发票（days＝最早一张开票至今的天数，超过 UNPAID_ALERT_DAYS 记 overdue）；last＝最近一张已付清的。
  pending: { amount: number; date: string; days: number; count: number; overdue: boolean } | null;
  last: { amount: number; date: string } | null;
}
// 按门槛开的发票略超门槛，月结的低于门槛；累积超过推断门槛这么多，说明门槛已经改了。
const THRESHOLD_STALE_MARGIN = 20;
// 统一结算开票当天就从卖家余额扣（实测每张都是）；开票超过这么多天还没扣完，页面标红。
export const UNPAID_ALERT_DAYS = 3;
const CHARGE_RANK: Record<AdsChargeKind, number> = { due: 0, closing: 1, month: 2, threshold: 3 };

// 月结：每月 2 日给上月累积的费用开票（实测月结发票都开在 2 日），所以是起始日之后的下一个 2 日。
export function monthCloseAfter(since: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since);
  if (!match) return "";
  const year = Number(match[1]), month = Number(match[2]);
  return Number(match[3]) < 2 ? `${match[1]}-${match[2]}-02` : new Date(Date.UTC(year, month, 2)).toISOString().slice(0, 10);
}

// 扣款门槛与日期都是估算：亚马逊不提供门槛接口，日均优先用广告区块的近 7 日日均花费。
export function adsBillingView(data: AdsBillingData, nowMs: number, avgDailySpend: number | null): AdsBillingView {
  const today = zonedParts(nowMs, SITE_ZONE).ymd;
  const open = data.accumulating;
  const accrued = open ? open.amount : null;
  const issued = data.invoices.filter((item) => item.amount !== null && item.amount > 0).slice(0, 6);
  let threshold: number | null = issued.length ? Math.max(...issued.map((item) => Math.floor(item.amount! / 10) * 10)) : null;
  if (threshold !== null && (threshold <= 0 || (accrued !== null && accrued >= threshold + THRESHOLD_STALE_MARGIN))) threshold = null;
  const elapsed = open?.since ? (nowMs - Date.parse(zonedMidnight(open.since, SITE_ZONE))) / 86_400_000 : 0;
  const rate = avgDailySpend !== null && avgDailySpend > 0 ? avgDailySpend : accrued !== null && accrued > 0 && elapsed >= 1 ? round(accrued / elapsed) : null;
  const monthClose = open ? monthCloseAfter(open.since) : "";
  let next: AdsBillingView["next"] = null;
  if (open) {
    const options: Array<{ date: string; kind: AdsChargeKind }> = [];
    if (threshold !== null && accrued !== null) {
      if (accrued >= threshold) options.push({ date: today, kind: "due" });
      else if (rate) options.push({ date: zonedParts(nowMs + ((threshold - accrued) / rate) * 86_400_000, SITE_ZONE).ymd, kind: "threshold" });
    }
    if (monthClose) options.push(monthClose <= today ? { date: today, kind: "closing" } : { date: monthClose, kind: "month" });
    next = options.sort((a, b) => a.date.localeCompare(b.date) || CHARGE_RANK[a.kind] - CHARGE_RANK[b.kind])[0] ?? null;
  }
  const unpaid = data.invoices.filter((item) => item.status !== "WRITTEN_OFF" && item.remaining !== null && item.remaining > 0.004);
  const oldest = unpaid.map((item) => item.date).filter(Boolean).sort()[0] ?? "";
  const days = oldest ? Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) / 86_400_000)) : 0;
  const paid = data.invoices.find((item) => item.status === "PAID_IN_FULL" && item.amount !== null && item.date);
  return {
    accrued, currency: open?.currency || data.invoices.find((item) => item.currency)?.currency || "USD", since: open?.since ?? "", threshold, rate, monthClose, next,
    pending: unpaid.length ? { amount: round(sum(unpaid.map((item) => item.remaining!))), date: oldest, days, count: unpaid.length, overdue: days > UNPAID_ALERT_DAYS } : null,
    last: paid ? { amount: paid.amount!, date: paid.date } : null,
  };
}
