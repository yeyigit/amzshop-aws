import type { AppConfig, BusinessEvent, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { ordersApiVersion, processOrderEvent, truncateToSeconds } from "./orders.js";
import { deliverNotification, flushNotification, prepareNotification } from "../notifications.js";
import { ensureOneTimeSchedule } from "../scheduling.js";
import { log } from "../log.js";
import { errorText, feishuFieldText, ownerId, sha256, timeMs, ymdInZone } from "../util.js";
import { PRICE_SUMMARY_DATA, competitiveSummaries, promotionSignature, type SummaryView } from "./competitive.js";
import { competitorSettings, refreshIfDue, trackedCompetitors } from "./competitor-sets.js";
import { SALE_TRIGGER_HOURS, applyDealTrigger, currentSaleMode, hasDeal, refreshPromotionEvents, saleSettings } from "./sale-windows.js";

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
const text = (value: unknown): string => String(value ?? "").trim();
const DAY = 86_400_000;
export const RECONCILE_BUDGET_MS = 600_000;
const PHASES = ["created", "updated", "stale"] as const;
type Phase = typeof PHASES[number];
const STALE_STATUSES = ["待处理", "未发货", "部分发货"];

function phaseStart(phase: Phase, windowEnd: string): string {
  return new Date(Date.parse(windowEnd) - (phase === "created" ? 7 : 3) * DAY).toISOString();
}

// 下单时间为洛杉矶本地时间文本（兼容毫秒时间戳）；按 UTC-7 换算，足以判断是否超过 3 天。
function purchaseMs(value: unknown): number {
  const raw = feishuFieldText(value);
  if (/^\d{12,13}$/.test(raw)) return Number(raw);
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(raw);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]) + 7, Number(match[5])) : Number.NaN;
}

async function staleOrderIds(config: AppConfig, feishu: FeishuClient, now: number): Promise<string[]> {
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const table = config.get("FEISHU_BITABLE_TABLE_ID_ORDERS");
  const ids = new Set<string>();
  for (const status of STALE_STATUSES) {
    for (const record of await feishu.searchRecords(app, table, { "订单状态": status }, { fieldNames: ["订单编号", "订单状态", "下单时间"] })) {
      const orderId = feishuFieldText(record.fields["订单编号"]);
      if (/^\d{3}-\d{7}-\d{7}$/.test(orderId) && !(purchaseMs(record.fields["下单时间"]) > now - 3 * DAY)) ids.add(orderId);
    }
  }
  return [...ids].sort().slice(0, 500);
}

// 每日校准：①近 7 天创建 ②近 3 天更新（按 1 天时间片，NextToken 不跨调用保存，中断后从当前时间片起点重查，已处理订单由事件去重跳过）
// ③飞书中仍为待处理/未发货/部分发货且下单超过 3 天的订单逐单刷新。600 秒预算，超时保存断点 +60 秒续跑；全部按 getOrder/getOrderItems 官方速率节流。
export async function runOrderReconcile(event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient, schedule = ensureOneTimeSchedule): Promise<JsonObject> {
  const startedAt = Date.now();
  const taskId = event.taskId ?? `order-reconcile|${event.scheduledAt ?? new Date(startedAt).toISOString()}`;
  const saved = await state.task("order-reconcile", taskId);
  if (saved?.status === "done") return { status: "done", taskId, alreadyDone: true };
  const cursor = (saved?.state ?? {}) as Row;
  const windowEnd = text(cursor.windowEnd) || new Date(startedAt - 180_000).toISOString();
  let phase: Phase = PHASES.includes(cursor.phase as Phase) ? cursor.phase as Phase : "created";
  let sliceStart = text(cursor.sliceStart) || phaseStart(phase, windowEnd);
  let staleIds = Array.isArray(cursor.staleIds) ? cursor.staleIds.map(String) : undefined;
  let staleIndex = Number(cursor.staleIndex ?? 0);
  const counts: Record<string, number> = { processed: 0, duplicates: 0, busyOrders: 0, refreshed: 0, refreshFailed: 0, ...((cursor.counts ?? {}) as Record<string, number>) };
  const snapshot = (): JsonObject => ({ windowEnd, phase, sliceStart, ...(staleIds ? { staleIds, staleIndex } : {}), counts });
  const v2026 = ordersApiVersion(config) === "v2026";
  const marketplaceIds = config.optional("MARKETPLACE_IDS", config.optional("MARKETPLACE_ID", "ATVPDKIKX0DER"));
  const overBudget = (): boolean => Date.now() - startedAt >= RECONCILE_BUDGET_MS;
  const pause = async (): Promise<JsonObject> => {
    const nextAt = new Date(Date.now() + 60_000);
    await state.saveTask("order-reconcile", taskId, snapshot(), "active", nextAt.toISOString());
    await schedule({ taskType: "order-reconcile", taskId, ...(event.scheduledAt ? { scheduledAt: event.scheduledAt } : {}) }, nextAt);
    return { status: "continuing", taskId, phase, ...counts };
  };
  const refresh = async (orderId: string, occurredAt: string, version: number): Promise<void> => {
    const synthetic: BusinessEvent = { module: "order", entityKey: `order#${orderId}`, eventKey: "ORDER_CHANGE", version, occurredAt, payload: { orderId, suppressNotifications: true } };
    const owner = ownerId();
    const claim = await state.claimEvent(synthetic.entityKey, synthetic.eventKey, synthetic.version, owner, 240_000);
    if (claim.status === "busy") { counts.busyOrders = (counts.busyOrders ?? 0) + 1; return; }
    if (claim.status === "duplicate") { counts.duplicates = (counts.duplicates ?? 0) + 1; return; }
    try {
      const result = await processOrderEvent(synthetic, config, state, amazon, feishu, { pace: true });
      await state.completeEvent(synthetic.entityKey, synthetic.eventKey, owner, result);
      counts.processed = (counts.processed ?? 0) + 1;
    } catch (error) {
      await state.failEvent(synthetic.entityKey, synthetic.eventKey, owner, error);
      throw error;
    }
  };
  while (phase !== "stale") {
    if (Date.parse(sliceStart) >= Date.parse(windowEnd)) {
      phase = phase === "created" ? "updated" : "stale";
      sliceStart = phase === "updated" ? phaseStart("updated", windowEnd) : windowEnd;
      continue;
    }
    const sliceEnd = new Date(Math.min(Date.parse(sliceStart) + DAY, Date.parse(windowEnd))).toISOString();
    const range = phase === "created" ? { CreatedAfter: sliceStart, CreatedBefore: sliceEnd } : { LastUpdatedAfter: sliceStart, LastUpdatedBefore: sliceEnd };
    const range2026 = phase === "created" ? { createdAfter: sliceStart, createdBefore: sliceEnd } : { lastUpdatedAfter: sliceStart, lastUpdatedBefore: sliceEnd };
    let nextToken = "";
    const seen = new Set<string>();
    do {
      if (overBudget()) return pause();
      // v2026 用 searchOrders（0.0056 次/秒、突发 20，令牌 24 小时过期）：按一天时间片在本次调用内翻完，不跨调用保存令牌。
      const response = v2026
        ? await amazon.sp<JsonObject>("/orders/2026-01-01/orders", { query: { marketplaceIds, maxResultsPerPage: 100, ...range2026, ...(nextToken ? { paginationToken: nextToken } : {}) } })
        : await amazon.sp<JsonObject>("/orders/v0/orders", { query: nextToken ? { NextToken: nextToken } : { MarketplaceIds: marketplaceIds, ...range } });
      const payload = (response.payload ?? response) as JsonObject;
      for (const order of rows(payload.Orders ?? payload.orders)) {
        if (overBudget()) return pause();
        const orderId = text(order.AmazonOrderId ?? order.amazonOrderId ?? order.orderId);
        if (!orderId) continue;
        const occurredAt = (v2026 ? truncateToSeconds(order.lastUpdatedTime) : text(order.LastUpdateDate ?? order.lastUpdateDate)) || event.scheduledAt || new Date().toISOString();
        await refresh(orderId, occurredAt, Date.parse(occurredAt) || Date.now());
      }
      nextToken = text(v2026 ? (payload.pagination as JsonObject | undefined)?.nextToken : payload.NextToken ?? payload.nextToken);
      if (nextToken && seen.has(nextToken)) throw new Error(`订单 ${phase} 分页 NextToken 重复。`);
      if (nextToken) seen.add(nextToken);
    } while (nextToken);
    sliceStart = sliceEnd;
    await state.saveTask("order-reconcile", taskId, snapshot(), "active");
  }
  if (!staleIds) {
    staleIds = await staleOrderIds(config, feishu, startedAt);
    staleIndex = 0;
    await state.saveTask("order-reconcile", taskId, snapshot(), "active");
  }
  for (; staleIndex < staleIds.length; staleIndex += 1) {
    if (overBudget()) return pause();
    const orderId = staleIds[staleIndex]!;
    const now = new Date().toISOString();
    // 旧订单逐单隔离：单单失败（如 Amazon 查不到、飞书重复行）只计数，不阻塞整轮校准。
    try { await refresh(orderId, now, Date.parse(now)); counts.refreshed = (counts.refreshed ?? 0) + 1; }
    catch (error) {
      counts.refreshFailed = (counts.refreshFailed ?? 0) + 1;
      log("WARN", "order_stale_refresh_failed", { taskId, orderId, error: errorText(error).slice(0, 200) });
    }
  }
  await state.saveTask("order-reconcile", taskId, snapshot(), "done");
  return { status: "done", taskId, ...counts, staleOrders: staleIds.length };
}

// 竞品报价：New 条件下浏览占比最大 segment 的 featured offer 到手价（含默认运费）；没有 featured offer 用 New 最低到手价。
function competitorQuote(summary: SummaryView | undefined): { price: number; source: string; buyBox: string; promotions: string; promoTypes: string[] } | undefined {
  if (!summary?.ok) return undefined;
  const main = summary.featured[0];
  const chosen = main ?? summary.lowestNew;
  if (!chosen) return undefined;
  const buyBox = main ? (main.fulfillmentType === "AFN" ? "FBA" : "自发货") : "无（按 New 最低报价）";
  return { price: chosen.landed, source: main ? "featuredBuyingOptions" : "lowestPricedOffers", buyBox, promotions: main ? promotionSignature(main.promotions) : "", promoTypes: main ? [...new Set(main.promotions.map((item) => item.type))].sort() : [] };
}

// 竞品大促加密：计划每 2 小时（北京时间偶数整点）触发；平时只有 14:00 那一轮比价，其余轮次直接跳过（不调接口、不记健康）。
// 没有计划时间（旧调用、测试）按 14:00 那一轮处理；手动调用带 cursor.force=true 不论时段都比价。
export const COMPETITOR_DAILY_HOUR = 14;
export function isCompetitorDailySlot(scheduledAt: unknown): boolean {
  const ms = timeMs(scheduledAt);
  if (!ms) return true;
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" }).format(new Date(ms))) === COMPETITOR_DAILY_HOUR;
}

// 北京时间“MM-DD HH:mm”（sv-SE 只取月日时会输出“日/月”，所以按字段拼）。
function shortTime(iso: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// 口径标记：v0 getCompetitivePricing 换成 getCompetitiveSummary 后，旧价格与新价格不可直接比较。
// 已有旧实现的成功运行记录（HEALTH）而尚无新口径标记时，本轮只写新基准并落标记；标记之后仍缺口径字段的旧记录也只重建基准。
export const COMPETITOR_BASIS = "competitiveSummary-v1";

// 比价清单＝SSM 人工竞品 ∪ 状态表自动竞品（见 competitor-sets.ts）；到期时先刷新自动清单，刷新查过的报价本轮直接复用。
// 自动竞品（含移除后再加入）在加入后第一次比价只记基准：旧价格记录早于加入时间时不比较。
// 大促窗口内（见 sale-windows.ts）每轮都比价，本轮全部价格变化与开始促销合并成一条“🛒 大促竞品动态”（键 competitor-sale|<计划时间>）：
// 先持久化意图、再写比价记录、再发送；平时逐条通知不变。清单刷新与本店大促活动刷新只在 14:00 那一轮。
export async function runCompetitorPrices(event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient): Promise<JsonObject> {
  const sale = saleSettings(config);
  const now = new Date(timeMs(event.scheduledAt) || Date.now());
  const daily = isCompetitorDailySlot(event.scheduledAt) || event.cursor?.force === true;
  const events = daily && sale.enabled ? await refreshPromotionEvents(amazon, state, [...new Set(config.asins().map((item) => item.sku))], now) : undefined;
  const mode = await currentSaleMode(state, sale, now);
  if (!daily && !mode.active) return { status: "done", skipped: true };
  const settings = competitorSettings(config);
  const refresh = daily && settings ? await refreshIfDue({ config, state, amazon, feishu }, settings) : undefined;
  const tracked = await trackedCompetitors(config, state, settings);
  const byAsin = new Map(tracked.map((item) => [item.asin, item]));
  const asins = tracked.map((item) => item.asin);
  const day = ymdInZone(new Date(), "Asia/Shanghai");
  const meta = await state.get("COMPETITOR_PRICE_META", "basis");
  const baselineOnly = !meta && !!(await state.get("HEALTH", "competitor-prices"));
  let checked = 0;
  let changed = 0;
  let promoAlerts = 0;
  const unavailable: string[] = [];
  const newDeals: string[] = [];
  const saleLines: string[] = [];
  const records: JsonObject[] = [];
  const prefetched = refresh?.summaries ?? new Map<string, SummaryView>();
  const missing = asins.filter((asin) => !prefetched.has(asin));
  const summaries = missing.length ? await competitiveSummaries(amazon, missing, PRICE_SUMMARY_DATA) : new Map<string, SummaryView>();
  for (const asin of asins) {
    const quote = competitorQuote(summaries.get(asin) ?? prefetched.get(asin));
    if (!quote) { unavailable.push(asin); continue; }
    const { price } = quote;
    const previous = await state.get("COMPETITOR_PRICE", asin);
    const item = byAsin.get(asin);
    const auto = !!item && !item.manual;
    const rejoined = auto && item.since !== undefined && !(timeMs(previous?.updatedAt) >= timeMs(item.since));
    const comparable = !baselineOnly && !rejoined && !!previous && (previous.basis === COMPETITOR_BASIS || (previous.basis === undefined && !meta));
    const old = previous?.price === undefined ? null : Number(previous.price);
    const skus = item?.skus ?? [];
    const promoText = quote.promotions || "无";
    // 自动竞品在原有行之后追加一行品牌与标题，便于认出是哪个商品。
    const origin = auto ? [`竞品：${[item.brand, item.title.slice(0, 40)].filter(Boolean).join("｜") || "未知"}（自动跟踪）`] : [];
    const priceChanged = comparable && old !== null && Number.isFinite(old) && old !== price;
    const promoStarted = comparable && previous?.promoSignature === "" && !!quote.promotions;
    if (comparable && quote.promoTypes.includes("DEAL") && !hasDeal(previous?.promoTypes, previous?.promoSignature)) newDeals.push(asin);
    if (mode.active) {
      if (priceChanged || promoStarted) saleLines.push(`【${skus.join("、")}】${asin}${auto && item.brand ? ` ${item.brand}` : ""}：${priceChanged ? `${old!.toFixed(2)} → ${price.toFixed(2)}` : `到手价 ${price.toFixed(2)}`}${quote.promotions ? `｜${promoStarted ? "开始促销" : "促销"}：${quote.promotions}` : ""}`);
    } else {
      if (priceChanged) {
        // 键含旧价、新价与北京日期：价格回摆到曾出现过的价位时仍会通知，同一天同一变化只通知一次。原有四行不变，只在其后追加。
        await deliverNotification(config, state, feishu, `competitor|${asin}|${old!.toFixed(2)}->${price.toFixed(2)}|${day}`, ["竞品价格变化", `${old!.toFixed(2)} → ${price.toFixed(2)}`, `SKU：${skus.join("、")}`, `竞品ASIN：${asin}`, `Buy Box：${quote.buyBox}`, `促销：${promoText}`, ...origin]);
      }
      // 竞品从“无促销”（上次已按新口径确认为空）变为“有促销”单独提醒；键含促销签名与北京日期，同日同一促销只发一次。
      if (promoStarted) await deliverNotification(config, state, feishu, `competitor-promo|${asin}|${sha256(quote.promotions).slice(0, 12)}|${day}`, ["竞品开始促销", `SKU：${skus.join("、")}`, `竞品ASIN：${asin}`, `促销：${quote.promotions}`, `到手价：${price.toFixed(2)}`, `Buy Box：${quote.buyBox}`, ...origin]);
    }
    if (priceChanged) changed += 1;
    if (promoStarted) promoAlerts += 1;
    const record: JsonObject = { pk: "COMPETITOR_PRICE", sk: asin, sku: skus[0] ?? "", price, basis: COMPETITOR_BASIS, source: quote.source, buyBox: quote.buyBox, promoSignature: quote.promotions, promoTypes: quote.promoTypes, updatedAt: new Date().toISOString() };
    if (mode.active) records.push(record);
    else await state.put(record);
    checked += 1;
  }
  // 数据触发：同一轮新开限时折扣的竞品达到阈值即加密 48 小时（已在触发期内则顺延）；消息意图先于状态写入。
  const triggerAt = sale.enabled && sale.dealTrigger > 0 && newDeals.length >= sale.dealTrigger ? new Date(now.getTime() + SALE_TRIGGER_HOURS * 3_600_000).toISOString() : undefined;
  const triggerLine = triggerAt ? `⚡ ${newDeals.length} 个竞品同时开始限时折扣，已进入大促加密：每 2 小时比价一次，至 ${shortTime(triggerAt)}（北京时间）` : "";
  let saleKey = "";
  if (mode.active && (saleLines.length || triggerLine)) {
    const reasons = [...new Set([...mode.windows.map((item) => item.name), ...(mode.triggerUntil ? ["竞品集中开限时折扣"] : [])])];
    saleKey = `competitor-sale|${event.scheduledAt ?? now.toISOString()}`;
    await prepareNotification(config, state, saleKey, [`🛒 大促竞品动态${reasons.length ? `（${reasons.join("、")}）` : ""}`, ...(triggerLine ? [triggerLine] : []), ...saleLines, "大促期间每 2 小时比价一次，只列与上一轮相比的变化。"]);
  } else if (triggerLine) {
    saleKey = `competitor-sale-trigger|${triggerAt!.slice(0, 13)}`;
    await prepareNotification(config, state, saleKey, [triggerLine, ...newDeals.map((asin) => `【${(byAsin.get(asin)?.skus ?? []).join("、")}】${asin}`)]);
  }
  for (const record of records) await state.put(record);
  if (triggerAt) await applyDealTrigger(state, sale, newDeals, now);
  if (baselineOnly) await state.put({ pk: "COMPETITOR_PRICE_META", sk: "basis", basis: COMPETITOR_BASIS, switchedAt: new Date().toISOString(), baselineAsins: checked });
  if (saleKey) await flushNotification(state, feishu, saleKey);
  // 上一轮清单汇总消息若还没发出（如发送时飞书失败），这里补发；维护任务也会补发。
  if (refresh?.pendingKey) {
    try { await flushNotification(state, feishu, refresh.pendingKey); }
    catch (error) { log("WARN", "competitor_set_resend_failed", { eventKey: refresh.pendingKey, error: errorText(error).slice(0, 200) }); }
  }
  const autoTracked = tracked.filter((item) => !item.manual).length;
  const saleMode = [...mode.windows.map((item) => item.name), ...(mode.triggerUntil ? ["trigger"] : [])].join(",");
  return {
    status: "done", checked, changed, unavailable,
    ...(baselineOnly ? { baselineOnly: true } : {}), ...(promoAlerts ? { promoAlerts } : {}), ...(autoTracked ? { autoTracked } : {}),
    ...(saleMode ? { saleMode } : {}), ...(newDeals.length ? { newDeals: newDeals.length } : {}), ...(triggerAt ? { saleTriggerUntil: triggerAt } : {}),
    ...(events?.promotionEvents === "failed" || Number(events?.promotionEvents) > 0 ? { promotionEvents: events!.promotionEvents! } : {}),
    ...(refresh?.result ?? {}),
  };
}
