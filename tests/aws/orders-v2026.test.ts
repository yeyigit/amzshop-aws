import assert from "node:assert/strict";
import test from "node:test";
import { orderFromV2026, ordersApiVersion, processOrderEvent, truncateToSeconds } from "../../src/business/orders.js";
import { runOrderReconcile } from "../../src/business/orders-periodic.js";
import type { AppConfig, FeishuRecord, JobEvent } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import type { StateStore } from "../../src/state.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const V2026 = { ORDERS_API_VERSION: "v2026" };
const DAY = 86_400_000;
const item2026 = (sku: string, quantity: number, subtotal?: Row): Row => ({ product: { sellerSku: sku }, quantityOrdered: quantity, ...(subtotal ? { proceeds: { breakdowns: [{ type: "ITEM", subtotal }] } } : {}) });

// ---- 以下三条复制旧 v0 同场景用例，只换 Amazon 响应固件（v2026 getOrder），断言不变 ----

test("[v2026] 取消刷新保留既有数量与财务字段，空 ItemPrice 不写零或清空币种", async () => {
  const writes: Record<string, unknown>[] = [];
  const old = { record_id: "rec-1", fields: { SKU: [{ text: "SKU-1" }], "数量": 1, "付款金额": 12.5, "费用币种": "USD", "佣金": 1.95, "配送费": 4.09, "订单状态": "Shipped", "订单状态更新时间": "2026-09-23T00:00:00Z" } };
  const amazon = { sp: async () => ({ order: { orderId: "1", lastUpdatedTime: "2026-09-24T00:00:00.417Z", fulfillment: { fulfillmentStatus: "CANCELLED" }, orderItems: [item2026("SKU-1", 0, { amount: "", currencyCode: "" })] } }) } as unknown as AmazonClient;
  const feishu = { searchRecords: async () => [old], upsert: async (_app: string, _table: string, _key: unknown, fields: Record<string, unknown>) => { writes.push(fields); return old.record_id; } } as unknown as FeishuClient;
  const config = { get: () => "test", optional: (key: string, fallback = "") => (V2026 as Record<string, string>)[key] ?? fallback, asins: () => [] } as unknown as AppConfig;
  await processOrderEvent({ module: "order", entityKey: "order#1", eventKey: "ORDER_CHANGE", version: 1, occurredAt: "2026-09-24T00:00:00Z", payload: { orderId: "1", suppressNotifications: true } }, config, { notification: async () => undefined } as unknown as StateStore, amazon, feishu);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.["数量"], 1);
  assert.equal(writes[0]?.["订单状态"], "已取消");
  for (const field of ["付款金额", "费用币种", "佣金", "配送费", "促销费用", "费用更新时间"]) assert.equal(Object.hasOwn(writes[0]!, field), false);
});

test("[v2026] 新取消单 Amazon 数量为零时沿用 GAS 的一件保底，不虚构付款金额", async () => {
  const writes: Record<string, unknown>[] = [];
  const amazon = { sp: async () => ({ order: { orderId: "1", lastUpdatedTime: "2026-09-24T00:00:00.020Z", fulfillment: { fulfillmentStatus: "CANCELLED" }, proceeds: { grandTotal: { currencyCode: "USD", amount: "" } }, orderItems: [item2026("SKU-1", 0)] } }) } as unknown as AmazonClient;
  const feishu = { searchRecords: async () => [], upsert: async (_app: string, _table: string, _key: unknown, fields: Record<string, unknown>) => { writes.push(fields); return "rec-1"; } } as unknown as FeishuClient;
  const config = { get: () => "test", optional: (key: string, fallback = "") => (V2026 as Record<string, string>)[key] ?? fallback, asins: () => [] } as unknown as AppConfig;
  await processOrderEvent({ module: "order", entityKey: "order#1", eventKey: "ORDER_CHANGE", version: 1, occurredAt: "2026-09-24T00:00:00Z", payload: { orderId: "1", suppressNotifications: true } }, config, { notification: async () => undefined } as unknown as StateStore, amazon, feishu);
  assert.equal(writes[0]?.["数量"], 1);
  assert.equal(Object.hasOwn(writes[0]!, "付款金额"), false);
});

test("[v2026] 新订单通知仅在 Amazon 明确标记企业买家时首行追加“企业买家”，不再输出是否企业买家行", async () => {
  // v2026 以 programs 数组表达企业单，没有 v0 的字符串布尔与缺省三态，只复制可对应的 true/false 两例。
  for (const [programs, first, field] of [[["AMAZON_BUSINESS"], "💰新订单  企业买家", "true"], [[], "💰新订单", "false"], [undefined, "💰新订单", "false"]] as const) {
    const sent: string[][] = [];
    const saved: string[][] = [];
    let fields: Record<string, unknown> = {};
    const amazon = { sp: async () => ({ order: { orderId: "1", fulfillment: { fulfillmentStatus: "UNSHIPPED" }, ...(programs ? { programs } : {}), orderItems: [item2026("SKU-1", 2)] } }) } as unknown as AmazonClient;
    const feishu = {
      searchRecords: async () => [],
      upsert: async (_app: string, _table: string, _key: unknown, value: Record<string, unknown>) => { fields = value; return "rec-1"; },
      sendText: async (_recipient: string, lines: string[]) => { sent.push(lines); },
    } as unknown as FeishuClient;
    const state = { saveNotification: async (_key: string, lines: string[]) => { saved.push(lines); }, notification: async () => undefined, markRecipient: async () => undefined, completeNotification: async () => undefined } as unknown as StateStore;
    const config = { get: () => "test", optional: (key: string) => key === "ORDERS_API_VERSION" ? "v2026" : "user-1", asins: () => [] } as unknown as AppConfig;
    await processOrderEvent({ module: "order", entityKey: "order#1", eventKey: "ORDER_CHANGE", version: 1, occurredAt: "2026-09-27T00:00:00Z", payload: { orderId: "1" } }, config, state, amazon, feishu);
    const expected = [first, "SKU-1 x 2", "订单编号：1"];
    assert.equal(fields["企业买家"], field);
    assert.deepEqual(saved, [expected], "写飞书前持久化的通知意图就是最终文案");
    assert.deepEqual(sent, [expected]);
    assert.equal(sent.flat().some((line) => line.includes("是否企业买家")), false);
  }
});

// ---- v2026 映射本身 ----

test("C1 开关默认 v0：只有明确配置 ORDERS_API_VERSION=v2026 才调用 v2026 getOrder(includedData=PROCEEDS,FULFILLMENT)", async () => {
  assert.equal(ordersApiVersion({ get: () => "", asins: () => [] } as unknown as AppConfig), "v0", "配置不可读按 v0");
  assert.equal(ordersApiVersion({ optional: (_key: string, fallback = "") => fallback } as unknown as AppConfig), "v0");
  assert.equal(ordersApiVersion({ optional: () => "V2026" } as unknown as AppConfig), "v2026");
  const paths: Array<{ path: string; query?: Row }> = [];
  const amazon = { sp: async (path: string, init: { query?: Row } = {}) => {
    paths.push({ path, ...(init.query ? { query: init.query } : {}) });
    if (path.startsWith("/orders/2026-01-01/")) return { order: { orderId: "111-0000000-0000001", fulfillment: { fulfillmentStatus: "SHIPPED" }, orderItems: [item2026("SKU-1", 1)] } };
    return path.endsWith("/orderItems") ? { payload: { OrderItems: [{ SellerSKU: "SKU-1", QuantityOrdered: 1 }] } } : { payload: { OrderStatus: "Shipped" } };
  } } as unknown as AmazonClient;
  const feishu = { searchRecords: async () => [], upsert: async () => "rec" } as unknown as FeishuClient;
  const event = { module: "order", entityKey: "order#111-0000000-0000001", eventKey: "ORDER_CHANGE", version: 1, occurredAt: "2026-09-27T00:00:00Z", payload: { orderId: "111-0000000-0000001", suppressNotifications: true } };
  await processOrderEvent(event, { get: () => "t", optional: (_key: string, fallback = "") => fallback, asins: () => [] } as unknown as AppConfig, { notification: async () => undefined } as unknown as StateStore, amazon, feishu);
  assert.deepEqual(paths.map((item) => item.path).sort(), ["/orders/v0/orders/111-0000000-0000001", "/orders/v0/orders/111-0000000-0000001/orderItems"]);
  paths.length = 0;
  await processOrderEvent(event, { get: () => "t", optional: (key: string, fallback = "") => key === "ORDERS_API_VERSION" ? "v2026" : fallback, asins: () => [] } as unknown as AppConfig, { notification: async () => undefined } as unknown as StateStore, amazon, feishu);
  assert.deepEqual(paths, [{ path: "/orders/2026-01-01/orders/111-0000000-0000001", query: { includedData: "PROCEEDS,FULFILLMENT" } }]);
});

test("C1 v2026 映射按迁移指南：状态、企业单、换货单与原单号、商品价、订单总额；时间截断到秒与 v0 写入值相同", async () => {
  assert.equal(truncateToSeconds("2026-09-29T10:20:30.941Z"), "2026-09-29T10:20:30Z");
  assert.equal(truncateToSeconds("2026-09-29T10:20:30Z"), "2026-09-29T10:20:30Z");
  const mapped = orderFromV2026({
    orderId: "111-0000000-0000009", createdTime: "2026-09-20T17:00:00.512Z", lastUpdatedTime: "2026-09-21T03:04:05.999Z",
    fulfillment: { fulfillmentStatus: "PARTIALLY_SHIPPED" }, programs: ["AMAZON_BUSINESS"],
    associatedOrders: [{ orderId: "111-0000000-0000001", associationType: "REPLACEMENT_ORIGINAL_ID" }],
    proceeds: { grandTotal: { amount: "25.98", currencyCode: "USD" } },
    orderItems: [{ product: { sellerSku: "SKU-1", asin: "B0A" }, quantityOrdered: 2, proceeds: { breakdowns: [{ type: "TAX", subtotal: { amount: "2.00", currencyCode: "USD" } }, { type: "ITEM", subtotal: { amount: "25.98", currencyCode: "USD" } }] } }],
  });
  assert.deepEqual(mapped.order, { AmazonOrderId: "111-0000000-0000009", OrderStatus: "PartiallyShipped", PurchaseDate: "2026-09-20T17:00:00Z", LastUpdateDate: "2026-09-21T03:04:05Z", IsBusinessOrder: true, IsReplacementOrder: true, ReplacedOrderId: "111-0000000-0000001", OrderTotal: { Amount: "25.98", CurrencyCode: "USD" } });
  assert.deepEqual(mapped.items, [{ SellerSKU: "SKU-1", ASIN: "B0A", QuantityOrdered: 2, ItemPrice: { Amount: "25.98", CurrencyCode: "USD" } }]);
  const writes: Row[] = [];
  const amazon = { sp: async () => ({ order: { orderId: "111-0000000-0000009", createdTime: "2026-09-20T17:00:00.512Z", lastUpdatedTime: "2026-09-21T03:04:05.999Z", fulfillment: { fulfillmentStatus: "PARTIALLY_SHIPPED" }, programs: ["AMAZON_BUSINESS"], associatedOrders: [{ orderId: "111-0000000-0000001", associationType: "EXCHANGE_ORIGINAL_ID" }], orderItems: [{ product: { sellerSku: "SKU-1", asin: "B0A" }, quantityOrdered: 2, proceeds: { breakdowns: [{ type: "ITEM", subtotal: { amount: "25.98", currencyCode: "USD" } }] } }] } }) } as unknown as AmazonClient;
  const feishu = { searchRecords: async () => [], upsert: async (_a: string, _t: string, _k: unknown, fields: Row) => { writes.push(fields); return "rec"; } } as unknown as FeishuClient;
  await processOrderEvent({ module: "order", entityKey: "order#x", eventKey: "ORDER_CHANGE", version: 1, occurredAt: "2026-09-27T00:00:00Z", payload: { orderId: "111-0000000-0000009", suppressNotifications: true } }, { get: () => "t", optional: (key: string, fallback = "") => key === "ORDERS_API_VERSION" ? "v2026" : fallback, asins: () => [] } as unknown as AppConfig, { notification: async () => undefined } as unknown as StateStore, amazon, feishu);
  assert.deepEqual(writes[0], { "订单编号": "111-0000000-0000009", SKU: "SKU-1", "数量": 2, ASIN: "B0A", "下单时间": "2026-09-20 10:00:00", "企业买家": "true", "换货单": "true", "换货订单号": "111-0000000-0000001", "金额币种": "USD", "付款金额": 25.98, "订单状态": "部分发货", "订单状态更新时间": "2026-09-20 20:04:05" });
});

test("[v2026] 订单校准改用 searchOrders 按一天时间片查询，超时保存游标 +60 秒续跑，逐单按 v2026 getOrder 刷新并节流", async () => {
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
      if (path === "/orders/2026-01-01/orders") { clock += 90_000; listCalls.push(init.query ?? {}); return { orders: [], pagination: {} }; }
      return { order: { orderId: "111-0000000-0000001", fulfillment: { fulfillmentStatus: "SHIPPED" }, lastUpdatedTime: "2026-06-12T00:00:00.123Z", createdTime: "2026-06-10T17:00:00.456Z", orderItems: [item2026("SKU-1", 1)] } };
    } } as unknown as AmazonClient;
    const feishu = {
      searchRecords: async (_app: string, _table: string, key: Record<string, string>) => key["订单状态"] === "待处理" ? [{ record_id: "rec-1", fields: rows["111-0000000-0000001"]!.fields }] : key["订单状态"] ? [] : Object.values(rows).filter((row) => row.fields["订单编号"] === key["订单编号"]).map((row) => structuredClone(row)),
      upsert: async (_app: string, _table: string, _key: unknown, fields: Row, _createOnly: unknown, options: { existing?: FeishuRecord[] } = {}) => { Object.assign(rows[String(fields["订单编号"])]!.fields, fields); return options.existing?.[0]?.record_id ?? "rec"; },
    } as unknown as FeishuClient;
    const config = { get: (key: string) => key, optional: (key: string, fallback = "") => key === "ORDERS_API_VERSION" ? "v2026" : fallback, bool: () => true, asins: () => [] } as unknown as AppConfig;
    const event: JobEvent = { taskType: "order-reconcile", taskId: "order-reconcile|2026-09-29T00:30:00Z", scheduledAt: "2026-09-29T00:30:00Z" };
    const schedule = async (next: JobEvent, when: Date): Promise<string> => { schedules.push({ event: next, when }); return "s"; };
    const first = await runOrderReconcile(event, config, state.asStore(), amazon, feishu, schedule);
    assert.equal(first.status, "continuing");
    assert.equal(listCalls.length, 7);
    assert.ok(listCalls.every((query) => "createdAfter" in query && "createdBefore" in query && query.maxResultsPerPage === 100 && query.marketplaceIds === "ATVPDKIKX0DER"));
    assert.ok(listCalls.every((query) => Date.parse(String(query.createdBefore)) - Date.parse(String(query.createdAfter)) <= DAY));
    assert.equal(schedules[0]!.when.getTime(), clock + 60_000);
    clock += 60_000;
    const second = await runOrderReconcile(event, config, state.asStore(), amazon, feishu, schedule);
    assert.equal(second.status, "done");
    assert.ok(listCalls.slice(7).every((query) => "lastUpdatedAfter" in query && "lastUpdatedBefore" in query));
    assert.equal(rows["111-0000000-0000001"]!.fields["订单状态"], "已发货");
    assert.equal(rows["111-0000000-0000001"]!.fields["订单状态更新时间"], "2026-06-11 17:00:00", "写入时间截断到秒、换成洛杉矶本地时间文本，与 v0 同形");
    assert.ok(paces.has("orders2026-getOrder"));
  } finally {
    Date.now = realNow;
  }
});
