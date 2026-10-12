import assert from "node:assert/strict";
import test from "node:test";
import { orderAge, processOrderEvent } from "../../src/business/orders.js";
import type { AppConfig } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import type { StateStore } from "../../src/state.js";

test("新订单通知仅在 Amazon 明确标记企业买家时首行追加“企业买家”，不再输出是否企业买家行", async () => {
  for (const [raw, first, field] of [
    [true, "💰新订单  企业买家", "true"],
    [false, "💰新订单", "false"],
    [" FALSE ", "💰新订单", "false"],
    [undefined, "💰新订单", undefined],
    ["yes", "💰新订单", undefined],
  ] as const) {
    const sent: string[][] = [];
    const saved: string[][] = [];
    let fields: Record<string, unknown> = {};
    const amazon = { sp: async (path: string) => path.endsWith("/orderItems")
      ? { payload: { OrderItems: [{ SellerSKU: "SKU-1", QuantityOrdered: 2 }] } }
      : { payload: { OrderStatus: "Unshipped", IsReplacementOrder: false, ...(raw === undefined ? {} : { IsBusinessOrder: raw }) } } } as unknown as AmazonClient;
    const feishu = {
      searchRecords: async () => [],
      upsert: async (_app: string, _table: string, _key: unknown, value: Record<string, unknown>) => { fields = value; return "rec-1"; },
      sendText: async (_recipient: string, lines: string[]) => { sent.push(lines); },
    } as unknown as FeishuClient;
    const state = {
      saveNotification: async (_key: string, lines: string[]) => { saved.push(lines); },
      notification: async () => undefined,
      markRecipient: async () => undefined,
      completeNotification: async () => undefined,
    } as unknown as StateStore;
    const config = { get: () => "test", optional: () => "user-1", asins: () => [] } as unknown as AppConfig;
    await processOrderEvent({ module: "order", entityKey: "order#1", eventKey: "ORDER_CHANGE", version: 1, occurredAt: "2026-09-27T00:00:00Z", payload: { orderId: "1" } }, config, state, amazon, feishu);
    const expected = [first, "SKU-1 x 2", "订单编号：1"];
    assert.equal(fields["企业买家"], field);
    assert.deepEqual(saved, [expected], "写飞书前持久化的通知意图就是最终文案");
    assert.deepEqual(sent, [expected]);
    assert.equal(sent.flat().some((line) => line.includes("是否企业买家")), false);
  }
});

test("新订单通知在“新订单”后隔两个空格写下单距今，企业买家时放在“企业买家”前、同样隔两个空格；v0 与 v2026 同形，下单时间未知不写", async () => {
  const now = Date.parse("2026-10-08T05:50:00Z");
  for (const [version, order, first] of [
    ["v0", { PurchaseDate: "2026-10-08T03:28:00Z" }, "💰新订单  2 小时前"],
    ["v0", { PurchaseDate: "2026-10-08T03:28:00Z", IsBusinessOrder: true }, "💰新订单  2 小时前  企业买家"],
    ["v0", { IsBusinessOrder: true }, "💰新订单  企业买家"],
    ["v2026", { createdTime: "2026-10-08T05:47:12.345Z" }, "💰新订单  2 分钟前"],
    ["v2026", { createdTime: "2026-10-08T05:47:12.345Z", programs: ["AMAZON_BUSINESS"] }, "💰新订单  2 分钟前  企业买家"],
  ] as const) {
    const sent: string[][] = [];
    const amazon = { sp: async (path: string) => version === "v2026"
      ? { order: { orderId: "1", fulfillment: { fulfillmentStatus: "UNSHIPPED" }, ...order, orderItems: [{ product: { sellerSku: "SKU-1" }, quantityOrdered: 1 }] } }
      : path.endsWith("/orderItems")
        ? { payload: { OrderItems: [{ SellerSKU: "SKU-1", QuantityOrdered: 1 }] } }
        : { payload: { OrderStatus: "Unshipped", IsReplacementOrder: false, ...order } } } as unknown as AmazonClient;
    const feishu = { searchRecords: async () => [], upsert: async () => "rec-1", sendText: async (_recipient: string, lines: string[]) => { sent.push(lines); } } as unknown as FeishuClient;
    const state = { saveNotification: async () => undefined, notification: async () => undefined, markRecipient: async () => undefined, completeNotification: async () => undefined } as unknown as StateStore;
    const config = { get: () => "test", optional: (key: string) => key === "ORDERS_API_VERSION" ? version : "user-1", asins: () => [] } as unknown as AppConfig;
    await processOrderEvent({ module: "order", entityKey: "order#1", eventKey: "ORDER_CHANGE", version: 1, occurredAt: "2026-10-08T05:49:00Z", payload: { orderId: "1" } }, config, state, amazon, feishu, { now });
    assert.deepEqual(sent, [[first, "SKU-1 x 1", "订单编号：1"]], `${version} ${JSON.stringify(order)}`);
  }
});

test("下单距今按准备通知的时刻向下取整：不足 1 分钟写“刚刚”，不足 1 小时按分钟，不足 48 小时按小时，之后按天；时间无效不写", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const ago = (ms: number): string => orderAge(new Date(now - ms).toISOString(), now);
  assert.equal(ago(30_000), "刚刚");
  assert.equal(ago(-30_000), "刚刚", "亚马逊时间略快于本机时不写负数");
  assert.equal(ago(MINUTE), "1 分钟前");
  assert.equal(ago(59 * MINUTE + 59_000), "59 分钟前");
  assert.equal(ago(HOUR), "1 小时前");
  assert.equal(ago(2 * HOUR + 22 * MINUTE), "2 小时前");
  assert.equal(ago(47 * HOUR + 59 * MINUTE), "47 小时前");
  assert.equal(ago(48 * HOUR), "2 天前");
  assert.equal(ago(80 * HOUR), "3 天前");
  for (const bad of [undefined, null, "", "not a date"]) assert.equal(orderAge(bad, now), "");
});
