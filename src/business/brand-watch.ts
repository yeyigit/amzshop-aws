import type { AppConfig, JobEvent, JsonObject } from "../types.js";
import { AmazonClient, type Pace } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { flushNotification, prepareNotification } from "../notifications.js";
import { log } from "../log.js";
import { errorText, nowIso, timeMs } from "../util.js";
import { OFFER_MARKETS, fetchOwnListings, member, watchedMarkets, type ListingEntry, type OfferMarket } from "./offers.js";

// Catalog Items searchCatalogItems / getCatalogItem 官方 2 次/秒。
export const CATALOG_PACE: Pace = { key: "catalog-items", minIntervalMs: 600 };
export const BRAND_SEARCH_MAX_PAGES = 5;
const BRAND_CACHE_MS = 7 * 24 * 3_600_000;
const LISTINGS_CACHE_MS = 26 * 3_600_000;
const SIMILAR_MIN = 0.3;
const STOP_WORDS = new Set(["and", "for", "the", "with", "toy", "toys", "kids", "baby", "para", "con", "los", "las", "del", "de", "y", "pour", "avec", "les", "des"]);

const text = (value: unknown): string => String(value ?? "").trim();
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const normalizeBrand = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();

export function titleTokens(title: string, brand: string): Set<string> {
  const skip = normalizeBrand(brand);
  return new Set(title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && word !== skip && !STOP_WORDS.has(word)));
}

export function titleSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

// 按标题相似度猜对方仿的是本店哪个 SKU（先比同站点，再比其它站点）；低于阈值就说明对不上，不硬猜。
export function closestSkuHint(title: string, brand: string, indexes: ReadonlyMap<string, Record<string, ListingEntry>>, marketplaceId: string): string {
  const target = titleTokens(title, brand);
  const pools = [indexes.get(marketplaceId) ?? {}, ...[...indexes].filter(([id]) => id !== marketplaceId).map(([, index]) => index)];
  let best = { score: 0, skus: [] as string[] };
  for (const pool of pools) {
    for (const entry of Object.values(pool)) {
      const score = titleSimilarity(target, titleTokens(entry.title, brand));
      if (score > best.score) best = { score, skus: entry.skus };
    }
  }
  return best.score >= SIMILAR_MIN ? `疑似对应你的 SKU：${best.skus.join("、")}（标题相似 ${Math.round(best.score * 100)}%）` : "未能对应到你的 SKU（标题差异较大）";
}

export function brandWatchLines(market: OfferMarket, brand: string, asin: string, title: string, hint: string): string[] {
  return [
    `🔎 发现冒用你品牌的 listing（${market.label}）`,
    `品牌：${brand}`,
    `对方 ASIN：${asin}`,
    `链接：https://${market.domain}/dp/${asin}`,
    `标题：${title ? title.slice(0, 80) : "（无标题）"}`,
    hint,
    "这个 ASIN 不在你任何站点的 listing 里；确认不是你的后，可在品牌备案后台举报。",
  ];
}

// 品牌名：优先 BRAND_WATCH_BRANDS（逗号分隔）；否则用 7 天内的缓存；再否则抽查本店有报价的商品目录品牌，只取出现最多的一个（避免把代售的他牌当成自有品牌）。
async function resolveBrands(config: AppConfig, state: StateStore, amazon: AmazonClient, indexes: ReadonlyMap<string, Record<string, ListingEntry>>): Promise<string[]> {
  const configured = config.optional("BRAND_WATCH_BRANDS", "").split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
  if (configured.length) return [...new Set(configured)];
  const cached = await state.get("OFFER_META", "brands");
  const cachedBrands = list(cached?.brands).map(text).filter(Boolean);
  if (cachedBrands.length && Date.now() - timeMs(cached?.refreshedAt) < BRAND_CACHE_MS) return cachedBrands;
  const samples: Array<[string, string]> = [];
  for (const [marketplaceId, index] of indexes) for (const [asin, entry] of Object.entries(index)) if (entry.hasOffer) samples.push([marketplaceId, asin]);
  samples.sort(([left], [right]) => Number(right === "ATVPDKIKX0DER") - Number(left === "ATVPDKIKX0DER"));
  const tally = new Map<string, number>();
  const seen = new Set<string>();
  for (const [marketplaceId, asin] of samples) {
    if (seen.has(asin) || seen.size >= 10) continue;
    seen.add(asin);
    try {
      const item = await amazon.sp<JsonObject>(`/catalog/2022-04-01/items/${encodeURIComponent(asin)}`, { query: { marketplaceIds: marketplaceId, includedData: "summaries" }, pace: CATALOG_PACE });
      const brand = text(member(list(member(item, "summaries"))[0], "brand"));
      if (brand) tally.set(brand, (tally.get(brand) ?? 0) + 1);
    } catch (error) {
      log("WARN", "brand_watch_catalog_failed", { asin, error: errorText(error).slice(0, 200) });
    }
  }
  const top = [...tally].sort((left, right) => right[1] - left[1])[0]?.[0];
  if (!top) return cachedBrands;
  await state.put({ pk: "OFFER_META", sk: "brands", brands: [top], refreshedAt: nowIso(), updatedAt: nowIso() });
  return [top];
}

async function searchBrand(amazon: AmazonClient, marketplaceId: string, brand: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let pageToken = "";
  for (let page = 0; page < BRAND_SEARCH_MAX_PAGES; page += 1) {
    const response = await amazon.sp<JsonObject>("/catalog/2022-04-01/items", { query: { marketplaceIds: marketplaceId, keywords: brand, brandNames: brand, includedData: "summaries", pageSize: 20, ...(pageToken ? { pageToken } : {}) }, pace: CATALOG_PACE });
    items.push(...list(response.items));
    pageToken = text(member(member(response, "pagination"), "nextToken"));
    if (!pageToken) break;
  }
  return items;
}

// 每日品牌冒用检查：按“关键词＋品牌过滤”搜各站点目录，品牌一致且不属于本店任何站点 listing 的 ASIN 每个站点只提醒一次。
// 本店 listing 读取失败时用 26 小时内的缓存，没有缓存就让任务失败（宁可不查也不把自家 ASIN 报成冒用）。
export async function runBrandWatch(_event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient): Promise<JsonObject> {
  const own = config.get("SP_API_SELLER_ID");
  const markets = watchedMarkets(config);
  const indexes = new Map<string, Record<string, ListingEntry>>();
  for (const marketplaceId of markets) {
    try {
      const index = await fetchOwnListings(amazon, own, marketplaceId);
      indexes.set(marketplaceId, index);
      await state.put({ pk: "OFFER_LISTINGS", sk: marketplaceId, asins: index, refreshedAt: nowIso(), updatedAt: nowIso() });
    } catch (error) {
      const saved = await state.get("OFFER_LISTINGS", marketplaceId);
      if (!saved?.asins || Date.now() - timeMs(saved.refreshedAt) >= LISTINGS_CACHE_MS) throw new Error(`本店 ${OFFER_MARKETS[marketplaceId]?.code ?? marketplaceId} listing 读取失败且无 26 小时内的缓存，无法判断哪些 ASIN 属于本店：${errorText(error).slice(0, 200)}`);
      indexes.set(marketplaceId, saved.asins as Record<string, ListingEntry>);
    }
  }
  const ownAsins = new Set([...indexes.values()].flatMap((index) => Object.keys(index)));
  const brands = await resolveBrands(config, state, amazon, indexes);
  if (!brands.length) throw new Error("未能确定本店品牌名，请配置 BRAND_WATCH_BRANDS。");
  let searched = 0, results = 0, candidates = 0, notified = 0;
  for (const marketplaceId of markets) {
    const market = OFFER_MARKETS[marketplaceId];
    if (!market) continue;
    for (const brand of brands) {
      const items = await searchBrand(amazon, marketplaceId, brand);
      searched += 1;
      results += items.length;
      for (const item of items) {
        const asin = text(member(item, "asin")).toUpperCase();
        const summaries = list(member(item, "summaries"));
        const summary = summaries.find((entry) => text(member(entry, "marketplaceId")) === marketplaceId) ?? summaries[0];
        if (!asin || ownAsins.has(asin) || normalizeBrand(text(member(summary, "brand"))) !== normalizeBrand(brand)) continue;
        candidates += 1;
        const sk = `${marketplaceId}|${asin}`;
        if (await state.get("BRAND_WATCH", sk)) continue;
        const title = text(member(summary, "itemName"));
        const eventKey = `brand-watch|${sk}`;
        const prepared = await prepareNotification(config, state, eventKey, brandWatchLines(market, brand, asin, title, closestSkuHint(title, brand, indexes, marketplaceId)));
        await state.put({ pk: "BRAND_WATCH", sk, marketplaceId, asin, brand: text(member(summary, "brand")), title: title.slice(0, 200), firstSeenAt: nowIso(), notificationKey: eventKey, updatedAt: nowIso() });
        await flushNotification(state, feishu, eventKey, prepared);
        notified += 1;
      }
    }
  }
  return { status: "done", markets: markets.length, brands: brands.length, ownAsins: ownAsins.size, searched, results, candidates, notified };
}
