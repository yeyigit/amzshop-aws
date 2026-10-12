import type { AppConfig, JsonObject } from "../types.js";
import type { AmazonClient, Pace } from "../clients/amazon.js";
import { isFeishuQuotaError, type FeishuClient } from "../clients/feishu.js";
import type { StateStore } from "../state.js";
import { HttpError } from "../http.js";
import { log } from "../log.js";
import { competitorSettings, trackedCompetitors } from "../business/competitor-sets.js";
import { currentSaleMode, saleSettings } from "../business/sale-windows.js";
import { addDaysYmd, errorText, feishuFieldText, zonedMidnight } from "../util.js";
import { SITE_ZONE, zonedParts } from "./clock.js";
import {
  FEED_PREFIXES, adsSummary, aggregateOrders, campaignRows, catalogItems, competitorDrops, feedItems, inventoryRows, offerFacts, overviewRows, parseAdsInvoices, parseFunds, parseSalesBuckets, shipmentSummary, stockFacts, trafficFacts,
  type AdsBillingData, type AdsView, type CatalogItem, type FeedItem, type FundsData, type InventoryRow, type OfferFact, type OrdersData, type SalesData, type ShipmentSummary, type StockFact, type TrafficMetric,
} from "./metrics.js";

// 店铺中台取数：只读。飞书只调 records/search 与记录列表 GET，亚马逊只调 GET（SP-API 与广告 API 发票），状态表只读业务分区；
// 结果按区块写入 PORTAL_CACHE/<区块>（只存汇总），各区块独立失败、失败保留旧值并记下原因。
type Row = Record<string, unknown>;
export const CACHE_PK = "PORTAL_CACHE";
export const LEASE_SCOPE = "portal";
export const MARKETPLACE_US = "ATVPDKIKX0DER";
export type SectionKey = "sales" | "orders" | "adsToday" | "funds" | "adsBilling" | "ads" | "inventory" | "live" | "feed" | "catalog" | "stock" | "shipments";
export const SECTION_KEYS: SectionKey[] = ["sales", "orders", "adsToday", "funds", "adsBilling", "ads", "inventory", "live", "feed", "catalog", "stock", "shipments"];
const MINUTE = 60_000;
export const SECTION_TTL_MS: Record<SectionKey, number> = {
  sales: 5 * MINUTE, orders: 5 * MINUTE, adsToday: 5 * MINUTE, funds: 30 * MINUTE, adsBilling: 30 * MINUTE, ads: 60 * MINUTE, inventory: 60 * MINUTE, live: 5 * MINUTE, feed: 15 * MINUTE,
  catalog: 6 * 60 * MINUTE, stock: 15 * MINUTE, shipments: 30 * MINUTE,
};
// 手动刷新时，变化快的区块只要超过 30 秒就重取；变化慢的仍按缓存时长。
export const FAST_SECTIONS: SectionKey[] = ["sales", "orders", "adsToday", "live"];
// 取数失败后 60 秒内不重试同一区块，避免页面反复刷新时连续打接口。
export const ERROR_BACKOFF_MS = MINUTE;
// 按站点日取数的区块：洛杉矶换日后立即视为过期。
const DATED_SECTIONS: SectionKey[] = ["sales", "orders", "adsToday", "ads"];

// 缓存格式版本：区块数据结构变了就加 1，旧格式的区块立即视为过期重取（10/07 改版前写入的缓存没有这个字段）。
// 3（2026-10-11）：live 区块加店铺健康与库存健康。
export const CACHE_SCHEMA = 3;
export interface CachedSection { data?: unknown; fetchedAt?: string; error?: string; errorAt?: string; schema?: number }
export type SectionCache = Partial<Record<SectionKey, CachedSection>>;
export interface SourceContext { config: AppConfig; state: StateStore; amazon: AmazonClient; feishu: FeishuClient; now: () => number }

export interface DatedSales extends SalesData { today: string }
export interface DatedOrders extends OrdersData { today: string }
export interface AdsTodayData { today: string; spend: number; campaigns: number; updatedAt: string }
export interface DatedAds extends AdsView { today: string }
export interface CompetitorSummary { asins: string[]; priced: number; minPrice: number | null; promos: number; updatedAt: string }
// 竞品大促加密状态（见 docs/模块说明.md「竞品大促加密」）：加密期间竞品每 2 小时比价，平时每天 14:00。
export interface SaleView { active: boolean; names: string[]; until: string }
// 店铺健康与库存健康（docs/模块说明.md「店铺健康、库龄与 SQP」）：只读 STORE_HEALTH/summary 与 INVENTORY_HEALTH/latest 两条状态。
export interface StoreHealthView {
  account: { status: string; ahrStatus: string; ahrScore: number | null; issues: string[]; fetchedAt: string } | null;
  listings: Array<{ market: string; sku: string; kind: string; text: string; since: string }>; updatedAt: string;
}
export interface InventoryHealthSku { status: string; aged181: number; willAge90: number; storageNextMonth: number | null; aisNextMonth: number | null; monthsToClear: number | null }
export interface InventoryHealthView { snapshotDate: string; storageNextMonth: number; aisNextMonth: number; excessSkus: number; skus: Record<string, InventoryHealthSku>; updatedAt: string }
export interface LiveData {
  offers: Record<string, OfferFact>; traffic: Record<string, { sessions?: TrafficMetric; conversion?: TrafficMetric }>; competitors: Record<string, CompetitorSummary>; health: Record<string, string>; sale: SaleView | null;
  storeHealth: StoreHealthView | null; inventoryHealth: InventoryHealthView | null;
}
export interface FeedData { items: FeedItem[]; drops: Record<string, number> }

// 中台自己的节流键（与 Jobs 不在同一实例，官方配额共用，所以每次刷新只调必要的几次）。
const PACE: Record<"sales" | "balances" | "payouts" | "listings" | "inventory" | "adsInvoices", Pace> = {
  sales: { key: "portal:sales", minIntervalMs: 2_100 },
  balances: { key: "portal:balances", minIntervalMs: 2_100 },
  payouts: { key: "portal:payouts", minIntervalMs: 2_100 },
  listings: { key: "portal:listings", minIntervalMs: 250 },
  inventory: { key: "portal:inventory", minIntervalMs: 600 },
  adsInvoices: { key: "portal:ads-invoices", minIntervalMs: 1_000 },
};
export interface DatedCatalog { items: CatalogItem[] }

const siteToday = (ctx: SourceContext): string => zonedParts(ctx.now(), SITE_ZONE).ymd;

// 只读查询：飞书 records/search（POST 只是查询的请求方式），分页取全。
export async function searchRecords(feishu: FeishuClient, app: string, table: string, filter: Row, fieldNames?: string[]): Promise<Array<{ fields: Row }>> {
  const output: Array<{ fields: Row }> = [];
  let pageToken = "";
  do {
    const data = await feishu.request<{ items?: Array<{ fields: Row }>; has_more?: boolean; page_token?: string }>(
      "POST", `/open-apis/bitable/v1/apps/${encodeURIComponent(app)}/tables/${encodeURIComponent(table)}/records/search`,
      { ...(fieldNames ? { field_names: fieldNames } : {}), filter, automatic_fields: false },
      { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) },
    );
    output.push(...(data.items ?? []));
    pageToken = data.has_more ? String(data.page_token ?? "") : "";
    if (data.has_more && !pageToken) throw new Error("飞书分页缺少 page_token。");
  } while (pageToken);
  return output;
}

async function loadSales(ctx: SourceContext): Promise<DatedSales> {
  const today = siteToday(ctx);
  const response = await ctx.amazon.sp<JsonObject>("/sales/v1/orderMetrics", {
    query: { marketplaceIds: MARKETPLACE_US, interval: `${zonedMidnight(addDaysYmd(today, -7), SITE_ZONE)}--${zonedMidnight(addDaysYmd(today, 1), SITE_ZONE)}`, granularity: "Hour", granularityTimeZone: SITE_ZONE },
    pace: PACE.sales,
  });
  return { ...parseSalesBuckets(response.payload), today };
}

// 今天 + 前 30 天（31 个“下单时间包含日期”的 or 条件；几百行时约 2 页、几秒）。
export const ORDER_DAYS = 31;

async function loadOrders(ctx: SourceContext): Promise<DatedOrders> {
  const today = siteToday(ctx);
  const days = Array.from({ length: ORDER_DAYS }, (_, index) => addDaysYmd(today, index - ORDER_DAYS + 1));
  const records = await searchRecords(ctx.feishu, ctx.config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS"), ctx.config.get("FEISHU_BITABLE_TABLE_ID_ORDERS"),
    { conjunction: "or", conditions: days.map((day) => ({ field_name: "下单时间", operator: "contains", value: [day] })) },
    ["订单编号", "SKU", "数量", "订单状态", "下单时间", "付款金额", "金额"]);
  return { ...aggregateOrders(records, days), today };
}

// 卖家 ID：配置 SP_API_SELLER_ID，缺失时用定价任务已解析并缓存的 CACHE/sellerId（只读）。
async function sellerId(ctx: SourceContext): Promise<string> {
  const configured = ctx.config.optional("SP_API_SELLER_ID", "").trim();
  if (configured) return configured;
  const cached = String((await ctx.state.get("CACHE", "sellerId"))?.value ?? "").trim();
  if (!cached) throw new Error("缺少 Parameter Store 配置 SP_API_SELLER_ID。");
  return cached;
}

async function loadCatalog(ctx: SourceContext): Promise<DatedCatalog> {
  const seller = await sellerId(ctx);
  const items: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let pageToken = "";
  do {
    const page = await ctx.amazon.sp<JsonObject>(`/listings/2021-08-01/items/${encodeURIComponent(seller)}`, { query: { marketplaceIds: MARKETPLACE_US, includedData: "summaries,offers", pageSize: 20, ...(pageToken ? { pageToken } : {}) }, pace: PACE.listings });
    items.push(...(Array.isArray(page.items) ? page.items as Array<Record<string, unknown>> : []));
    pageToken = String(((page.pagination ?? {}) as Record<string, unknown>).nextToken ?? "");
    if (pageToken && seen.has(pageToken)) throw new Error("Listings 分页 nextToken 重复。");
    if (pageToken) seen.add(pageToken);
  } while (pageToken && seen.size < 50);
  return { items: catalogItems(items, MARKETPLACE_US) };
}

async function loadStock(ctx: SourceContext): Promise<Record<string, StockFact>> {
  const summaries: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let nextToken = "";
  do {
    const page = await ctx.amazon.sp<JsonObject>("/fba/inventory/v1/summaries", { query: { granularityType: "Marketplace", granularityId: MARKETPLACE_US, marketplaceIds: MARKETPLACE_US, details: true, ...(nextToken ? { nextToken } : {}) }, pace: PACE.inventory });
    const payload = (page.payload ?? {}) as Record<string, unknown>;
    summaries.push(...(Array.isArray(payload.inventorySummaries) ? payload.inventorySummaries as Array<Record<string, unknown>> : []));
    nextToken = String(((page.pagination ?? {}) as Record<string, unknown>).nextToken ?? "");
    if (nextToken && seen.has(nextToken)) throw new Error("FBA 库存分页 nextToken 重复。");
    if (nextToken) seen.add(nextToken);
  } while (nextToken && seen.size < 50);
  return stockFacts(summaries);
}

async function loadAdsToday(ctx: SourceContext): Promise<AdsTodayData> {
  const today = siteToday(ctx);
  const records = await searchRecords(ctx.feishu, ctx.config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS"), ctx.config.get("FEISHU_BITABLE_TABLE_ID_ADS"),
    { conjunction: "and", conditions: [{ field_name: "预算日期", operator: "is", value: [today] }] }, ["已花费预算", "预算更新时间"]);
  let spend = 0, updatedAt = "";
  for (const { fields } of records) {
    const value = Number(feishuFieldText(fields["已花费预算"]));
    if (Number.isFinite(value)) spend += value;
    const at = feishuFieldText(fields["预算更新时间"]);
    if (at > updatedAt) updatedAt = at;
  }
  return { today, spend: Math.round(spend * 100) / 100, campaigns: records.length, updatedAt };
}

async function loadFunds(ctx: SourceContext): Promise<FundsData> {
  const balances = await ctx.amazon.sp<JsonObject>("/finances/2024-06-19/balances", { query: { marketplaceIds: MARKETPLACE_US }, pace: PACE.balances });
  const expected = await ctx.amazon.sp<JsonObject>("/finances/transfers/2024-06-01/payouts/expected", { query: { marketplaceIds: MARKETPLACE_US }, pace: PACE.payouts });
  return parseFunds(balances, expected, ctx.now());
}

// 广告账单只看美国站 Profile，与广告任务同一来源：ADS_PROFILES_JSON 里的美国站（没写站点的按美国站），没配就用 ADS_PROFILE_ID。
// 不引用 business/ads.ts：那边模块加载时会建 Scheduler 客户端，中台不需要。
export function usAdsProfileId(config: AppConfig): string {
  const listed = config.optional("ADS_PROFILES_JSON", "").trim();
  if (!listed) return config.get("ADS_PROFILE_ID");
  const profiles = JSON.parse(listed) as unknown;
  const us = (Array.isArray(profiles) ? profiles as Row[] : []).find((item) => (String(item.marketplaceId ?? "").trim() || MARKETPLACE_US) === MARKETPLACE_US);
  const id = String(us?.profileId ?? "").trim();
  if (!id) throw new Error("ADS_PROFILES_JSON 里没有美国站 Profile。");
  return id;
}

// 广告发票（只读 GET）：取最近 10 张，累积中的那张即后台“累积费用”；按状态筛累积中的会返回 400，所以不带筛选。
async function loadAdsBilling(ctx: SourceContext): Promise<AdsBillingData> {
  return parseAdsInvoices(await ctx.amazon.ads<JsonObject>("/invoices", { profileId: usAdsProfileId(ctx.config), query: { count: 10 }, pace: PACE.adsInvoices }));
}

async function loadAds(ctx: SourceContext): Promise<DatedAds | null> {
  const today = siteToday(ctx);
  const app = ctx.config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const since = (days: number): Row => ({ conjunction: "and", conditions: [{ field_name: "站点日期", operator: "isGreater", value: ["ExactDate", String(Date.parse(`${addDaysYmd(today, -days)}T12:00:00Z`))] }] });
  const [overview, campaigns] = await Promise.all([
    searchRecords(ctx.feishu, app, ctx.config.get("FEISHU_BITABLE_TABLE_ID_ADS_DAILY_OVERVIEW"), since(16), ["站点日期", "花费", "广告销售额", "广告订单", "曝光", "点击", "总销售额"]),
    searchRecords(ctx.feishu, app, ctx.config.get("FEISHU_BITABLE_TABLE_ID_ADS_CAMPAIGN_DAILY"), since(15), ["站点日期", "活动ID", "活动名称", "活动状态", "花费", "广告订单", "广告销售额", "曝光", "点击"]),
  ]);
  const threshold = Number(ctx.config.optional("PORTAL_ADS_NO_ORDER_SPEND", "10"));
  const view = adsSummary(overviewRows(overview), campaignRows(campaigns), today, Number.isFinite(threshold) && threshold > 0 ? threshold : 10);
  return view ? { ...view, today } : null;
}

async function loadInventory(ctx: SourceContext): Promise<InventoryRow[]> {
  return inventoryRows(await ctx.feishu.listRecords(ctx.config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS"), ctx.config.get("FEISHU_BITABLE_TABLE_ID_INVENTORY_ALERTS")));
}

// 货件概况：货件表只读、只取「当前状态」一列（通常一页取完），按状态计数。
async function loadShipments(ctx: SourceContext): Promise<ShipmentSummary> {
  const records = await searchRecords(ctx.feishu, ctx.config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS"), ctx.config.get("FEISHU_BITABLE_TABLE_ID_SHIPMENTS"),
    { conjunction: "and", conditions: [{ field_name: "当前状态", operator: "isNotEmpty", value: [] }] }, ["当前状态"]);
  return shipmentSummary(records);
}

const numOrNull = (value: unknown): number | null => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const textOf = (value: unknown): string => String(value ?? "").trim();

export function storeHealthView(item: Row | undefined): StoreHealthView | null {
  if (!item) return null;
  const account = item.account as Row | null | undefined;
  return {
    account: account ? { status: textOf(account.status), ahrStatus: textOf(account.ahrStatus), ahrScore: numOrNull(account.ahrScore), issues: (Array.isArray(account.issues) ? account.issues : []).map(textOf).filter(Boolean), fetchedAt: textOf(account.fetchedAt) } : null,
    listings: (Array.isArray(item.listings) ? item.listings as Row[] : []).slice(0, 20).map((row) => ({ market: textOf(row.market), sku: textOf(row.sku), kind: textOf(row.kind), text: textOf(row.text).slice(0, 160), since: textOf(row.since) })),
    updatedAt: textOf(item.updatedAt),
  };
}

export function inventoryHealthView(item: Row | undefined): InventoryHealthView | null {
  if (!item) return null;
  const totals = (item.totals ?? {}) as Row;
  const skus: Record<string, InventoryHealthSku> = {};
  for (const row of Array.isArray(item.skus) ? item.skus as Row[] : []) {
    const sku = textOf(row.sku);
    if (sku) skus[sku] = { status: textOf(row.status), aged181: Number(row.aged181 ?? 0) || 0, willAge90: Number(row.willAge90 ?? 0) || 0, storageNextMonth: numOrNull(row.storageNextMonth), aisNextMonth: numOrNull(row.aisNextMonth), monthsToClear: numOrNull(row.monthsToClear) };
  }
  return { snapshotDate: textOf(item.snapshotDate), storageNextMonth: Number(totals.storageNextMonth ?? 0) || 0, aisNextMonth: Number(totals.aisNextMonth ?? 0) || 0, excessSkus: Number(totals.excessSkus ?? 0) || 0, skus, updatedAt: textOf(item.updatedAt) };
}

async function loadLive(ctx: SourceContext): Promise<LiveData> {
  const [offerItems, trafficItems, priceItems, healthItems, tracked, storeHealth, inventoryHealth] = await Promise.all([
    ctx.state.list("OFFER"), ctx.state.list("TRAFFIC"), ctx.state.list("COMPETITOR_PRICE"), ctx.state.listHealth(),
    trackedCompetitors(ctx.config, ctx.state, competitorSettings(ctx.config)),
    ctx.state.get("STORE_HEALTH", "summary"), ctx.state.get("INVENTORY_HEALTH", "latest"),
  ]);
  const prices = new Map(priceItems.map((item) => [String(item.sk ?? "").toUpperCase(), item]));
  const competitors: Record<string, CompetitorSummary> = {};
  for (const competitor of tracked) {
    for (const sku of competitor.skus) {
      const summary = (competitors[sku] ??= { asins: [], priced: 0, minPrice: null, promos: 0, updatedAt: "" });
      const asin = competitor.asin.toUpperCase();
      if (summary.asins.includes(asin)) continue;
      summary.asins.push(asin);
      const quote = prices.get(asin);
      const price = Number(quote?.price);
      if (!quote || !Number.isFinite(price)) continue;
      summary.priced += 1;
      summary.minPrice = summary.minPrice === null ? price : Math.min(summary.minPrice, price);
      if (String(quote.promoSignature ?? "").trim()) summary.promos += 1;
      const updated = String(quote.updatedAt ?? "");
      if (updated > summary.updatedAt) summary.updatedAt = updated;
    }
  }
  const health: Record<string, string> = {};
  for (const item of healthItems) if (item.lastSuccessAt) health[String(item.sk)] = String(item.lastSuccessAt);
  // 只读两条状态（COMPETITOR_SALE/events、trigger）；配置写错时不让整个区块失败，只是不显示大促状态。
  let sale: SaleView | null = null;
  try {
    const mode = await currentSaleMode(ctx.state, saleSettings(ctx.config), new Date(ctx.now()));
    sale = { active: mode.active, names: [...new Set([...mode.windows.map((item) => item.name), ...(mode.triggerUntil ? ["竞品集中开限时折扣"] : [])])], until: mode.triggerUntil ?? "" };
  } catch (error) {
    log("WARN", "portal_sale_mode_failed", { error: describeError(error) });
  }
  return {
    offers: Object.fromEntries(offerFacts(offerItems, MARKETPLACE_US)), traffic: Object.fromEntries(trafficFacts(trafficItems)), competitors, health, sale,
    storeHealth: storeHealthView(storeHealth), inventoryHealth: inventoryHealthView(inventoryHealth),
  };
}

// 动态来自已发出的业务消息：每个前缀一次查询（按键排序而非时间，所以取够上限后再按创建时间筛近 7 天）。
async function loadFeed(ctx: SourceContext): Promise<FeedData> {
  const groups = await Promise.all(FEED_PREFIXES.map(([prefix]) => ctx.state.queryPartition("NOTIFICATION", { beginsWith: prefix, limit: 1000 })));
  const items = groups.flat();
  return { items: feedItems(items, ctx.now()), drops: Object.fromEntries(competitorDrops(items, ctx.now())) };
}

export const LOADERS: Record<SectionKey, (ctx: SourceContext) => Promise<unknown>> = {
  sales: loadSales, orders: loadOrders, adsToday: loadAdsToday, funds: loadFunds, adsBilling: loadAdsBilling, ads: loadAds, inventory: loadInventory, live: loadLive, feed: loadFeed,
  catalog: loadCatalog, stock: loadStock, shipments: loadShipments,
};

export async function readCache(state: StateStore): Promise<SectionCache> {
  const cache: SectionCache = {};
  for (const item of await state.queryPartition(CACHE_PK, { limit: 50 })) {
    const key = String(item.sk) as SectionKey;
    if (!SECTION_KEYS.includes(key)) continue;
    let data: unknown;
    try { data = typeof item.payload === "string" ? JSON.parse(item.payload) : undefined; } catch { data = undefined; }
    cache[key] = {
      ...(data !== undefined ? { data } : {}),
      ...(item.fetchedAt ? { fetchedAt: String(item.fetchedAt) } : {}),
      ...(item.error ? { error: String(item.error) } : {}),
      ...(item.errorAt ? { errorAt: String(item.errorAt) } : {}),
      ...(Number.isInteger(Number(item.schema)) && item.schema !== undefined ? { schema: Number(item.schema) } : {}),
    };
  }
  return cache;
}

const datedFor = (entry: CachedSection | undefined): string => String((entry?.data as { today?: unknown } | undefined)?.today ?? "");

export function staleSections(cache: SectionCache, nowMs: number, force = false): SectionKey[] {
  const today = zonedParts(nowMs, SITE_ZONE).ymd;
  return SECTION_KEYS.filter((key) => {
    const entry = cache[key];
    const errorAge = nowMs - Date.parse(entry?.errorAt ?? "");
    if (errorAge >= 0 && errorAge < ERROR_BACKOFF_MS) return false;
    const age = nowMs - Date.parse(entry?.fetchedAt ?? "");
    if (!(age >= 0)) return true;
    if (entry?.schema !== CACHE_SCHEMA) return true;
    if (DATED_SECTIONS.includes(key) && entry?.data && datedFor(entry) !== today) return true;
    if (force && FAST_SECTIONS.includes(key)) return age > 30_000;
    return age >= SECTION_TTL_MS[key];
  });
}

// 页面上显示的失败原因：只给人能看懂的短句与错误码，不带接口原文。
export function describeError(error: unknown): string {
  if (isFeishuQuotaError(error)) return "飞书本月调用额度已用尽（每月 1 日重置）";
  if (error instanceof HttpError) {
    if (error.status === 429) return "接口限流，稍后自动重试";
    if (error.status >= 500) return `接口暂时故障（HTTP ${error.status}）`;
    return `接口拒绝（HTTP ${error.status}${error.code ? ` ${error.code}` : ""}）`;
  }
  const message = errorText(error);
  if (/timeout|超时|aborted/i.test(message)) return "接口超时";
  if (/缺少 Parameter Store 配置/.test(message)) return message.slice(0, 80);
  return "取数失败";
}

async function writeSection(state: StateStore, key: SectionKey, entry: CachedSection): Promise<void> {
  await state.put({
    pk: CACHE_PK, sk: key, updatedAt: new Date().toISOString(),
    ...(entry.data !== undefined ? { payload: JSON.stringify(entry.data) } : {}),
    ...(entry.fetchedAt ? { fetchedAt: entry.fetchedAt } : {}),
    ...(entry.error ? { error: entry.error, errorAt: entry.errorAt } : {}),
    ...(entry.schema ? { schema: entry.schema } : {}),
  });
}

export interface RefreshOutcome { cache: SectionCache; refreshed: SectionKey[]; failed: SectionKey[]; busy: boolean }

// 刷新过期区块：同一时刻只允许一个刷新（租约 90 秒）；拿不到租约说明别处正在刷新，直接返回当前缓存。
export async function refreshSections(ctx: SourceContext, cache: SectionCache, keys: SectionKey[], owner: string): Promise<RefreshOutcome> {
  if (!keys.length) return { cache, refreshed: [], failed: [], busy: false };
  if (!(await ctx.state.acquireLease(LEASE_SCOPE, "refresh", owner, 90_000))) return { cache: await readCache(ctx.state), refreshed: [], failed: [], busy: true };
  const next: SectionCache = { ...cache };
  const failed: SectionKey[] = [];
  try {
    const results = await Promise.allSettled(keys.map((key) => LOADERS[key](ctx)));
    const at = new Date(ctx.now()).toISOString();
    for (const [index, key] of keys.entries()) {
      const result = results[index]!;
      if (result.status === "fulfilled") next[key] = { data: result.value, fetchedAt: at, schema: CACHE_SCHEMA };
      else {
        failed.push(key);
        // 失败保留旧值与旧格式版本：旧格式的数据在退避期过后仍会被重取。
        const { data, fetchedAt, schema } = cache[key] ?? {};
        const error = describeError(result.reason);
        log("WARN", "portal_section_failed", { section: key, error, code: result.reason instanceof HttpError ? result.reason.code : "" });
        next[key] = { ...(data !== undefined ? { data } : {}), ...(fetchedAt ? { fetchedAt } : {}), ...(schema ? { schema } : {}), error, errorAt: at };
      }
      await writeSection(ctx.state, key, next[key]!);
    }
  } finally {
    await ctx.state.releaseLease(LEASE_SCOPE, "refresh", owner);
  }
  return { cache: next, refreshed: keys.filter((key) => !failed.includes(key)), failed, busy: false };
}
