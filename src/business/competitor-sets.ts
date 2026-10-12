import type { AppConfig, AsinMapping, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { flushNotification, prepareNotification, type PreparedNotification } from "../notifications.js";
import { log } from "../log.js";
import { addDaysYmd, errorText, ownerId, parseJson, timeMs, ymdInZone } from "../util.js";
import { COMPETITIVE_SUMMARY_BATCH, MARKETPLACE_US, PRICE_SUMMARY_DATA, competitiveSummaries, type SummaryView } from "./competitive.js";
import { fetchOwnListings, member, money, type ListingEntry } from "./offers.js";
import { CATALOG_PACE } from "./brand-watch.js";

// 竞品自动维护（规则见 docs/模块说明.md「竞品自动维护」）：人工竞品（SSM asin/ 的 competitors）只读、永远保留且计入上限；
// 自动竞品每 7 天按亚马逊“相似商品”刷新一次，清单只存状态表 COMPETITOR_SET/<自有ASIN>，比价任务读“人工 ∪ 自动”。
export const COMPETITOR_SET_PK = "COMPETITOR_SET";
export const COMPETITOR_META_PK = "COMPETITOR_SET_META";
export const COMPETITOR_HEALTH = "competitor-sets";
export const COMPETITOR_REFRESH_DAYS = 7;
export const COMPETITOR_DROP_AFTER = 3;
export const COMPETITOR_MAX_PER_PRODUCT_DEFAULT = 10;
// 一次刷新最多 12 批 getCompetitiveSummary（相似商品＋候选报价，每批 ≤20 个、批间 31 秒，约 6 分钟），给同一轮比价留出 900 秒内的余量。
export const COMPETITOR_REFRESH_MAX_BATCHES = 12;
const LEASE_SCOPE = "competitor-sets";
const LEASE_MS = 900_000;
const LISTINGS_CACHE_MS = 26 * 3_600_000;
const CATALOG_BATCH = 20;
const MESSAGE_MAX_LINES = 80;

const text = (value: unknown): string => String(value ?? "").trim();
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const asinOf = (value: unknown): string => text(value).toUpperCase();
const validAsin = (value: string): boolean => /^[A-Z0-9]{10}$/.test(value);
const normalizeBrand = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();

// excludedFor / keywords 的键是小写的 SKU 或自有 ASIN。
export interface CompetitorSettings { enabled: boolean; perProduct: number; total: number; excluded: Set<string>; excludedFor: Map<string, Set<string>>; keywords: Map<string, string[][]>; sellerId: string; brands: string[] }

function whole(config: AppConfig, key: string, fallback: number): number {
  const raw = config.optional(key, "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key} 必须是不小于 0 的整数。`);
  return value;
}

// “非常相似”判定（用户 2026-10-06：上限是最多、不强行补满，必须同款或非常相似）：只看商品“是什么”的词，去掉品牌与通用词。
// 用生产商品与竞品对校准：标题核心词能分开用户认定的好坏，细分类目（浏览节点）与商品类型都分不开。
const GENERIC_WORDS = new Set([
  "baby", "toy", "kid", "toddler", "infant", "newborn", "child", "children", "boy", "girl", "unisex", "adult", "teen", "month", "year", "old", "age", "yr",
  "gift", "birthday", "christmas", "holiday", "idea", "learning", "learn", "educational", "education", "montessori", "sensory", "musical", "music", "sound",
  "light", "led", "set", "piece", "pcs", "pack", "early", "development", "developmental", "game", "fun", "best", "new", "perfect", "great", "cute", "colorful",
  "interactive", "electronic", "play", "activity", "time", "plu", "plus", "premium", "quality", "durable", "safe", "free", "bpa", "mini", "small", "large", "big",
  "for", "with", "and", "the", "from", "your", "you", "this", "that", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "first",
]);
const singular = (word: string): string =>
  word.length > 4 && word.endsWith("ies") ? `${word.slice(0, -3)}y`
    : word.length > 4 && /(x|ch|sh|ss|z)es$/.test(word) ? word.slice(0, -2)
      : word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;

export function titleWords(title: string, drop: ReadonlySet<string> = new Set()): string[] {
  return title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !/\d/.test(word)).map(singular).filter((word) => !GENERIC_WORDS.has(word) && !drop.has(word));
}

// 核心词＝标题第一段（截到第一个逗号、冒号、分号、括号、带空格的破折号或 with 之前）去掉品牌与通用词；第一段没有就退回全标题。
const SEGMENT_BREAK = /[,，|:：;；(（]| [-–—] | with | w\/ /i;
export function productCore(title: string, brand: string): string[] {
  const brandWords = new Set(titleWords(brand));
  const head = [...new Set(titleWords(title.split(SEGMENT_BREAK)[0] ?? "", brandWords))];
  return head.length ? head : [...new Set(titleWords(title, brandWords))];
}

// 判定函数：配置了关键词（COMPETITOR_KEYWORDS_JSON）时命中任一短语即可；否则竞品标题须命中核心词（≥2 个时至少 2 个）。
// 不知道本店商品标题（如不在售商品）时返回 undefined＝不做相似判定；知道标题却取不到核心词时一律不算相似（宁缺毋滥）。
export function productMatcher(product: { asin: string; skus: readonly string[]; title?: string; brand?: string }, keywords?: ReadonlyMap<string, string[][]>): ((competitorTitle: string) => boolean) | undefined {
  const phrases = [product.asin, ...product.skus].map((key) => keywords?.get(key.toLowerCase())).find((value) => value?.length);
  if (phrases) return (title) => { const words = new Set(titleWords(title)); return phrases.some((phrase) => phrase.every((word) => words.has(word))); };
  if (!product.title) return undefined;
  const core = productCore(product.title, product.brand ?? "");
  const need = Math.min(2, core.length);
  return (title) => { const words = new Set(titleWords(title)); return need > 0 && core.filter((word) => words.has(word)).length >= need; };
}

export function productExclusions(settings: Partial<Pick<CompetitorSettings, "excludedFor">>, product: string, skus: readonly string[]): Set<string> {
  const output = new Set<string>();
  for (const key of [product, ...skus]) for (const asin of settings.excludedFor?.get(key.toLowerCase()) ?? []) output.add(asin);
  return output;
}

function keywordMap(raw: string): Map<string, string[][]> {
  const output = new Map<string, string[][]>();
  if (!raw.trim()) return output;
  const parsed = parseJson<unknown>(raw, "COMPETITOR_KEYWORDS_JSON");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("COMPETITOR_KEYWORDS_JSON 必须是 {SKU或自有ASIN: [关键词或短语]} 的 JSON 对象。");
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) throw new Error(`COMPETITOR_KEYWORDS_JSON 的 ${key.slice(0, 40)} 必须是关键词数组。`);
    const phrases = value.map((item) => titleWords(String(item))).filter((words) => words.length);
    if (key.trim() && phrases.length) output.set(key.trim().toLowerCase(), phrases);
  }
  return output;
}

// 上限语义：COMPETITOR_MAX_PER_PRODUCT 按自有商品（ASIN）计人工＋自动；COMPETITOR_MAX_TOTAL（可选，0 或不配＝不限）按全店不同竞品 ASIN 计。
// COMPETITOR_EXCLUDE_ASINS：竞品 ASIN＝全店排除；<SKU或自有ASIN>:<竞品ASIN>＝只对该商品排除。
// 配置对象不可读（只读诊断、极简测试配置）时返回 undefined：只比价人工竞品，不读写任何自动清单。
export function competitorSettings(config: AppConfig): CompetitorSettings | undefined {
  if (typeof config?.optional !== "function") return undefined;
  const tokens = config.optional("COMPETITOR_EXCLUDE_ASINS", "").split(/[\s,，、;；]+/).map((item) => item.trim()).filter(Boolean);
  const excludedFor = new Map<string, Set<string>>();
  for (const token of tokens.filter((item) => /[:：]/.test(item))) {
    const [product = "", competitor = ""] = token.split(/[:：]/);
    const target = asinOf(competitor);
    if (product.trim() && validAsin(target)) excludedFor.set(product.trim().toLowerCase(), new Set([...(excludedFor.get(product.trim().toLowerCase()) ?? []), target]));
  }
  return {
    enabled: typeof config.bool === "function" ? config.bool("COMPETITOR_AUTO_ENABLED", true) : true,
    perProduct: whole(config, "COMPETITOR_MAX_PER_PRODUCT", COMPETITOR_MAX_PER_PRODUCT_DEFAULT),
    total: whole(config, "COMPETITOR_MAX_TOTAL", 0),
    excluded: new Set(tokens.filter((item) => !/[:：]/.test(item)).map(asinOf).filter(validAsin)),
    excludedFor,
    keywords: keywordMap(config.optional("COMPETITOR_KEYWORDS_JSON", "")),
    sellerId: config.optional("SP_API_SELLER_ID", "").trim(),
    brands: config.optional("BRAND_WATCH_BRANDS", "").split(/[,，、]/).map((item) => item.trim()).filter(Boolean),
  };
}

export interface ManualIndex { byProduct: Map<string, Set<string>>; all: Set<string> }

export function manualIndex(mappings: AsinMapping[]): ManualIndex {
  const byProduct = new Map<string, Set<string>>();
  const all = new Set<string>();
  for (const mapping of mappings) {
    const product = asinOf(mapping.asin);
    for (const competitor of mapping.competitors.map(asinOf).filter(Boolean)) {
      all.add(competitor);
      if (product) byProduct.set(product, new Set([...(byProduct.get(product) ?? []), competitor]));
    }
  }
  return { byProduct, all };
}

export interface SlotQueue { product: string; manual: ReadonlySet<string>; entries: string[] }

// 名额分配：每个自有商品人工先占名额，自动的按队列顺序补到 perProduct 为止；配置了全店上限时，人工先占（按不同 ASIN 计），
// 剩余名额按“各商品第 1 个、各商品第 2 个……”轮流分配。队列里已跟踪的排在新候选之前，所以新候选不会挤掉已跟踪的。
export function allocateSlots(queues: SlotQueue[], perProduct: number, total: number, manualAll: ReadonlySet<string>): Map<string, string[]> {
  const capped = [...queues].sort((left, right) => left.product.localeCompare(right.product)).map((queue) => ({
    product: queue.product,
    entries: [...new Set(queue.entries)].filter((asin) => !queue.manual.has(asin) && asin !== queue.product).slice(0, Math.max(0, perProduct - queue.manual.size)),
  }));
  const result = new Map<string, string[]>(capped.map((queue) => [queue.product, total > 0 ? [] : queue.entries]));
  if (!(total > 0)) return result;
  let budget = Math.max(0, total - manualAll.size);
  const chosen = new Set<string>();
  const depth = Math.max(0, ...capped.map((queue) => queue.entries.length));
  for (let level = 0; level < depth; level += 1) {
    for (const queue of capped) {
      const asin = queue.entries[level];
      if (!asin) continue;
      if (!manualAll.has(asin) && !chosen.has(asin)) {
        if (budget <= 0) continue;
        budget -= 1;
        chosen.add(asin);
      }
      result.get(queue.product)?.push(asin);
    }
  }
  return result;
}

export interface AutoCompetitor { asin: string; addedAt: string; lastSeenAt: string; misses: number; missReason?: string; brand: string; title: string; price: number | null; salesRank: number | null; similarRank: number }
export interface CompetitorSet { pk: typeof COMPETITOR_SET_PK; sk: string; asin: string; skus: string[]; active: boolean; auto: AutoCompetitor[]; refreshSeq: number; refreshedAt: string; updatedAt: string }
export interface CandidateFacts { found: boolean; brand: string; title: string; groups: string[]; salesRank: number | null; offer: boolean; featured: boolean; price: number | null }
// similar 为 undefined 表示这次没取到（接口报错），清单原样保留；[] 表示亚马逊明确没有相似商品。
export interface ProductObservation { asin: string; skus: string[]; active: boolean; similar?: string[]; groups: string[]; title?: string; brand?: string }
export interface RemovedCompetitor { asin: string; brand: string; reason: string }
export interface ProductPlan { asin: string; skus: string[]; manual: number; previous?: CompetitorSet; next?: CompetitorSet; added: AutoCompetitor[]; removed: RemovedCompetitor[]; frozen: boolean }
export interface PlanInput {
  products: ProductObservation[];
  previous: ReadonlyMap<string, CompetitorSet>;
  manual: ManualIndex;
  facts: ReadonlyMap<string, CandidateFacts>;
  ownAsins: ReadonlySet<string>;
  ownBrands: ReadonlySet<string>;
  settings: Pick<CompetitorSettings, "perProduct" | "total" | "excluded"> & Partial<Pick<CompetitorSettings, "excludedFor" | "keywords">>;
  now: string;
  seq: number;
}

const disjoint = (left: readonly string[], right: readonly string[]): boolean => left.length > 0 && right.length > 0 && !left.some((item) => right.includes(item));

// 不合格原因（空串＝合格）；接在“连续 N 次刷新”之后读。取数失败（similar 为 undefined）不在这里判，由调用方原样保留。
function missReason(product: ProductObservation, asin: string, fact: CandidateFacts | undefined): string {
  if (!product.active) return "时本店商品不在售";
  if (!(product.similar ?? []).includes(asin)) return "不在亚马逊相似商品里";
  if (!fact?.found) return "在目录里查不到";
  if (!fact.offer) return "没有全新品报价";
  if (disjoint(product.groups, fact.groups)) return "与本店商品不在同一销售大类";
  return "";
}

interface Draft { product: ProductObservation; manual: ReadonlySet<string>; previous?: CompetitorSet; kept: AutoCompetitor[]; fresh: AutoCompetitor[]; removed: RemovedCompetitor[]; frozen: boolean }

function draftProduct(product: ProductObservation, input: PlanInput): Draft {
  const previous = input.previous.get(product.asin);
  const manual = input.manual.byProduct.get(product.asin) ?? new Set<string>();
  const base = { product, manual, ...(previous ? { previous } : {}) };
  // 同一刷新序号已写过（上次运行写到一半中断后重跑）：原样保留，避免重复累计“未出现”次数。
  const stored = list(previous?.auto) as AutoCompetitor[];
  if (previous && previous.refreshSeq === input.seq) return { ...base, kept: [...stored], fresh: [], removed: [], frozen: true };
  const observed = !product.active || product.similar !== undefined;
  const excludedHere = productExclusions(input.settings, product.asin, product.skus);
  const similarEnough = productMatcher(product, input.settings.keywords);
  const kept: AutoCompetitor[] = [];
  const removed: RemovedCompetitor[] = [];
  for (const entry of stored) {
    if (manual.has(entry.asin)) continue; // 已改为人工竞品：照常比价，只是不再占自动名额
    const fact = input.facts.get(entry.asin);
    const brand = fact?.found && fact.brand ? fact.brand : entry.brand;
    const title = [fact?.found ? fact.title : "", text(entry.title)].sort((left, right) => right.length - left.length)[0] ?? "";
    const immediate = input.ownAsins.has(entry.asin) || entry.asin === product.asin ? "本店商品"
      : brand && input.ownBrands.has(normalizeBrand(brand)) ? "本店品牌"
        : input.settings.excluded.has(entry.asin) || excludedHere.has(entry.asin) ? "已加入排除名单"
          : similarEnough && title && !similarEnough(title) ? "与本店商品不够相似" : "";
    if (immediate) { removed.push({ asin: entry.asin, brand, reason: immediate }); continue; }
    if (!observed) { kept.push(entry); continue; }
    const reason = missReason(product, entry.asin, fact);
    if (!reason && fact) {
      const { missReason: _reason, ...rest } = entry;
      kept.push({ ...rest, misses: 0, lastSeenAt: input.now, brand: fact.brand || entry.brand, title: fact.title || entry.title, price: fact.price, salesRank: fact.salesRank, similarRank: (product.similar ?? []).indexOf(entry.asin) + 1 });
      continue;
    }
    const misses = (Number(entry.misses) || 0) + 1;
    if (misses >= COMPETITOR_DROP_AFTER) removed.push({ asin: entry.asin, brand, reason: `连续 ${misses} 次刷新${reason}` });
    else kept.push({ ...entry, misses, missReason: reason });
  }
  kept.sort((left, right) => left.misses - right.misses || timeMs(left.addedAt) - timeMs(right.addedAt) || left.asin.localeCompare(right.asin));
  const fresh: Array<AutoCompetitor & { featured: boolean }> = [];
  if (product.active && product.similar) {
    const taken = new Set([...kept, ...removed].map((entry) => entry.asin));
    product.similar.forEach((asin, index) => {
      if (taken.has(asin) || manual.has(asin) || asin === product.asin || input.ownAsins.has(asin) || input.settings.excluded.has(asin) || excludedHere.has(asin)) return;
      const fact = input.facts.get(asin);
      if (!fact?.found || input.ownBrands.has(normalizeBrand(fact.brand)) || missReason(product, asin, fact)) return;
      if (similarEnough && !similarEnough(fact.title)) return;
      fresh.push({ asin, addedAt: input.now, lastSeenAt: input.now, misses: 0, brand: fact.brand.slice(0, 60), title: fact.title.slice(0, 120), price: fact.price, salesRank: fact.salesRank, similarRank: index + 1, featured: fact.featured });
    });
    // 新候选排序：有 Buy Box（featured offer）的在前 → 销售排名靠前的在前（无排名最后）→ 亚马逊相似商品顺序。
    fresh.sort((left, right) => Number(right.featured) - Number(left.featured) || (left.salesRank ?? Number.MAX_SAFE_INTEGER) - (right.salesRank ?? Number.MAX_SAFE_INTEGER) || left.similarRank - right.similarRank);
  }
  return { ...base, kept, fresh: fresh.map(({ featured: _featured, ...entry }) => entry), removed, frozen: false };
}

// 纯函数：由本轮观测与上次清单得出每个自有商品的新清单与变化（新增、移除及原因）。
export function planCompetitorSets(input: PlanInput): ProductPlan[] {
  const { perProduct, total } = input.settings;
  const drafts = input.products.map((product) => draftProduct(product, input));
  const allocation = allocateSlots(drafts.map((draft) => ({ product: draft.product.asin, manual: draft.manual, entries: [...draft.kept, ...draft.fresh].map((entry) => entry.asin) })), perProduct, total, input.manual.all);
  return drafts.map((draft) => {
    const { product, previous } = draft;
    const chosen = new Set(allocation.get(product.asin) ?? []);
    const skus = product.skus.length ? [...product.skus] : [...(previous?.skus ?? [])];
    const shared = { asin: product.asin, skus, manual: draft.manual.size, ...(previous ? { previous } : {}) };
    if (draft.frozen) return { ...shared, ...(previous ? { next: previous } : {}), added: [], removed: [], frozen: true };
    const slots = Math.max(0, perProduct - draft.manual.size);
    const kept = draft.kept.filter((entry) => chosen.has(entry.asin));
    const trimmed = draft.kept.filter((entry) => !chosen.has(entry.asin)).map((entry): RemovedCompetitor => ({ asin: entry.asin, brand: entry.brand, reason: draft.kept.indexOf(entry) >= slots ? `超出每个商品 ${perProduct} 个的上限` : `超出全店 ${total} 个的上限` }));
    const added = draft.fresh.filter((entry) => chosen.has(entry.asin));
    const auto = [...kept, ...added];
    const next: CompetitorSet | undefined = auto.length || product.active
      ? { pk: COMPETITOR_SET_PK, sk: product.asin, asin: product.asin, skus, active: product.active, auto, refreshSeq: input.seq, refreshedAt: input.now, updatedAt: input.now }
      : undefined;
    return { ...shared, ...(next ? { next } : {}), added, removed: [...draft.removed, ...trimmed], frozen: false };
  });
}

export interface CatalogFact { brand: string; title: string; groups: string[]; salesRank: number | null }

// 目录事实（searchCatalogItems 按 ASIN，每次 ≤20 个）：品牌、标题、销售大类与大类排名。销售大类优先取销售排名的 websiteDisplayGroup
// （实测有商品的目录展示大类是 baby、销售排名却在 toy，以排名为准）；新品还没有排名时退回目录展示大类。
export async function catalogFacts(amazon: AmazonClient, asins: string[]): Promise<Map<string, CatalogFact>> {
  const output = new Map<string, CatalogFact>();
  const unique = [...new Set(asins)];
  for (let offset = 0; offset < unique.length; offset += CATALOG_BATCH) {
    const chunk = unique.slice(offset, offset + CATALOG_BATCH);
    const response = await amazon.sp<JsonObject>("/catalog/2022-04-01/items", { query: { marketplaceIds: MARKETPLACE_US, identifiers: chunk.join(","), identifiersType: "ASIN", includedData: "summaries,salesRanks", pageSize: CATALOG_BATCH }, pace: CATALOG_PACE });
    for (const item of list(response.items)) {
      const asin = asinOf(member(item, "asin"));
      if (!asin) continue;
      const summaries = list(member(item, "summaries"));
      const summary = summaries.find((entry) => text(member(entry, "marketplaceId")) === MARKETPLACE_US) ?? summaries[0];
      const rankGroups = list(member(item, "salesRanks"));
      const ranks = list(member(rankGroups.find((entry) => text(member(entry, "marketplaceId")) === MARKETPLACE_US) ?? rankGroups[0], "displayGroupRanks"));
      const values = ranks.map((rank) => Number(member(rank, "rank"))).filter((rank) => Number.isFinite(rank) && rank > 0);
      const rankedGroups = [...new Set(ranks.map((rank) => text(member(rank, "websiteDisplayGroup"))).filter(Boolean))];
      output.set(asin, {
        brand: text(member(summary, "brand")).slice(0, 60),
        title: text(member(summary, "itemName")).slice(0, 200),
        groups: rankedGroups.length ? rankedGroups : [text(member(summary, "websiteDisplayGroup"))].filter(Boolean),
        salesRank: values.length ? Math.min(...values) : null,
      });
    }
  }
  return output;
}

function candidateFacts(catalog: CatalogFact | undefined, summary: SummaryView | undefined): CandidateFacts {
  const main = summary?.ok ? summary.featured[0] : undefined;
  const chosen = main ?? (summary?.ok ? summary.lowestNew : undefined);
  return { found: !!catalog, brand: catalog?.brand ?? "", title: catalog?.title ?? "", groups: catalog?.groups ?? [], salesRank: catalog?.salesRank ?? null, offer: !!chosen, featured: !!main, price: chosen ? chosen.landed : null };
}

// 本店美国站 listing：现查失败时用报价对账每小时刷新的 26 小时内缓存；都没有就失败（宁可这次不刷新，也不把自家 ASIN 当竞品）。
async function ownUsListings(amazon: AmazonClient, state: StateStore, sellerId: string): Promise<Record<string, ListingEntry>> {
  try {
    return await fetchOwnListings(amazon, sellerId, MARKETPLACE_US);
  } catch (error) {
    const saved = await state.get("OFFER_LISTINGS", MARKETPLACE_US);
    if (saved?.asins && Date.now() - timeMs(saved.refreshedAt) < LISTINGS_CACHE_MS) {
      log("WARN", "competitor_listings_cached", { error: errorText(error).slice(0, 200) });
      return saved.asins as Record<string, ListingEntry>;
    }
    throw new Error(`本店美国站 listing 读取失败且无 26 小时内的缓存，无法确定要维护竞品的商品：${errorText(error).slice(0, 200)}`);
  }
}

// 在售＝listing 状态含 BUYABLE（与报价对账同口径）；旧缓存没有 buyable 字段时退回 hasOffer。
const isBuyable = (entry: ListingEntry): boolean => entry.buyable ?? entry.hasOffer;

export interface RefreshCounts { products: number; active: number; candidates: number; added: number; removed: number; manual: number; auto: number; tracked: number }
export interface RefreshOutcome { status: "done" | "busy"; seq: number; counts: RefreshCounts; notified: boolean; plan: ProductPlan[]; summaries: Map<string, SummaryView> }
interface Context { config: AppConfig; state: StateStore; amazon: AmazonClient; feishu: FeishuClient }

const EMPTY_COUNTS: RefreshCounts = { products: 0, active: 0, candidates: 0, added: 0, removed: 0, manual: 0, auto: 0, tracked: 0 };

export function competitorSetLines(changed: ProductPlan[], settings: Pick<CompetitorSettings, "perProduct" | "total">, counts: RefreshCounts): string[] {
  const body: string[] = [];
  for (const item of changed) {
    const auto = item.next?.auto.length ?? 0;
    body.push(`【${item.skus.join("、") || "未找到 SKU"}｜${item.asin}】现跟踪 ${item.manual + auto} 个（人工 ${item.manual}、自动 ${auto}）`);
    for (const entry of item.added) body.push(`＋ ${entry.asin} ${entry.brand || "未知品牌"} ${money(entry.price, "USD")}${entry.title ? `｜${entry.title.slice(0, 40)}` : ""}`);
    for (const entry of item.removed) body.push(`－ ${entry.asin} ${entry.brand || "未知品牌"}（${entry.reason}）`);
  }
  const shown = body.length > MESSAGE_MAX_LINES ? [...body.slice(0, MESSAGE_MAX_LINES - 1), `……另有 ${body.length - MESSAGE_MAX_LINES + 1} 行未列出（完整清单在状态表 COMPETITOR_SET）`] : body;
  return [
    "🔁 竞品清单已自动更新（美国站）",
    `本次新增 ${counts.added} 个、移除 ${counts.removed} 个；现跟踪 ${counts.tracked} 个竞品 ASIN（人工 ${counts.manual}、自动 ${counts.auto}）`,
    `规则：每个商品最多 ${settings.perProduct} 个，人工填写的计入且永远保留${settings.total > 0 ? `，全店最多 ${settings.total} 个` : ""}；只收同款或非常相似的，不强行补满；每 7 天按亚马逊“相似商品”刷新一次`,
    ...shown,
    "新加入的竞品先记基准价，之后价格变化或开始促销再提醒。",
    "不想跟踪某个竞品：把它的 ASIN 加进配置 COMPETITOR_EXCLUDE_ASINS（逗号分隔），下一次竞品任务（每天 14:00）起不再比价。",
  ];
}

// 刷新：本店美国站 BUYABLE listing → similarItems → 目录（品牌、大类、排名）→ 候选全新品报价 → 规划。
// apply=false 只读预览；apply=true 在租约内：先持久化汇总通知意图 → 写各商品清单 → 写刷新元数据与健康 → 发送（失败由维护任务补发）。
// 刷新序号以元数据为准：写到一半中断时元数据仍是上一轮，重跑得到同一序号，已写过的商品原样保留（见 draftProduct）。
export async function refreshCompetitorSets(context: Context, settings: CompetitorSettings, options: { apply: boolean; now?: Date }): Promise<RefreshOutcome> {
  const { config, state, amazon, feishu } = context;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const owner = ownerId();
  if (options.apply && !(await state.acquireLease(LEASE_SCOPE, "global", owner, LEASE_MS))) return { status: "busy", seq: 0, counts: EMPTY_COUNTS, notified: false, plan: [], summaries: new Map() };
  try {
    const index = await ownUsListings(amazon, state, settings.sellerId);
    const [meta, stored, otherMarkets] = await Promise.all([state.get(COMPETITOR_META_PK, "state"), state.list(COMPETITOR_SET_PK), state.list("OFFER_LISTINGS")]);
    // 本店 ASIN＝美国站现查的全部 listing ∪ 报价对账每小时缓存的各站点 listing（加/墨独有的 ASIN 也不当竞品）。
    const ownAsins = new Set([...Object.keys(index), ...otherMarkets.flatMap((item) => Object.keys((item.asins ?? {}) as Record<string, unknown>))].map(asinOf));
    const seq = Math.max(0, Math.floor(Number(meta?.seq ?? 0)) || 0) + 1;
    const previous = new Map(stored.map((item) => [asinOf(item.asin ?? item.sk), item as unknown as CompetitorSet]));
    const active = Object.entries(index).filter(([, entry]) => isBuyable(entry)).map(([asin, entry]) => ({ asin: asinOf(asin), skus: [...entry.skus] })).sort((left, right) => left.asin.localeCompare(right.asin));
    const similar = active.length ? await competitiveSummaries(amazon, active.map((item) => item.asin), ["similarItems"]) : new Map<string, SummaryView>();
    const candidates = [...new Set(active.flatMap((item) => { const view = similar.get(item.asin); return view?.ok ? view.similar : []; }))].filter((asin) => !ownAsins.has(asin) && !settings.excluded.has(asin));
    const catalog = await catalogFacts(amazon, [...active.map((item) => item.asin), ...candidates]);
    const ownBrands = new Set([...settings.brands, ...active.map((item) => catalog.get(item.asin)?.brand ?? "")].map(normalizeBrand).filter(Boolean));
    const offerTargets = candidates.filter((asin) => { const fact = catalog.get(asin); return !!fact && !ownBrands.has(normalizeBrand(fact.brand)); });
    const batches = Math.ceil(active.length / COMPETITIVE_SUMMARY_BATCH) + Math.ceil(offerTargets.length / COMPETITIVE_SUMMARY_BATCH);
    if (batches > COMPETITOR_REFRESH_MAX_BATCHES) throw new Error(`竞品清单刷新需要 ${batches} 批报价查询，超过单次预算 ${COMPETITOR_REFRESH_MAX_BATCHES} 批（在售 ${active.length} 个、候选 ${offerTargets.length} 个），本次不刷新。`);
    const summaries = offerTargets.length ? await competitiveSummaries(amazon, offerTargets, PRICE_SUMMARY_DATA) : new Map<string, SummaryView>();
    const facts = new Map(candidates.map((asin) => [asin, candidateFacts(catalog.get(asin), summaries.get(asin))]));
    const activeSet = new Set(active.map((item) => item.asin));
    const products: ProductObservation[] = [
      ...active.map((item): ProductObservation => {
        const view = similar.get(item.asin);
        const own = catalog.get(item.asin);
        const title = own?.title || text(index[item.asin]?.title);
        return { asin: item.asin, skus: item.skus, active: true, ...(view?.ok ? { similar: view.similar } : {}), groups: own?.groups ?? [], ...(title ? { title } : {}), ...(own?.brand ? { brand: own.brand } : {}) };
      }),
      ...[...previous.entries()].filter(([asin]) => !activeSet.has(asin)).map(([asin, set]): ProductObservation => ({ asin, skus: [...(set.skus ?? [])], active: false, groups: [] })),
    ];
    const manual = manualIndex(config.asins());
    const plan = planCompetitorSets({ products, previous, manual, facts, ownAsins, ownBrands, settings, now: nowIso, seq });
    const autoAsins = new Set(plan.flatMap((item) => item.next?.auto.map((entry) => entry.asin) ?? []).filter((asin) => !manual.all.has(asin)));
    const counts: RefreshCounts = {
      products: products.length, active: active.length, candidates: candidates.length,
      added: plan.reduce((sum, item) => sum + item.added.length, 0), removed: plan.reduce((sum, item) => sum + item.removed.length, 0),
      manual: manual.all.size, auto: autoAsins.size, tracked: manual.all.size + autoAsins.size,
    };
    if (!options.apply) return { status: "done", seq, counts, notified: false, plan, summaries };

    // 汇总消息键＝刷新序号＋本轮开始时间：开始时间在第一次持久化副作用前记入元数据，中断重跑沿用同一个键（只发一条）；
    // 元数据被重置后序号从 1 重来也不会撞上 400 天内已完成的旧键而被吞掉。
    const changed = plan.filter((item) => item.added.length || item.removed.length);
    const cycle = (meta?.cycle ?? {}) as Record<string, unknown>;
    const startedAt = Number(cycle.seq) === seq && text(cycle.startedAt) ? text(cycle.startedAt) : nowIso;
    const eventKey = `competitor-set|${seq}|${startedAt}`;
    let prepared: PreparedNotification | undefined;
    if (changed.length) {
      if (startedAt === nowIso) await state.put({ ...(meta ?? {}), pk: COMPETITOR_META_PK, sk: "state", cycle: { seq, startedAt }, updatedAt: nowIso });
      prepared = await prepareNotification(config, state, eventKey, competitorSetLines(changed, settings, counts));
    }
    for (const item of plan) {
      if (item.frozen) continue;
      if (item.next) await state.put({ ...item.next });
      else if (item.previous) await state.delete(COMPETITOR_SET_PK, item.previous.sk);
    }
    const pendingKey = prepared || (await state.notification(eventKey)) ? eventKey : text(meta?.lastNotificationKey);
    await state.put({ pk: COMPETITOR_META_PK, sk: "state", seq, lastRefreshAt: nowIso, lastRefreshDay: ymdInZone(now, "Asia/Shanghai"), ...(pendingKey ? { lastNotificationKey: pendingKey } : {}), lastSummary: { ...counts }, updatedAt: nowIso });
    try { await state.recordHealth(COMPETITOR_HEALTH, "done", { seq, ...counts }); }
    catch (error) { log("WARN", "health_record_failed", { taskType: COMPETITOR_HEALTH, error: errorText(error).slice(0, 200) }); }
    let notified = false;
    try { notified = (await flushNotification(state, feishu, eventKey, prepared)) === "sent"; }
    catch (error) { log("WARN", "competitor_set_notify_failed", { eventKey, error: errorText(error).slice(0, 200) }); }
    log("INFO", "competitor_sets_refreshed", { seq, ...counts, notified });
    return { status: "done", seq, counts, notified, plan, summaries };
  } finally {
    if (options.apply) await state.releaseLease(LEASE_SCOPE, "global", owner);
  }
}

export interface DueRefresh { summaries: Map<string, SummaryView>; result: JsonObject; pendingKey: string }

// 竞品任务开头调用：自动竞品停用时只记健康（避免误报）；距上次刷新满 7 个北京日期（或从未刷新）才刷新。
// 刷新失败不影响当天比价（沿用已存清单），第二天自动重试；连续失败由健康规则 competitor-sets 发邮件。
export async function refreshIfDue(context: Context, settings: CompetitorSettings, now = new Date()): Promise<DueRefresh | undefined> {
  const { state } = context;
  if (!settings.enabled) {
    try { await state.recordHealth(COMPETITOR_HEALTH, "done", { disabled: true }); }
    catch (error) { log("WARN", "health_record_failed", { taskType: COMPETITOR_HEALTH, error: errorText(error).slice(0, 200) }); }
    return undefined;
  }
  if (!settings.sellerId) {
    log("WARN", "competitor_refresh_skipped", { reason: "SP_API_SELLER_ID missing" });
    return undefined;
  }
  const meta = await state.get(COMPETITOR_META_PK, "state");
  const pendingKey = text(meta?.lastNotificationKey);
  const last = text(meta?.lastRefreshDay);
  if (/^\d{4}-\d{2}-\d{2}$/.test(last) && addDaysYmd(last, COMPETITOR_REFRESH_DAYS) > ymdInZone(now, "Asia/Shanghai")) return { summaries: new Map(), result: {}, pendingKey };
  try {
    const outcome = await refreshCompetitorSets(context, settings, { apply: true, now });
    if (outcome.status === "busy") return { summaries: new Map(), result: { refresh: "busy" }, pendingKey };
    return { summaries: outcome.summaries, result: { refresh: "done", refreshAdded: outcome.counts.added, refreshRemoved: outcome.counts.removed }, pendingKey: "" };
  } catch (error) {
    log("WARN", "competitor_refresh_failed", { error: errorText(error).slice(0, 200) });
    return { summaries: new Map(), result: { refresh: "failed", refreshError: errorText(error).slice(0, 200) }, pendingKey };
  }
}

export interface TrackedCompetitor { asin: string; skus: string[]; manual: boolean; brand: string; title: string; since?: string }

// 比价清单＝人工 ∪ 自动：人工顺序与原实现一致；自动部分按当前配置（停用、排除名单、上限）在读取时再过一遍，改配置不必等下次刷新。
export async function trackedCompetitors(config: AppConfig, state: StateStore, settings: CompetitorSettings | undefined): Promise<TrackedCompetitor[]> {
  const tracked = new Map<string, TrackedCompetitor>();
  const mappings = config.asins();
  for (const mapping of mappings) {
    for (const asin of mapping.competitors) {
      const existing = tracked.get(asin);
      tracked.set(asin, existing ? { ...existing, skus: [...existing.skus, mapping.sku] } : { asin, skus: [mapping.sku], manual: true, brand: "", title: "" });
    }
  }
  if (!settings?.enabled) return [...tracked.values()];
  const manual = manualIndex(mappings);
  const manualKeys = new Map([...tracked.keys()].map((asin) => [asinOf(asin), asin]));
  const sets = (await state.list(COMPETITOR_SET_PK)) as unknown as CompetitorSet[];
  const byProduct = new Map(sets.map((set) => [asinOf(set.asin ?? set.sk), set]));
  const queues = [...byProduct].map(([product, set]): SlotQueue => {
    const excludedHere = productExclusions(settings, product, [...(set.skus ?? [])]);
    return {
      product, manual: manual.byProduct.get(product) ?? new Set<string>(),
      entries: list(set.auto).map((entry) => asinOf(member(entry, "asin"))).filter((asin) => validAsin(asin) && !settings.excluded.has(asin) && !excludedHere.has(asin)),
    };
  });
  for (const [product, asins] of allocateSlots(queues, settings.perProduct, settings.total, manual.all)) {
    const set = byProduct.get(product);
    if (!set) continue;
    const skus = [...(set.skus ?? [])];
    const stored = list(set.auto) as AutoCompetitor[];
    for (const asin of asins) {
      const existing = tracked.get(manualKeys.get(asin) ?? asin);
      const entry = stored.find((item) => asinOf(item.asin) === asin);
      if (existing) {
        existing.skus = [...new Set([...existing.skus, ...skus])];
        if (!existing.manual && entry && timeMs(entry.addedAt) < timeMs(existing.since)) existing.since = entry.addedAt;
        continue;
      }
      tracked.set(asin, { asin, skus, manual: false, brand: text(entry?.brand), title: text(entry?.title), since: text(entry?.addedAt) });
    }
  }
  return [...tracked.values()];
}

function planView(plan: ProductPlan[]): JsonObject[] {
  return plan.filter((item) => item.next?.auto.length || item.added.length || item.removed.length || item.manual).map((item) => ({
    sku: item.skus.join(","), asin: item.asin, manual: item.manual,
    auto: (item.next?.auto ?? []).map((entry) => `${entry.asin}${entry.misses ? `（已连续 ${entry.misses} 次${entry.missReason ?? "不合格"}）` : ""}`),
    added: item.added.map((entry) => `${entry.asin} ${entry.brand} ${money(entry.price, "USD")}`),
    removed: item.removed.map((entry) => `${entry.asin}（${entry.reason}）`),
  }));
}

// 只手动调用的运维任务：默认只读预览（不写状态、不发消息）；cursor.apply=true 立即按同一规则刷新并发汇总消息（不受 7 天间隔限制）。
export async function runCompetitorRefresh(event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient): Promise<JsonObject> {
  const settings = competitorSettings(config);
  if (!settings?.sellerId) throw new Error("缺少 SP_API_SELLER_ID，无法识别本店 listing。");
  const apply = event.cursor?.apply === true;
  if (apply && !settings.enabled) throw new Error("COMPETITOR_AUTO_ENABLED=false：自动竞品已停用，未刷新（预览不受影响）。");
  const outcome = await refreshCompetitorSets({ config, state, amazon, feishu }, settings, { apply });
  if (outcome.status === "busy") return { status: "busy", mode: "apply", note: "另一轮刷新正在进行，稍后再试" };
  return { status: "done", mode: apply ? "apply" : "preview", seq: outcome.seq, ...outcome.counts, notified: outcome.notified, plan: planView(outcome.plan) };
}
