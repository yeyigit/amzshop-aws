import assert from "node:assert/strict";
import test from "node:test";
import { processOrderEvent } from "../../src/business/orders.js";
import { claimOrderEvent } from "../../src/handlers/order.js";
import type { AppConfig, BusinessEvent, FeishuRecord } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import type { StateStore } from "../../src/state.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const HOUR = 3_600_000;
const orderConfig = { get: (key: string) => key, optional: (key: string, fallback = "") => key === "FEISHU_NOTIFY_USER_IDS" ? "u1" : fallback, asins: () => [] } as unknown as AppConfig;
const orderEvent = (orderId: string, payload: Row = {}): BusinessEvent => ({ module: "order", entityKey: `order#${orderId}`, eventKey: "ORDER_CHANGE", version: 1, occurredAt: "2026-09-28T00:00:00Z", payload: { orderId, ...payload } });

function orderAmazon(status: string, extra: Row = {}): AmazonClient {
  return { sp: async (path: string) => path.endsWith("/orderItems")
    ? { payload: { OrderItems: [{ SellerSKU: "SKU-1", QuantityOrdered: 1, ItemPrice: { Amount: "10.00", CurrencyCode: "USD" } }] } }
    : { payload: { OrderStatus: status, IsReplacementOrder: false, LastUpdateDate: "2026-09-28T00:00:00Z", PurchaseDate: "2026-09-27T20:00:00Z", ...extra } } } as unknown as AmazonClient;
}

function orderTable(initial: FeishuRecord[] = []) {
  const rows = [...initial];
  const upserts: Array<Record<string, unknown>> = [];
  const sent: string[][] = [];
  let failSends = 0;
  const feishu = {
    searchRecords: async () => structuredClone(rows),
    upsert: async (_app: string, _table: string, _key: unknown, fields: Record<string, unknown>, _createOnly: unknown, options: { existing?: FeishuRecord[] }) => {
      upserts.push(fields);
      const current = options.existing?.[0] ? rows.find((row) => row.record_id === options.existing![0]!.record_id) : undefined;
      if (current) Object.assign(current.fields, fields); else rows.push({ record_id: `rec-${rows.length + 1}`, fields: { ...fields } });
      return current?.record_id ?? `rec-${rows.length}`;
    },
    sendText: async (_user: string, lines: string[]) => { if (failSends > 0) { failSends -= 1; throw new Error("飞书 API 失败: internal error"); } sent.push(lines); },
  } as unknown as FeishuClient;
  return { rows, upserts, sent, feishu, failNextSends: (count: number) => { failSends = count; } };
}

test("新单通知首轮发送失败：意图已在写飞书前持久化，重试时补发且不重复；之后的校准不再发送", async () => {
  const state = new MemoryState();
  const table = orderTable();
  table.failNextSends(1);
  await assert.rejects(processOrderEvent(orderEvent("111-0000000-0000001"), orderConfig, state.asStore(), orderAmazon("Unshipped"), table.feishu, { now: Date.parse("2026-09-27T22:22:00Z") }), /internal error/);
  assert.equal(table.rows.length, 1);
  assert.equal(state.item("NOTIFICATION", "new|111-0000000-0000001")?.status, "pending");
  assert.ok(state.item("NOTIFICATION_PENDING", "new|111-0000000-0000001"));
  const retry = await processOrderEvent(orderEvent("111-0000000-0000001"), orderConfig, state.asStore(), orderAmazon("Unshipped"), table.feishu);
  assert.deepEqual(table.sent, [["💰新订单  2 小时前", "SKU-1 x 1", "订单编号：111-0000000-0000001"]], "重试补发首轮持久化的文案，不按重试时刻重算下单距今");
  assert.deepEqual(retry.notifications, { new: "sent" });
  assert.equal(retry.written, 0, "飞书行与现值一致时跳过写入");
  assert.equal(state.item("NOTIFICATION", "new|111-0000000-0000001")?.status, "done");
  await processOrderEvent(orderEvent("111-0000000-0000001", { suppressNotifications: true }), orderConfig, state.asStore(), orderAmazon("Unshipped"), table.feishu);
  assert.equal(table.sent.length, 1);
});

test("suppressNotifications 只抑制新意图，仍补发既有未完成意图；超过 48 小时的旧意图不在订单处理中发送", async () => {
  const created = new Date(Date.now() - HOUR).toISOString();
  const state = new MemoryState([
    { pk: "NOTIFICATION_PENDING", sk: "cancel|111-0000000-0000002", createdAt: created },
    { pk: "NOTIFICATION", sk: "cancel|111-0000000-0000002", status: "pending", lines: ["❌ 订单取消", "SKU-1 x 1", "订单编号：111-0000000-0000002"], recipients: ["u1"], delivered: {}, createdAt: created },
    { pk: "NOTIFICATION", sk: "new|111-0000000-0000003", status: "pending", lines: ["💰新订单"], recipients: ["u1"], delivered: {}, updatedAt: "2026-09-23T13:34:00.000Z" },
  ]);
  const cancelled = orderTable([{ record_id: "rec-1", fields: { "订单编号": "111-0000000-0000002", SKU: "SKU-1", "订单状态": "已取消" } }]);
  const result = await processOrderEvent(orderEvent("111-0000000-0000002", { suppressNotifications: true }), orderConfig, state.asStore(), orderAmazon("Canceled"), cancelled.feishu);
  assert.deepEqual(cancelled.sent, [["❌ 订单取消", "SKU-1 x 1", "订单编号：111-0000000-0000002"]]);
  assert.deepEqual(result.notifications, { cancel: "sent" });
  const stale = orderTable([{ record_id: "rec-1", fields: { "订单编号": "111-0000000-0000003", SKU: "SKU-1", "订单状态": "未发货" } }]);
  const staleResult = await processOrderEvent(orderEvent("111-0000000-0000003", { suppressNotifications: true }), orderConfig, state.asStore(), orderAmazon("Unshipped"), stale.feishu);
  assert.deepEqual(stale.sent, []);
  assert.deepEqual(staleResult.notifications, { new: "stale" });
  assert.equal(state.item("NOTIFICATION", "new|111-0000000-0000003")?.status, "pending", "陈旧意图留给维护任务标记过期");
});

test("取消意图在写飞书前持久化：飞书写入失败后重试仍发送取消通知", async () => {
  const state = new MemoryState();
  const table = orderTable([{ record_id: "rec-1", fields: { "订单编号": "111-0000000-0000004", SKU: "SKU-1", "订单状态": "未发货", "付款金额": 10, "金额币种": "USD" } }]);
  const failing = { ...table.feishu, upsert: async () => { throw new Error("飞书 API 失败: write conflict"); } } as unknown as FeishuClient;
  await assert.rejects(processOrderEvent(orderEvent("111-0000000-0000004"), orderConfig, state.asStore(), orderAmazon("Canceled"), failing), /write conflict/);
  assert.equal(state.item("NOTIFICATION", "cancel|111-0000000-0000004")?.status, "pending");
  await processOrderEvent(orderEvent("111-0000000-0000004"), orderConfig, state.asStore(), orderAmazon("Canceled"), table.feishu);
  assert.equal(table.sent.length, 1);
  assert.equal(table.sent[0]![0], "❌ 订单取消");
  assert.ok(table.sent[0]!.includes("金额：$10"));
  assert.equal(table.rows[0]!.fields["订单状态"], "已取消");
});

test("订单事件 busy 时函数内每 3 秒重试认领，约 20 秒仍忙才交回 SQS", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const held = { leaseExpiresAt: Date.now() + 60_000 };
  const state = { claimEvent: async () => (++calls < 3 ? { status: "busy", item: held } : { status: "claimed" }) } as unknown as StateStore;
  const event = orderEvent("111-0000000-0000005");
  const claimed = await claimOrderEvent(state, event, "owner", { sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(claimed.status, "claimed");
  assert.deepEqual(sleeps, [3_000, 3_000]);
  sleeps.length = 0;
  const alwaysBusy = { claimEvent: async () => ({ status: "busy", item: held }) } as unknown as StateStore;
  assert.equal((await claimOrderEvent(alwaysBusy, event, "owner", { sleep: async (ms) => { sleeps.push(ms); } })).status, "busy");
  assert.equal(sleeps.reduce((sum, ms) => sum + ms, 0), 18_000);
  sleeps.length = 0;
  const versionConflict = { claimEvent: async () => ({ status: "busy", item: { stage: "failed", version: 9 } }) } as unknown as StateStore;
  assert.equal((await claimOrderEvent(versionConflict, event, "owner", { sleep: async (ms) => { sleeps.push(ms); } })).status, "busy");
  assert.deepEqual(sleeps, [], "没有活动租约的 busy 不等待");
});
