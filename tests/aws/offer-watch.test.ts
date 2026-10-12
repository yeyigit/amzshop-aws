import assert from "node:assert/strict";
import test from "node:test";
import type { SQSRecord } from "aws-lambda";
import { applyOfferSnapshot, ownSkus, parseOfferNotification, processOfferSnapshot, type OfferContext, type OfferSnapshot } from "../../src/business/offers.js";
import { ITEM_OFFERS_PATH, runOfferReconcile, runOfferSubscriptionSetup } from "../../src/business/offer-tasks.js";
import { runBuyboxWatch } from "../../src/business/buybox.js";
import { runJob } from "../../src/business/jobs.js";
import { HEALTH_RULES } from "../../src/business/maintenance.js";
import { handleOfferRecords } from "../../src/handlers/offer.js";
import { prepareNotification } from "../../src/notifications.js";
import { HttpError } from "../../src/http.js";
import type { AppConfig } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const OWN = "SELLER-OWN";
const US = "ATVPDKIKX0DER";
const CA = "A2EUQ1WTGCTBG2";
const MX = "A1AM78C64UM0Y8";
const BR = "A2Q3Y263D00KWC";
const MARKETS = [US, CA, MX];
const T0 = Date.parse("2026-10-05T10:00:00.000Z");
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

function makeConfig(values: Record<string, string> = {}, bools: Record<string, boolean> = {}): AppConfig {
  const all: Record<string, string> = { FEISHU_NOTIFY_USER_IDS: "u1", SP_API_SELLER_ID: OWN, ...values };
  return {
    get: (key: string) => { const value = all[key]; if (!value) throw new Error(`缺少 ${key}`); return value; },
    optional: (key: string, fallback = "") => all[key] ?? fallback,
    bool: (key: string, fallback = false) => bools[key] ?? fallback,
    json: () => { throw new Error("unused"); },
    asins: () => [{ sku: "SKU-MAPPED", asin: "B0MAPPED01", competitors: [], adMarker: "" }],
    version: "test",
  };
}

const offer = (sellerId: string, amount: number, options: { fba?: boolean; winner?: boolean; feedback?: number; positive?: number; sub?: string; currency?: string } = {}): Row => ({
  SellerId: sellerId,
  SubCondition: options.sub ?? "new",
  ListingPrice: { Amount: amount, CurrencyCode: options.currency ?? "USD" },
  Shipping: { Amount: 0, CurrencyCode: options.currency ?? "USD" },
  IsFulfilledByAmazon: options.fba ?? true,
  ...(options.winner === undefined ? {} : { IsBuyBoxWinner: options.winner }),
  SellerFeedbackRating: { FeedbackCount: options.feedback ?? 100, SellerPositiveFeedbackRating: options.positive ?? 98 },
});

const notification = (asin: string, time: string, offers: Row[], options: { marketplace?: string; condition?: string; type?: string } = {}): string => JSON.stringify({
  NotificationVersion: "1.0", NotificationType: options.type ?? "ANY_OFFER_CHANGED", PayloadVersion: "1.0", EventTime: time,
  NotificationMetadata: { ApplicationId: "app", SubscriptionId: "sub", PublishTime: time, NotificationId: `n-${asin}-${time}` },
  Payload: { AnyOfferChangedNotification: { SellerId: OWN, OfferChangeTrigger: { MarketplaceId: options.marketplace ?? US, ASIN: asin, ItemCondition: options.condition ?? "new", TimeOfOfferChange: time, OfferChangeType: "Internal" }, Summary: {}, Offers: offers } },
});

const listing = (asin: string, sku = "SKU-A"): Row => ({ pk: "OFFER_LISTINGS", sk: US, asins: { [asin]: { skus: [sku], hasOffer: true, title: "t" } }, refreshedAt: at(0) });

function harness(initial: Row[] = [], options: { config?: AppConfig; sp?: (path: string, init: Row) => unknown } = {}) {
  const state = new MemoryState(initial);
  const sent: string[][] = [];
  const calls: Array<Row & { path: string }> = [];
  const feishu = { sendText: async (_user: string, lines: string[]) => { sent.push(lines); } } as unknown as FeishuClient;
  const amazon = { sp: async (path: string, init: Row = {}) => { calls.push({ path, ...init }); return options.sp ? options.sp(path, init) : { items: [] }; } } as unknown as AmazonClient;
  const config = options.config ?? makeConfig();
  const context: OfferContext = { config, state: state.asStore(), amazon, feishu, own: OWN, allowed: new Set(["ALLOWED-1"]) };
  const push = async (body: string) => handleOfferRecords([{ messageId: "m1", body } as unknown as SQSRecord], context, MARKETS);
  return { state, sent, calls, context, config, push };
}

test("报价推送解析：官方结构生成全新品快照；SNS 包装同样可读；其它类型、非全新品、非范围站点忽略；缺 ASIN 报错", () => {
  const body = notification("B0TEST0001", at(5), [offer(OWN, 12.99, { winner: true }), offer("USED-1", 5, { sub: "used" }), offer("HIJACK", 9.99, { fba: false, winner: false })]);
  const parsed = parseOfferNotification(body, MARKETS);
  assert.ok("snapshot" in parsed);
  assert.equal(parsed.snapshot.asin, "B0TEST0001");
  assert.equal(parsed.snapshot.marketplaceId, US);
  assert.equal(parsed.snapshot.at, at(5));
  assert.equal(parsed.snapshot.source, "push");
  assert.deepEqual(parsed.snapshot.offers.map((item) => [item.sellerId, item.landed, item.fba, item.winner]), [[OWN, 12.99, true, true], ["HIJACK", 9.99, false, false]], "二手报价不进快照");
  const wrapped = parseOfferNotification(JSON.stringify({ Type: "Notification", Message: body }), MARKETS);
  assert.deepEqual(wrapped, parsed);
  assert.deepEqual(parseOfferNotification(notification("B0TEST0001", at(5), [], { condition: "used" }), MARKETS), { ignored: "condition:used" });
  assert.deepEqual(parseOfferNotification(notification("B0TEST0001", at(5), [], { marketplace: BR }), MARKETS), { ignored: `marketplace:${BR}` });
  assert.deepEqual(parseOfferNotification(JSON.stringify({ NotificationType: "ORDER_CHANGE", Payload: {} }), MARKETS), { ignored: "type:ORDER_CHANGE" });
  assert.throws(() => parseOfferNotification(notification("", at(5), []), MARKETS), /缺少有效 ASIN/);
});

test("跟卖出现立即提醒一次：带我的 SKU、对方卖家、店铺链接、报价与购物车归属；重复推送不再提醒；旧推送不覆盖新状态", async () => {
  const h = harness([listing("B0TEST0001")]);
  await h.push(notification("B0TEST0001", at(0), [offer(OWN, 12.99, { winner: true })]));
  assert.equal(h.sent.length, 0);
  assert.equal((h.state.item("OFFER", `${US}|B0TEST0001`)?.buyBox as Row).status, "won");
  await h.push(notification("B0TEST0001", at(5), [offer(OWN, 12.99, { winner: true }), offer("HIJACK", 9.99, { fba: false, winner: false, feedback: 3, positive: 67 })]));
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], [
    "🚨 发现跟卖（美国站）",
    "我的 SKU：SKU-A",
    "ASIN：B0TEST0001",
    "跟卖卖家：HIJACK",
    "店铺：https://www.amazon.com/sp?seller=HIJACK",
    "对方报价：$9.99（自发货），反馈 3 条 · 67% 好评",
    "购物车：仍在你手里",
    "我的报价：$12.99（FBA）",
    "时间：10-05 18:05（北京）",
  ]);
  await h.push(notification("B0TEST0001", at(5), [offer(OWN, 12.99, { winner: true }), offer("HIJACK", 9.99, { fba: false, winner: false })]));
  assert.equal(h.sent.length, 1, "重复推送不重复提醒");
  await h.push(notification("B0TEST0001", at(3), [offer(OWN, 12.99, { winner: true })]));
  const sellers = h.state.item("OFFER", `${US}|B0TEST0001`)?.sellers as Record<string, Row>;
  assert.equal(sellers.HIJACK?.absentSince, undefined, "旧推送不覆盖新状态");
  assert.equal(h.state.item("OFFER", `${US}|B0TEST0001`)?.eventAt, at(5));
});

test("跟卖者同时拿走购物车只发一条；未结期间反复易手不重复；重新持有满 1 小时才提醒恢复", async () => {
  const h = harness([listing("B0TAKE0001")]);
  const own = (winner: boolean) => offer(OWN, 12.99, { winner });
  const rival = (winner: boolean) => offer("HIJACK", 9.99, { winner });
  await h.push(notification("B0TAKE0001", at(0), [own(true)]));
  await h.push(notification("B0TAKE0001", at(10), [own(false), rival(true)]));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]![0], "🚨 发现跟卖，购物车被对方拿走（美国站）");
  assert.ok(!h.sent[0]!.some((line) => line.startsWith("购物车：")), "标题已说明购物车被拿走");
  assert.equal(h.state.item("NOTIFICATION", `offer-buybox|${US}|B0TAKE0001|1`), undefined, "不单发购物车丢失");
  const buyBox = () => h.state.item("OFFER", `${US}|B0TAKE0001`)?.buyBox as Row;
  assert.equal(buyBox().status, "lost");
  assert.equal(buyBox().holder, "HIJACK");
  await h.push(notification("B0TAKE0001", at(20), [own(true), rival(false)]));
  assert.equal(buyBox().wonSince, at(20));
  await h.push(notification("B0TAKE0001", at(40), [own(false), rival(true)]));
  assert.equal(buyBox().wonSince, undefined, "再次易手重新计时");
  await h.push(notification("B0TAKE0001", at(50), [own(true), rival(false)]));
  await h.push(notification("B0TAKE0001", at(80), [own(true), rival(false)]));
  assert.equal(h.sent.length, 1, "持有不满 1 小时不算恢复");
  await h.push(notification("B0TAKE0001", at(111), [own(true), rival(false)]));
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1], ["✅ 购物车已恢复（美国站）", "我的 SKU：SKU-A", "ASIN：B0TAKE0001", "本次丢失约 40 分钟（10-05 18:10 起），已稳定持有满 1 小时"]);
  assert.equal(buyBox().status, "won");
  await h.push(notification("B0TAKE0001", at(130), [own(true), rival(false)]));
  assert.equal(h.sent.length, 2);
});

test("跟卖者消失不满 1 小时又回来不算离开；消失满 1 小时提醒一次离开；之后再出现算新一轮", async () => {
  const h = harness([listing("B0LEAV0001")]);
  const both = [offer(OWN, 12.99, { winner: true }), offer("HIJACK", 9.99, { winner: false })];
  const alone = [offer(OWN, 12.99, { winner: true })];
  await h.push(notification("B0LEAV0001", at(0), both));
  await h.push(notification("B0LEAV0001", at(10), alone));
  await h.push(notification("B0LEAV0001", at(30), both));
  await h.push(notification("B0LEAV0001", at(60), alone));
  await h.push(notification("B0LEAV0001", at(100), alone));
  assert.equal(h.sent.length, 1, "只有首次出现提醒");
  await h.push(notification("B0LEAV0001", at(121), alone));
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1], ["✅ 跟卖已离开（美国站）", "我的 SKU：SKU-A", "ASIN：B0LEAV0001", "跟卖卖家：HIJACK", "店铺：https://www.amazon.com/sp?seller=HIJACK", "在你的 listing 上停留约 1 小时（10-05 18:00 至 10-05 19:00，北京）"]);
  await h.push(notification("B0LEAV0001", at(130), alone));
  assert.equal(h.sent.length, 2);
  await h.push(notification("B0LEAV0001", at(200), both));
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2]![0], "🚨 发现跟卖（美国站）");
  assert.ok(h.state.item("NOTIFICATION", `offer-seller|${US}|B0LEAV0001|HIJACK|2`), "再出现是第 2 轮");
});

test("购物车给他人或被压制立即提醒；无持有标记不发购物车提醒；本店未在售时不发任何提醒；白名单、本店、二手不算跟卖；亚马逊自营与站点币种正确标注", async () => {
  const seeded = { pk: "OFFER", sk: `${US}|B0LOST0001`, marketplaceId: US, asin: "B0LOST0001", eventAt: at(0), source: "push", rev: 1, sellers: { RIVAL: { episode: 1, firstSeenAt: at(0), lastSeenAt: at(0), landed: 9.5, currency: "USD", fba: true, feedbackCount: 50, positive: 99 } }, buyBox: { status: "won", incident: 0 }, own: null, notificationKeys: [] };
  const h = harness([seeded]);
  await h.push(notification("B0LOST0001", at(10), [offer(OWN, 12.99, { winner: false }), offer("RIVAL", 9.5, { winner: true })]));
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0]!.slice(0, 1).concat(h.sent[0]!.slice(3)), ["⚠️ 购物车丢失（美国站）", "当前持有：RIVAL（跟卖） $9.50 FBA", "店铺：https://www.amazon.com/sp?seller=RIVAL", "我的报价：$12.99（FBA）", "时间：10-05 18:10（北京）"]);
  await h.push(notification("B0SUPP0001", at(10), [offer(OWN, 12.99, { winner: false })]));
  assert.equal(h.sent.length, 2);
  assert.ok(h.sent[1]!.includes("当前持有：无人持有（购物车被压制，常见原因是价格高于亚马逊参考价）"));
  await h.push(notification("B0UNKN0001", at(10), [offer(OWN, 12.99), offer("HIJACK2", 9)]));
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2]![0], "🚨 发现跟卖（美国站）", "无持有标记时只报跟卖");
  assert.ok(!h.sent[2]!.some((line) => line.startsWith("购物车：")));
  assert.equal((h.state.item("OFFER", `${US}|B0UNKN0001`)?.buyBox as Row).status, "unknown");
  await h.push(notification("B0OOS00001", at(10), [offer("HIJACK3", 9, { winner: true })]));
  assert.equal(h.sent.length, 3, "本店未在售：不发跟卖提醒（用户 10/05 决定）");
  assert.deepEqual(h.state.item("OFFER", `${US}|B0OOS00001`)?.sellers, {}, "未在售期间不跟踪");
  assert.equal((h.state.item("OFFER", `${US}|B0OOS00001`)?.buyBox as Row).status, "unknown", "本店断货不判购物车");
  await h.push(notification("B0FILT0001", at(10), [offer(OWN, 12.99, { winner: true }), offer("ALLOWED-1", 11), offer("USED-1", 5, { sub: "used" })]));
  assert.equal(h.sent.length, 3, "白名单与二手不算跟卖");
  assert.deepEqual(h.state.item("OFFER", `${US}|B0FILT0001`)?.sellers, {});
  await h.push(notification("B0AMZN0001", at(10), [offer(OWN, 12.99, { winner: true }), offer(US, 11.49)]));
  assert.ok(h.sent[3]!.includes(`跟卖卖家：${US}（亚马逊自营）`));
  await h.push(notification("B0CANA0001", at(10), [offer(OWN, 20, { winner: true, currency: "CAD" }), offer("HIJACK-CA", 14.99, { currency: "CAD" })], { marketplace: CA }));
  assert.equal(h.sent[4]![0], "🚨 发现跟卖（加拿大站）");
  assert.ok(h.sent[4]!.includes("店铺：https://www.amazon.ca/sp?seller=HIJACK-CA"));
  assert.ok(h.sent[4]!.some((line) => line.startsWith("对方报价：C$14.99（FBA）")));
});

test("未在售期间跟卖状态冻结：不提醒出现也不判离开；恢复在售时仍在的新跟卖者才提醒；在售时已提醒过的不重复", async () => {
  const h = harness([listing("B0FRZ00001")]);
  const rival = (winner?: boolean) => offer("HIJACK", 9.99, winner === undefined ? {} : { winner });
  await h.push(notification("B0FRZ00001", at(0), [rival(true)]));
  assert.equal(h.sent.length, 0, "未在售时出现的跟卖者不提醒");
  await h.push(notification("B0FRZ00001", at(10), [offer(OWN, 12.99, { winner: false }), rival(true)]));
  assert.equal(h.sent.length, 1, "恢复在售时对方仍在，按新出现提醒");
  assert.equal(h.sent[0]![0], "🚨 发现跟卖，购物车被对方拿走（美国站）");
  await h.push(notification("B0FRZ00001", at(20), [rival(true)]));
  await h.push(notification("B0FRZ00001", at(200), [rival(true)]));
  const track = () => (h.state.item("OFFER", `${US}|B0FRZ00001`)?.sellers as Record<string, Row>).HIJACK!;
  assert.equal(track().absentSince, undefined, "断货期间不判离开");
  assert.equal(track().lastSeenAt, at(10), "断货期间状态冻结");
  await h.push(notification("B0FRZ00001", at(210), [offer(OWN, 12.99, { winner: true }), rival(false)]));
  assert.equal(h.sent.length, 1, "恢复在售时已提醒过的跟卖者不重复提醒");
  await h.push(notification("B0FRZ00001", at(280), [offer(OWN, 12.99, { winner: true })]));
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1]![0], "✅ 购物车已恢复（美国站）");
  await h.push(notification("B0FRZ00001", at(341), [offer(OWN, 12.99, { winner: true })]));
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2]![0], "✅ 跟卖已离开（美国站）");
});

test("并发写冲突时重读重算：另一实例已处理同一变化，两边的通知键相同，最终只发一条", async () => {
  const h = harness([listing("B0RACE0001")]);
  const snapshot: OfferSnapshot = { marketplaceId: US, asin: "B0RACE0001", at: at(5), source: "push", offers: [{ sellerId: OWN, landed: 12.99, currency: "USD", fba: true, winner: true, feedbackCount: 9, positive: 100 }, { sellerId: "HIJACK", landed: 9.99, currency: "USD", fba: false, winner: false, feedbackCount: 1, positive: 100 }] };
  const original = h.state.putVersioned.bind(h.state);
  let raced = false;
  h.state.putVersioned = async (item: Row, rev: number | undefined) => {
    if (!raced) {
      raced = true;
      const { next, changes } = applyOfferSnapshot(undefined, snapshot, OWN, new Set());
      await prepareNotification(h.config, h.state.asStore(), changes[0]!.eventKey, ["另一实例的跟卖提醒"]);
      await original({ ...next }, undefined);
      return false;
    }
    return original(item, rev);
  };
  const outcome = await processOfferSnapshot(snapshot, h.context);
  assert.deepEqual(outcome, { stale: false, changes: [] }, "重算后已无新变化");
  assert.equal(h.sent.length, 1, "同一变化只发一条");
  assert.equal(h.sent[0]![0], "🚨 发现跟卖（美国站）");
  assert.equal(h.state.item("NOTIFICATION", `offer-seller|${US}|B0RACE0001|HIJACK|1`)?.status, "done");
  assert.equal(h.state.item("OFFER", `${US}|B0RACE0001`)?.rev, 2);
});

test("我的 SKU 依次取本店 listing、SSM 映射、现查 Listings API；都查不到写“未找到”", async () => {
  const h = harness([listing("B0LIST0001", "SKU-LISTED")], { sp: (_path, init) => ((init.query as Row).identifiers === "B0LIVE0001" ? { items: [{ sku: "SKU-LIVE" }] } : (() => { throw new Error("boom"); })()) });
  assert.deepEqual(await ownSkus(h.context, US, "B0LIST0001"), ["SKU-LISTED"]);
  assert.deepEqual(await ownSkus(h.context, US, "B0MAPPED01"), ["SKU-MAPPED"]);
  assert.deepEqual(await ownSkus(h.context, US, "B0LIVE0001"), ["SKU-LIVE"]);
  assert.equal(h.calls.length, 1, "前两级命中时不调接口");
  assert.deepEqual(await ownSkus(h.context, US, "B0NONE0001"), []);
  await h.push(notification("B0NONE0001", at(5), [offer(OWN, 12.99, { winner: true }), offer("HIJACK", 9.99)]));
  assert.ok(h.sent[0]!.includes("我的 SKU：未找到（可能是新上架，或不在本店 listing 中）"));
});

test("处理函数只回报失败消息的 messageId；忽略的消息直接确认", async () => {
  const h = harness([listing("B0TEST0001")]);
  const records = [
    { messageId: "ok", body: notification("B0TEST0001", at(5), [offer(OWN, 12.99, { winner: true })]) },
    { messageId: "ignored", body: notification("B0TEST0001", at(5), [], { condition: "used" }) },
    { messageId: "bad-json", body: "not json" },
    { messageId: "no-asin", body: notification("", at(5), []) },
  ] as unknown as SQSRecord[];
  assert.deepEqual(await handleOfferRecords(records, h.context, MARKETS), [{ itemIdentifier: "bad-json" }, { itemIdentifier: "no-asin" }]);
});

const asinOf = (index: number): string => `B0REC${String(index).padStart(5, "0")}`;
function reconcileAmazon(options: { failBatches?: boolean; subscription?: "ok" | "missing" } = {}) {
  const us = [...Array.from({ length: 25 }, (_, index) => ({ sku: `SKU-${index}`, summaries: [{ marketplaceId: US, asin: asinOf(index), status: ["BUYABLE"], itemName: `Item ${index}` }], offers: [{ marketplaceId: US, price: { amount: 10 + index } }] })),
    { sku: "PARENT", summaries: [{ marketplaceId: US, asin: "B0PARENT01", status: ["DISCOVERABLE"], itemName: "Parent" }], offers: [] },
    { sku: "OUT-OF-STOCK", summaries: [{ marketplaceId: US, asin: "B0RECOOS01", status: ["DISCOVERABLE"], itemName: "Out of stock" }], offers: [{ marketplaceId: US, price: { amount: 15 } }] }];
  return (path: string, init: Row): unknown => {
    const query = (init.query ?? {}) as Row;
    if (path.startsWith("/listings/")) {
      if (query.marketplaceIds === US) return query.pageToken === "p2" ? { items: us.slice(20) } : { items: us.slice(0, 20), pagination: { nextToken: "p2" } };
      if (query.marketplaceIds === CA) return { items: [{ sku: "SKU-CA", summaries: [{ marketplaceId: CA, asin: "B0RECCA001", status: ["BUYABLE"], itemName: "CA item" }], offers: [] }] };
      return { items: [] };
    }
    if (path === ITEM_OFFERS_PATH) {
      if (options.failBatches) throw new HttpError(503, "ServiceUnavailable", "", "HTTP 503", true);
      const requests = (init.body as { requests: Row[] }).requests;
      return { responses: requests.map((request) => {
        const asin = String(request.uri).split("/")[5];
        const echo = { MarketplaceId: request.MarketplaceId, Asin: asin, ItemCondition: "New", CustomerType: "Consumer" };
        return asin === asinOf(3)
          ? { status: { statusCode: 400 }, body: { errors: [{ code: "InvalidInput" }] }, request: echo }
          : { status: { statusCode: 200 }, body: { payload: { ASIN: asin, marketplaceId: request.MarketplaceId, Offers: [offer(OWN, 12.99, { winner: true })] } }, request: echo };
      }).reverse() };
    }
    if (path.startsWith("/notifications/v1/subscriptions/")) {
      if (options.subscription === "missing") throw new HttpError(404, "NotFound", "", "HTTP 404", false);
      return { payload: { subscriptionId: "sub-1", destinationId: "dest-1" } };
    }
    throw new Error(`unexpected ${path}`);
  };
}

test("每小时对账：刷新本店 listing，每批不超过 20 个且按回显对应结果，取数失败的 ASIN 保留原状态；订阅指向本功能目的地才记健康", async () => {
  const h = harness([{ pk: "OFFER_META", sk: "subscription", destinationId: "dest-1" }], { sp: reconcileAmazon() });
  const result = await runOfferReconcile({ taskType: "offer-reconcile" }, h.config, h.state.asStore(), h.context.amazon, h.context.feishu);
  assert.equal(result.status, "done");
  assert.equal(result.targets, 26, "只查在售（BUYABLE）的 listing：父体与有价但未在售的都不查");
  assert.ok(!h.calls.some((call) => call.path === ITEM_OFFERS_PATH && JSON.stringify(call.body).includes("B0RECOOS01")));
  assert.equal(result.checked, 25);
  assert.deepEqual(result.unavailable, [`US:${asinOf(3)}`]);
  assert.equal(result.subscription, "ok");
  const batches = h.calls.filter((call) => call.path === ITEM_OFFERS_PATH);
  assert.deepEqual(batches.map((call) => (call.body as { requests: Row[] }).requests.length), [20, 6]);
  assert.ok(batches.every((call) => (call.pace as Row).key === "products-itemOffersBatch"));
  assert.equal(h.state.item("OFFER", `${US}|${asinOf(3)}`), undefined, "取数失败不写状态");
  assert.equal((h.state.item("OFFER", `${US}|${asinOf(4)}`)?.buyBox as Row).status, "won");
  assert.deepEqual(((h.state.item("OFFER_LISTINGS", US)?.asins as Record<string, Row>)[asinOf(0)])?.skus, ["SKU-0"]);
  assert.ok(h.state.item("OFFER_LISTINGS", CA) && h.state.item("OFFER_LISTINGS", MX));
  assert.equal(h.state.item("HEALTH", "offer-subscription")?.lastStatus, "done");
  assert.equal(h.sent.length, 0);
});

test("对账：订阅不存在不记健康；全部批次取数失败时任务失败", async () => {
  const missing = harness([{ pk: "OFFER_META", sk: "subscription", destinationId: "dest-1" }], { sp: reconcileAmazon({ subscription: "missing" }) });
  const result = await runOfferReconcile({ taskType: "offer-reconcile" }, missing.config, missing.state.asStore(), missing.context.amazon, missing.context.feishu);
  assert.equal(result.subscription, "missing");
  assert.equal(missing.state.item("HEALTH", "offer-subscription"), undefined);
  const failing = harness([], { sp: reconcileAmazon({ failBatches: true }) });
  await assert.rejects(() => runOfferReconcile({ taskType: "offer-reconcile" }, failing.config, failing.state.asStore(), failing.context.amazon, failing.context.feishu), /HTTP 503/);
});

test("订阅运维任务：默认只读预览；apply 建目的地与订阅（美加墨、5 分钟合并）；已有订阅指向别处不改动；remove 只删本功能订阅", async () => {
  const queueArn = "arn:aws:sqs:us-east-1:123456789012:amzshop-prod-offer-events";
  const previous = process.env.OFFER_QUEUE_ARN;
  process.env.OFFER_QUEUE_ARN = queueArn;
  try {
    const world = { destinations: [] as Row[], subscription: undefined as Row | undefined };
    const calls: Array<{ kind: string; path: string; method: string; body?: unknown }> = [];
    const amazon = {
      spGrantless: async (path: string, init: { method?: string; body?: unknown } = {}) => {
        calls.push({ kind: "grantless", path, method: init.method ?? "GET", body: init.body });
        if ((init.method ?? "GET") === "GET") return { payload: world.destinations };
        if (init.method === "POST") { const created = { destinationId: "dest-new", resource: { sqs: { arn: queueArn } } }; world.destinations.push(created); return { payload: created }; }
        world.subscription = undefined;
        return {};
      },
      sp: async (path: string, init: { method?: string; body?: unknown } = {}) => {
        calls.push({ kind: "sp", path, method: init.method ?? "GET", body: init.body });
        if ((init.method ?? "GET") === "GET") { if (!world.subscription) throw new HttpError(404, "NotFound", "", "HTTP 404", false); return { payload: world.subscription }; }
        world.subscription = { subscriptionId: "sub-new", destinationId: "dest-new" };
        return { payload: world.subscription };
      },
    } as unknown as AmazonClient;
    const state = new MemoryState();
    const config = makeConfig();
    const preview = await runOfferSubscriptionSetup({ taskType: "offer-subscription-setup" }, config, state.asStore(), amazon);
    assert.equal(preview.mode, "preview");
    assert.equal(preview.matches, false);
    assert.equal(state.writes.length, 0);
    assert.ok(calls.every((call) => call.method === "GET"), "预览只读");
    const applied = await runOfferSubscriptionSetup({ taskType: "offer-subscription-setup", cursor: { apply: true } }, config, state.asStore(), amazon);
    assert.equal(applied.matches, true);
    assert.equal(applied.marketplaces, "US,CA,MX");
    assert.deepEqual(calls.find((call) => call.kind === "grantless" && call.method === "POST")?.body, { name: "amzshop-prod-offer-events", resourceSpecification: { sqs: { arn: queueArn } } });
    assert.deepEqual(calls.find((call) => call.kind === "sp" && call.method === "POST")?.body, { payloadVersion: "1.0", destinationId: "dest-new", processingDirective: { eventFilter: { eventFilterType: "ANY_OFFER_CHANGED", marketplaceIds: MARKETS, aggregationSettings: { aggregationTimePeriod: "FiveMinutes" } } } });
    assert.equal(state.item("OFFER_META", "subscription")?.destinationId, "dest-new");
    const again = await runOfferSubscriptionSetup({ taskType: "offer-subscription-setup", cursor: { apply: true } }, config, state.asStore(), amazon);
    assert.equal(again.matches, true);
    assert.equal(calls.filter((call) => call.method === "POST").length, 2, "重复 apply 不重复创建");
    world.subscription = { subscriptionId: "sub-other", destinationId: "dest-order-queue" };
    const posts = calls.length;
    await assert.rejects(() => runOfferSubscriptionSetup({ taskType: "offer-subscription-setup", cursor: { apply: true } }, config, state.asStore(), amazon), /不指向报价队列/);
    await assert.rejects(() => runOfferSubscriptionSetup({ taskType: "offer-subscription-setup", cursor: { remove: true } }, config, state.asStore(), amazon), /拒绝删除/);
    assert.ok(calls.slice(posts).every((call) => call.method === "GET"), "指向别处时不做任何写操作");
    world.subscription = { subscriptionId: "sub-new", destinationId: "dest-new" };
    const removed = await runOfferSubscriptionSetup({ taskType: "offer-subscription-setup", cursor: { remove: true } }, config, state.asStore(), amazon);
    assert.equal(removed.subscriptionId, "");
    assert.ok(calls.some((call) => call.method === "DELETE" && call.path === "/notifications/v1/subscriptions/ANY_OFFER_CHANGED/sub-new"));
    assert.ok(state.item("OFFER_META", "subscription")?.removedAt);
  } finally {
    if (previous === undefined) delete process.env.OFFER_QUEUE_ARN; else process.env.OFFER_QUEUE_ARN = previous;
  }
});

test("旧 Buy Box 巡检开关：BUYBOX_WATCH_ENABLED=false 时不调接口、不发通知并记成功；不配置时照常运行", async () => {
  let called = 0;
  const amazon = { sp: async () => { called += 1; return { responses: [] }; } } as unknown as AmazonClient;
  const retired = await runBuyboxWatch({ taskType: "buybox-watch" }, makeConfig({}, { BUYBOX_WATCH_ENABLED: false }), new MemoryState().asStore(), amazon, {} as FeishuClient);
  assert.deepEqual(retired, { status: "done", retired: true, checked: 0 });
  assert.equal(called, 0);
  const running = await runBuyboxWatch({ taskType: "buybox-watch" }, makeConfig(), new MemoryState().asStore(), amazon, {} as FeishuClient);
  assert.equal(running.retired, undefined);
});

test("新任务接入任务分发与维护任务健康规则", async () => {
  const h = harness([], { sp: (path) => (path.startsWith("/notifications/") ? (() => { throw new HttpError(404, "NotFound", "", "HTTP 404", false); })() : { items: [] }) });
  const result = await runJob({ taskType: "offer-reconcile", taskId: "offer-reconcile|x" }, { config: h.config, state: h.state.asStore(), amazon: h.context.amazon, feishu: h.context.feishu });
  assert.equal(result.status, "done");
  assert.equal(result.subscription, "unconfigured");
  assert.equal(HEALTH_RULES["offer-reconcile"], 3 * 3_600_000);
  assert.equal(HEALTH_RULES["brand-watch"], 26 * 3_600_000);
  assert.equal(HEALTH_RULES["offer-subscription"], 26 * 3_600_000);
});
