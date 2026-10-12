import assert from "node:assert/strict";
import test from "node:test";
import { isCompetitorDailySlot, runCompetitorPrices } from "../../src/business/orders-periodic.js";
import { easterYmd, parseSaleWindows, promotionEventName, ruleSaleWindows, thanksgivingYmd } from "../../src/business/sale-windows.js";
import { healthTaskType } from "../../src/handlers/jobs.js";
import type { AppConfig } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { COMPETITOR_BASIS } from "../../src/business/orders-periodic.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const money = (amount: number): Row => ({ amount, currencyCode: "USD" });
const offer = (sellerId: string, listing: number, options: { promotions?: Row[] } = {}): Row => ({
  sellerId, condition: "New", fulfillmentType: "AFN", listingPrice: money(listing), shippingOptions: [{ shippingOptionType: "DEFAULT", price: money(0) }],
  ...(options.promotions ? { promotions: options.promotions } : {}), featuredOfferSegments: [{ customerMembership: "NON_PRIME", segmentDetails: { glanceViewWeightPercentage: 100 } }],
});
const summaryResponse = (asin: string, featured: Row[]): Row => ({ status: { statusCode: 200 }, body: { asin, marketplaceId: "ATVPDKIKX0DER", featuredBuyingOptions: [{ buyingOptionType: "New", segmentedFeaturedOffers: featured }], lowestPricedOffers: [] } });
const DAILY = "2026-10-07T06:00:00.000Z"; // 北京 14:00，洛杉矶 10/06，不在任何规则窗口
const configOf = (options: Record<string, string> = {}): AppConfig => ({
  get: (key: string) => key,
  optional: (key: string, fallback = "") => key === "FEISHU_NOTIFY_USER_IDS" ? "u1" : options[key] ?? fallback,
  bool: (key: string, fallback: boolean) => options[key] === undefined ? fallback : options[key] === "true",
  asins: () => [{ sku: "SKU-1", asin: "B0OWN", competitors: ["B0COMP1", "B0COMP2"], adMarker: "" }],
}) as unknown as AppConfig;

function harness(initial: Row[], respond: (asin: string) => Row, promotions: Row[] = []) {
  const paths: string[] = [];
  const amazon = { sp: async (path: string, init: { body?: { requests: Row[] } }) => {
    paths.push(path);
    if (path.startsWith("/promotions/")) return { promotions };
    return { responses: (init.body?.requests ?? []).map((request) => respond(String(request.asin))) };
  } } as unknown as AmazonClient;
  const sent: string[][] = [];
  const feishu = { sendText: async (_user: string, lines: string[]) => { sent.push(lines); } } as unknown as FeishuClient;
  const state = new MemoryState(initial);
  const run = (scheduledAt: string, options: Record<string, string> = {}, cursor?: Row) => runCompetitorPrices({ taskType: "competitor-prices", scheduledAt, ...(cursor ? { cursor } : {}) } as never, configOf(options), state.asStore(), amazon, feishu);
  return { paths, sent, state, run };
}
const known = (asin: string, price: number, promoSignature = ""): Row => ({ pk: "COMPETITOR_PRICE", sk: asin, sku: "SKU-1", price, basis: COMPETITOR_BASIS, promoSignature, updatedAt: "2026-10-01T06:00:00.000Z" });
const deal = (to: number): Row => ({ promotionType: "DEAL", promotionSavings: { discountedPrice: { amount: to, currencyCode: "USD" } } });

test("大促规则日期：复活节公式、感恩节＝11 月第 4 个周四；黑五网一＋圣诞季从感恩节前 7 天到 12/24，复活节前 14 天到当天", () => {
  assert.deepEqual([2024, 2025, 2026, 2027].map(easterYmd), ["2024-03-31", "2025-04-20", "2026-04-05", "2027-03-28"]);
  assert.deepEqual([2024, 2025, 2026, 2027].map(thanksgivingYmd), ["2024-11-28", "2025-11-27", "2026-11-26", "2027-11-25"]);
  assert.deepEqual(ruleSaleWindows(2026).map((item) => [item.name, item.start, item.end]), [["复活节", "2026-03-22", "2026-04-05"], ["黑五网一·圣诞季", "2026-11-19", "2026-12-24"]]);
});

test("人工大促窗口按“名称:开始~结束”解析，格式错误明确报错；本店活动按 eventId 或大促命名识别，平时折扣不算", () => {
  assert.deepEqual(parseSaleWindows("Prime Day:2027-06-22~2027-06-25；秋季大促：2027-10-05～2027-10-06"), [
    { name: "Prime Day", start: "2027-06-22", end: "2027-06-25", source: "config" },
    { name: "秋季大促", start: "2027-10-05", end: "2027-10-06", source: "config" },
  ]);
  assert.throws(() => parseSaleWindows("Prime Day 2027-06-22"), /COMPETITOR_SALE_WINDOWS/);
  assert.throws(() => parseSaleWindows("X:2027-06-25~2027-06-22"), /开始不晚于结束/);
  assert.equal(promotionEventName({ promotionTitle: "2026PrimeDay", schedule: {} }), "2026PrimeDay");
  assert.equal(promotionEventName({ promotionTitle: "2025黑五网一", schedule: {} }), "2025黑五网一");
  assert.equal(promotionEventName({ promotionTitle: "x", schedule: { eventId: "Prime Day" } }), "Prime Day");
  for (const title of ["清货", "会员折扣", "prime 10% off", "清货prime价", "robot清货"]) assert.equal(promotionEventName({ promotionTitle: title, schedule: {} }), "", title);
});

test("竞品比价平时只有北京 14:00 那轮比价：其余轮次不调接口、不记健康；没有计划时间按 14:00 处理", async () => {
  assert.equal(isCompetitorDailySlot(DAILY), true);
  assert.equal(isCompetitorDailySlot("2026-10-07T08:00:00.000Z"), false);
  assert.equal(isCompetitorDailySlot(undefined), true);
  const h = harness([known("B0COMP1", 15), known("B0COMP2", 20)], (asin) => summaryResponse(asin, [offer("S", 14)]));
  const skipped = await h.run("2026-10-07T08:00:00.000Z");
  assert.deepEqual(skipped, { status: "done", skipped: true });
  assert.deepEqual(h.paths, [], "跳过的轮次不调亚马逊");
  assert.equal(healthTaskType({ taskType: "competitor-prices" }, "t", skipped), undefined, "跳过的轮次不算成功");
  assert.equal(healthTaskType({ taskType: "competitor-prices" }, "t", { status: "done", checked: 2 }), "competitor-prices");
});

test("大促窗口内非 14:00 轮次也比价，本轮变化合并成一条“大促竞品动态”，先持久化意图再写比价记录；不读本店活动、不刷新清单", async () => {
  const h = harness([known("B0COMP1", 15), known("B0COMP2", 20)], (asin) => asin === "B0COMP1" ? summaryResponse(asin, [offer("S", 16.99, { promotions: [deal(12.99)] })]) : summaryResponse(asin, [offer("S", 20)]));
  const scheduledAt = "2026-11-25T02:00:00.000Z"; // 北京 10:00，洛杉矶 11/24，在黑五网一·圣诞季窗口
  const result = await h.run(scheduledAt);
  assert.equal(result.saleMode, "黑五网一·圣诞季");
  assert.equal(result.changed, 1);
  assert.ok(!h.paths.some((path) => path.startsWith("/promotions/")), "本店活动只在 14:00 那轮读");
  assert.deepEqual(h.sent, [["🛒 大促竞品动态（黑五网一·圣诞季）", "【SKU-1】B0COMP1：15.00 → 16.99｜开始促销：DEAL 到手 $12.99", "大促期间每 2 小时比价一次，只列与上一轮相比的变化。"]]);
  assert.equal(h.state.item("NOTIFICATION", `competitor-sale|${scheduledAt}`)?.status, "done");
  assert.ok(!h.state.partition("NOTIFICATION").some((item) => /^competitor(-promo)?\|/.test(String(item.sk))), "窗口内不再逐条发");
  assert.deepEqual(h.state.item("COMPETITOR_PRICE", "B0COMP1")?.promoTypes, ["DEAL"]);
  const again = await h.run("2026-11-25T04:00:00.000Z");
  assert.equal(again.changed, 0);
  assert.equal(h.sent.length, 1, "没有变化不发");
});

test("平时 14:00 那轮 ≥2 个竞品新开限时折扣：逐条通知照发，另发一条触发提醒并加密 48 小时；触发期内非 14:00 轮次照常比价并注明原因", async () => {
  let price = 14;
  const h = harness([known("B0COMP1", 15), known("B0COMP2", 20)], (asin) => summaryResponse(asin, [offer("S", asin === "B0COMP1" ? 15 : price, { promotions: [deal(asin === "B0COMP1" ? 12 : 17)] })]));
  const result = await h.run(DAILY);
  assert.equal(result.newDeals, 2);
  assert.equal(result.saleTriggerUntil, "2026-10-09T06:00:00.000Z");
  assert.equal(h.state.item("COMPETITOR_SALE", "trigger")?.until, "2026-10-09T06:00:00.000Z");
  assert.ok(h.sent.some((lines) => lines[0] === "竞品开始促销"), "平时轮次逐条通知不变");
  const trigger = h.sent.find((lines) => lines[0]?.startsWith("⚡"));
  assert.ok(trigger?.[0]?.includes("2 个竞品同时开始限时折扣") && trigger[0].includes("10-09 14:00"));
  assert.deepEqual(trigger?.slice(1), ["【SKU-1】B0COMP1", "【SKU-1】B0COMP2"]);
  price = 13;
  const dense = await h.run("2026-10-07T10:00:00.000Z");
  assert.equal(dense.saleMode, "trigger");
  assert.deepEqual(h.sent.at(-1), ["🛒 大促竞品动态（竞品集中开限时折扣）", "【SKU-1】B0COMP2：14.00 → 13.00｜促销：DEAL 到手 $17.00", "大促期间每 2 小时比价一次，只列与上一轮相比的变化。"]);
  const after = await h.run("2026-10-09T08:00:00.000Z");
  assert.equal(after.skipped, true, "48 小时后恢复平时节奏");
});

test("本店报名的大促活动（按命名识别）在 14:00 那轮存成窗口，开始前 1 天起加密；总开关关闭时恢复每天一次、不触发", async () => {
  const promotions = [
    { promotionTitle: "2026PrimeDay", status: "UPCOMING", schedule: { startDate: "2026-10-20T00:00:01-07:00", endDate: "2026-10-23T23:59:59-07:00" } },
    { promotionTitle: "清货", status: "RUNNING", schedule: { startDate: "2026-10-05T01:18:20-07:00", endDate: "2026-11-03T23:59:59-08:00" } },
  ];
  const h = harness([known("B0COMP1", 15), known("B0COMP2", 20)], (asin) => summaryResponse(asin, [offer("S", 15, { promotions: [deal(12)] })]), promotions);
  const daily = await h.run(DAILY);
  assert.equal(daily.promotionEvents, 1);
  assert.deepEqual(h.state.item("COMPETITOR_SALE", "events")?.windows, [{ name: "2026PrimeDay", start: "2026-10-19", end: "2026-10-23", source: "promotion" }]);
  assert.equal((await h.run("2026-10-18T02:00:00.000Z")).skipped, true, "开始前 2 天仍是平时");
  assert.equal((await h.run("2026-10-20T02:00:00.000Z")).saleMode, "2026PrimeDay", "洛杉矶 10/19（开始前 1 天）起加密");
  assert.equal((await h.run("2026-10-20T04:00:00.000Z", { COMPETITOR_SALE_MODE_ENABLED: "false" })).skipped, true);
  const off = harness([known("B0COMP1", 15), known("B0COMP2", 20)], (asin) => summaryResponse(asin, [offer("S", 15, { promotions: [deal(12)] })]));
  const result = await off.run(DAILY, { COMPETITOR_SALE_MODE_ENABLED: "false" });
  assert.equal(result.newDeals, 2);
  assert.equal(result.saleTriggerUntil, undefined, "总开关关闭不触发加密");
  assert.equal(off.state.item("COMPETITOR_SALE", "trigger"), undefined);
  assert.ok(!off.paths.some((path) => path.startsWith("/promotions/")), "总开关关闭不读本店活动");
});

test("人工配置的大促窗口生效；手动 force 不论时段都比价", async () => {
  const h = harness([known("B0COMP1", 15), known("B0COMP2", 20)], (asin) => summaryResponse(asin, [offer("S", 15)]));
  const windows = { COMPETITOR_SALE_WINDOWS: "秋季大促:2027-10-05~2027-10-06" };
  assert.equal((await h.run("2027-10-06T02:00:00.000Z", windows)).saleMode, "秋季大促");
  assert.equal((await h.run("2027-10-08T02:00:00.000Z", windows)).skipped, true);
  const forced = await h.run("2027-10-08T04:00:00.000Z", windows, { force: true });
  assert.equal(forced.skipped, undefined);
  assert.equal(forced.checked, 2);
});
