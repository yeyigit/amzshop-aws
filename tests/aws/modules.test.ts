import assert from "node:assert/strict";
import test from "node:test";
import { resetSellerIdCache, resolveSellerId, runPricing } from "../../src/business/pricing.js";
import { runCompetitorPrices, runOrderReconcile } from "../../src/business/orders-periodic.js";
import { runShipments } from "../../src/business/shipments.js";
import { runInventory } from "../../src/business/inventory.js";
import { runOrderReasons } from "../../src/business/order-reasons.js";
import { clearCampaignNameCache, processAmsEvent } from "../../src/business/ams.js";
import { addDaysYmd, ymdInZone } from "../../src/util.js";
import type { AppConfig, FeishuRecord, JobEvent } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import type { StateStore } from "../../src/state.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
// 竞品比价固定在平时（不在任何大促窗口）的 14:00 那轮。
const DAILY_SLOT = "2026-10-07T06:00:00.000Z";
const DAY = 86_400_000;
const configOf = (asins: Row[] = [], optional: Record<string, string> = {}): AppConfig => ({
  get: (key: string) => key,
  optional: (key: string, fallback = "") => optional[key] ?? (key === "FEISHU_NOTIFY_USER_IDS" ? "u1" : fallback),
  bool: () => true,
  asins: () => asins,
}) as unknown as AppConfig;

test("Pricing Seller ID：配置优先，其次实例缓存与状态表 CACHE/sellerId，仅首次用 Finances 反推", async () => {
  resetSellerIdCache();
  const state = new MemoryState();
  let calls = 0;
  const unique = { sp: async () => { calls += 1; return { payload: { transactions: [{ sellingPartnerMetadata: { sellingPartnerId: "seller-1" } }] } }; } } as unknown as AmazonClient;
  const ambiguous = { sp: async () => { calls += 1; return { payload: { transactions: [{ sellingPartnerMetadata: { sellingPartnerId: "a" } }, { sellingPartnerMetadata: { sellingPartnerId: "b" } }] } }; } } as unknown as AmazonClient;
  assert.equal(await resolveSellerId(configOf(), unique, state.asStore()), "seller-1");
  assert.equal(state.item("CACHE", "sellerId")?.value, "seller-1");
  assert.equal(await resolveSellerId(configOf(), ambiguous, state.asStore()), "seller-1");
  resetSellerIdCache();
  assert.equal(await resolveSellerId(configOf(), ambiguous, state.asStore()), "seller-1");
  assert.equal(calls, 1, "实例缓存与状态表命中时不再调用 Finances");
  assert.equal(await resolveSellerId(configOf([], { SP_API_SELLER_ID: "configured" }), ambiguous, state.asStore()), "configured");
  resetSellerIdCache();
});

test("Pricing 完整拉取 BUYABLE 列表后，不在列表的毛利行按“已退出在售范围”处理，已清理的行不重复写", async () => {
  resetSellerIdCache();
  const amazon = { sp: async (path: string) => {
    if (path.startsWith("/fba/inventory")) return { payload: { inventorySummaries: [{ sellerSku: "SKU-A", inventoryDetails: { fulfillableQuantity: 5 } }] } };
    if (path.startsWith("/listings/")) return { items: [{ sku: "SKU-A", summaries: [{ marketplaceId: "ATVPDKIKX0DER", asin: "B0A", status: ["BUYABLE"] }], attributes: { purchasable_offer: [{ marketplace_id: "ATVPDKIKX0DER", audience: "ALL", currency: "USD", our_price: [{ schedule: [{ value_with_tax: 19.99 }] }] }] } }] };
    if (path.startsWith("/promotions/")) return { promotions: [] };
    throw new Error(`unexpected ${path}`);
  } } as unknown as AmazonClient;
  const updates: Array<{ recordId: string; fields: Row }> = [];
  const feishu = {
    listRecords: async (_app: string, table: string) => table === "FEISHU_BITABLE_TABLE_ID_SKUS"
      ? ["A", "B", "C"].map((code) => ({ record_id: `sku-${code}`, fields: { "SKU编号": `SKU-${code}` } }))
      : [
        { record_id: "profit-A", fields: { "SKU编号": [{ record_id: "sku-A" }] } },
        { record_id: "profit-B", fields: { "SKU编号": [{ record_id: "sku-B" }], "AMZ促销价": 15.99, "活动计算价": 15.99, "价格同步状态": "常规价已更新；活动已确认" } },
        { record_id: "profit-C", fields: { "SKU编号": [{ record_id: "sku-C" }], "价格同步状态": "已退出在售范围", "活动说明": "Listing 非 BUYABLE" } },
      ],
    update: async (_app: string, _table: string, recordId: string, fields: Row) => { updates.push({ recordId, fields }); },
  } as unknown as FeishuClient;
  const result = await runPricing({ taskType: "pricing" }, configOf([], { SP_API_SELLER_ID: "seller-1" }), new MemoryState().asStore(), amazon, feishu);
  assert.deepEqual(updates.map((item) => item.recordId), ["profit-A", "profit-B"]);
  const exit = updates[1]!.fields;
  assert.deepEqual(Object.keys(exit).sort(), ["AMZ Coupon后价", "AMZ Deal价", "AMZ Prime专享价", "AMZ促销价", "价格同步状态", "活动最后成功同步时间", "活动计算价", "活动说明"].sort());
  assert.equal(updates.some((item) => "价格观察时间" in item.fields), false, "「价格观察时间」已删除（2026-10-06）");
  assert.equal(exit["价格同步状态"], "已退出在售范围");
  assert.equal(exit["活动说明"], "Listing 非 BUYABLE");
  assert.equal(exit["AMZ促销价"], null);
  assert.equal(exit["AMZ售价"], undefined, "退出在售不清空原日常价");
  assert.equal(updates[0]!.fields["AMZ售价"], 19.99);
  assert.equal(result.updated, 2);
});

test("竞品价格每请求最多 20 个 ASIN、按 2.1 秒节流；通知键含旧价、新价与北京日期", async () => {
  const competitors = Array.from({ length: 21 }, (_, index) => `B${String(index).padStart(9, "0")}`);
  const calls: Array<{ asins: string; pace?: Row }> = [];
  const amazon = { sp: async (path: string, init: { body: { requests: Array<{ asin: string }> }; pace?: Row }) => {
    if (path.startsWith("/promotions/")) return { promotions: [] };
    calls.push({ asins: init.body.requests.map((request) => request.asin).join(","), ...(init.pace ? { pace: init.pace } : {}) });
    return { responses: init.body.requests.map(({ asin }) => ({ status: { statusCode: 200 }, body: { asin, featuredBuyingOptions: [{ buyingOptionType: "New", segmentedFeaturedOffers: [{ sellerId: "S1", condition: "New", fulfillmentType: "AFN", listingPrice: { amount: 12.5, currencyCode: "USD" }, shippingOptions: [{ shippingOptionType: "DEFAULT", price: { amount: 0, currencyCode: "USD" } }], featuredOfferSegments: [{ customerMembership: "NON_PRIME", segmentDetails: { glanceViewWeightPercentage: 100 } }] }] }] } })) };
  } } as unknown as AmazonClient;
  const state = new MemoryState([{ pk: "COMPETITOR_PRICE", sk: competitors[0], price: 11 }, { pk: "COMPETITOR_PRICE", sk: competitors[1], price: 12.5 }]);
  const sent: string[][] = [];
  const feishu = { sendText: async (_user: string, lines: string[]) => { sent.push(lines); } } as unknown as FeishuClient;
  const result = await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, configOf([{ sku: "SKU-1", asin: "B0", competitors, adMarker: "" }]), state.asStore(), amazon, feishu);
  assert.deepEqual(calls.map((call) => call.asins.split(",").length), [20, 1]);
  assert.ok(calls.every((call) => Number(call.pace?.minIntervalMs) >= 31_000));
  assert.equal(result.checked, 21);
  assert.equal(result.changed, 1);
  const day = ymdInZone(new Date(), "Asia/Shanghai");
  assert.equal(state.item("NOTIFICATION", `competitor|${competitors[0]}|11.00->12.50|${day}`)?.status, "done");
  assert.deepEqual(sent, [["竞品价格变化", "11.00 → 12.50", "SKU：SKU-1", `竞品ASIN：${competitors[0]}`, "Buy Box：FBA", "促销：无"]]);
});

test("货件“上次状态”只在状态变化时写入；SKU 查询按运行缓存；复用已查到的货件记录；状态变化通知只发一次", async () => {
  const shipmentsTable: Record<string, FeishuRecord> = { "FBA:FBA1": { record_id: "ship-1", fields: { "货件唯一键": "FBA:FBA1", "当前状态": "处理中" } }, "FBA:FBA2": { record_id: "ship-2", fields: { "货件唯一键": "FBA:FBA2", "当前状态": "处理中" } } };
  const writes: Array<{ table: string; fields: Row; existing?: FeishuRecord[] }> = [];
  let skuSearches = 0;
  const sent: string[][] = [];
  const feishu = {
    searchRecords: async (_app: string, table: string, key: Record<string, string>) => {
      if (table === "FEISHU_BITABLE_TABLE_ID_SKUS") { skuSearches += 1; return [{ record_id: "sku-1", fields: {} }]; }
      const record = shipmentsTable[key["货件唯一键"] ?? ""];
      return record ? [structuredClone(record)] : [];
    },
    upsert: async (_app: string, table: string, _key: unknown, fields: Row, _createOnly: unknown, options: { existing?: FeishuRecord[] } = {}) => {
      writes.push({ table, fields, ...(options.existing ? { existing: options.existing } : {}) });
      if (table === "FEISHU_BITABLE_TABLE_ID_SHIPMENTS") Object.assign(shipmentsTable[String(fields["货件唯一键"])]!.fields, fields);
      return "rec";
    },
    sendText: async (_user: string, lines: string[]) => { sent.push(lines); },
  } as unknown as FeishuClient;
  const amazon = { sp: async (path: string) => {
    if (path === "/fba/inbound/v0/shipments") return { payload: { ShipmentData: [{ ShipmentId: "FBA1", ShipmentName: "a", ShipmentStatus: "SHIPPED" }, { ShipmentId: "FBA2", ShipmentName: "b", ShipmentStatus: "WORKING" }] } };
    if (path.endsWith("/items")) return { payload: { ItemData: [{ SellerSKU: "SKU-1", QuantityShipped: 5, QuantityReceived: 0 }] } };
    return { shipments: [] };
  } } as unknown as AmazonClient;
  const state = new MemoryState();
  await runShipments({ taskType: "shipment" }, configOf(), state.asStore(), amazon, feishu);
  const shipmentWrites = writes.filter((item) => item.table === "FEISHU_BITABLE_TABLE_ID_SHIPMENTS");
  assert.equal(shipmentWrites[0]!.fields["上次状态"], "处理中");
  assert.equal(shipmentWrites[0]!.fields["当前状态"], "已发货");
  assert.equal(Object.hasOwn(shipmentWrites[1]!.fields, "上次状态"), false, "状态未变不覆盖上次状态");
  assert.equal(shipmentWrites[0]!.existing?.[0]?.record_id, "ship-1");
  assert.equal(skuSearches, 1);
  assert.equal(Object.hasOwn(shipmentWrites[0]!.fields, "承运商"), false);
  assert.deepEqual(sent, [["📦货件状态更新", "货件：FBA1（FBA）", "处理中 → 已发货"]]);
  writes.length = 0;
  await runShipments({ taskType: "shipment" }, configOf(), state.asStore(), amazon, feishu);
  assert.equal(Object.hasOwn(writes.find((item) => item.table === "FEISHU_BITABLE_TABLE_ID_SHIPMENTS")!.fields, "上次状态"), false);
  assert.equal(sent.length, 1);
});

test("库存通知状态按本 SKU 是否触发写“待发送/未触发”，汇总发送成功后批量改“已发送”，复用已读取的预警行", async () => {
  const end = addDaysYmd(ymdInZone(new Date(), "America/Los_Angeles"), -1);
  const amazon = { sp: async (path: string, init: { query?: Row }) => {
    if (path.startsWith("/fba/inventory")) return { payload: { inventorySummaries: [{ sellerSku: "SKU-A", inventoryDetails: { fulfillableQuantity: 0 } }, { sellerSku: "SKU-B", inventoryDetails: { fulfillableQuantity: 10 } }] } };
    if (path.startsWith("/awd/")) return { inventory: [] };
    if (path.startsWith("/sales/")) return { payload: init.query?.sku === "SKU-A" ? Array.from({ length: 30 }, (_, index) => ({ interval: `${addDaysYmd(end, -index)}T00:00:00-07:00--x`, unitCount: 2 })) : [] };
    throw new Error(`unexpected ${path}`);
  } } as unknown as AmazonClient;
  const upserts: Array<{ fields: Row; existing?: FeishuRecord[] }> = [];
  const batches: Array<Array<{ recordId: string; fields: Row }>> = [];
  const sent: string[][] = [];
  const feishu = {
    listRecords: async (_app: string, table: string) => table === "FEISHU_BITABLE_TABLE_ID_INVENTORY_ALERTS"
      ? [{ record_id: "rec-A", fields: { SKU: "SKU-A", "预警等级": "正常" } }, { record_id: "rec-B", fields: { SKU: "SKU-B", "预警等级": "正常" } }]
      : [{ record_id: "p-A", fields: { SKU: "SKU-A" } }, { record_id: "p-B", fields: { SKU: "SKU-B" } }],
    upsert: async (_app: string, _table: string, _key: unknown, fields: Row, _createOnly: unknown, options: { existing?: FeishuRecord[] } = {}) => { upserts.push({ fields, ...(options.existing ? { existing: options.existing } : {}) }); return options.existing?.[0]?.record_id ?? "new"; },
    batchUpdate: async (_app: string, _table: string, rows: Array<{ recordId: string; fields: Row }>) => { batches.push(rows); },
    sendText: async (_user: string, lines: string[]) => { sent.push(lines); },
  } as unknown as FeishuClient;
  const state = new MemoryState();
  const asins = [{ sku: "SKU-A", asin: "B0A", competitors: [], adMarker: "" }, { sku: "SKU-B", asin: "B0B", competitors: [], adMarker: "" }];
  const result = await runInventory({ taskType: "inventory" }, configOf(asins), state.asStore(), amazon, feishu);
  const bySku = new Map(upserts.map((item) => [String(item.fields.SKU), item]));
  assert.equal(bySku.get("SKU-A")!.fields["通知状态"], "待发送");
  assert.equal(bySku.get("SKU-A")!.fields["预警等级"], "FBA断货风险");
  assert.equal(bySku.get("SKU-B")!.fields["通知状态"], "未触发");
  assert.ok(upserts.every((item) => item.existing?.length === 1), "复用已读取的预警行，不再逐条搜索");
  assert.equal(sent.length, 1);
  assert.match(sent[0]![1]!, /^SKU-A：正常 → FBA断货风险/);
  assert.deepEqual(batches, [[{ recordId: "rec-A", fields: { "通知状态": "已发送" } }]]);
  assert.equal(result.notification, "sent");
  assert.equal(state.item("NOTIFICATION", `inventory|${end}`)?.status, "done");
});

test("AWD 库存按 details=SHOW 取明细：AWD 可用计入全链路库存，补货中仅展示，不因漏算误报补货", async () => {
  const end = addDaysYmd(ymdInZone(new Date(), "America/Los_Angeles"), -1);
  const awdQueries: Row[] = [];
  const amazon = { sp: async (path: string, init: { query?: Row }) => {
    if (path.startsWith("/fba/inventory")) return { payload: { inventorySummaries: [{ sellerSku: "SKU-A", inventoryDetails: { fulfillableQuantity: 76 } }] } };
    if (path.startsWith("/awd/")) {
      awdQueries.push(init.query ?? {});
      // 官方 listInventory 默认 details=HIDE 只回汇总；SHOW 才带 inventoryDetails。
      const summary: Row = { sku: "SKU-A", totalInboundQuantity: 4, totalOnhandQuantity: 50 };
      return { inventory: [init.query?.details === "SHOW" ? { ...summary, inventoryDetails: { availableDistributableQuantity: 50, replenishmentQuantity: 9 } } : summary] };
    }
    if (path.startsWith("/sales/")) return { payload: Array.from({ length: 90 }, (_, index) => ({ interval: `${addDaysYmd(end, -index)}T00:00:00-07:00--x`, unitCount: 1 })) };
    throw new Error(`unexpected ${path}`);
  } } as unknown as AmazonClient;
  const upserts: Row[] = [];
  const feishu = {
    listRecords: async (_app: string, table: string) => table === "FEISHU_BITABLE_TABLE_ID_INVENTORY_ALERTS"
      ? [{ record_id: "rec-A", fields: { SKU: "SKU-A", "预警等级": "正常" } }]
      : [{ record_id: "p-A", fields: { SKU: "SKU-A" } }],
    upsert: async (_app: string, _table: string, _key: unknown, fields: Row) => { upserts.push(fields); return "rec-A"; },
    batchUpdate: async () => undefined,
    sendText: async () => undefined,
  } as unknown as FeishuClient;
  await runInventory({ taskType: "inventory" }, configOf([{ sku: "SKU-A", asin: "B0A", competitors: [], adMarker: "" }]), new MemoryState().asStore(), amazon, feishu);
  assert.ok(awdQueries.length > 0 && awdQueries.every((query) => query.details === "SHOW"), "AWD 查询必须带 details=SHOW");
  const row = upserts[0]!;
  assert.equal(row["AWD可用"], 50);
  assert.equal(row["去AWD在途"], 4);
  assert.equal(row["AWD补货中（仅展示）"], 9);
  assert.equal(row["全链路库存"], 76 + 50 + 4, "AWD 可用与去 AWD 在途计入全链路，补货中不计入");
  // 日均 1、默认提前期 60 天＋安全 14 天：漏算 AWD 可用时全链路仅 80，会误报“即将补货”。
  assert.equal(row["预警等级"], "正常");
});

test("售后原因待匹配事件指数退避（1 小时起、封顶 7 天），普通待匹配不再缩短报表周期，常驻进度不用 done", async () => {
  const saves: Array<{ state: Row; status: string }> = [];
  let saved: Row = { pending: [{ eventKey: "return|1|SKU|2026-09-20T00:00:00.000Z|DEFECTIVE", eventTime: "2026-09-20T00:00:00.000Z", timeBasis: "退货入仓时间", reasonRaw: "DEFECTIVE", reasonZh: "商品有缺陷", comment: "", type: "退货", source: "FBA退货报告｜SKU级", orderId: "111-0000000-0000001", sku: "SKU", asin: "", scope: "sku" }], lastCompletedAt: new Date(Date.now() - 3_600_000).toISOString() };
  const state = {
    task: async () => ({ state: saved }),
    saveTask: async (_type: string, _id: string, progress: Row, status: string) => { saves.push({ state: progress, status }); saved = progress; },
  } as unknown as StateStore;
  let searches = 0;
  const feishu = { searchRecords: async () => { searches += 1; return []; } } as unknown as FeishuClient;
  const amazon = { sp: async () => { throw new Error("不应创建报表"); } } as unknown as AmazonClient;
  const config = configOf([], { MARKETPLACE_IDS: "ATVPDKIKX0DER" });
  (config as unknown as { get: (key: string) => string }).get = (key: string) => key === "ORDER_REASON_ENABLED_AT" ? "2026-09-01T00:00:00.000Z" : key;
  const before = Date.now();
  await runOrderReasons({ taskType: "order-reason" }, config, state, amazon, feishu);
  const pending = (saves.at(-1)!.state.pending as Row[])[0]!;
  assert.equal(saves.at(-1)!.status, "pending_match");
  assert.equal(pending.attempts, 1);
  assert.ok(Math.abs(Date.parse(String(pending.nextAt)) - (before + 3_600_000)) < 5_000);
  await runOrderReasons({ taskType: "order-reason" }, config, state, amazon, feishu);
  assert.equal(searches, 1, "未到期的待匹配事件不重试");
  saved = { ...saved, pending: [{ ...(saved.pending as Row[])[0], attempts: 12, nextAt: new Date(before - 1).toISOString() }] };
  await runOrderReasons({ taskType: "order-reason" }, config, state, amazon, feishu);
  const capped = (saves.at(-1)!.state.pending as Row[])[0]!;
  assert.ok(Date.parse(String(capped.nextAt)) - before <= 7 * DAY + 5_000);
  saved = { lastCompletedAt: new Date().toISOString() };
  await runOrderReasons({ taskType: "order-reason" }, config, state, amazon, feishu);
  assert.equal(saves.at(-1)!.status, "idle");
});

test("售后原因同步进度存状态表 ORDER_REASON：上次状态已存但飞书没写成功（synced=false）时先补写，飞书只写四个可见列", async () => {
  const event = { eventKey: "return|111-0000000-0000001|SKU|2026-09-20T00:00:00.000Z|DEFECTIVE", eventTime: "2026-09-20T00:00:00.000Z", timeBasis: "退货入仓时间", reasonRaw: "DEFECTIVE", reasonZh: "商品有缺陷", comment: "盒子坏了", type: "退货", source: "FBA退货报告｜SKU级", orderId: "111-0000000-0000001", sku: "SKU", asin: "", scope: "sku" };
  const state = new MemoryState([
    { pk: "TASK#order-reason", sk: "ATVPDKIKX0DER", status: "pending_match", state: { pending: [{ ...event, attempts: 1, nextAt: new Date(Date.now() - 1).toISOString() }], lastCompletedAt: new Date(Date.now() - 3_600_000).toISOString() } },
    { pk: "ORDER_REASON", sk: "111-0000000-0000001|sku", technical: { version: 1, currentTime: event.eventTime, events: [event], pending: null }, synced: false },
  ]);
  const writes: Row[] = [];
  const feishu = { searchRecords: async () => [{ record_id: "rec-1", fields: { SKU: "SKU" } }], update: async (_app: string, _table: string, _id: string, fields: Row) => { writes.push(fields); } } as unknown as FeishuClient;
  const amazon = { sp: async () => { throw new Error("不应创建报表"); } } as unknown as AmazonClient;
  const config = configOf([], { MARKETPLACE_IDS: "ATVPDKIKX0DER" });
  (config as unknown as { get: (key: string) => string }).get = (key: string) => key === "ORDER_REASON_ENABLED_AT" ? "2026-09-01T00:00:00.000Z" : key;
  await runOrderReasons({ taskType: "order-reason" }, config, state.asStore(), amazon, feishu);
  assert.equal(writes.length, 1, "补写一次；同一事件已在状态里，不再重复写");
  assert.deepEqual(Object.keys(writes[0]!).sort(), ["买家备注原文", "售后原因中文", "售后原因原文", "售后原因时间"].sort());
  assert.equal(writes[0]!["售后原因中文"], "商品有缺陷");
  assert.equal(writes[0]!["售后原因时间"], "2026-09-19 17:00:00｜退货入仓时间", "写洛杉矶本地时间文本（事件时间 2026-09-20T00:00:00Z）");
  assert.equal(state.item("ORDER_REASON", "111-0000000-0000001|sku")?.synced, true);
  assert.deepEqual(state.item("TASK#order-reason", "ATVPDKIKX0DER")?.state && ((state.item("TASK#order-reason", "ATVPDKIKX0DER")!.state as Row).pending as Row[]).length, 0);
});

test("订单校准 600 秒预算：超时保存阶段与时间片游标并 +60 秒续跑；第三阶段刷新飞书中停滞超过 3 天的非终态订单并按官方速率节流", async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const state = new MemoryState();
    const schedules: Array<{ event: JobEvent; when: Date }> = [];
    const paces = new Set<string>();
    const listCalls: Row[] = [];
    const rows: Record<string, FeishuRecord> = { "111-0000000-0000001": { record_id: "rec-1", fields: { "订单编号": "111-0000000-0000001", SKU: "SKU-1", "订单状态": "待处理", "下单时间": "2026-06-10 10:00:00" } } };
    const amazon = { sp: async (path: string, init: { query?: Row; pace?: { key: string } } = {}) => {
      if (init.pace) paces.add(init.pace.key);
      if (path === "/orders/v0/orders") { clock += 90_000; listCalls.push(init.query ?? {}); return { payload: { Orders: [] } }; }
      if (path.endsWith("/orderItems")) return { payload: { OrderItems: [{ SellerSKU: "SKU-1", QuantityOrdered: 1 }] } };
      return { payload: { OrderStatus: "Shipped", IsReplacementOrder: false, LastUpdateDate: "2026-06-12T00:00:00Z", PurchaseDate: "2026-06-10T17:00:00Z" } };
    } } as unknown as AmazonClient;
    const feishu = {
      searchRecords: async (_app: string, _table: string, key: Record<string, string>) => key["订单状态"] === "待处理"
        ? [{ record_id: "rec-1", fields: rows["111-0000000-0000001"]!.fields }, { record_id: "rec-9", fields: { "订单编号": "111-0000000-0000009", "订单状态": "待处理", "下单时间": new Date(realNow() - DAY).toISOString().slice(0, 19).replace("T", " ") } }]
        : key["订单状态"] ? [] : Object.values(rows).filter((row) => row.fields["订单编号"] === key["订单编号"]).map((row) => structuredClone(row)),
      upsert: async (_app: string, _table: string, _key: unknown, fields: Row, _createOnly: unknown, options: { existing?: FeishuRecord[] } = {}) => { Object.assign(rows[String(fields["订单编号"])]!.fields, fields); return options.existing?.[0]?.record_id ?? "rec"; },
    } as unknown as FeishuClient;
    const event: JobEvent = { taskType: "order-reconcile", taskId: "order-reconcile|2026-09-29T00:30:00Z", scheduledAt: "2026-09-29T00:30:00Z" };
    const schedule = async (next: JobEvent, when: Date): Promise<string> => { schedules.push({ event: next, when }); return "s"; };
    const first = await runOrderReconcile(event, configOf(), state.asStore(), amazon, feishu, schedule);
    assert.equal(first.status, "continuing");
    assert.equal(listCalls.length, 7, "近 7 天创建按 7 个一天时间片查询后预算用尽");
    assert.ok(listCalls.every((query) => "CreatedAfter" in query && "CreatedBefore" in query));
    assert.deepEqual(schedules[0]?.event, { taskType: "order-reconcile", taskId: event.taskId, scheduledAt: event.scheduledAt });
    assert.equal(schedules[0]!.when.getTime(), clock + 60_000);
    const saved = state.item("TASK#order-reconcile", event.taskId!)!;
    assert.equal(saved.status, "active");
    assert.equal((saved.state as Row).phase, "updated");
    clock += 60_000;
    const second = await runOrderReconcile(event, configOf(), state.asStore(), amazon, feishu, schedule);
    assert.equal(second.status, "done");
    assert.equal(listCalls.length, 10);
    assert.ok(listCalls.slice(7).every((query) => "LastUpdatedAfter" in query));
    assert.equal(second.staleOrders, 1, "只刷新下单超过 3 天的非终态订单");
    assert.equal(second.refreshed, 1);
    assert.equal(rows["111-0000000-0000001"]!.fields["订单状态"], "已发货");
    assert.ok(paces.has("orders-getOrder") && paces.has("orders-getOrderItems"));
  } finally {
    Date.now = realNow;
  }
});

test("AMS 活动名实例内缓存 6 小时，同一活动的后续预算消息不再查询 Ads", async () => {
  clearCampaignNameCache();
  let lookups = 0;
  const amazon = { ads: async () => { lookups += 1; return { campaigns: [{ name: "SKU1-Auto" }] }; } } as unknown as AmazonClient;
  const names: string[] = [];
  const feishu = { upsert: async (_app: string, _table: string, _key: unknown, fields: Row) => { names.push(String(fields["广告活动名称"])); return "rec"; } } as unknown as FeishuClient;
  const event = (at: string) => ({ module: "ams", entityKey: "ams|p1|c1|2026-09-28", eventKey: "BUDGET_USAGE", version: Date.parse(at), occurredAt: at, payload: { profileId: "p1", campaignId: "c1", budget: 100, budget_usage_percentage: 10 } });
  await processAmsEvent(event("2026-09-28T10:00:00Z"), configOf(), new MemoryState().asStore(), amazon, feishu);
  await processAmsEvent(event("2026-09-28T11:00:00Z"), configOf(), new MemoryState().asStore(), amazon, feishu);
  assert.equal(lookups, 1);
  assert.deepEqual(names, ["SKU1-Auto", "SKU1-Auto"]);
  clearCampaignNameCache();
});

test("AMS「预算更新时间」写洛杉矶本地时间文本（夏令时与冬令时都对），不写 UTC ISO——飞书 TODATE 不识别 Z", async () => {
  clearCampaignNameCache();
  const written: Row[] = [];
  const feishu = { upsert: async (_app: string, _table: string, _key: unknown, fields: Row) => { written.push(fields); return "rec"; } } as unknown as FeishuClient;
  const amazon = { ads: async () => ({ campaigns: [{ name: "SKU1-Auto" }] }) } as unknown as AmazonClient;
  const event = (at: string, date: string) => ({ module: "ams", entityKey: `ams|p1|c1|${date}`, eventKey: "BUDGET_USAGE", version: Date.parse(at), occurredAt: at, payload: { profileId: "p1", campaignId: "c1", budget: 100, budget_usage_percentage: 10 } });
  await processAmsEvent(event("2026-10-04T06:12:06Z", "2026-10-03"), configOf(), new MemoryState().asStore(), amazon, feishu);
  await processAmsEvent(event("2026-12-15T03:00:00Z", "2026-12-14"), configOf(), new MemoryState().asStore(), amazon, feishu);
  assert.deepEqual(written.map((fields) => [fields["预算更新时间"], fields["预算日期"]]), [["2026-10-03 23:12:06", "2026-10-03"], ["2026-12-14 19:00:00", "2026-12-14"]]);
  clearCampaignNameCache();
});
