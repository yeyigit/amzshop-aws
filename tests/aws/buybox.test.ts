import assert from "node:assert/strict";
import test from "node:test";
import { runBuyboxWatch } from "../../src/business/buybox.js";
import { runJob } from "../../src/business/jobs.js";
import type { AppConfig } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import type { StateStore } from "../../src/state.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const OWN = "SELLER-OWN";
const config = { get: (key: string) => key === "SP_API_SELLER_ID" ? OWN : key, optional: (key: string, fallback = "") => key === "FEISHU_NOTIFY_USER_IDS" ? "u1" : key === "SP_API_SELLER_ID" ? OWN : fallback, bool: () => true, asins: () => [{ sku: "SKU-A", asin: "B0A", competitors: [], adMarker: "" }, { sku: "SKU-B", asin: "B0B", competitors: [], adMarker: "" }, { sku: "SKU-B2", asin: "B0B", competitors: [], adMarker: "" }] } as unknown as AppConfig;
const money = (amount: number): Row => ({ amount, currencyCode: "USD" });
const seg = (sellerId: string, listing: number, weight: number, membership: string, fba = true): Row => ({ sellerId, condition: "New", fulfillmentType: fba ? "AFN" : "MFN", listingPrice: money(listing), shippingOptions: [{ shippingOptionType: "DEFAULT", price: money(0) }], featuredOfferSegments: [{ customerMembership: membership, segmentDetails: { glanceViewWeightPercentage: weight } }] });

function harness(initial: Row[] = []) {
  let current: Record<string, Row[]> = {};
  const requests: Row[][] = [];
  const amazon = { sp: async (_path: string, init: { body: { requests: Row[] } }) => {
    requests.push(init.body.requests);
    return { responses: init.body.requests.map((request) => ({ status: { statusCode: 200 }, body: { asin: request.asin, featuredBuyingOptions: current[String(request.asin)]?.length ? [{ buyingOptionType: "New", segmentedFeaturedOffers: current[String(request.asin)] }] : [] } })) };
  } } as unknown as AmazonClient;
  const sent: string[][] = [];
  const feishu = { sendText: async (_user: string, lines: string[]) => { sent.push(lines); } } as unknown as FeishuClient;
  const state = new MemoryState(initial);
  return { state, sent, requests, set: (next: Record<string, Row[]>) => { current = next; }, run: () => runBuyboxWatch({ taskType: "buybox-watch" }, config, state.asStore(), amazon, feishu) };
}

test("B2 主 segment 的 featured offer 不是自家或没有 featured offer 判为丢失；只在首次丢失与恢复时通知，状态存状态表", async () => {
  const h = harness();
  h.set({ B0A: [seg(OWN, 19.99, 80, "NON_PRIME"), seg("OTHER", 18.5, 20, "PRIME", false)], B0B: [seg("RIVAL", 17.25, 90, "NON_PRIME", false), seg(OWN, 19, 10, "PRIME")] });
  const first = await h.run();
  assert.equal(first.status, "done");
  assert.equal(first.lost, 1);
  assert.deepEqual(h.requests[0]!.map((request) => request.asin), ["B0A", "B0B"], "同一 ASIN 只查一次");
  assert.deepEqual(h.requests[0]![0]!.includedData, ["featuredBuyingOptions"]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]![0], "⚠️ Buy Box 丢失");
  assert.ok(h.sent[0]!.includes("ASIN：B0B"));
  assert.ok(h.sent[0]!.includes("SKU：SKU-B、SKU-B2"));
  assert.ok(h.sent[0]!.includes("当前 Buy Box：他人（自发货）$17.25，浏览占比 90%"));
  assert.equal(h.state.item("BUYBOX", "B0B")?.status, "lost");
  assert.equal(h.state.item("BUYBOX", "B0A")?.status, "won");
  await h.run();
  assert.equal(h.sent.length, 1, "持续丢失不重复通知");
  h.set({ B0A: [], B0B: [seg(OWN, 19, 95, "NON_PRIME"), seg("RIVAL", 17, 5, "PRIME", false)] });
  const third = await h.run();
  assert.equal(third.lost, 1);
  assert.equal(third.recovered, 1);
  const lost = h.sent.find((lines) => lines.includes("ASIN：B0A"))!;
  assert.equal(lost[0], "⚠️ Buy Box 丢失");
  assert.ok(lost.includes("当前 Buy Box：无 featured offer"));
  const recovered = h.sent.find((lines) => lines[0] === "✅ Buy Box 恢复")!;
  assert.ok(recovered.includes("ASIN：B0B"));
  assert.ok(recovered.some((line) => /其余细分：PRIME 5% 为他人（自发货）\$17\.00/.test(line)), "其余 segment 丢失只列出占比");
  assert.equal(h.sent.length, 3);
});

test("B2 其余 segment 丢失但主 segment 仍是自家不算丢失；单个 ASIN 取数失败保留原状态不误报恢复", async () => {
  const h = harness([{ pk: "BUYBOX", sk: "B0B", status: "lost", since: "2026-09-30T01:20:00.000Z", updatedAt: "2026-09-30T01:20:00.000Z" }]);
  h.set({ B0A: [seg(OWN, 19.99, 60, "NON_PRIME"), seg("OTHER", 18.5, 40, "PRIME")] });
  const amazonFailing = { sp: async (_path: string, init: { body: { requests: Row[] } }) => ({ responses: init.body.requests.map((request) => request.asin === "B0B" ? { status: { statusCode: 500 }, body: { errors: [{ code: "InternalFailure" }] } } : { status: { statusCode: 200 }, body: { asin: request.asin, featuredBuyingOptions: [{ buyingOptionType: "New", segmentedFeaturedOffers: [seg(OWN, 19.99, 60, "NON_PRIME"), seg("OTHER", 18.5, 40, "PRIME")] }] } }) }) } as unknown as AmazonClient;
  const result = await runBuyboxWatch({ taskType: "buybox-watch" }, config, h.state.asStore(), amazonFailing, { sendText: async (_u: string, lines: string[]) => { h.sent.push(lines); } } as unknown as FeishuClient);
  assert.equal(result.lost, 0);
  assert.deepEqual(result.unavailable, ["B0B"]);
  assert.equal(h.sent.length, 0);
  assert.equal(h.state.item("BUYBOX", "B0B")?.status, "lost", "取数失败不改状态");
  assert.equal(h.state.item("BUYBOX", "B0A")?.status, "won");
});

test("B2 buybox-watch 接入任务分发", async () => {
  const state = new MemoryState();
  const amazon = { sp: async (_path: string, init: { body: { requests: Row[] } }) => ({ responses: init.body.requests.map((request) => ({ status: { statusCode: 200 }, body: { asin: request.asin, featuredBuyingOptions: [{ buyingOptionType: "New", segmentedFeaturedOffers: [seg(OWN, 10, 100, "NON_PRIME")] }] } })) }) } as unknown as AmazonClient;
  const result = await runJob({ taskType: "buybox-watch", taskId: "buybox-watch|x" }, { config, state: state.asStore() as StateStore, amazon, feishu: {} as FeishuClient });
  assert.equal(result.status, "done");
  assert.equal(result.checked, 2);
});
