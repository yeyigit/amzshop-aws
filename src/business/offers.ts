import type { AppConfig, JsonObject } from "../types.js";
import { AmazonClient, type Pace } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { flushNotification, prepareNotification, type PreparedNotification } from "../notifications.js";
import { log } from "../log.js";
import { booleanFact, errorText, nowIso, parseJson, timeMs, unwrapNotification } from "../util.js";
import { assertOwnSeller } from "./events.js";

export interface OfferMarket { code: string; label: string; domain: string; retailSellerId: string }
// 跟卖/购物车提醒覆盖的站点；retailSellerId 是亚马逊零售自营在该站的卖家 ID，只用于在提醒里标注“亚马逊自营”。
export const OFFER_MARKETS: Record<string, OfferMarket> = {
  ATVPDKIKX0DER: { code: "US", label: "美国站", domain: "www.amazon.com", retailSellerId: "ATVPDKIKX0DER" },
  A2EUQ1WTGCTBG2: { code: "CA", label: "加拿大站", domain: "www.amazon.ca", retailSellerId: "A3DWYIK6Y9EEQB" },
  A1AM78C64UM0Y8: { code: "MX", label: "墨西哥站", domain: "www.amazon.com.mx", retailSellerId: "AVDBXBAVVSXLQ" },
};
export const LEAVE_CONFIRM_MS = 3_600_000;
export const RECOVER_CONFIRM_MS = 3_600_000;
export const OFFER_WRITE_ATTEMPTS = 4;
// searchListingsItems 官方 5 次/秒。
export const LISTINGS_PACE: Pace = { key: "listings-search", minIntervalMs: 250 };

const text = (value: unknown): string => String(value ?? "").trim();
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const finite = (value: unknown): number | null => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

export function member(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const wanted = name.toLowerCase();
  return Object.entries(value).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

export function watchedMarkets(config: AppConfig): string[] {
  const configured = config.optional("OFFER_WATCH_MARKETPLACES", "").split(",").map((item) => item.trim()).filter(Boolean);
  return (configured.length ? configured : Object.keys(OFFER_MARKETS)).filter((id) => OFFER_MARKETS[id] !== undefined);
}

export function allowedSellers(config: AppConfig): Set<string> {
  return new Set(config.optional("OFFER_WATCH_ALLOWED_SELLER_IDS", "").split(",").map((item) => item.trim()).filter(Boolean));
}

export interface OfferFact { sellerId: string; landed: number | null; currency: string; fba: boolean; winner?: boolean; feedbackCount: number | null; positive: number | null }
export interface OfferSnapshot { marketplaceId: string; asin: string; at: string; source: "push" | "reconcile"; offers: OfferFact[] }

// 推送与 getItemOffers 的单个报价字段同名（大小写不一致时也能读）；只保留全新品报价，到手价＝标价＋运费。
function offerFact(raw: unknown): OfferFact | undefined {
  const sellerId = text(member(raw, "SellerId"));
  const condition = text(member(raw, "SubCondition")).toLowerCase();
  if (!sellerId || (condition && condition !== "new")) return undefined;
  const price = member(raw, "ListingPrice");
  const listing = finite(member(price, "Amount"));
  const shipping = finite(member(member(raw, "Shipping"), "Amount")) ?? 0;
  const winner = booleanFact(member(raw, "IsBuyBoxWinner"));
  const rating = member(raw, "SellerFeedbackRating");
  return {
    sellerId,
    landed: listing === null ? null : Math.round((listing + shipping + Number.EPSILON) * 100) / 100,
    currency: text(member(price, "CurrencyCode")).toUpperCase(),
    fba: booleanFact(member(raw, "IsFulfilledByAmazon")).value,
    ...(winner.known ? { winner: winner.value } : {}),
    feedbackCount: finite(member(rating, "FeedbackCount")),
    positive: finite(member(rating, "SellerPositiveFeedbackRating")),
  };
}

const offerFacts = (raw: unknown[]): OfferFact[] => raw.map(offerFact).filter((item): item is OfferFact => item !== undefined);

export type ParsedOfferMessage = { snapshot: OfferSnapshot } | { ignored: string };

// ANY_OFFER_CHANGED：Payload.AnyOfferChangedNotification{SellerId（订阅方）, OfferChangeTrigger{MarketplaceId, ASIN, ItemCondition, TimeOfOfferChange}, Offers[]}。
// 非该类型、非全新品、站点不在范围的消息返回 ignored（由调用方直接确认）；类型对但缺 ASIN 视为异常消息；
// 订阅方不是本店（ownSellerId）时抛错交回 SQS（单店铺边界），报价列表里出现的其它卖家不受影响。
export function parseOfferNotification(body: string, markets: readonly string[], now = Date.now(), ownSellerId = ""): ParsedOfferMessage {
  const payload = unwrapNotification(parseJson<unknown>(body, "报价 SQS 消息"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("报价消息正文不是 JSON 对象。");
  const type = text(member(payload, "NotificationType")).toUpperCase();
  if (type !== "ANY_OFFER_CHANGED") return { ignored: `type:${type || "unknown"}` };
  const wrapper = member(payload, "Payload");
  const notice = member(wrapper, "AnyOfferChangedNotification") ?? wrapper;
  assertOwnSeller(type, text(member(notice, "SellerId")), ownSellerId);
  const trigger = member(notice, "OfferChangeTrigger");
  const condition = text(member(trigger, "ItemCondition")).toLowerCase();
  if (condition !== "new") return { ignored: `condition:${condition || "unknown"}` };
  const marketplaceId = text(member(trigger, "MarketplaceId"));
  if (!markets.includes(marketplaceId)) return { ignored: `marketplace:${marketplaceId || "unknown"}` };
  const asin = text(member(trigger, "ASIN")).toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error("ANY_OFFER_CHANGED 缺少有效 ASIN。");
  const at = [member(trigger, "TimeOfOfferChange"), member(payload, "EventTime")].map(timeMs).find((value) => value > 0) ?? now;
  return { snapshot: { marketplaceId, asin, at: new Date(at).toISOString(), source: "push", offers: offerFacts(list(member(notice, "Offers"))) } };
}

export interface ItemOffersResult { marketplaceId: string; asin: string; snapshot?: OfferSnapshot; error?: string }

// getItemOffersBatch 单条结果按回显的 request（Asin/MarketplaceId）对应；非 200（如下架 ASIN 的 InvalidInput）记为取数失败。
export function itemOffersResult(row: unknown, at: string): ItemOffersResult {
  const request = member(row, "request");
  const body = member(row, "body");
  const payload = member(body, "payload");
  const marketplaceId = text(member(request, "MarketplaceId") ?? member(payload, "marketplaceId"));
  const asin = text(member(request, "Asin") ?? member(payload, "ASIN")).toUpperCase();
  const status = Number(member(member(row, "status"), "statusCode"));
  if (status !== 200 || !payload || typeof payload !== "object") {
    const code = list(member(body, "errors")).map((item) => text(member(item, "code"))).filter(Boolean).join(",");
    return { marketplaceId, asin, error: code || `HTTP ${Number.isFinite(status) ? status : "?"}` };
  }
  return { marketplaceId, asin, snapshot: { marketplaceId, asin, at, source: "reconcile", offers: offerFacts(list(member(payload, "Offers"))) } };
}

export interface SellerTrack { episode: number; firstSeenAt: string; lastSeenAt: string; absentSince?: string; leftAt?: string; landed: number | null; currency: string; fba: boolean; feedbackCount: number | null; positive: number | null }
export interface BuyBoxTrack { status: "won" | "lost" | "unknown"; incident: number; lostAt?: string; wonSince?: string; regainedAt?: string; recoveredAt?: string; holder?: string; holderLanded?: number | null; holderCurrency?: string; holderFba?: boolean }
export interface OwnOffer { landed: number | null; currency: string; fba: boolean; winner?: boolean }
export interface OfferState { pk: "OFFER"; sk: string; marketplaceId: string; asin: string; eventAt: string; source: string; rev?: number; sellers: Record<string, SellerTrack>; buyBox: BuyBoxTrack; own: OwnOffer | null; notificationKeys: string[]; updatedAt?: string }
export type OfferChangeKind = "seller-appeared" | "seller-left" | "buybox-lost" | "buybox-recovered";
export interface OfferChange { kind: OfferChangeKind; eventKey: string; sellerId?: string; tookBuyBox?: boolean }

// 纯判定：旧快照不覆盖新状态；跟卖出现即提醒、消失满 1 小时才算离开；购物车丢失开一个事件只提醒一次，重新持有满 1 小时才算恢复。
// 本店在该 listing 无在售报价时不提醒（用户 2026-10-05 决定）：跟卖者状态原样冻结，恢复在售后再按出现/离开判定。
// 通知键由站点、ASIN、卖家与轮次序号组成，与快照时间无关，重放与并发重算得到同一键。
export function applyOfferSnapshot(previous: OfferState | undefined, snapshot: OfferSnapshot, own: string, allowed: ReadonlySet<string>): { next: OfferState; changes: OfferChange[]; stale: boolean } {
  const atMs = timeMs(snapshot.at);
  if (previous && timeMs(previous.eventAt) > atMs) return { next: previous, changes: [], stale: true };
  const base = `${snapshot.marketplaceId}|${snapshot.asin}`;
  const changes: OfferChange[] = [];
  const sellers: Record<string, SellerTrack> = {};
  for (const [id, track] of Object.entries(previous?.sellers ?? {})) sellers[id] = { ...track };
  const mine = snapshot.offers.find((offer) => offer.sellerId === own);

  const present = new Set<string>();
  for (const offer of mine ? snapshot.offers : []) {
    if (offer.sellerId === own || allowed.has(offer.sellerId)) continue;
    present.add(offer.sellerId);
    const latest = { landed: offer.landed, currency: offer.currency, fba: offer.fba, feedbackCount: offer.feedbackCount, positive: offer.positive };
    const track = sellers[offer.sellerId];
    if (!track || track.leftAt) {
      const episode = (track?.episode ?? 0) + 1;
      sellers[offer.sellerId] = { episode, firstSeenAt: snapshot.at, lastSeenAt: snapshot.at, ...latest };
      changes.push({ kind: "seller-appeared", sellerId: offer.sellerId, eventKey: `offer-seller|${base}|${offer.sellerId}|${episode}` });
    } else {
      const { absentSince: _absent, ...rest } = track;
      sellers[offer.sellerId] = { ...rest, lastSeenAt: snapshot.at, ...latest };
    }
  }
  for (const [id, track] of Object.entries(mine ? sellers : {})) {
    if (track.leftAt || present.has(id)) continue;
    if (id === own || allowed.has(id)) { sellers[id] = { ...track, leftAt: snapshot.at }; continue; }
    if (!track.absentSince) { sellers[id] = { ...track, absentSince: snapshot.at }; continue; }
    if (atMs - timeMs(track.absentSince) >= LEAVE_CONFIRM_MS) {
      sellers[id] = { ...track, leftAt: snapshot.at };
      changes.push({ kind: "seller-left", sellerId: id, eventKey: `offer-seller-left|${base}|${id}|${track.episode}` });
    }
  }

  // 购物车只在本店有在售报价、且数据明确标了本店是否持有时判定；本店断货或标记缺失时保持原状态。
  let buyBox: BuyBoxTrack = { ...(previous?.buyBox ?? { status: "unknown", incident: 0 }) };
  if (mine?.winner !== undefined) {
    const holder = snapshot.offers.find((offer) => offer.winner === true && offer.sellerId !== own);
    const holderFacts = holder ? { holder: holder.sellerId, holderLanded: holder.landed, holderCurrency: holder.currency, holderFba: holder.fba } : { holder: "" };
    if (!mine.winner) {
      const { wonSince: _won, holderLanded: _landed, holderCurrency: _currency, holderFba: _fba, ...rest } = buyBox;
      if (buyBox.status !== "lost") {
        buyBox = { status: "lost", incident: buyBox.incident + 1, lostAt: snapshot.at, ...holderFacts };
        changes.push({ kind: "buybox-lost", eventKey: `offer-buybox|${base}|${buyBox.incident}` });
      } else {
        buyBox = { ...rest, ...holderFacts };
      }
    } else if (buyBox.status === "lost") {
      if (!buyBox.wonSince) buyBox = { ...buyBox, wonSince: snapshot.at };
      else if (atMs - timeMs(buyBox.wonSince) >= RECOVER_CONFIRM_MS) {
        changes.push({ kind: "buybox-recovered", eventKey: `offer-buybox-back|${base}|${buyBox.incident}` });
        buyBox = { status: "won", incident: buyBox.incident, ...(buyBox.lostAt ? { lostAt: buyBox.lostAt } : {}), regainedAt: buyBox.wonSince, recoveredAt: snapshot.at };
      }
    } else {
      const { holder: _holder, holderLanded: _landed, holderCurrency: _currency, holderFba: _fba, wonSince: _won, ...rest } = buyBox;
      buyBox = { ...rest, status: "won" };
    }
  }

  // 跟卖者出现的同时拿走购物车：合成一条“发现跟卖，购物车被对方拿走”，不再单发“购物车丢失”（事件照常开启，恢复时照常提醒）。
  const lostIndex = changes.findIndex((change) => change.kind === "buybox-lost");
  const taker = lostIndex >= 0 && buyBox.holder ? changes.find((change) => change.kind === "seller-appeared" && change.sellerId === buyBox.holder) : undefined;
  if (taker) {
    taker.tookBuyBox = true;
    changes.splice(lostIndex, 1);
  }

  const next: OfferState = {
    pk: "OFFER", sk: base, marketplaceId: snapshot.marketplaceId, asin: snapshot.asin, eventAt: snapshot.at, source: snapshot.source,
    ...(previous?.rev !== undefined ? { rev: previous.rev } : {}),
    sellers, buyBox,
    own: mine ? { landed: mine.landed, currency: mine.currency, fba: mine.fba, ...(mine.winner !== undefined ? { winner: mine.winner } : {}) } : null,
    notificationKeys: changes.length ? changes.map((change) => change.eventKey) : [...(previous?.notificationKeys ?? [])],
  };
  return { next, changes, stale: false };
}

const SYMBOLS: Record<string, string> = { USD: "$", CAD: "C$", MXN: "MX$" };

export function money(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "价格未知";
  const symbol = SYMBOLS[currency];
  return symbol ? `${symbol}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`.trim();
}

export function beijingClock(iso: string | undefined): string {
  const ms = timeMs(iso);
  if (!ms) return "未知";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function roughSpan(fromIso: string | undefined, toIso: string | undefined): string {
  const ms = Math.max(0, timeMs(toIso) - timeMs(fromIso));
  if (ms < 3_600_000) return `约 ${Math.max(1, Math.round(ms / 60_000))} 分钟`;
  if (ms < 48 * 3_600_000) return `约 ${Math.round(ms / 3_600_000)} 小时`;
  return `约 ${Math.round(ms / 86_400_000)} 天`;
}

const channel = (fba: boolean | undefined): string => (fba ? "FBA" : "自发货");
const storeLink = (sellerId: string, market: OfferMarket): string => `https://${market.domain}/sp?seller=${encodeURIComponent(sellerId)}`;
const sellerName = (sellerId: string, market: OfferMarket): string => (sellerId === market.retailSellerId ? `${sellerId}（亚马逊自营）` : sellerId);

function feedback(count: number | null | undefined, positive: number | null | undefined): string {
  if (count === null || count === undefined) return "";
  if (count === 0) return "，新卖家（0 条反馈）";
  return `，反馈 ${count} 条${positive === null || positive === undefined ? "" : ` · ${positive}% 好评`}`;
}

export function offerChangeLines(change: OfferChange, next: OfferState, snapshot: OfferSnapshot, skus: readonly string[], allowed: ReadonlySet<string>): string[] {
  const market = OFFER_MARKETS[next.marketplaceId] ?? { code: next.marketplaceId, label: next.marketplaceId, domain: "www.amazon.com", retailSellerId: "" };
  const head = [`我的 SKU：${skus.length ? skus.join("、") : "未找到（可能是新上架，或不在本店 listing 中）"}`, `ASIN：${next.asin}`];
  const ownLine = next.own ? `我的报价：${money(next.own.landed, next.own.currency)}（${channel(next.own.fba)}）` : "我的报价：当前无在售报价";
  const when = `时间：${beijingClock(snapshot.at)}（北京）`;
  if (change.kind === "seller-appeared" || change.kind === "seller-left") {
    const sellerId = change.sellerId ?? "";
    const track = next.sellers[sellerId];
    const who = [`跟卖卖家：${sellerName(sellerId, market)}`, `店铺：${storeLink(sellerId, market)}`];
    if (change.kind === "seller-left") {
      return [`✅ 跟卖已离开（${market.label}）`, ...head, ...who, `在你的 listing 上停留${roughSpan(track?.firstSeenAt, track?.absentSince)}（${beijingClock(track?.firstSeenAt)} 至 ${beijingClock(track?.absentSince)}，北京）`];
    }
    const holder = next.buyBox.holder ?? "";
    const buyBoxLine = change.tookBuyBox || next.own?.winner === undefined ? []
      : next.own.winner ? ["购物车：仍在你手里"]
        : [holder ? (holder === sellerId ? "购物车：被对方拿走" : `购物车：在 ${sellerName(holder, market)} 手里`) : "购物车：无人持有"];
    return [
      change.tookBuyBox ? `🚨 发现跟卖，购物车被对方拿走（${market.label}）` : `🚨 发现跟卖（${market.label}）`,
      ...head,
      ...who,
      `对方报价：${money(track?.landed, track?.currency ?? "")}（${channel(track?.fba)}）${feedback(track?.feedbackCount, track?.positive)}`,
      ...buyBoxLine,
      ownLine,
      when,
    ];
  }
  if (change.kind === "buybox-lost") {
    const holder = next.buyBox.holder ?? "";
    const role = allowed.has(holder) ? "（白名单卖家）" : holder === market.retailSellerId ? "" : "（跟卖）";
    const holderLines = holder
      ? [`当前持有：${sellerName(holder, market)}${role} ${money(next.buyBox.holderLanded, next.buyBox.holderCurrency ?? "")} ${channel(next.buyBox.holderFba)}`, `店铺：${storeLink(holder, market)}`]
      : ["当前持有：无人持有（购物车被压制，常见原因是价格高于亚马逊参考价）"];
    return [`⚠️ 购物车丢失（${market.label}）`, ...head, ...holderLines, ownLine, when];
  }
  return [`✅ 购物车已恢复（${market.label}）`, ...head, `本次丢失${roughSpan(next.buyBox.lostAt, next.buyBox.regainedAt)}（${beijingClock(next.buyBox.lostAt)} 起），已稳定持有满 1 小时`];
}

export interface OfferContext { config: AppConfig; state: StateStore; amazon: AmazonClient; feishu: FeishuClient; own: string; allowed: ReadonlySet<string> }
export interface OfferOutcome { stale: boolean; changes: OfferChangeKind[] }

export interface ListingEntry { skus: string[]; hasOffer: boolean; buyable?: boolean; title: string }

// 本店在某站点的全部 listing：ASIN → SKU、是否有报价（有价或 BUYABLE）、是否在售（BUYABLE）、标题。父体等无报价 listing 也收录（用于认定“本店 ASIN”）。
export async function fetchOwnListings(amazon: AmazonClient, sellerId: string, marketplaceId: string): Promise<Record<string, ListingEntry>> {
  const output: Record<string, ListingEntry> = {};
  let pageToken = "";
  for (let page = 0; page < 50; page += 1) {
    const response = await amazon.sp<JsonObject>(`/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`, { query: { marketplaceIds: marketplaceId, includedData: "summaries,offers", pageSize: 20, ...(pageToken ? { pageToken } : {}) }, pace: LISTINGS_PACE });
    for (const item of list(response.items)) {
      const sku = text(member(item, "sku"));
      const summaries = list(member(item, "summaries"));
      const summary = summaries.find((entry) => text(member(entry, "marketplaceId")) === marketplaceId) ?? summaries[0];
      const asin = text(member(summary, "asin")).toUpperCase();
      if (!sku || !asin) continue;
      const buyable = list(member(summary, "status")).some((status) => text(status).toUpperCase() === "BUYABLE");
      const priced = list(member(item, "offers")).some((offer) => text(member(offer, "marketplaceId")) === marketplaceId && finite(member(member(offer, "price"), "amount")) !== null);
      const entry = output[asin] ?? { skus: [], hasOffer: false, buyable: false, title: "" };
      output[asin] = { skus: [...new Set([...entry.skus, sku])], hasOffer: entry.hasOffer || buyable || priced, buyable: !!entry.buyable || buyable, title: entry.title || text(member(summary, "itemName")).slice(0, 200) };
    }
    pageToken = text(member(member(response, "pagination"), "nextToken"));
    if (!pageToken) break;
  }
  return output;
}

// 我的 SKU：每小时对账刷新的本店 listing → SSM SKU 映射 → 现查 Listings API；都查不到返回空（提醒里写“未找到”）。
export async function ownSkus(context: OfferContext, marketplaceId: string, asin: string): Promise<string[]> {
  const listings = await context.state.get("OFFER_LISTINGS", marketplaceId);
  const indexed = (listings?.asins as Record<string, ListingEntry> | undefined)?.[asin]?.skus ?? [];
  if (indexed.length) return [...indexed];
  const mapped = context.config.asins().filter((mapping) => mapping.asin === asin).map((mapping) => mapping.sku);
  if (mapped.length) return mapped;
  try {
    const response = await context.amazon.sp<JsonObject>(`/listings/2021-08-01/items/${encodeURIComponent(context.own)}`, { query: { marketplaceIds: marketplaceId, identifiers: asin, identifiersType: "ASIN", includedData: "summaries", pageSize: 20 }, pace: LISTINGS_PACE });
    return [...new Set(list(response.items).map((item) => text(member(item, "sku"))).filter(Boolean))];
  } catch (error) {
    log("WARN", "offer_sku_lookup_failed", { marketplace: OFFER_MARKETS[marketplaceId]?.code ?? marketplaceId, asin, error: errorText(error).slice(0, 200) });
    return [];
  }
}

// 处理一个报价快照：读状态 → 判定 → 先持久化通知意图 → 版本条件写状态（冲突重读重算）→ 发送；末尾补发上一批未完成的通知。
export async function processOfferSnapshot(snapshot: OfferSnapshot, context: OfferContext): Promise<OfferOutcome> {
  const { config, state, feishu } = context;
  const sk = `${snapshot.marketplaceId}|${snapshot.asin}`;
  const resend = async (keys: readonly string[]): Promise<void> => { for (const key of keys) await flushNotification(state, feishu, key); };
  let skus: string[] | undefined;
  for (let attempt = 1; attempt <= OFFER_WRITE_ATTEMPTS; attempt += 1) {
    const previous = await state.get("OFFER", sk) as OfferState | undefined;
    const { next, changes, stale } = applyOfferSnapshot(previous, snapshot, context.own, context.allowed);
    if (stale) {
      await resend(previous?.notificationKeys ?? []);
      return { stale: true, changes: [] };
    }
    if (changes.length && !skus) skus = await ownSkus(context, snapshot.marketplaceId, snapshot.asin);
    const prepared: Array<[OfferChange, PreparedNotification | undefined]> = [];
    for (const change of changes) prepared.push([change, await prepareNotification(config, state, change.eventKey, offerChangeLines(change, next, snapshot, skus ?? [], context.allowed))]);
    const { rev: _rev, ...item } = next;
    if (!(await state.putVersioned({ ...item, updatedAt: nowIso() }, previous ? Number(previous.rev ?? 0) : undefined))) continue;
    for (const [change, notice] of prepared) await flushNotification(state, feishu, change.eventKey, notice);
    await resend((previous?.notificationKeys ?? []).filter((key) => !changes.some((change) => change.eventKey === key)));
    return { stale: false, changes: changes.map((change) => change.kind) };
  }
  throw new Error(`报价状态 ${sk} 并发写冲突，重试 ${OFFER_WRITE_ATTEMPTS} 次仍失败。`);
}
