import assert from "node:assert/strict";
import test from "node:test";
import { parseAmsEvent, parseOrderEvent, parsePricingEvent } from "../../src/business/events.js";
import { processOrderEvent } from "../../src/business/orders.js";
import { appendShipmentFact, applyFinanceWithDetailWait, ledgerFields, mergeShipmentFee, refundFacts, runFinance, selectShipmentFinanceCurrency, updateOrderDisposalFee, updateRefunds, updateShipmentFinance } from "../../src/business/finance.js";
import { parseReturnReport, runOrderReasons } from "../../src/business/order-reasons.js";
import { fetchFbaShipmentItems, runShipments } from "../../src/business/shipments.js";
import { feishuFieldText, sha256, zonedMidnight } from "../../src/util.js";
import { AdsRun, adsJobPlan, marginResolution, processReport, runAdsReports, runAdsRetention } from "../../src/business/ads.js";
import { runCompetitorPrices } from "../../src/business/orders-periodic.js";
import { buildProfitRegistry, resolveSellerId } from "../../src/business/pricing.js";
import { shouldDeferFinanceRateLimit, shouldRetryDataNotReady } from "../../src/handlers/jobs.js";
import { HttpError } from "../../src/http.js";
import { blocksCompletedReplay, completedStateExpiresAt, COMPLETED_STATE_RETENTION_SECONDS } from "../../src/state.js";
import type { AppConfig } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import type { StateStore } from "../../src/state.js";

// 竞品比价固定在平时（不在任何大促窗口）的 14:00 那轮。
const DAILY_SLOT = "2026-10-07T06:00:00.000Z";

test("完成状态保留 400 天，TTL 延迟删除时按显式到期时间放行重放", () => {
  const nowMs = Date.parse("2026-09-21T00:00:00Z");
  const nowSeconds = Math.floor(nowMs / 1000);
  assert.equal(completedStateExpiresAt(nowMs), nowSeconds + COMPLETED_STATE_RETENTION_SECONDS);
  assert.equal(blocksCompletedReplay({ stage: "done", version: 2, expiresAt: nowSeconds + 1 }, 2, nowSeconds), true);
  assert.equal(blocksCompletedReplay({ stage: "done", version: 2, expiresAt: nowSeconds }, 2, nowSeconds), false);
  assert.equal(blocksCompletedReplay({ stage: "failed", version: 2 }, 2, nowSeconds), false);
});

test("Ads 数据未就绪保留续跑，Pricing 仍遵守三次重试上限", () => {
  const temporary = new Error("飞书 API 失败: Data not ready, please try again later");
  for (const taskType of ["ads-early", "ads-daily", "ads-continue"]) {
    assert.equal(shouldRetryDataNotReady({ taskType, cursor: { dataNotReadyRetries: 9 } }, temporary), true);
  }
  assert.equal(shouldRetryDataNotReady({ taskType: "pricing", cursor: { dataNotReadyRetries: 2 } }, temporary), true);
  assert.equal(shouldRetryDataNotReady({ taskType: "pricing", cursor: { dataNotReadyRetries: 3 } }, temporary), false);
  assert.equal(shouldRetryDataNotReady({ taskType: "ads-continue" }, new Error("飞书稳定业务键不唯一")), false);
});

test("飞书富文本 SKU 与数字字段读取保留实际值", () => {
  assert.equal(feishuFieldText([{ type: "text", text: "SKU-1" }]), "SKU-1");
  assert.equal(feishuFieldText([{ type: "text", text: "12.50" }]), "12.50");
  assert.equal(feishuFieldText("SKU-2"), "SKU-2");
  assert.equal(feishuFieldText(null), "");
});

test("竞品官方报价缺失时保留旧价并继续检查后续 ASIN", async () => {
  const writes: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const config = { asins: () => [{ sku: "SKU-1", asin: "B000000001", competitors: ["B000000002", "B000000003"] }] } as unknown as AppConfig;
  const amazon = { sp: async (path: string, init: { body: { requests: Array<{ asin: string }> } }) => {
    if (path.startsWith("/promotions/")) return { promotions: [] };
    calls.push(init.body.requests.map((request) => request.asin).join(","));
    return { responses: init.body.requests.map(({ asin }) => ({ status: { statusCode: 200 }, body: { asin, featuredBuyingOptions: asin === "B000000002" ? [] : [{ buyingOptionType: "New", segmentedFeaturedOffers: [{ sellerId: "S1", condition: "New", fulfillmentType: "AFN", listingPrice: { amount: 12.5, currencyCode: "USD" }, featuredOfferSegments: [{ customerMembership: "NON_PRIME", segmentDetails: { glanceViewWeightPercentage: 100 } }] }] }], lowestPricedOffers: [] } })) };
  } } as unknown as AmazonClient;
  const state = { get: async (_pk: string, sk: string) => sk === "B000000002" ? { price: 11 } : undefined, put: async (item: Record<string, unknown>) => { writes.push(item); } } as unknown as StateStore;
  const result = await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, config, state, amazon, {} as FeishuClient);
  assert.deepEqual(calls, ["B000000002,B000000003"]);
  assert.deepEqual(result, { status: "done", checked: 1, changed: 0, unavailable: ["B000000002"] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.sk, "B000000003");
  assert.equal(writes[0]?.price, 12.5);
});

test("广告月报富文本指纹核对成功才删除日报", async () => {
  const date = Date.now() - 100 * 86_400_000;
  const daily = [{ record_id: "rec-daily", fields: { "站点日期": date, "Profile ID": [{ text: "profile-1" }], "活动ID": [{ text: "campaign-1" }], "活动名称": [{ text: "Campaign" }], "花费": 5 } }];
  const deleted: string[] = [];
  let monthly: Record<string, unknown> | undefined;
  const feishu = {
    listRecords: async () => daily,
    upsert: async (_app: string, _table: string, _key: unknown, fields: Record<string, unknown>) => { monthly = fields; return "rec-monthly"; },
    searchRecords: async () => monthly ? [{ record_id: "rec-monthly", fields: { "核对指纹": [{ text: monthly["核对指纹"] }] } }] : [],
    delete: async (_app: string, _table: string, id: string) => { deleted.push(id); },
  } as unknown as FeishuClient;
  const config = { get: (key: string) => key, optional: (_key: string, fallback: string) => fallback } as unknown as AppConfig;
  const manifests: Record<string, unknown>[] = [];
  const state = { list: async () => manifests, put: async (item: Record<string, unknown>) => { manifests[0] = item; } } as unknown as StateStore;
  const result = await runAdsRetention({ taskType: "ads-retention" }, config, state, {} as AmazonClient, feishu);
  assert.deepEqual(result, { status: "done", archivedGroups: 1, deletedDailyRows: 1, deferredGroups: 0 });
  assert.deepEqual(deleted, ["rec-daily"]);
  assert.equal(monthly?.["Profile ID"], "profile-1");
  assert.equal(monthly?.["活动ID"], "campaign-1");
  assert.equal(monthly?.["活动名称"], "Campaign");
});

test("广告月报指纹不一致时绝不删除日报", async () => {
  const date = Date.now() - 100 * 86_400_000;
  let deleted = false;
  let created = false;
  const feishu = {
    listRecords: async () => [{ record_id: "rec-daily", fields: { "站点日期": date, "Profile ID": "profile-1", "活动ID": "campaign-1" } }],
    upsert: async () => { created = true; return "rec-monthly"; },
    searchRecords: async () => created ? [{ record_id: "rec-monthly", fields: { "核对指纹": [{ text: "wrong" }] } }] : [],
    delete: async () => { deleted = true; },
  } as unknown as FeishuClient;
  const config = { get: (key: string) => key, optional: (_key: string, fallback: string) => fallback } as unknown as AppConfig;
  const manifests: Record<string, unknown>[] = [];
  const state = { list: async () => manifests, put: async (item: Record<string, unknown>) => { manifests[0] = item; } } as unknown as StateStore;
  await assert.rejects(() => runAdsRetention({ taskType: "ads-retention" }, config, state, {} as AmazonClient, feishu), /月报核对失败/);
  assert.equal(deleted, false);
});

test("广告月报写入后删到一半失败，按已保存的 record_id 清单续跑不重算金额", async () => {
  const date = Date.now() - 100 * 86_400_000;
  const daily = new Map([1, 2].map((n) => [`rec-${n}`, { record_id: `rec-${n}`, fields: { "站点日期": date, "Profile ID": "profile-1", "活动ID": "campaign-1", "花费": n } }]));
  let monthly: Record<string, unknown> | undefined;
  let failSecondDelete = true;
  const manifest = new Map<string, Record<string, unknown>>();
  const feishu = {
    listRecords: async () => [...daily.values()],
    searchRecords: async () => monthly ? [{ record_id: "rec-monthly", fields: { ...monthly, "核对指纹": [{ text: monthly["核对指纹"] }] } }] : [],
    upsert: async (_app: string, _table: string, _key: unknown, fields: Record<string, unknown>) => { monthly = fields; return "rec-monthly"; },
    delete: async (_app: string, _table: string, id: string) => { if (id === "rec-2" && failSecondDelete) { failSecondDelete = false; throw new Error("temporary delete failure"); } daily.delete(id); },
  } as unknown as FeishuClient;
  const state = { list: async () => [...manifest.values()], put: async (item: Record<string, unknown>) => { manifest.set(String(item.sk), item); } } as unknown as StateStore;
  const config = { get: (key: string) => key, optional: (_key: string, fallback: string) => fallback } as unknown as AppConfig;
  await assert.rejects(() => runAdsRetention({ taskType: "ads-retention" }, config, state, {} as AmazonClient, feishu), /temporary delete failure/);
  assert.equal(daily.size, 1);
  assert.equal(monthly?.["花费"], 3);
  assert.equal([...manifest.values()][0]?.status, "prepared");
  const result = await runAdsRetention({ taskType: "ads-retention" }, config, state, {} as AmazonClient, feishu);
  assert.equal(result.status, "done");
  assert.equal(result.deletedDailyRows, 1);
  assert.equal(daily.size, 0);
  assert.equal(monthly?.["花费"], 3);
  assert.equal([...manifest.values()][0]?.status, "done");
});

test("同月旧归档基线只追加明确较新的日期，不覆盖先前月报", async () => {
  const date = Date.now() - 100 * 86_400_000;
  const dateText = new Date(date).toISOString().slice(0, 10);
  const priorDay = new Date(date - 86_400_000).toISOString().slice(0, 10);
  const key = `${dateText.slice(0, 7)}|profile-1|campaign-1`;
  const baselineFingerprint = "a".repeat(64);
  let monthly: Record<string, unknown> = { "花费": 10, "广告销售额": 20, "广告订单": 1, "广告销量": 1, "曝光": 100, "点击": 5, "来源日数": 1, "核对指纹": baselineFingerprint };
  const daily = [{ record_id: "rec-new", fields: { "站点日期": date, "Profile ID": "profile-1", "活动ID": "campaign-1", "花费": 5 } }];
  const manifest = new Map([[key, { pk: "ADS_RETENTION", sk: key, status: "done", throughDate: priorDay, targetFingerprint: baselineFingerprint } as Record<string, unknown>]]);
  let upserts = 0;
  const feishu = {
    listRecords: async () => daily,
    searchRecords: async () => [{ record_id: "rec-monthly", fields: { ...monthly, "核对指纹": [{ text: monthly["核对指纹"] }] } }],
    upsert: async (_app: string, _table: string, _key: unknown, fields: Record<string, unknown>) => { upserts += 1; monthly = fields; return "rec-monthly"; },
    delete: async () => { daily.length = 0; },
  } as unknown as FeishuClient;
  const state = { list: async () => [...manifest.values()], put: async (item: Record<string, unknown>) => { manifest.set(String(item.sk), item); } } as unknown as StateStore;
  const config = { get: (name: string) => name, optional: (_name: string, fallback: string) => fallback } as unknown as AppConfig;
  const result = await runAdsRetention({ taskType: "ads-retention" }, config, state, {} as AmazonClient, feishu);
  assert.equal(result.status, "done");
  assert.equal(monthly["花费"], 15);
  assert.equal(monthly["广告销售额"], 20);
  assert.equal(monthly["来源日数"], 2);
  assert.equal(upserts, 1);
  await runAdsRetention({ taskType: "ads-retention" }, config, state, {} as AmazonClient, feishu);
  assert.equal(upserts, 1);
});

test("未满整月保留日报，但旧已归档清单可完成部分删除", async () => {
  const cutoff = new Date(Date.now() - 60 * 86_400_000);
  const date = Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1);
  const month = new Date(date).toISOString().slice(0, 7);
  const key = `${month}|profile-1|campaign-1`;
  const fingerprint = "b".repeat(64);
  const daily = [{ record_id: "rec-included", fields: { "站点日期": date, "Profile ID": "profile-1", "活动ID": "campaign-1" } }];
  let deleted = 0;
  const feishu = {
    listRecords: async () => daily,
    searchRecords: async () => [{ record_id: "rec-monthly", fields: { "核对指纹": [{ text: fingerprint }] } }],
    delete: async () => { deleted += 1; },
  } as unknown as FeishuClient;
  const config = { get: (name: string) => name, optional: (_name: string, fallback: string) => fallback } as unknown as AppConfig;
  const blankState = { list: async () => [] } as unknown as StateStore;
  const deferred = await runAdsRetention({ taskType: "ads-retention" }, config, blankState, {} as AmazonClient, feishu);
  assert.deepEqual(deferred, { status: "done", archivedGroups: 0, deletedDailyRows: 0, deferredGroups: 1 });
  const manifest = new Map([[key, { pk: "ADS_RETENTION", sk: key, status: "prepared", targetFingerprint: fingerprint, throughDate: new Date(date).toISOString().slice(0, 10), pendingIds: ["rec-included"] } as Record<string, unknown>]]);
  const state = { list: async () => [...manifest.values()], put: async (item: Record<string, unknown>) => { manifest.set(String(item.sk), item); } } as unknown as StateStore;
  const recovered = await runAdsRetention({ taskType: "ads-retention" }, config, state, {} as AmazonClient, feishu);
  assert.equal(recovered.deletedDailyRows, 1);
  assert.equal(deleted, 1);
  assert.equal(manifest.get(key)?.status, "done");
});

test("订单和 AMS 消息使用业务键解析，未知类型明确失败", () => {
  const order = parseOrderEvent(JSON.stringify({ Message: JSON.stringify({ NotificationType: "ORDER_CHANGE", Payload: { AmazonOrderId: "111-2222222-3333333", TimeOfOrderChange: "2026-09-20T01:02:03Z" } }) }));
  assert.equal(order?.entityKey, "order#111-2222222-3333333");
  assert.equal(order?.version, Date.parse("2026-09-20T01:02:03Z"));
  assert.throws(() => parseOrderEvent(JSON.stringify({ NotificationType: "SURPRISE" })), /未知 NotificationType/);
  const ams = parseAmsEvent(JSON.stringify({ dataset_id: "budget-usage", budget_scope_type: "CAMPAIGN", budget_scope_id: "c1", usage_updated_timestamp: "2026-09-20T02:00:00Z", budget: 100, budget_usage_percentage: 25 }), "p1");
  assert.equal(ams?.entityKey, "ams|p1|c1|2026-09-19");
  assert.equal(parseAmsEvent(JSON.stringify({ dataset_id: "other" }), "p1"), null);
});

test("取消刷新保留既有数量与财务字段，空 ItemPrice 不写零或清空币种", async () => {
  const writes: Record<string, unknown>[] = [];
  const old = { record_id: "rec-1", fields: { SKU: [{ text: "SKU-1" }], "数量": 1, "付款金额": 12.5, "费用币种": "USD", "佣金": 1.95, "配送费": 4.09, "订单状态": "Shipped", "订单状态更新时间": "2026-09-23T00:00:00Z" } };
  const amazon = { sp: async (path: string) => path.endsWith("/orderItems")
    ? { payload: { OrderItems: [{ SellerSKU: "SKU-1", QuantityOrdered: 0, ItemPrice: { Amount: "", CurrencyCode: "" } }] } }
    : { payload: { OrderStatus: "Canceled", LastUpdateDate: "2026-09-24T00:00:00Z" } } } as unknown as AmazonClient;
  const feishu = { searchRecords: async () => [old], upsert: async (_app: string, _table: string, _key: unknown, fields: Record<string, unknown>) => { writes.push(fields); return old.record_id; } } as unknown as FeishuClient;
  const config = { get: () => "test", asins: () => [] } as unknown as AppConfig;
  await processOrderEvent({ module: "order", entityKey: "order#1", eventKey: "ORDER_CHANGE", version: 1, occurredAt: "2026-09-24T00:00:00Z", payload: { orderId: "1", suppressNotifications: true } }, config, { notification: async () => undefined } as unknown as StateStore, amazon, feishu);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.["数量"], 1);
  assert.equal(writes[0]?.["订单状态"], "已取消");
  for (const field of ["付款金额", "费用币种", "佣金", "配送费", "促销费用", "费用更新时间"]) assert.equal(Object.hasOwn(writes[0]!, field), false);
});

test("订单状态更新时间写洛杉矶时间文本；表内旧值（飞书富文本，洛杉矶文本或历史 UTC ISO）按洛杉矶时区比较，旧事件不覆盖新状态", async () => {
  const run = async (stored: string, lastUpdate: string): Promise<Record<string, unknown>> => {
    const writes: Record<string, unknown>[] = [];
    const old = { record_id: "rec-1", fields: { "订单编号": "1", SKU: [{ type: "text", text: "SKU-1" }], "数量": 1, "订单状态": [{ type: "text", text: "未发货" }], "订单状态更新时间": [{ type: "text", text: stored }] } };
    const amazon = { sp: async (path: string) => path.endsWith("/orderItems")
      ? { payload: { OrderItems: [{ SellerSKU: "SKU-1", QuantityOrdered: 1 }] } }
      : { payload: { OrderStatus: "Shipped", LastUpdateDate: lastUpdate, PurchaseDate: "2026-09-23T20:00:00Z" } } } as unknown as AmazonClient;
    const feishu = { searchRecords: async () => [old], upsert: async (_app: string, _table: string, _key: unknown, fields: Record<string, unknown>) => { writes.push(fields); return old.record_id; } } as unknown as FeishuClient;
    const config = { get: () => "test", asins: () => [] } as unknown as AppConfig;
    await processOrderEvent({ module: "order", entityKey: "order#1", eventKey: "ORDER_CHANGE", version: 1, occurredAt: lastUpdate, payload: { orderId: "1", suppressNotifications: true } }, config, { notification: async () => undefined } as unknown as StateStore, amazon, feishu);
    return writes[0] ?? {};
  };
  // 表内 “2026-09-24 10:00:00” 是洛杉矶时间（= 17:00Z）；16:00Z 的事件更旧，不得改状态。按 UTC 或本机时区解析都会误判为更新。
  assert.equal(Object.hasOwn(await run("2026-09-24 10:00:00", "2026-09-24T16:00:00Z"), "订单状态"), false);
  assert.equal(Object.hasOwn(await run("2026-09-24T17:00:00Z", "2026-09-24T16:00:00Z"), "订单状态"), false, "历史 UTC ISO 仍按真实时刻比较");
  const newer = await run("2026-09-24 10:00:00", "2026-09-24T18:00:00Z");
  assert.equal(newer["订单状态"], "已发货");
  assert.equal(newer["订单状态更新时间"], "2026-09-24 11:00:00", "写洛杉矶本地时间文本（夏令时 UTC-7）");
  assert.equal((await run("2026-12-01 10:00:00", "2026-12-01T19:30:00Z"))["订单状态更新时间"], "2026-12-01 11:30:00", "冬令时 UTC-8");
});

test("新取消单 Amazon 数量为零时沿用 GAS 的一件保底，不虚构付款金额", async () => {
  const writes: Record<string, unknown>[] = [];
  const amazon = { sp: async (path: string) => path.endsWith("/orderItems")
    ? { payload: { OrderItems: [{ SellerSKU: "SKU-1", QuantityOrdered: 0, ItemPrice: {} }] } }
    : { payload: { OrderStatus: "Canceled", OrderTotal: { CurrencyCode: "USD", Amount: "" }, LastUpdateDate: "2026-09-24T00:00:00Z" } } } as unknown as AmazonClient;
  const feishu = { searchRecords: async () => [], upsert: async (_app: string, _table: string, _key: unknown, fields: Record<string, unknown>) => { writes.push(fields); return "rec-1"; } } as unknown as FeishuClient;
  const config = { get: () => "test", asins: () => [] } as unknown as AppConfig;
  await processOrderEvent({ module: "order", entityKey: "order#1", eventKey: "ORDER_CHANGE", version: 1, occurredAt: "2026-09-24T00:00:00Z", payload: { orderId: "1", suppressNotifications: true } }, config, { notification: async () => undefined } as unknown as StateStore, amazon, feishu);
  assert.equal(writes[0]?.["数量"], 1);
  assert.equal(Object.hasOwn(writes[0]!, "付款金额"), false);
});

test("Finance 不用缺失的明细清零费用，原交易等待并可在明细出现后完成", async () => {
  const record = { record_id: "rec-1", fields: { SKU: "SKU-1", "数量": 1, "佣金": 1.95, "配送费": 4.09, "促销费用": 0.5 } };
  const updates: Record<string, unknown>[] = [];
  let fees: unknown[] = [];
  const events = () => ({ ShipmentEventList: [{ ShipmentItemList: [{ SellerSKU: "SKU-1", ItemChargeList: [{ ChargeAmount: { CurrencyAmount: "12", CurrencyCode: "USD" } }], ItemFeeList: fees }] }] });
  const feishu = { searchRecords: async () => [record], update: async (_app: string, _table: string, _id: string, fields: Record<string, unknown>) => { updates.push(fields); } } as unknown as FeishuClient;
  const config = { get: () => "test" } as unknown as AppConfig;
  await assert.rejects(() => updateShipmentFinance(config, feishu, "113-1111111-1111111", { ShipmentEventList: [{ ShipmentItemList: [] }] }, "2026-09-24T00:00:00Z"), /费用明细未就绪/);
  await assert.rejects(() => updateShipmentFinance(config, feishu, "113-1111111-1111111", events(), "2026-09-24T00:00:00Z"), /费用明细未就绪/);
  assert.equal(updates.length, 0);
  const items = new Map<string, Record<string, unknown>>();
  const state = { put: async (item: Record<string, unknown>) => { items.set(`${item.pk}|${item.sk}`, item); }, get: async (pk: string, sk: string) => items.get(`${pk}|${sk}`), delete: async (pk: string, sk: string) => { items.delete(`${pk}|${sk}`); } } as unknown as StateStore;
  const amazon = { sp: async () => ({ payload: { FinancialEvents: events() } }) } as unknown as AmazonClient;
  const transaction = { transactionId: "tx-1", transactionType: "Shipment", transactionStatus: "RELEASED", sellingPartnerMetadata: { sellingPartnerId: "seller", marketplaceId: "US" }, relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "113-1111111-1111111" }] };
  assert.equal(await applyFinanceWithDetailWait(config, state, amazon, feishu, transaction), "waiting_detail");
  assert.equal([...items.values()].find((item) => item.pk === "FINANCE_PENDING")?.stage, "pending_detail");
  assert.equal(updates.length, 0);
  fees = [{ FeeType: "Commission", FeeAmount: { CurrencyAmount: "-2", CurrencyCode: "USD" } }];
  assert.equal(await applyFinanceWithDetailWait(config, state, amazon, feishu, transaction), "done");
  assert.equal(items.size, 1);
  assert.equal(updates[0]?.["佣金"], 2);
  // Ready settlement details make absent categories known zeros (GAS semantics).
  for (const field of ["配送费", "促销费用"]) assert.equal(updates[0]?.[field], 0);
});

test("订单关联 FBADisposal ServiceFee 后到时仅补缺失弃置费，明细未就绪可待补重试", async () => {
  const record = { record_id: "rec-1", fields: { SKU: "SKU-1", "数量": 1, "付款金额": 14.59, "弃置费": 0, "费用币种": "USD" } as Record<string, unknown> };
  const writes: Record<string, unknown>[] = [];
  const feishu = { searchRecords: async () => [record], update: async (_app: string, _table: string, _id: string, fields: Record<string, unknown>) => { writes.push(fields); Object.assign(record.fields, fields); } } as unknown as FeishuClient;
  const config = { get: () => "test" } as unknown as AppConfig;
  const events = { ServiceFeeEventList: [{ FeeList: [{ FeeType: "FBADisposalFee", FeeAmount: { CurrencyAmount: -1.53, CurrencyCode: "USD" } }] }] };
  assert.equal(await updateOrderDisposalFee(config, feishu, "113-1111111-1111111", events, "2026-09-27T00:00:00Z"), 1);
  assert.equal(record.fields["弃置费"], 1.53);
  assert.equal(record.fields["费用更新时间"], "2026-09-26 17:00:00");
  assert.equal(await updateOrderDisposalFee(config, feishu, "113-1111111-1111111", events, "2026-09-27T00:00:00Z"), 0);
  record.fields["弃置费"] = 2;
  await assert.rejects(() => updateOrderDisposalFee(config, feishu, "113-1111111-1111111", events, "2026-09-27T00:00:00Z"), /拒绝覆盖/);
  assert.equal(writes.filter((fields) => Object.hasOwn(fields, "弃置费")).length, 1);

  record.fields["弃置费"] = 0;
  const items = new Map<string, Record<string, unknown>>();
  const state = { put: async (item: Record<string, unknown>) => { items.set(`${item.pk}|${item.sk}`, item); }, get: async (pk: string, sk: string) => items.get(`${pk}|${sk}`), delete: async (pk: string, sk: string) => { items.delete(`${pk}|${sk}`); } } as unknown as StateStore;
  let ready = false;
  const amazon = { sp: async () => ({ payload: { FinancialEvents: ready ? events : {} } }) } as unknown as AmazonClient;
  const transaction = { transactionId: "tx-disposal", transactionType: "ServiceFee", description: "FBADisposal", transactionStatus: "RELEASED", postedDate: "2026-09-27T00:00:00Z", totalAmount: { currencyAmount: -1.53, currencyCode: "USD" }, sellingPartnerMetadata: { sellingPartnerId: "seller", marketplaceId: "US" }, relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "113-1111111-1111111" }] };
  assert.equal(await applyFinanceWithDetailWait(config, state, amazon, feishu, transaction), "waiting_detail");
  assert.equal([...items.values()].find((item) => item.pk === "FINANCE_PENDING")?.stage, "pending_detail");
  ready = true;
  assert.equal(await applyFinanceWithDetailWait(config, state, amazon, feishu, transaction), "done");
  assert.equal(record.fields["弃置费"], 1.53);
  assert.equal(items.has("FINANCE_PENDING|seller|US|tx-disposal"), false);
});

test("Finance 流水日期字段按飞书日期列要求写毫秒时间戳", () => {
  const fields = ledgerFields({ transactionId: "tx-1", transactionType: "ServiceFee", transactionStatus: "RELEASED", postedDate: "2026-09-24T00:00:00Z", totalAmount: { currencyAmount: "-1", currencyCode: "USD" }, sellingPartnerMetadata: { sellingPartnerId: "seller", marketplaceId: "US" } });
  assert.equal(fields["交易时间"], Date.parse("2026-09-24T00:00:00Z"));
  assert.equal(Object.hasOwn(fields, "首次发现时间"), false);
  assert.equal(typeof fields["最后更新时间"], "number");
  // 2026-10-06 字段精简：卖家、站点、交易 ID 已在流水唯一键里，原始状态与完整交易在 FINANCE/；关联标识与金额明细按 Finance 不变量保留。
  assert.deepEqual(Object.keys(fields).sort(), ["流水唯一键", "交易时间", "交易状态", "交易类型", "业务分类", "流水名称", "原币金额", "利润核算金额", "币种", "账户类型", "亚马逊交易类型", "原始描述", "关联标识", "金额明细", "最后更新时间", "备注"].sort());
});

test("Finance 流水沿用旧 GAS 中文展示，并保留原始类型与描述", () => {
  const base = { transactionId: "tx-1", transactionStatus: "RELEASED", postedDate: "2026-09-24T00:00:00Z", totalAmount: { currencyAmount: "-1", currencyCode: "USD" }, sellingPartnerMetadata: { sellingPartnerId: "seller", marketplaceId: "US" } };
  for (const [type, description, expectedType, expectedName] of [
    ["ServiceFee", "FBADisposal", "服务费用", "亚马逊物流弃置费用"],
    ["DebtRecovery", "DebtPayment", "债务追回", "待分类｜债务追回｜债务付款"],
    ["Transfer", "Disbursement", "清算", "结算划转"],
    ["ProductAdsPayment", "ProductAdsPayment", "服务费用", "广告费用"],
    ["ServiceFee", "FBALongTermStorageBilling", "服务费用", "亚马逊物流长期仓储费"],
    ["ServiceFee", "Subscription", "服务费用", "月度服务费"],
    ["ServiceFee", "FBAStorageBilling", "服务费用", "亚马逊物流仓储费"],
    ["ServiceFee", "STARStorageBilling", "服务费用", "AWD 仓储费"],
    ["FBAInventoryReimbursement", "REVERSAL_REIMBURSEMENT", "库存退款赔偿", "亚马逊物流买家未退货赔偿"],
    ["FBAInventoryReimbursement", "FREE_REPLACEMENT_REFUND_ITEMS", "库存退款赔偿", "亚马逊物流免费换货赔偿"],
    ["FBAInventoryReimbursement", "COMPENSATED_CLAWBACK", "库存退款赔偿", "亚马逊物流取消的退款赔偿"],
    // 2026-10-11：高退货率商品的退货处理费是扣款，原名“亚马逊物流买家退货赔偿”会误导，改名；分类仍是平台费用。
    ["ServiceFee", "CustomerReturnHRREvent", "服务费用", "亚马逊物流高退货率处理费"],
  ]) {
    const fields = ledgerFields({ ...base, transactionType: type, description });
    assert.equal(fields["交易类型"], expectedType);
    assert.equal(fields["流水名称"], expectedName);
    assert.equal(fields["亚马逊交易类型"], type);
    assert.equal(fields["原始描述"], description);
    if (description === "CustomerReturnHRREvent") assert.equal(fields["业务分类"], "平台费用");
  }
  const removal = ledgerFields({ ...base, transactionType: "RemovalShipment", description: "RecommerceAfterMarketplaceShipmentItem" });
  assert.equal(removal["交易类型"], "移除货件");
  assert.equal(removal["流水名称"], "移除货件（待分类）");
  assert.equal(removal["原始描述"], "RecommerceAfterMarketplaceShipmentItem");
  assert.equal(removal["业务分类"], "待分类");
});

test("Finance 429 仅在有持久断点且有限次数内转计划等待", () => {
  const event = { taskType: "finance", taskId: "finance|2026-09-27|" };
  const rateLimited = new HttpError(429, "QuotaExceeded", "", "HTTP 429", true);
  const task = { state: { startTime: "2026-09-26T00:00:00Z", endTime: "2026-09-27T00:00:00Z", financeRateLimitRetries: 5 } };
  assert.equal(shouldDeferFinanceRateLimit(event, rateLimited, task), true);
  assert.equal(shouldDeferFinanceRateLimit(event, rateLimited, { state: { ...task.state, financeRateLimitRetries: 6 } }), false);
  assert.equal(shouldDeferFinanceRateLimit(event, rateLimited, undefined), false);
  assert.equal(shouldDeferFinanceRateLimit(event, new HttpError(400, "InvalidInput", "", "HTTP 400", false), task), false);
  assert.equal(shouldDeferFinanceRateLimit({ taskType: "ads-daily" }, rateLimited, task), false);
});

test("Finance 过期分页 token 不跨调用复用，已完成同一交易不重复写入", async () => {
  const transactions = ["tx-1", "tx-2"].map((transactionId) => ({ transactionId, transactionType: "OtherTransaction", transactionStatus: "RELEASED", postedDate: "2026-09-24T00:00:00Z", totalAmount: { currencyAmount: "-1", currencyCode: "USD" }, sellingPartnerMetadata: { sellingPartnerId: "seller", marketplaceId: "US" } }));
  const config = { get: () => "test", optional: (_key: string, fallback: string) => fallback } as unknown as AppConfig;
  let writes = 0;
  const savedStates: Record<string, unknown>[] = [];
  const state = {
    task: async () => ({ status: "active", updatedAt: "2026-09-24T12:00:00Z", state: { mode: "daily", phase: "scan", startTime: "2026-09-24T09:00:00Z", endTime: "2026-09-24T11:00:00Z", nextToken: "expired-token", pageOffset: 1, pageHash: sha256(JSON.stringify(transactions)), processed: 1 } }),
    get: async (_pk: string, sk: string) => sk.endsWith("tx-1") ? { transaction: transactions[0] } : undefined,
    list: async () => [],
    put: async () => undefined,
    delete: async () => undefined,
    saveTask: async (_type: string, _id: string, cursor: Record<string, unknown>) => { savedStates.push(cursor); },
  } as unknown as StateStore;
  const amazon = { sp: async (_path: string, init: { query: Record<string, unknown> }) => {
    assert.equal(init.query.postedAfter, "2026-09-24T09:00:00Z");
    assert.equal(Date.parse(String(init.query.postedBefore)), Date.parse("2026-09-24T11:00:00Z"));
    assert.equal(init.query.nextToken, undefined);
    return { transactions };
  } } as unknown as AmazonClient;
  const feishu = { upsert: async () => { writes += 1; } } as unknown as FeishuClient;
  const result = await runFinance({ taskType: "finance", taskId: "test-finance", scheduledAt: "2026-09-24T11:00:00Z", cursor: { startTime: "old-stale-start", pageOffset: 0 } }, config, state, amazon, feishu);
  assert.equal(result.status, "done");
  assert.equal(writes, 1);
  assert.equal(savedStates.at(-1)?.pageOffset, 0);
  assert.equal(savedStates.at(-1)?.processed, 2);
});

test("Finance pending_release 按 ORDER_ID 刷新原交易状态并按稳定键完成", async () => {
  const orderId = "111-2222222-3333333";
  const base = { transactionId: "tx-release", transactionType: "OtherTransaction", postedDate: "2026-09-08T00:00:00Z", relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: orderId }], sellingPartnerMetadata: { sellingPartnerId: "seller", marketplaceId: "US" } };
  const pending = { pk: "FINANCE_PENDING", sk: "seller|US|tx-release", stage: "waiting_release", destination: "order", transaction: { ...base, transactionStatus: "DEFERRED" } };
  const writes: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const config = { get: () => "test", optional: (_key: string, fallback: string) => fallback } as unknown as AppConfig;
  const state = {
    task: async () => ({ status: "active", updatedAt: "2026-09-25T12:00:00Z", state: { mode: "daily", phase: "pending", startTime: "2026-09-25T00:00:00Z", endTime: "2026-09-25T00:00:00Z", pendingAfter: "" } }),
    get: async (pk: string) => pk === "FINANCE_PENDING" ? pending : undefined,
    list: async (pk: string) => pk === "FINANCE_PENDING" ? [pending] : [],
    put: async (item: Record<string, unknown>) => { writes.push(item); },
    delete: async () => undefined,
    saveTask: async () => undefined,
  } as unknown as StateStore;
  const amazon = { sp: async (_path: string, init: { query: Record<string, unknown> }) => {
    assert.equal(init.query.relatedIdentifierName, "ORDER_ID");
    assert.equal(init.query.relatedIdentifierValue, orderId);
    return { transactions: [{ ...base, transactionStatus: "RELEASED" }] };
  } } as unknown as AmazonClient;
  const feishu = {
    searchRecords: async () => [{ record_id: "row", fields: { "订单编号": orderId, SKU: "SKU-1" } }],
    update: async (_app: string, _table: string, _id: string, fields: Record<string, unknown>) => { updates.push(fields); },
  } as unknown as FeishuClient;
  const result = await runFinance({ taskType: "finance", taskId: "test-refresh", scheduledAt: "2026-09-25T00:00:00Z" }, config, state, amazon, feishu);
  assert.equal(result.status, "done");
  assert.equal(writes.some((item) => item.pk === "FINANCE" && item.stage === "done" && (item.transaction as Record<string, unknown>).transactionStatus === "RELEASED"), true);
  assert.equal(updates.length, 0, "退款、清算、弃置费以外的订单交易只存状态表 FINANCE/，不再往订单表写原始交易 JSON（2026-10-06 删去「资金交易明细」）");
});

test("Pricing 队列只接受 US ANY_OFFER_CHANGED 并以权威 API 全量校准", () => {
  const event = parsePricingEvent(JSON.stringify({ NotificationType: "ANY_OFFER_CHANGED", EventTime: "2026-09-20T02:00:00Z", Payload: { OfferChangeTrigger: { MarketplaceId: "ATVPDKIKX0DER", SellerSKU: "SKU-1", ASIN: "B000000001" } } }));
  assert.equal(event?.sku, "SKU-1");
  assert.equal(event?.version, Date.parse("2026-09-20T02:00:00Z"));
  assert.equal(parsePricingEvent(JSON.stringify({ NotificationType: "OTHER" })), null);
  assert.throws(() => parsePricingEvent("not-json"), /Pricing SQS 消息.*格式无效/);
});

test("Pricing 按飞书关联记录解析唯一 SKU，拒绝把 record_id 当 SKU", () => {
  const registry = buildProfitRegistry(
    [{ record_id: "sku-rec-1", fields: { "SKU编号": "SKU-1" } }],
    [{ record_id: "profit-rec-1", fields: { "SKU编号": [{ record_id: "sku-rec-1", text: "展示文本不可依赖" }] } }],
  );
  assert.equal(registry.bySku.get("SKU-1")?.record_id, "profit-rec-1");
  assert.equal(registry.unmapped.length, 0);
});

test("货件资金事实重放不双算，金额或分类变化时替换原事实", () => {
  const entry = (description: string, amount: number) => ({ category: "", amount, currency: "USD", postedDate: "2026-09-20T00:00:00Z", transactionStatus: "RELEASED", description });
  const legacy = { oldTransport: entry("transportation fee", 10), oldCustoms: entry("customs duty", 2) };
  const original = { "运输费": 10, "海关费": 2, "费用合计": 12, "其他费用明细": "人工备注" };
  const oldReplay = mergeShipmentFee(original, legacy, "oldTransport", legacy.oldTransport);
  assert.equal(oldReplay.changed, false);
  const first = mergeShipmentFee(original, legacy, "newFee", entry("transportation fee", 3));
  assert.equal(first.updates["运输费"], 13);
  assert.equal(first.updates["费用合计"], 15);
  assert.equal(first.updates["其他费用明细"], "人工备注");
  const afterFeishuBeforeDdb = mergeShipmentFee({ ...original, ...first.updates }, legacy, "newFee", entry("transportation fee", 3));
  assert.equal(afterFeishuBeforeDdb.updates["费用合计"], 15);
  const replay = mergeShipmentFee({ ...original, ...first.updates }, first.feeIndex, "newFee", entry("transportation fee", 3));
  assert.equal(replay.changed, false);
  const revised = mergeShipmentFee({ ...original, ...first.updates }, first.feeIndex, "newFee", entry("customs duty", 4));
  assert.equal(revised.updates["运输费"], 10);
  assert.equal(revised.updates["海关费"], 6);
  assert.equal(revised.updates["费用合计"], 16);
  assert.equal(revised.updates["其他费用明细"], "人工备注");
});

test("早期无币种旧费用保留原事实；同 ID 的 USD 修订替换，非 USD 拒绝", async () => {
  const legacy = { oldFee: { category: "transportation", amount: 10, postedDate: "2025-08-14T00:00:00Z", description: "transportation fee" } };
  const fields = { "运输费": 10, "费用合计": 10, "其他费用明细": "" };
  const usd = { category: "运输费", amount: 10, currency: "USD", postedDate: "2025-08-14T00:00:00Z", transactionStatus: "RELEASED", description: "transportation fee" };
  const replay = mergeShipmentFee(fields, legacy, "oldFee", usd);
  assert.equal(replay.updates["费用合计"], 10);
  assert.equal(replay.feeIndex.oldFee?.currency, "USD");
  const revised = mergeShipmentFee(fields, legacy, "oldFee", { ...usd, amount: 12 });
  assert.equal(revised.updates["费用合计"], 12);
  assert.equal(legacy.oldFee.amount, 10);
  assert.throws(() => mergeShipmentFee(fields, legacy, "oldFee", { ...usd, currency: "EUR" }), /索引条目无效/);
});

test("飞书成功而 DDB 提交失败时按旧索引重算，重试不二次累计", async () => {
  const legacy = { oldTransport: { category: "transportation", amount: 10, currency: "USD", postedDate: "2026-09-20T00:00:00Z", transactionStatus: "RELEASED", description: "transportation fee" } };
  const record = { record_id: "rec-1", fields: { "货件唯一键": "FBA:FBA123", "费用合计": 10, "运输费": 10, "其他费用明细": "" } as Record<string, unknown> };
  let indexed: Record<string, unknown> = { pk: "SHIPMENT_FEE_INDEX", sk: "FBA:FBA123", feeIndex: legacy };
  let failPut = true;
  let held = false;
  const totals: number[] = [];
  const state = {
    acquireLease: async () => { if (held) return false; held = true; return true; },
    releaseLease: async () => { held = false; },
    get: async () => indexed,
    put: async (item: Record<string, unknown>) => { if (failPut) { failPut = false; throw new Error("simulated DDB failure"); } indexed = item; },
  } as unknown as StateStore;
  const feishu = {
    searchRecords: async () => [record],
    update: async (_app: string, _table: string, _id: string, updates: Record<string, unknown>) => { Object.assign(record.fields, updates); totals.push(Number(updates["费用合计"])); },
  } as unknown as FeishuClient;
  const config = { get: () => "test" } as unknown as AppConfig;
  const transaction = { transactionId: "newFee", transactionStatus: "RELEASED", transactionType: "ServiceFee", description: "transportation fee", totalAmount: { currencyAmount: -3, currencyCode: "USD" }, relatedIdentifiers: [{ relatedIdentifierName: "SHIPMENT_ID", relatedIdentifierValue: "FBA123" }] };
  await assert.rejects(appendShipmentFact(config, state, feishu, transaction), /simulated DDB failure/);
  assert.equal(record.fields["费用合计"], 13);
  assert.equal(Object.keys(indexed.feeIndex as object).length, 1);
  await appendShipmentFact(config, state, feishu, transaction);
  assert.deepEqual(totals, [13, 13]);
  assert.equal(Object.keys(indexed.feeIndex as object).length, 2);
  await appendShipmentFact(config, state, feishu, transaction);
  assert.deepEqual(totals, [13, 13]);
  assert.equal(held, false);
});

test("退款权威明细按 adjustmentId 和 SKU 保留金额、费用与币种", () => {
  const facts = refundFacts({ RefundEventList: [{ PostedDate: "2026-09-20T01:00:00Z", ShipmentItemAdjustmentList: [{ OrderAdjustmentItemId: "a1", SellerSKU: "SKU-1", QuantityShipped: 1, ItemChargeAdjustmentList: [{ ChargeAmount: { CurrencyAmount: -12.5, CurrencyCode: "USD" } }], ItemFeeAdjustmentList: [{ FeeAmount: { CurrencyAmount: 2.25, CurrencyCode: "USD" } }] }] }] }, "111-2222222-3333333");
  assert.deepEqual(facts.map(({ adjustmentId, sku, refundAmount, feeAdjustment, currencies }) => ({ adjustmentId, sku, refundAmount, feeAdjustment, currencies })), [{ adjustmentId: "a1", sku: "SKU-1", refundAmount: -12.5, feeAdjustment: 2.25, currencies: ["USD"] }]);
});

test("新退款通知沿用订单表下单时间，且不重复猜测时间", async () => {
  const facts = refundFacts({ RefundEventList: [{ PostedDate: "2026-09-24T01:00:00Z", ShipmentItemAdjustmentList: [{ OrderAdjustmentItemId: "a1", SellerSKU: "SKU-1", QuantityShipped: 1, ItemChargeAdjustmentList: [{ ChargeAmount: { CurrencyAmount: -12.5, CurrencyCode: "USD" } }] }] }] }, "111-2222222-3333333");
  let savedLines: string[] = [];
  let sentLines: string[] = [];
  const state = { get: async () => undefined, put: async () => {}, saveNotification: async (_key: string, lines: string[]) => { savedLines = lines; }, notification: async () => ({ lines: savedLines, recipients: ["u1"], delivered: {} }), markRecipient: async () => {}, completeNotification: async () => {} } as unknown as StateStore;
  const feishu = { searchRecords: async () => [{ record_id: "rec-1", fields: { SKU: "SKU-1", "数量": 1, "下单时间": "2026-09-15 12:30:00", "付款金额": 12.5, "费用币种": "USD" } }], update: async () => {}, sendText: async (_id: string, lines: string[]) => { sentLines = lines; } } as unknown as FeishuClient;
  const config = { get: () => "test", optional: () => "u1" } as unknown as AppConfig;
  await updateRefunds(config, state, feishu, "111-2222222-3333333", facts, 0);
  assert.ok(sentLines.includes("下单时间：2026-09-15 12:30:00"));
});

test("SKU 财务币种缺失时只继承唯一的整单权威币种，混币仍拒绝", () => {
  assert.equal(selectShipmentFinanceCurrency(new Set(), new Set(["USD"])), "USD");
  assert.equal(selectShipmentFinanceCurrency(new Set(["EUR"]), new Set(["USD", "EUR"])), "EUR");
  assert.equal(selectShipmentFinanceCurrency(new Set(), new Set(["USD", "EUR"])), undefined);
  assert.equal(selectShipmentFinanceCurrency(new Set(), new Set()), undefined);
});

test("退货 TSV 保留带换行备注并形成稳定 SKU 事件", () => {
  const report = "return-date\torder-id\tsku\treason\tcustomer-comments\tasin\r\n2026-09-19T10:00:00Z\t111-2222222-3333333\tSKU-1\tDEFECTIVE\t\"line 1\nline 2\"\tB000000001\r\n";
  const [event] = parseReturnReport(report);
  assert.equal(event?.reasonZh, "商品有缺陷");
  assert.equal(event?.comment, "line 1\nline 2");
  assert.equal(event?.scope, "sku");
});

test("OrderReason 续接旧活动报告行号与待匹配引用，并保留时间依据", async () => {
  const report = (sku: string) => `return-date\torder-id\tsku\treason\tcustomer-comments\n2026-09-19T10:00:00Z\t111-2222222-3333333\t${sku}\tDEFECTIVE\tnote\n`;
  const active = report("SKIP") + `2026-09-20T10:00:00Z\t111-2222222-3333333\tPROCESS\tDEFECTIVE\tactive\n`;
  const writes: Array<Record<string, unknown>> = [];
  const saves: Array<Record<string, unknown>> = [];
  const config = { bool: () => true, get: (key: string) => key === "ORDER_REASON_ENABLED_AT" ? "2026-09-01T00:00:00.000Z" : "table", optional: (key: string, fallback = "") => key === "MARKETPLACE_IDS" ? "ATVPDKIKX0DER" : fallback } as unknown as AppConfig;
  const amazon = {
    sp: async (path: string) => path.endsWith("/r1") ? { processingStatus: "DONE", reportDocumentId: "d1" } : path.endsWith("/r2") ? { processingStatus: "DONE", reportDocumentId: "d2" } : { url: path.endsWith("/d1") ? "https://example.test/d1" : "https://example.test/d2" },
    download: async (url: string) => Buffer.from(url.endsWith("/d1") ? report("PENDING") : active),
  } as unknown as AmazonClient;
  const feishu = { searchRecords: async () => [{ record_id: "rec1", fields: { SKU: "PENDING" } }, { record_id: "rec2", fields: { SKU: "PROCESS" } }], update: async (_app: string, _table: string, _id: string, fields: Record<string, unknown>) => { writes.push(fields); } } as unknown as FeishuClient;
  const items = new Map<string, Record<string, unknown>>();
  const state = {
    task: async () => ({ state: { reportId: "r2", mode: "review", startTime: "2026-08-01T00:00:00.000Z", endTime: "2026-08-31T00:00:00.000Z", rowIndex: 1, reportCount: 3, pendingRefs: [{ key: "r1|0", reportId: "r1", marketplaceId: "ATVPDKIKX0DER", rowIndex: 0, eventKey: "return|111-2222222-3333333|PENDING|2026-09-19T10:00:00.000Z|DEFECTIVE", attempts: 0, nextAt: "2026-09-20T00:00:00.000Z" }] } }),
    saveTask: async (_type: string, _id: string, progress: Record<string, unknown>) => { saves.push(progress); },
    get: async (pk: string, sk: string) => items.get(`${pk}|${sk}`),
    put: async (item: Record<string, unknown>) => { items.set(`${String(item.pk)}|${String(item.sk)}`, item); },
  } as unknown as StateStore;
  const result = await runOrderReasons({ taskType: "order-reason" }, config, state, amazon, feishu);
  assert.equal(result.status, "done");
  assert.equal(writes.length, 2);
  assert.equal(writes.some((fields) => String(fields["售后原因时间"]).includes("退货入仓时间")), true);
  assert.deepEqual(writes.map((fields) => Object.keys(fields).sort()), Array(2).fill(["买家备注原文", "售后原因中文", "售后原因原文", "售后原因时间"].sort()), "只写四个可见列，同步进度不进飞书");
  assert.deepEqual([...items.values()].map((item) => [item.sk, item.synced]).sort(), [["111-2222222-3333333|pending", true], ["111-2222222-3333333|process", true]]);
  assert.equal(saves.at(-1)?.reviewCursor, "2026-08-31T00:00:00.000Z");
  assert.equal(saves.at(-1)?.reportCount, 4);
  assert.deepEqual(saves.at(-1)?.pendingRefs, []);
});

test("FBA v0 从历史起点发现，货件明细按 NextToken 全量读取", async () => {
  const requests: Array<{ path: string; query: Record<string, unknown> }> = [];
  const amazon = { sp: async (path: string, options: { query: Record<string, unknown> }) => {
    requests.push({ path, query: options.query });
    if (path.endsWith("/items")) return { payload: { ItemData: [{ SellerSKU: "SKU-1" }], NextToken: "next-1" } };
    if (path.endsWith("/shipmentItems")) return { payload: { ItemData: [{ SellerSKU: "SKU-2" }] } };
    if (path.endsWith("/shipments")) return { payload: { ShipmentData: [] } };
    return { shipments: [] };
  } } as unknown as AmazonClient;
  const items = await fetchFbaShipmentItems(amazon, "FBA123");
  assert.deepEqual(items.map((item) => item.SellerSKU), ["SKU-1", "SKU-2"]);
  assert.equal(requests[1]?.path, "/fba/inbound/v0/shipmentItems");
  assert.deepEqual(requests[1]?.query, { QueryType: "NEXT_TOKEN", MarketplaceId: "ATVPDKIKX0DER", NextToken: "next-1" });
  const config = { asins: () => [], optional: (key: string, fallback = "") => key === "SHIPMENT_SYNC_START_DATE" ? "2025-01-01" : fallback } as unknown as AppConfig;
  const state = { get: async () => undefined, put: async () => {} } as unknown as StateStore;
  await runShipments({ taskType: "shipment" }, config, state, amazon, {} as FeishuClient);
  assert.equal(requests.find((request) => request.path === "/fba/inbound/v0/shipments")?.query.LastUpdatedAfter, "2025-01-01T00:00:00.000Z");
});

test("Pricing 可从 Finances 唯一确定 Seller ID，歧义时拒绝猜测", async () => {
  const config = { optional: () => "" } as unknown as AppConfig;
  const amazon = { sp: async () => ({ payload: { transactions: [{ sellingPartnerMetadata: { sellingPartnerId: "seller-1" } }] } }) } as unknown as AmazonClient;
  assert.equal(await resolveSellerId(config, amazon), "seller-1");
  const ambiguous = { sp: async () => ({ payload: { transactions: [{ sellingPartnerMetadata: { sellingPartnerId: "seller-1" } }, { sellingPartnerMetadata: { sellingPartnerId: "seller-2" } }] } }) } as unknown as AmazonClient;
  await assert.rejects(resolveSellerId(config, ambiguous), /唯一确定/);
});

test("洛杉矶午夜遵守夏令时，非固定 UTC 偏移", () => {
  assert.equal(zonedMidnight("2026-01-15", "America/Los_Angeles"), "2026-01-15T08:00:00.000Z");
  assert.equal(zonedMidnight("2026-07-15", "America/Los_Angeles"), "2026-07-15T07:00:00.000Z");
});

test("Ads EARLY 与 DAILY 任务范围：DAILY 含 30 日投放、搜索词、广告位报表与逐 SKU 每日销售（进快照）", () => {
  const profile = [{ profileId: "P1", marketplaceId: "ATVPDKIKX0DER", countryCode: "US", currencyCode: "USD" }];
  const registry = Array.from({ length: 17 }, (_, index) => ({ sku: `SKU-${index}`, asin: `ASIN-${index}`, name: `Item ${index}`, marginRate: 0.3, profitMatchCount: index === 3 ? 0 : 1 }));
  const early = adsJobPlan(profile, "EARLY", "early", "2026-08-30", registry);
  assert.equal(early.length, 5);
  assert.deepEqual(early.map((job) => job.kind).sort(), ["advertisedProduct", "campaign", "sales", "sales", "sales"].sort());
  const daily = adsJobPlan(profile, "DAILY", "daily", "2026-08-30", registry);
  assert.equal(daily.length, 36, "活动+商品 2、投放/搜索词/广告位 3、14 天总销售 14、逐 SKU 销售 17（缺毛利率的 SKU 也取）");
  assert.equal(daily.some((job) => ["placement", "salesSku30"].includes(job.kind as string)), false);
  for (const kind of ["targeting", "searchTerm", "campaignPlacement"]) assert.deepEqual([daily.find((job) => job.kind === kind)?.startDate, daily.find((job) => job.kind === kind)?.endDate], ["2026-08-01", "2026-08-30"], kind);
  assert.equal(daily.filter((job) => job.kind === "skuSales").length, 17);
});

test("目标 ACOS＝毛利率 − 10 个百分点、盈亏线＝毛利率；清货阈值 2026-10-09 起为毛利率 < 10%", () => {
  const sku = (marginRate: number) => ({ sku: "S", asin: "A", name: "n", marginRate, profitMatchCount: 1 });
  const mid = marginResolution(sku(0.1844), "");
  assert.equal(mid.clearance, false, "18.4% 不再算清货（原阈值 20%）");
  assert.equal(Number(mid.targetAcos!.toFixed(4)), 0.0844);
  assert.equal(mid.breakEvenAcos, 0.1844);
  assert.equal(marginResolution(sku(0.1), "").clearance, false);
  assert.equal(marginResolution(sku(0.0093), "").clearance, true);
  assert.equal(marginResolution(sku(0.0093), "").targetAcos, 0);
  assert.equal(marginResolution(sku(-0.0537), "").clearance, true);
});

test("Ads 总销售先到不写假的零广告指标；报表按日期分块批量发布并保存游标", async () => {
  const saved: Array<{ table: string; fields: Record<string, unknown> }> = [];
  const config = {
    get: (key: string) => ({ FEISHU_BITABLE_APP_TOKEN_ORDERS: "app", FEISHU_BITABLE_TABLE_ID_ADS_DAILY_OVERVIEW: "overview", FEISHU_BITABLE_TABLE_ID_ADS_CAMPAIGN_DAILY: "campaign" })[key] ?? key,
    optional: (key: string) => key === "ADS_PROFILES_JSON" ? JSON.stringify([{ profileId: "P_ADS_BATCH", marketplaceId: "M1", countryCode: "US", currencyCode: "USD" }]) : "",
  } as unknown as AppConfig;
  const feishu = {
    listRecords: async () => [],
    batchCreate: async (_app: string, table: string, rows: Array<Record<string, unknown>>) => { for (const fields of rows) saved.push({ table, fields }); return rows.map((_, index) => `${table}-${saved.length}-${index}`); },
  } as unknown as FeishuClient;
  const amazon = {
    sp: async () => ({ payload: [{ totalSales: { amount: 42 }, orderCount: 3, unitCount: 4 }] }),
    ads: async () => ({ results: {} }),
  } as unknown as AmazonClient;
  const salesJob = { key: "sales", kind: "sales", profileId: "P_ADS_BATCH", startDate: "2026-09-21", endDate: "2026-09-21", status: "NEW", attempts: 0 };
  const state = { task: async () => ({ state: { jobs: [salesJob] } }), saveTask: async () => {}, get: async () => undefined, put: async () => {} } as unknown as StateStore;
  const scheduled: string[] = [];
  await runAdsReports({ taskType: "ads-daily", taskId: "sales-only" }, "DAILY", config, state, amazon, feishu, async (event) => { scheduled.push(String(event.taskId)); return "s"; });
  assert.deepEqual(scheduled, ["ads-runaway|2026-09-21"], "DAILY 批次完成后排一次跑飞排查");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.fields["站点日期"], Date.parse("2026-09-21T12:00:00Z"));
  for (const field of ["曝光", "点击", "花费", "广告销售额", "广告订单"]) assert.equal(Object.hasOwn(saved[0]!.fields, field), false);
  assert.equal(saved[0]!.fields["总销售额"], 42);
  saved.length = 0;
  const job: Parameters<typeof processReport>[0] = { key: "campaign", kind: "campaign", profileId: "P_ADS_BATCH", startDate: "2026-09-21", endDate: "2026-09-22", status: "PENDING", attempts: 1 };
  const data = [
    { date: "2026-09-21", campaignId: "C1", impressions: 100, clicks: 10, cost: 5, sales7d: 20, purchases7d: 2 },
    { date: "2026-09-22", campaignId: "C1", impressions: 200, clicks: 20, cost: 9, sales7d: 30, purchases7d: 3 },
  ];
  const cursors: number[] = [];
  assert.equal(await processReport(job, data, new AdsRun(config, amazon, feishu, 0, async () => { cursors.push(job.publishCursor ?? 0); })), true);
  assert.deepEqual(cursors, [2]);
  assert.equal(job.publishCursor, 2);
  for (const date of ["2026-09-21", "2026-09-22"]) assert.equal(saved.filter((item) => item.fields["站点日期"] === Date.parse(`${date}T12:00:00Z`)).length, 2);
  assert.deepEqual([...new Set(saved.map((item) => item.table))].sort(), ["campaign", "overview"]);
});

test("Ads 30 日投放报告整份存进每日分析快照，不写飞书（投放词监控 2026-10-09 停写）", async () => {
  const puts: Array<Record<string, unknown>> = [];
  const config = { get: (key: string) => key, optional: () => "" } as unknown as AppConfig;
  const refuse = async (): Promise<never> => { throw new Error("投放报告不应写飞书"); };
  const feishu = { listRecords: refuse, batchCreate: refuse, batchUpdate: refuse, batchDelete: refuse } as unknown as FeishuClient;
  const state = { put: async (item: Record<string, unknown>) => { puts.push(item); } } as unknown as StateStore;
  const job: Parameters<typeof processReport>[0] = { key: "targeting", kind: "targeting", profileId: "P_ADS_TARGET", startDate: "2026-08-25", endDate: "2026-09-23", status: "PENDING", attempts: 1 };
  const data = Array.from({ length: 21 }, (_, index) => ({ date: "2026-09-23", keywordId: `K${index}`, keyword: `keyword-${index}`, clicks: 1, cost: 0.5 }));
  assert.equal(await processReport(job, data, new AdsRun(config, {} as AmazonClient, feishu, 0, async () => {}, state)), true);
  assert.deepEqual(puts.map((item) => [item.pk, item.sk, item.part]), [["ADS_SNAPSHOT", "2026-09-23|P_ADS_TARGET|targets|000", "targets"]]);
  await assert.rejects(processReport({ ...job }, data, new AdsRun(config, {} as AmazonClient, feishu, 0)), /需要状态表/);
});
