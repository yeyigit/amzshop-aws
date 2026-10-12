import assert from "node:assert/strict";
import test from "node:test";
import { runCompetitorPrices } from "../../src/business/orders-periodic.js";
import { parseSummary } from "../../src/business/competitive.js";
import { ymdInZone } from "../../src/util.js";
import type { AppConfig } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
// 固定在平时（不在任何大促窗口）的 14:00 那轮，避免用例随运行日期进入大促合并模式。
export const DAILY_SLOT = "2026-10-07T06:00:00.000Z";
const configOf = (asins: Row[]): AppConfig => ({ get: (key: string) => key, optional: (key: string, fallback = "") => key === "FEISHU_NOTIFY_USER_IDS" ? "u1" : fallback, bool: () => true, asins: () => asins }) as unknown as AppConfig;
const money = (amount: number): Row => ({ amount, currencyCode: "USD" });
export const offer = (sellerId: string, listing: number, options: { shipping?: number; fba?: boolean; weight?: number; membership?: string; promotions?: Row[] } = {}): Row => ({
  sellerId, condition: "New", fulfillmentType: options.fba === false ? "MFN" : "AFN", listingPrice: money(listing),
  shippingOptions: [{ shippingOptionType: "DEFAULT", price: money(options.shipping ?? 0) }],
  ...(options.promotions ? { promotions: options.promotions } : {}),
  featuredOfferSegments: [{ customerMembership: options.membership ?? "NON_PRIME", segmentDetails: { glanceViewWeightPercentage: options.weight ?? 100 } }],
});
export const summaryResponse = (asin: string, featured: Row[], lowest: Row[] = []): Row => ({
  status: { statusCode: 200 },
  body: { asin, marketplaceId: "ATVPDKIKX0DER", featuredBuyingOptions: featured.length ? [{ buyingOptionType: "New", segmentedFeaturedOffers: featured }] : [], lowestPricedOffers: lowest.length ? [{ lowestPricedOffersInput: { itemCondition: "New", offerType: "Consumer" }, offers: lowest }] : [], referencePrices: [{ name: "WasPrice", price: money(30) }] },
});

function harness(initial: Row[], respond: (asin: string) => Row) {
  const calls: Array<{ path: string; method?: string; requests: Row[]; pace?: Row }> = [];
  const amazon = { sp: async (path: string, init: { method?: string; body?: { requests: Row[] }; pace?: Row }) => {
    if (path.startsWith("/promotions/")) return { promotions: [] };
    const requests = init.body?.requests ?? [];
    calls.push({ path, ...(init.method ? { method: init.method } : {}), requests, ...(init.pace ? { pace: init.pace } : {}) });
    return { responses: requests.map((request) => respond(String(request.asin))) };
  } } as unknown as AmazonClient;
  const sent: string[][] = [];
  const feishu = { sendText: async (_user: string, lines: string[]) => { sent.push(lines); } } as unknown as FeishuClient;
  const state = new MemoryState(initial);
  const run = () => runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, configOf([{ sku: "SKU-1", asin: "B0OWN", competitors: ["B0COMP1", "B0COMP2"], adMarker: "" }]), state.asStore(), amazon, feishu);
  return { calls, sent, state, run };
}

test("B1 切换到 getCompetitiveSummary 后首轮只写新基准不发价格变化通知，并落新口径标记；次轮按新口径比较并追加 Buy Box 与促销行", async () => {
  let price = 14.99;
  const h = harness([
    { pk: "HEALTH", sk: "competitor-prices", lastStatus: "done", lastSuccessAt: "2026-09-30T06:00:10.000Z", summary: { checked: 2 } },
    { pk: "COMPETITOR_PRICE", sk: "B0COMP1", sku: "SKU-1", price: 13.5, updatedAt: "2026-09-30T06:00:05.000Z" },
    { pk: "COMPETITOR_PRICE", sk: "B0COMP2", sku: "SKU-1", price: 20, updatedAt: "2026-09-30T06:00:05.000Z" },
  ], (asin) => asin === "B0COMP1" ? summaryResponse(asin, [offer("S-A", price, { shipping: 1 })]) : summaryResponse(asin, [offer("S-B", 21, { fba: false })]));
  const first = await h.run();
  assert.equal(first.baselineOnly, true);
  assert.equal(first.changed, 0);
  assert.deepEqual(h.sent, [], "口径切换首轮不得整批误报");
  assert.equal(h.state.item("COMPETITOR_PRICE", "B0COMP1")?.price, 15.99, "新基准为 featured offer 到手价（含默认运费）");
  assert.ok(h.state.item("COMPETITOR_PRICE_META", "basis"), "首轮落新口径标记");
  price = 12.99;
  const second = await h.run();
  assert.equal(second.baselineOnly, undefined);
  assert.equal(second.changed, 1);
  const day = ymdInZone(new Date(), "Asia/Shanghai");
  assert.equal(h.state.item("NOTIFICATION", `competitor|B0COMP1|15.99->13.99|${day}`)?.status, "done");
  assert.deepEqual(h.sent, [["竞品价格变化", "15.99 → 13.99", "SKU：SKU-1", "竞品ASIN：B0COMP1", "Buy Box：FBA", "促销：无"]]);
});

test("B1 竞品价取浏览占比最大 segment 的 New featured offer 到手价；无 featured 用 New 最低到手价；都没有记 unavailable 并保留旧价", async () => {
  const mixed = parseSummary("B0X", summaryResponse("B0X", [offer("S-SMALL", 9, { weight: 20, membership: "PRIME" }), offer("S-BIG", 11, { weight: 80, shipping: 2, fba: false })]) as Row);
  assert.equal(mixed.featured[0]?.sellerId, "S-BIG");
  assert.equal(mixed.featured[0]?.landed, 13);
  const h = harness([{ pk: "COMPETITOR_PRICE", sk: "B0COMP2", sku: "SKU-1", price: 20, basis: "competitiveSummary-v1" }], (asin) => asin === "B0COMP1"
    ? summaryResponse(asin, [], [offer("S-L1", 18, { shipping: 3 }), offer("S-L2", 16, { shipping: 4.5 })])
    : summaryResponse(asin, []));
  const result = await h.run();
  assert.equal(h.state.item("COMPETITOR_PRICE", "B0COMP1")?.price, 20.5, "无 featured offer 时用 New 最低到手价");
  assert.equal(h.state.item("COMPETITOR_PRICE", "B0COMP1")?.source, "lowestPricedOffers");
  assert.deepEqual(result.unavailable, ["B0COMP2"]);
  assert.equal(h.state.item("COMPETITOR_PRICE", "B0COMP2")?.price, 20, "取不到报价保留旧价");
});

test("B1 每批最多 20 个 ASIN、批间节流不少于 31 秒，请求带 featuredBuyingOptions/referencePrices/lowestPricedOffers 与 New/Consumer", async () => {
  const competitors = Array.from({ length: 21 }, (_, index) => `B1${String(index).padStart(8, "0")}`);
  const calls: Array<{ path: string; method?: string; requests: Row[]; pace?: Row }> = [];
  const amazon = { sp: async (path: string, init: { method?: string; body?: { requests: Row[] }; pace?: Row }) => {
    if (path.startsWith("/promotions/")) return { promotions: [] };
    calls.push({ path, requests: init.body?.requests ?? [], ...(init.method ? { method: init.method } : {}), ...(init.pace ? { pace: init.pace } : {}) });
    return { responses: (init.body?.requests ?? []).map((request) => summaryResponse(String(request.asin), [offer("S", 10)])) };
  } } as unknown as AmazonClient;
  await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, configOf([{ sku: "SKU-1", asin: "B0", competitors, adMarker: "" }]), new MemoryState().asStore(), amazon, {} as FeishuClient);
  assert.deepEqual(calls.map((call) => call.requests.length), [20, 1]);
  assert.ok(calls.every((call) => call.path === "/batches/products/pricing/2022-05-01/items/competitiveSummary" && call.method === "POST"));
  assert.ok(calls.every((call) => Number(call.pace?.minIntervalMs) >= 31_000));
  const request = calls[0]!.requests[0]!;
  assert.deepEqual(request.includedData, ["featuredBuyingOptions", "referencePrices", "lowestPricedOffers"]);
  assert.deepEqual(request.lowestPricedOffersInputs, [{ itemCondition: "New", offerType: "Consumer" }]);
  assert.equal(request.marketplaceId, "ATVPDKIKX0DER");
  assert.equal(request.uri, "/products/pricing/2022-05-01/items/competitiveSummary");
  assert.equal(request.method, "GET");
});

test("B1 竞品从无促销变为有促销单独提醒一次（键含 ASIN、促销签名与北京日期）；首轮与已知促销不重复提醒", async () => {
  let promotions: Row[] = [];
  const h = harness([], (asin) => summaryResponse(asin, [offer("S-A", 15, { promotions })]));
  await h.run();
  assert.equal(h.sent.length, 0, "首次见到的 ASIN 只记基准");
  promotions = [{ promotionType: "COUPON", promotionSavings: { discount: { type: "PERCENTAGE_OFF", percentOff: 10 } } }, { promotionType: "BASKET_BUILDING", promotionSavings: { discount: { type: "AMOUNT_OFF", amountOff: money(3) } }, purchaseRequirements: { condition: { quantityThreshold: { minimumQuantity: 2 } } } }];
  await h.run();
  const day = ymdInZone(new Date(), "Asia/Shanghai");
  const promoKeys = [...h.state.items.values()].filter((item) => item.pk === "NOTIFICATION" && String(item.sk).startsWith("competitor-promo|B0COMP1|")).map((item) => String(item.sk));
  assert.equal(promoKeys.length, 1);
  assert.ok(promoKeys[0]!.endsWith(`|${day}`));
  assert.ok(h.sent.some((lines) => lines[0] === "竞品开始促销" && lines.includes("竞品ASIN：B0COMP1") && lines.some((line) => /COUPON 减 10%/.test(line) && /满减 减 \$3\.00，满 2 件/.test(line))));
  const alerts = h.sent.length;
  await h.run();
  assert.equal(h.sent.length, alerts, "促销持续中不再提醒");
});
