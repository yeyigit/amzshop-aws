import { losAngelesTimeMs } from "../util.js";
import { HOME_ZONE, SITE_ZONE, clockLabel, greeting, siteHourOfDay, zonedParts } from "./clock.js";
import {
  METRIC, adsBillingView, dailySeries, last30, paceFor, paceSeries, skuPace,
  type AdsBillingData, type AdsBillingView, type AdsDay, type AdsView, type BalanceLine, type DailyPoint, type FeedItem, type FundsData, type InventoryRow, type PaceResult, type PayoutLine, type ShipmentSummary, type SkuFlag, type StockFact, type TrafficMetric,
} from "./metrics.js";
import type { PortalLinks } from "./links.js";
import {
  SECTION_KEYS, staleSections,
  type AdsTodayData, type DatedAds, type DatedCatalog, type DatedOrders, type DatedSales, type FeedData, type LiveData, type SaleView, type SectionCache, type SectionKey, type StoreHealthView,
} from "./sources.js";

// 把各区块缓存组装成页面数据（卖家后台式：“全局快照”指标格 + “商品绩效”表）。纯函数，“此刻”按请求时间重算。
// 10/08 用户改名（原“AMZ店铺中台”太长）；配置 PORTAL_TITLE 可覆盖。
export const DEFAULT_TITLE = "AMZ中台";
export type KpiView = PaceResult;
export interface AdSpendView { today: number; campaigns: number; updatedAt: string; shareOfSales: number | null; avgDaily: number | null }
export interface FundsView { total: number | null; available: number | null; currency: string; lines: BalanceLine[]; next: PayoutLine | null }
export interface FeaturedView { selling: number; won: number; lost: Array<{ sku: string; asin: string; holder: string }>; hijacked: number }
export interface StockAlertView { risk: number; soon: number; items: Array<{ sku: string; level: string; reason: string }> }
// 压货（库存健康报告）：冗余款数、下月仓储与超龄附加费估算（2026-10-11）。
export interface AgingView { snapshotDate: string; excessSkus: number; excess: string[]; storageNextMonth: number; aisNextMonth: number; aged181: number }
export interface ProductRow {
  sku: string; asin: string; title: string; image: string; buyable: boolean | null; price: number | null;
  todayUnits: number; todayOrders: number; avgDailyUnits: number; expectedSoFar: number | null; flag: SkuFlag; lastOrderAt: string; lastOrderAgoMin: number | null;
  units30: number | null; sales30: number | null;
  fulfillable: number | null; inbound: number | null; fbaDays: number | null; stockLevel: string; stockReason: string;
  aged181: number | null; excessStock: boolean; storageNextMonth: number | null; monthsToClear: number | null;
  buyBox: string; holder: string; hijackers: number | null;
  competitor: { count: number; priced: number; minPrice: number | null; promos: number; drops: number } | null;
  sessions: TrafficMetric | null;
  links: { detail: string; reviews: string };
}
export interface SourceView { key: SectionKey; label: string; fetchedAt: string; error: string; note: string }
export interface PortalView {
  title: string; generatedAt: string; today: string; laClock: string; bjClock: string; greeting: string; currency: string;
  user: { name: string; avatar: string };
  kpis: { sales: KpiView | null; units: KpiView | null; orders: KpiView | null };
  daily: DailyPoint[];
  pace: { avg: number[] | null; today: Array<[number, number]>; nowHour: number } | null;
  pendingOrders: number | null; featured: FeaturedView | null; adSpend: AdSpendView | null; adDay: AdsDay | null; funds: FundsView | null;
  // 广告账单（10/10 替换“竞品降价”格）：累积费用与预计扣款日；sale 只用于商品表竞品列的“大促加密中”标记。
  adsBilling: AdsBillingView | null; stockAlerts: StockAlertView | null; sale: SaleView | null; shipments: ShipmentSummary | null;
  // 账户与 Listing 健康、压货（2026-10-11）：没有数据时为 null。
  storeHealth: StoreHealthView | null; aging: AgingView | null;
  products: ProductRow[]; ads: AdsView | null; feed: FeedItem[];
  sources: SourceView[]; stale: SectionKey[];
  // 可点数字跳飞书多维表格（表、视图或仪表盘），没配网址时为空对象。
  links: PortalLinks;
}
export interface ViewOptions { nowMs: number; title: string; user: { name: string; avatar: string }; asinBySku: Record<string, string>; links?: PortalLinks }

const LABELS: Record<SectionKey, string> = {
  sales: "销售额、销量、订单（Sales API）", orders: "商品近 30 天与待处理订单（飞书订单表）", adsToday: "今日广告花费（广告预算表）", funds: "余额与放款（亚马逊资金接口）",
  adsBilling: "广告账单（广告 API 发票）",
  ads: "广告近 7 日（广告每日总览、活动日报）", inventory: "库存可售天数与预警（库存预警表）", live: "购物车、跟卖、竞品、会话、店铺健康、压货（系统状态）", feed: "近 7 天动态（系统已发消息）",
  catalog: "商品主图、标题、状态、价格（Listings）", stock: "FBA 可售库存（FBA Inventory）", shipments: "货件概况（飞书货件表）",
};

const dataOf = <T>(cache: SectionCache, key: SectionKey): T | undefined => cache[key]?.data as T | undefined;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const validAsin = (value: string): string => /^[A-Z0-9]{10}$/.test(value) ? value : "";

function notes(cache: SectionCache, today: string): Record<SectionKey, string> {
  const ads = dataOf<DatedAds | null>(cache, "ads");
  const inventory = dataOf<InventoryRow[]>(cache, "inventory");
  const live = dataOf<LiveData>(cache, "live");
  const adsToday = dataOf<AdsTodayData>(cache, "adsToday");
  const evalDay = Object.values(live?.traffic ?? {}).map((item) => item.sessions?.evalDay ?? "").filter(Boolean).sort().at(-1);
  const competitorRun = live?.health["competitor-prices"];
  const cadence = live?.sale?.active ? "大促加密中、每 2 小时比价" : "竞品价格平时每天 14:00（北京）比价、大促期间每 2 小时";
  return {
    sales: `按洛杉矶站点日 ${today}，与亚马逊后台口径一致，延迟约几分钟`,
    orders: "订单消息几分钟内写入；不含已取消；“最近 30 天”为今天之前的 30 个完整日",
    adsToday: `随亚马逊预算消息更新${adsToday?.updatedAt ? `，最近一条 ${adsToday.updatedAt}（洛杉矶）` : ""}`,
    funds: "实时查询，30 分钟缓存",
    adsBilling: "累积费用实时查询，30 分钟缓存；预计扣款日按近期发票与近 7 日广告花费估算",
    ads: ads ? `前一天完整数据，截至 ${ads.latest}` : "前一天完整数据",
    inventory: `每天 09:00（北京）更新${inventory?.[0]?.dataTime ? `，${inventory[0].dataTime}` : ""}`,
    live: `购物车与跟卖实时；${cadence}${competitorRun ? `，上次 ${clockLabel(Date.parse(competitorRun), HOME_ZONE)}` : ""}；会话约晚 2 天${evalDay ? `，截至 ${evalDay}` : ""}；账户健康每 6 小时、listing 每小时、库存健康每天 09:15（北京）更新`,
    feed: "复用系统已发出的业务消息",
    catalog: "6 小时缓存",
    stock: "实时查询，15 分钟缓存",
    shipments: "亚马逊货件状态每天 08:00（北京）同步到货件表；只计未完成入库的货件，30 分钟缓存",
  };
}

export function buildView(cache: SectionCache, options: ViewOptions): PortalView {
  const { nowMs } = options;
  const today = zonedParts(nowMs, SITE_ZONE).ymd;
  const nowHour = siteHourOfDay(nowMs);
  const sales = dataOf<DatedSales>(cache, "sales");
  const salesToday = sales && sales.today === today ? sales : undefined;
  const kpi = (metric: 0 | 1 | 2): KpiView | null => salesToday ? paceFor(salesToday, today, nowHour, metric) : null;
  const kpis = { sales: kpi(METRIC.sales), units: kpi(METRIC.units), orders: kpi(METRIC.orders) };

  const ads = dataOf<DatedAds | null>(cache, "ads") ?? null;
  const adsTodayData = dataOf<AdsTodayData>(cache, "adsToday");
  const adSpend: AdSpendView | null = adsTodayData && adsTodayData.today === today ? {
    today: adsTodayData.spend, campaigns: adsTodayData.campaigns, updatedAt: adsTodayData.updatedAt,
    shareOfSales: kpis.sales && kpis.sales.value > 0 ? adsTodayData.spend / kpis.sales.value : null, avgDaily: ads?.avgDailySpend ?? null,
  } : null;

  const fundsData = dataOf<FundsData>(cache, "funds");
  const currency = fundsData?.balances.find((line) => line.currency)?.currency || salesToday?.currency || "USD";
  const sameCurrency = (fundsData?.balances ?? []).filter((line) => line.currency === currency);
  const total = (values: Array<number | null>): number | null => values.some((value) => value !== null) ? round2(values.reduce<number>((sum, value) => sum + (value ?? 0), 0)) : null;
  const funds: FundsView | null = fundsData ? { total: total(sameCurrency.map((line) => line.total)), available: total(sameCurrency.map((line) => line.available)), currency, lines: fundsData.balances, next: fundsData.next } : null;
  const billing = dataOf<AdsBillingData>(cache, "adsBilling");
  const adsBilling = billing ? adsBillingView(billing, nowMs, ads?.avgDailySpend ?? null) : null;

  const orders = dataOf<DatedOrders>(cache, "orders");
  const ordersToday = orders && orders.today === today ? orders : undefined;
  const inventory = dataOf<InventoryRow[]>(cache, "inventory") ?? [];
  const catalog = dataOf<DatedCatalog>(cache, "catalog")?.items ?? [];
  const stock = dataOf<Record<string, StockFact>>(cache, "stock");
  const live = dataOf<LiveData>(cache, "live");
  const feed = dataOf<FeedData>(cache, "feed");
  const inventoryBySku = new Map(inventory.map((row) => [row.sku, row]));
  const catalogBySku = new Map(catalog.map((item) => [item.sku, item]));
  const unitsShare = kpis.units?.share ?? null;
  // 商品＝listing ∪ 近 31 天有单的 SKU ∪ 库存预警里的 SKU（listing 取不到时表格照样有行）。
  const skus = [...new Set([...catalog.map((item) => item.sku), ...Object.keys(ordersToday?.skus ?? {}), ...inventory.filter((row) => row.level !== "已停用").map((row) => row.sku)])];
  const products: ProductRow[] = skus.map((sku) => {
    const item = catalogBySku.get(sku);
    const alert = inventoryBySku.get(sku);
    const asin = validAsin((item?.asin || options.asinBySku[sku] || alert?.asin || "").toUpperCase());
    const entry = ordersToday?.skus[sku];
    const pace = skuPace(entry, unitsShare);
    const recent = ordersToday ? last30(entry) : null;
    const lastMs = entry?.last ? losAngelesTimeMs(entry.last) : 0;
    const offer = asin ? live?.offers[asin] : undefined;
    const rivals = live?.competitors[sku];
    const facts = stock?.[sku];
    const aging = live?.inventoryHealth?.skus[sku];
    return {
      sku, asin, title: item?.title || alert?.name || sku, image: item?.image ?? "", buyable: item ? item.buyable : null, price: item?.price ?? null,
      ...pace, lastOrderAt: entry?.last ?? "", lastOrderAgoMin: lastMs ? Math.max(0, Math.round((nowMs - lastMs) / 60_000)) : null,
      units30: recent?.units ?? null, sales30: recent?.sales ?? null,
      fulfillable: facts ? facts.fulfillable : alert?.fbaAvailable ?? null, inbound: facts ? facts.inbound : null,
      fbaDays: alert?.fbaDays ?? null, stockLevel: alert?.level ?? "", stockReason: alert?.reason ?? "",
      aged181: aging ? aging.aged181 : null, excessStock: aging?.status === "Excess", storageNextMonth: aging?.storageNextMonth ?? null, monthsToClear: aging?.monthsToClear ?? null,
      buyBox: offer?.buyBox ?? "unknown", holder: offer?.holder ?? "", hijackers: offer ? offer.hijackers : null,
      competitor: rivals ? { count: rivals.asins.length, priced: rivals.priced, minPrice: rivals.minPrice, promos: rivals.promos, drops: rivals.asins.reduce((sum, rival) => sum + (feed?.drops[rival] ?? 0), 0) } : null,
      sessions: (asin ? live?.traffic[asin]?.sessions : undefined) ?? null,
      links: { detail: asin ? `https://www.amazon.com/dp/${asin}` : "", reviews: asin ? `https://www.amazon.com/product-reviews/${asin}?sortBy=recent` : "" },
    };
  });

  // 推荐报价（购物车）：本店在售且状态已知的美国站商品里，此刻持有购物车的比例。
  let featured: FeaturedView | null = null;
  if (live) {
    const own = Object.entries(live.offers).filter(([, offer]) => offer.selling && offer.buyBox !== "unknown");
    const skuByAsin = new Map(products.filter((row) => row.asin).map((row) => [row.asin, row.sku]));
    featured = {
      selling: own.length, won: own.filter(([, offer]) => offer.buyBox === "won").length,
      lost: own.filter(([, offer]) => offer.buyBox === "lost").map(([asin, offer]) => ({ asin, sku: skuByAsin.get(asin) ?? "", holder: offer.holder })),
      hijacked: Object.values(live.offers).filter((offer) => offer.selling && offer.hijackers > 0).length,
    };
  }
  const stockAlerts: StockAlertView | null = inventory.length ? {
    risk: inventory.filter((row) => row.level === "FBA断货风险").length, soon: inventory.filter((row) => row.level === "紧急补货" || row.level === "即将补货").length,
    items: inventory.filter((row) => row.level && row.level !== "正常" && row.level !== "已停用").map((row) => ({ sku: row.sku, level: row.level, reason: row.reason })),
  } : null;

  const inventoryHealth = live?.inventoryHealth ?? null;
  const aging: AgingView | null = inventoryHealth ? {
    snapshotDate: inventoryHealth.snapshotDate, excessSkus: inventoryHealth.excessSkus, excess: Object.entries(inventoryHealth.skus).filter(([, item]) => item.status === "Excess").map(([sku]) => sku),
    storageNextMonth: inventoryHealth.storageNextMonth, aisNextMonth: inventoryHealth.aisNextMonth, aged181: Object.values(inventoryHealth.skus).reduce((sum, item) => sum + item.aged181, 0),
  } : null;

  const noteText = notes(cache, today);
  const sources: SourceView[] = SECTION_KEYS.map((key) => ({ key, label: LABELS[key], fetchedAt: cache[key]?.fetchedAt ?? "", error: cache[key]?.error ?? "", note: noteText[key] }));
  return {
    title: options.title || DEFAULT_TITLE, generatedAt: new Date(nowMs).toISOString(), today,
    laClock: clockLabel(nowMs, SITE_ZONE), bjClock: clockLabel(nowMs, HOME_ZONE), greeting: greeting(nowMs), currency,
    user: options.user, kpis, daily: salesToday ? dailySeries(salesToday, today) : [],
    pace: salesToday ? { ...paceSeries(salesToday, today, nowHour, METRIC.sales), nowHour: Math.round(nowHour * 1000) / 1000 } : null,
    pendingOrders: ordersToday ? ordersToday.pendingOrders : null, featured, adSpend, adDay: ads?.day ?? null, funds, adsBilling, stockAlerts,
    sale: live?.sale ?? null, shipments: dataOf<ShipmentSummary>(cache, "shipments") ?? null, storeHealth: live?.storeHealth ?? null, aging,
    products, ads, feed: feed?.items ?? [], sources, stale: staleSections(cache, nowMs), links: options.links ?? {},
  };
}
