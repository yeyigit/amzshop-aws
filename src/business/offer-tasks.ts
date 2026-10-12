import type { AppConfig, JobEvent, JsonObject } from "../types.js";
import { AmazonClient, type Pace } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { HttpError } from "../http.js";
import { log } from "../log.js";
import { errorText, nowIso } from "../util.js";
import { OFFER_MARKETS, allowedSellers, fetchOwnListings, itemOffersResult, member, processOfferSnapshot, watchedMarkets, type ListingEntry, type OfferChangeKind, type OfferContext } from "./offers.js";

export const ITEM_OFFERS_PATH = "/batches/products/pricing/v0/itemOffers";
export const ITEM_OFFERS_BATCH = 20;
// getItemOffersBatch 官方 0.1 次/秒、突发 1：同一进程内批间至少 10.5 秒。
export const ITEM_OFFERS_PACE: Pace = { key: "products-itemOffersBatch", minIntervalMs: 10_500 };
export const SUBSCRIPTION_PATH = "/notifications/v1/subscriptions/ANY_OFFER_CHANGED";
export const DESTINATIONS_PATH = "/notifications/v1/destinations";

const text = (value: unknown): string => String(value ?? "").trim();
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const code = (marketplaceId: string): string => OFFER_MARKETS[marketplaceId]?.code ?? marketplaceId;

// 每小时对账：刷新本店 listing（供查 SKU）→ 对本店在售（BUYABLE）的 listing 批量取全新品报价 → 与推送共用同一套判定（补抓漏推、确认离开/恢复）→ 核验订阅。
// 未在售的 listing 不提醒（用户 2026-10-05 决定），因此也不查；旧缓存没有 buyable 字段时按 hasOffer 处理。
// 单批取数失败只记 unavailable、保留原状态；全部批次都失败才让任务失败。
export async function runOfferReconcile(_event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient): Promise<JsonObject> {
  const own = config.get("SP_API_SELLER_ID");
  const context: OfferContext = { config, state, amazon, feishu, own, allowed: allowedSellers(config) };
  const targets: Array<{ marketplaceId: string; asin: string }> = [];
  const cachedListings: string[] = [];
  for (const marketplaceId of watchedMarkets(config)) {
    let index: Record<string, ListingEntry> | undefined;
    try {
      index = await fetchOwnListings(amazon, own, marketplaceId);
      await state.put({ pk: "OFFER_LISTINGS", sk: marketplaceId, asins: index, refreshedAt: nowIso(), updatedAt: nowIso() });
    } catch (error) {
      index = (await state.get("OFFER_LISTINGS", marketplaceId))?.asins as Record<string, ListingEntry> | undefined;
      cachedListings.push(code(marketplaceId));
      log("WARN", "offer_listings_failed", { marketplace: code(marketplaceId), cached: !!index, error: errorText(error).slice(0, 200) });
    }
    for (const [asin, entry] of Object.entries(index ?? {})) if (entry.buyable ?? entry.hasOffer) targets.push({ marketplaceId, asin });
  }

  const counts: Record<OfferChangeKind, number> = { "seller-appeared": 0, "seller-left": 0, "buybox-lost": 0, "buybox-recovered": 0 };
  const unavailable: string[] = [];
  let checked = 0, stale = 0, failedBatches = 0;
  let lastError: unknown;
  for (let offset = 0; offset < targets.length; offset += ITEM_OFFERS_BATCH) {
    const chunk = targets.slice(offset, offset + ITEM_OFFERS_BATCH);
    let response: JsonObject;
    try {
      response = await amazon.sp<JsonObject>(ITEM_OFFERS_PATH, {
        method: "POST",
        body: { requests: chunk.map((target) => ({ uri: `/products/pricing/v0/items/${encodeURIComponent(target.asin)}/offers`, method: "GET", MarketplaceId: target.marketplaceId, ItemCondition: "New", CustomerType: "Consumer" })) },
        pace: ITEM_OFFERS_PACE,
      });
    } catch (error) {
      failedBatches += 1;
      lastError = error;
      unavailable.push(...chunk.map((target) => `${code(target.marketplaceId)}:${target.asin}`));
      log("WARN", "offer_reconcile_batch_failed", { size: chunk.length, error: errorText(error).slice(0, 200) });
      continue;
    }
    const at = nowIso();
    const results = new Map(list(response.responses).map((row) => itemOffersResult(row, at)).map((result) => [`${result.marketplaceId}|${result.asin}`, result]));
    for (const target of chunk) {
      const result = results.get(`${target.marketplaceId}|${target.asin}`);
      if (!result?.snapshot) { unavailable.push(`${code(target.marketplaceId)}:${target.asin}`); continue; }
      const outcome = await processOfferSnapshot(result.snapshot, context);
      checked += 1;
      if (outcome.stale) stale += 1;
      for (const kind of outcome.changes) counts[kind] += 1;
    }
  }
  if (failedBatches && !checked) throw lastError instanceof Error ? lastError : new Error("报价对账全部批次取数失败。");
  const subscription = await verifyOfferSubscription(state, amazon);
  return {
    status: "done", targets: targets.length, checked, stale, unavailable,
    appeared: counts["seller-appeared"], left: counts["seller-left"], lost: counts["buybox-lost"], recovered: counts["buybox-recovered"],
    cachedListings, subscription,
  };
}

async function currentSubscription(amazon: AmazonClient): Promise<{ subscriptionId: string; destinationId: string } | undefined> {
  try {
    const payload = member(await amazon.sp<JsonObject>(SUBSCRIPTION_PATH), "payload");
    const subscriptionId = text(member(payload, "subscriptionId"));
    return subscriptionId ? { subscriptionId, destinationId: text(member(payload, "destinationId")) } : undefined;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined;
    throw error;
  }
}

// 订阅核验：ANY_OFFER_CHANGED 订阅存在且指向本功能创建的目的地才记健康项 offer-subscription（维护任务 26 小时无成功即发邮件）。
export async function verifyOfferSubscription(state: StateStore, amazon: AmazonClient): Promise<string> {
  const meta = await state.get("OFFER_META", "subscription");
  const expected = text(meta?.destinationId);
  if (!expected) return "unconfigured";
  if (meta?.removedAt) return "removed";
  try {
    const subscription = await currentSubscription(amazon);
    if (!subscription) return "missing";
    if (subscription.destinationId !== expected) return "mismatch";
    await state.recordHealth("offer-subscription", "done", { destination: expected.slice(0, 8) });
    return "ok";
  } catch (error) {
    log("WARN", "offer_subscription_check_failed", { error: errorText(error).slice(0, 200) });
    return "error";
  }
}

// 只手动调用的运维任务：默认只读预览；cursor.apply=true 才创建目的地（报价队列）与 ANY_OFFER_CHANGED 订阅（覆盖站点、5 分钟合并）；
// cursor.remove=true 只删除指向报价队列的订阅。已有订阅指向其它目的地时一律不改动。
export async function runOfferSubscriptionSetup(event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient): Promise<JsonObject> {
  const mode = event.cursor?.apply === true ? "apply" : event.cursor?.remove === true ? "remove" : "preview";
  const queueArn = text(process.env.OFFER_QUEUE_ARN);
  if (!/^arn:aws:sqs:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$/.test(queueArn)) throw new Error("缺少报价队列 ARN（Jobs 环境变量 OFFER_QUEUE_ARN）。");
  const markets = watchedMarkets(config);
  const destinations = list(member(await amazon.spGrantless<JsonObject>(DESTINATIONS_PATH), "payload"));
  let destinationId = text(member(destinations.find((row) => text(member(member(member(row, "resource"), "sqs"), "arn")) === queueArn), "destinationId"));
  let subscription = await currentSubscription(amazon);
  const view = (): JsonObject => ({
    status: "done", mode, queue: queueArn.split(":").pop() ?? "", destinationId,
    subscriptionId: subscription?.subscriptionId ?? "", subscribedDestinationId: subscription?.destinationId ?? "",
    matches: !!subscription && !!destinationId && subscription.destinationId === destinationId,
    marketplaces: markets.map(code).join(","),
  });
  if (mode === "preview") return view();
  if (mode === "apply") {
    if (subscription && subscription.destinationId !== destinationId) throw new Error("ANY_OFFER_CHANGED 已有订阅且不指向报价队列，未做任何改动。");
    if (!destinationId) {
      const created = member(await amazon.spGrantless<JsonObject>(DESTINATIONS_PATH, { method: "POST", body: { name: queueArn.split(":").pop() ?? "amzshop-offer-events", resourceSpecification: { sqs: { arn: queueArn } } } }), "payload");
      destinationId = text(member(created, "destinationId"));
      if (!destinationId) throw new Error("创建通知目的地后未返回 destinationId。");
    }
    if (!subscription) {
      const created = member(await amazon.sp<JsonObject>(SUBSCRIPTION_PATH, {
        method: "POST",
        body: { payloadVersion: "1.0", destinationId, processingDirective: { eventFilter: { eventFilterType: "ANY_OFFER_CHANGED", marketplaceIds: markets, aggregationSettings: { aggregationTimePeriod: "FiveMinutes" } } } },
      }), "payload");
      subscription = { subscriptionId: text(member(created, "subscriptionId")), destinationId: text(member(created, "destinationId")) || destinationId };
    }
    await state.put({ pk: "OFFER_META", sk: "subscription", destinationId, subscriptionId: subscription.subscriptionId, queueArn, marketplaceIds: markets, appliedAt: nowIso(), updatedAt: nowIso() });
    log("INFO", "offer_subscription_applied", { destination: destinationId.slice(0, 8), marketplaces: markets.map(code).join(",") });
    return view();
  }
  if (!subscription) return view();
  if (!destinationId || subscription.destinationId !== destinationId) throw new Error("ANY_OFFER_CHANGED 订阅不指向报价队列，拒绝删除。");
  await amazon.spGrantless<JsonObject>(`${SUBSCRIPTION_PATH}/${encodeURIComponent(subscription.subscriptionId)}`, { method: "DELETE" });
  const meta = await state.get("OFFER_META", "subscription");
  await state.put({ ...(meta ?? { pk: "OFFER_META", sk: "subscription", destinationId }), removedAt: nowIso(), updatedAt: nowIso() });
  log("INFO", "offer_subscription_removed", { destination: destinationId.slice(0, 8) });
  subscription = undefined;
  return view();
}
