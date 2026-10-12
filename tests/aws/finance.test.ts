import assert from "node:assert/strict";
import test from "node:test";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { parseOrderEvent, transactionUpdateFacts } from "../../src/business/events.js";
import { financeRunMode, refundFacts, refundNotifyAfter, runFinance, updateRefunds, updateShipmentFinance, REFUND_NOTIFY_CUTOVER } from "../../src/business/finance.js";
import { runJob } from "../../src/business/jobs.js";
import { financeWakeTaskId, scheduleFinanceWake } from "../../src/business/orders.js";
import { shouldDeferFinanceRateLimit } from "../../src/handlers/jobs.js";
import { HttpError } from "../../src/http.js";
import { StateStore } from "../../src/state.js";
import { amazonLocalTime, canonicalHash, feishuFieldText, sha256 } from "../../src/util.js";
import type { AppConfig, JobEvent } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";

type Item = Record<string, unknown>;
interface Call { path: string; query: Record<string, unknown>; pace?: { key: string; minIntervalMs: number } }
interface Row { record_id: string; table: string; fields: Record<string, unknown> }

const ORDERS = "FEISHU_BITABLE_TABLE_ID_ORDERS";
const ORDER = "111-2222222-3333333";
const config = { get: (key: string) => key, optional: (key: string, fallback = "") => key === "FEISHU_NOTIFY_USER_IDS" ? "u1" : fallback } as unknown as AppConfig;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const reversed = (value: unknown): unknown => Array.isArray(value) ? value.map(reversed)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)])) : value;

// Real StateStore over an in-memory table. Like production DynamoDB, reads do not preserve the map key order that was written.
function memoryState(initial: Item[] = []) {
  const items = new Map<string, Item>();
  const id = (pk: unknown, sk: unknown): string => `${String(pk)}\u0000${String(sk)}`;
  for (const item of initial) items.set(id(item.pk, item.sk), clone(item));
  const log: string[] = [];
  const read = (item: Item): Item => reversed(clone(item)) as Item;
  const db = { send: async (command: unknown) => {
    if (command instanceof GetCommand) {
      const key = command.input.Key as Item;
      log.push(`get ${String(key.pk)}|${String(key.sk)}`);
      const item = items.get(id(key.pk, key.sk));
      return { Item: item ? read(item) : undefined };
    }
    if (command instanceof PutCommand) {
      const item = clone(command.input.Item as Item);
      if (command.input.ConditionExpression && items.has(id(item.pk, item.sk))) throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
      log.push(`put ${String(item.pk)}|${String(item.sk)}`);
      items.set(id(item.pk, item.sk), item);
      return {};
    }
    if (command instanceof DeleteCommand) {
      const key = command.input.Key as Item;
      log.push(`delete ${String(key.pk)}|${String(key.sk)}`);
      items.delete(id(key.pk, key.sk));
      return {};
    }
    if (command instanceof QueryCommand) {
      const pk = (command.input.ExpressionAttributeValues as Item)[":pk"];
      log.push(`query ${String(pk)}`);
      return { Items: [...items.values()].filter((item) => item.pk === pk).sort((a, b) => String(a.sk) < String(b.sk) ? -1 : 1).map(read) };
    }
    if (command instanceof UpdateCommand) {
      const key = command.input.Key as Item;
      log.push(`update ${String(key.pk)}|${String(key.sk)}`);
      const item = items.get(id(key.pk, key.sk)) ?? { pk: key.pk, sk: key.sk };
      const names = (command.input.ExpressionAttributeNames ?? {}) as Record<string, string>;
      const values = (command.input.ExpressionAttributeValues ?? {}) as Item;
      for (const assignment of String(command.input.UpdateExpression).replace(/^SET\s+/, "").split(/\s+(?:REMOVE|ADD)\s+/)[0]!.split(",")) {
        const [path, token] = assignment.split("=").map((part) => part.trim());
        const parts = path!.split(".").map((part) => names[part] ?? part);
        let target = item;
        for (const part of parts.slice(0, -1)) target = (target[part] ??= {}) as Item;
        target[parts.at(-1)!] = values[token!];
      }
      items.set(id(key.pk, key.sk), item);
      return {};
    }
    throw new Error("未预期的 DynamoDB 命令。");
  } } as unknown as DynamoDBDocumentClient;
  return { state: new StateStore("finance-test", db), items, log, item: (pk: string, sk: string): Item | undefined => items.get(id(pk, sk)) };
}

function memoryFeishu(rows: Row[] = []) {
  const writes: Array<{ table: string; recordId: string; fields: Record<string, unknown> }> = [];
  const upserts: Array<{ table: string; key: Record<string, string>; fields: Record<string, unknown> }> = [];
  const sent: string[][] = [];
  const feishu = {
    searchRecords: async (_app: string, table: string, filter: Record<string, string>) => rows
      .filter((row) => row.table === table && Object.entries(filter).every(([field, value]) => feishuFieldText(row.fields[field]) === value))
      .map((row) => ({ record_id: row.record_id, fields: { ...row.fields } })),
    update: async (_app: string, table: string, recordId: string, fields: Record<string, unknown>) => {
      writes.push({ table, recordId, fields });
      const row = rows.find((item) => item.record_id === recordId);
      if (row) Object.assign(row.fields, fields);
    },
    upsert: async (_app: string, table: string, key: Record<string, string>, fields: Record<string, unknown>) => { upserts.push({ table, key, fields }); return `rec-${upserts.length}`; },
    sendText: async (_user: string, lines: string[]) => { sent.push(lines); },
  } as unknown as FeishuClient;
  return { feishu, rows, writes, upserts, sent };
}

function fakeAmazon(respond: (call: Call) => unknown) {
  const calls: Call[] = [];
  const amazon = { sp: async (path: string, init: { query?: Record<string, unknown>; pace?: Call["pace"] } = {}) => {
    const call: Call = { path, query: init.query ?? {}, ...(init.pace ? { pace: init.pace } : {}) };
    calls.push(call);
    return respond(call);
  } } as unknown as AmazonClient;
  return { amazon, calls };
}

function scheduler() {
  const scheduled: Array<{ event: JobEvent; when: string }> = [];
  return { scheduled, schedule: async (event: JobEvent, when: Date): Promise<string> => { scheduled.push({ event, when: when.toISOString() }); return `schedule-${scheduled.length}`; } };
}

const orderIds = (orderId: string): Item[] => [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: orderId }];
function tx(transactionId: string, overrides: Item = {}): Item {
  return {
    transactionId, transactionType: "Shipment", transactionStatus: "RELEASED", postedDate: "2026-09-27T10:00:00Z", description: "Order Payment",
    totalAmount: { currencyCode: "USD", currencyAmount: 12.5 },
    sellingPartnerMetadata: { sellingPartnerId: "SELLER1", marketplaceId: "ATVPDKIKX0DER", accountType: "Standard Orders" },
    relatedIdentifiers: orderIds(ORDER),
    breakdowns: [{ breakdownType: "Tax", breakdownAmount: { currencyCode: "USD", currencyAmount: 1.1 } }],
    ...overrides,
  };
}
const ledgerTx = (transactionId: string, postedDate: string): Item => tx(transactionId, { transactionType: "ServiceFee", description: "Subscription", postedDate, relatedIdentifiers: [], totalAmount: { currencyCode: "USD", currencyAmount: -39.99 } });
const keyOf = (transaction: Item): string => `SELLER1|ATVPDKIKX0DER|${String(transaction.transactionId)}`;
const inWindow = (transactions: Item[], query: Record<string, unknown>): Item[] => transactions.filter((item) => {
  const posted = Date.parse(String(item.postedDate));
  return posted >= Date.parse(String(query.postedAfter)) && posted < Date.parse(String(query.postedBefore));
});

function notification(options: { id?: string; postedDate?: string; identifiers?: Array<Record<string, string>> } = {}): Item {
  return {
    NotificationVersion: "1.0", NotificationType: "TRANSACTION_UPDATE", PayloadVersion: "1.0", EventTime: "2026-09-28T08:00:05.000Z",
    Payload: { TransactionUpdateNotification: {
      SellingPartnerMetadata: { SellingPartnerId: "SELLER1", AccountType: "Standard Orders", MarketplaceId: "ATVPDKIKX0DER" },
      RelatedIdentifiers: options.identifiers ?? [{ RelatedIdentifierName: "ORDER_ID", RelatedIdentifierValue: ORDER }, { RelatedIdentifierName: "SHIPMENT_ID", RelatedIdentifierValue: "DnbbKTN3r" }],
      TotalAmount: { CurrencyAmount: 12.5, CurrencyCode: "USD" }, TransactionType: "Shipment", PostedDate: options.postedDate ?? "2026-09-28T07:59:00Z",
    } },
    NotificationMetadata: { ApplicationId: "amzn1.sp.solution.test", SubscriptionId: "sub-1", PublishTime: "2026-09-28T08:00:06.000Z", ...(options.id === "" ? {} : { NotificationId: options.id ?? "notif-1" }) },
  };
}

test("TRANSACTION_UPDATE 按真实结构解析 ORDER_ID、通知 ID 与 PostedDate，键名与标识名大小写不敏感", () => {
  const event = parseOrderEvent(JSON.stringify({ Type: "Notification", Message: JSON.stringify(notification()) }));
  assert.equal(event?.module, "finance-wake");
  assert.equal(event?.entityKey, `order#${ORDER}`);
  assert.equal(event?.eventKey, "TRANSACTION#notif-1");
  assert.equal(event?.occurredAt, "2026-09-28T07:59:00Z");
  assert.equal(event?.version, Date.parse("2026-09-28T07:59:00Z"));
  for (const [field, value] of Object.entries({ orderId: ORDER, shipmentId: "DnbbKTN3r", postedDate: "2026-09-28T07:59:00Z", transactionType: "Shipment", marketplaceId: "ATVPDKIKX0DER", notificationId: "notif-1" })) assert.equal(event?.payload[field], value, field);
  const camel = { notificationMetadata: { notificationId: "notif-9" }, payload: { transactionUpdateNotification: {
    postedDate: "2026-09-28T01:00:00Z", transactionType: "Refund", sellingPartnerMetadata: { sellingPartnerId: "SELLER1", marketplaceId: "A2EUQ1WTGCTBG2" }, totalAmount: { currencyCode: "CAD", currencyAmount: -5 },
    relatedIdentifiers: [{ relatedIdentifierName: "order_id", relatedIdentifierValue: "702-1234567-7654321" }, { relatedIdentifierName: "ShipmentId", relatedIdentifierValue: "S1" }],
  } } };
  assert.deepEqual(transactionUpdateFacts(camel), { notificationId: "notif-9", orderId: "702-1234567-7654321", shipmentId: "S1", postedDate: "2026-09-28T01:00:00Z", transactionType: "Refund", marketplaceId: "A2EUQ1WTGCTBG2", sellerId: "SELLER1", totalAmount: { currencyCode: "CAD", currencyAmount: -5 } });
  const anonymous = notification({ id: "" });
  assert.equal(parseOrderEvent(JSON.stringify(anonymous))?.eventKey, `TRANSACTION#${sha256(JSON.stringify(anonymous))}`);
  const inbound = parseOrderEvent(JSON.stringify(notification({ id: "notif-3", identifiers: [{ RelatedIdentifierName: "ORDER_ID", RelatedIdentifierValue: "FBA15ABCDEF" }, { RelatedIdentifierName: "SHIPMENT_ID", RelatedIdentifierValue: "FBA15ABCDEF" }] })));
  assert.equal(inbound?.entityKey, "finance#ATVPDKIKX0DER");
  assert.equal(inbound?.payload.orderId, "");
  assert.equal(inbound?.payload.shipmentId, "FBA15ABCDEF");
});

test("唤醒任务身份为 finance-wake|<eventKey>，条件写防重复创建，重投复用未触发的同一计划", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-28T08:00:10.000Z") });
  const event = parseOrderEvent(JSON.stringify(notification()))!;
  const taskId = financeWakeTaskId(event);
  assert.equal(taskId, "finance-wake|TRANSACTION#notif-1");
  assert.throws(() => financeWakeTaskId({ ...event, eventKey: " " }), /稳定事件身份/);
  const store = memoryState();
  const { scheduled, schedule } = scheduler();
  assert.deepEqual(await scheduleFinanceWake(event, store.state, schedule), { scheduled: true, taskId });
  const task = store.item("TASK#finance", taskId)!;
  assert.equal(task.status, "scheduled");
  assert.equal(task.nextAt, "2026-09-28T08:01:10.000Z");
  assert.deepEqual(task.state, { sourceEvent: "TRANSACTION#notif-1", occurredAt: "2026-09-28T07:59:00Z", notice: { orderId: ORDER, shipmentId: "DnbbKTN3r", postedDate: "2026-09-28T07:59:00Z", transactionType: "Shipment", marketplaceId: "ATVPDKIKX0DER", notificationId: "notif-1" } });
  assert.deepEqual(scheduled, [{ event: { taskType: "finance", taskId, scheduledAt: "2026-09-28T08:01:10.000Z" }, when: "2026-09-28T08:01:10.000Z" }]);
  t.mock.timers.tick(20_000);
  assert.deepEqual(await scheduleFinanceWake(event, store.state, schedule), { scheduled: true, taskId });
  assert.deepEqual(scheduled[1], scheduled[0]);
  assert.equal([...store.items.keys()].filter((key) => key.startsWith("TASK#finance")).length, 1);
  t.mock.timers.tick(120_000);
  await scheduleFinanceWake(event, store.state, schedule);
  assert.equal(scheduled[2]?.when, "2026-09-28T08:03:30.000Z");
  store.item("TASK#finance", taskId)!.status = "done";
  assert.deepEqual(await scheduleFinanceWake(event, store.state, schedule), { scheduled: false, taskId, status: "done" });
  assert.equal(scheduled.length, 3);
  assert.equal(financeWakeTaskId(parseOrderEvent(JSON.stringify(notification({ id: "notif-2" })))!), "finance-wake|TRANSACTION#notif-2");
  await store.state.put({ pk: "TASK#finance", sk: "finance-wake|TRANSACTION#notif-3", status: "scheduled", state: { sourceEvent: "TRANSACTION#other" } });
  await assert.rejects(scheduleFinanceWake(parseOrderEvent(JSON.stringify(notification({ id: "notif-3" })))!, store.state, schedule), /身份冲突/);
});

test("Finance 运行模式：终态不动、sourceEvent 为唤醒、旧 waiting_* 与带游标的非 active 续跑终止、旧 active 扫完、其余为每日", () => {
  const cursor = { startTime: "2026-09-19T00:30:00.000Z", endTime: "2026-09-27T04:43:00.000Z", notifyRefunds: true };
  const range = { startTime: cursor.startTime, endTime: cursor.endTime };
  assert.equal(financeRunMode({ taskType: "finance" }, undefined), "daily");
  assert.equal(financeRunMode({ taskType: "finance", cursor }, undefined), "supersede");
  assert.equal(financeRunMode({ taskType: "finance" }, { status: "waiting_detail", state: { ...range, deferred: ["k"] } }), "supersede");
  assert.equal(financeRunMode({ taskType: "finance" }, { status: "waiting_release", state: {} }), "supersede");
  assert.equal(financeRunMode({ taskType: "finance", cursor }, { status: "scheduled", state: { sourceEvent: "TRANSACTION#x", payload: {} } }), "wake");
  assert.equal(financeRunMode({ taskType: "finance" }, { status: "waiting_rate_limit", state: { sourceEvent: "TRANSACTION#x" } }), "wake");
  assert.equal(financeRunMode({ taskType: "finance", cursor }, { status: "active", state: { ...range, deferred: [] } }), "legacy");
  assert.equal(financeRunMode({ taskType: "finance" }, { status: "active", state: { ...range, mode: "daily" } }), "daily");
  for (const status of ["done", "superseded", "deferred_to_daily", "archived"]) assert.equal(financeRunMode({ taskType: "finance", cursor }, { status, state: { sourceEvent: "x" } }), "terminal", status);
});

test("旧链 waiting_* 任务与带游标的 +24h 旧续跑被标记 superseded，不扫描、不读待处理、不写断点、不再排计划", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-28T12:00:00.000Z") });
  const cursor = { startTime: "2026-09-19T00:30:00.000Z", endTime: "2026-09-27T04:43:00.000Z", notifyRefunds: true };
  const store = memoryState([
    { pk: "TASK#finance", sk: "finance|2026-09-26|", module: "finance", status: "waiting_detail", state: { ...cursor, processed: 642, deferred: ["SELLER1|ATVPDKIKX0DER|t1"], waitingDetail: ["SELLER1|ATVPDKIKX0DER|t1"] }, nextAt: "2026-09-28T04:43:00.000Z" },
    { pk: "TASK#finance", sk: "finance|2026-09-25T00:30:00Z", module: "finance", status: "waiting_detail", state: { startTime: "2026-09-17T00:27:00.000Z", endTime: "2026-09-25T00:27:00.000Z", deferred: [] } },
    { pk: "TASK#finance", sk: "gas-import", module: "finance", status: "archived", state: {} },
  ]);
  const { amazon, calls } = fakeAmazon(() => { throw new Error("旧链终止不得调用 Amazon"); });
  const { scheduled, schedule } = scheduler();
  const sheet = memoryFeishu();
  const run = (event: JobEvent) => runFinance(event, config, store.state, amazon, sheet.feishu, schedule);
  const followUp = { taskType: "finance", taskId: "finance|2026-09-26|", scheduledAt: "2026-09-28T11:59:00.000Z", cursor };
  assert.deepEqual({ ...(await run(followUp)) }, { status: "done", superseded: true, mode: "superseded", taskId: "finance|2026-09-26|", previousStatus: "waiting_detail" });
  const superseded = store.item("TASK#finance", "finance|2026-09-26|")!;
  assert.equal(superseded.status, "superseded");
  assert.equal(Number(superseded.expiresAt), Math.floor(Date.now() / 1000) + 30 * 86_400);
  assert.equal((superseded.state as Item).processed, 642);
  assert.equal(superseded.nextAt, undefined);
  assert.equal((await run({ ...followUp, scheduledAt: "2026-09-28T16:00:00.000Z" })).mode, "terminal");
  assert.equal((await run({ taskType: "finance", taskId: "finance|2026-09-25T00:30:00Z" })).superseded, true);
  assert.equal((await run({ taskType: "finance", taskId: "finance|2026-09-20|", scheduledAt: "2026-09-28T12:00:00.000Z", cursor })).superseded, true);
  assert.equal((await run({ taskType: "finance", taskId: "gas-import" })).mode, "terminal");
  assert.equal(store.item("TASK#finance", "gas-import")!.status, "archived");
  assert.equal(calls.length, 0);
  assert.equal(scheduled.length, 0);
  assert.equal(store.log.some((entry) => entry.startsWith("query ") || entry.includes("CHECKPOINT")), false);
  assert.equal(sheet.writes.length + sheet.upserts.length, 0);
});

test("仍 active 的旧任务按既有游标把窗口扫完即 done，不复查待处理、不写断点、不排 +24h", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-28T12:00:00.000Z") });
  const late = ledgerTx("L-late", "2026-09-27T08:00:00Z");
  const taskId = "finance|2026-09-24T00:30:00Z";
  const store = memoryState([
    { pk: "CHECKPOINT", sk: "finance", until: "2026-09-28T00:27:00.000Z" },
    { pk: "TASK#finance", sk: taskId, module: "finance", status: "active", state: { startTime: "2026-09-27T00:00:00.000Z", endTime: "2026-09-27T12:00:00.000Z", windowStartTime: "2026-09-27T05:59:59.000Z", windowEndTime: "2026-09-27T11:59:59.000Z", nextToken: "", pageOffset: 0, pageHash: "", pendingAfter: "SELLER1|ATVPDKIKX0DER|x", processed: 300, deferred: ["a", "b"], waitingDetail: ["a"], notifyRefunds: true } },
    { pk: "FINANCE_PENDING", sk: keyOf(tx("p")), stage: "waiting_release", destination: "order", transaction: tx("p") },
  ]);
  const { amazon, calls } = fakeAmazon(({ query }) => ({ transactions: inWindow([late], query) }));
  const { scheduled, schedule } = scheduler();
  const sheet = memoryFeishu();
  const result = await runFinance({ taskType: "finance", taskId, scheduledAt: "2026-09-28T11:59:00.000Z" }, config, store.state, amazon, sheet.feishu, schedule);
  assert.equal(result.status, "done");
  assert.equal(result.mode, "legacy");
  assert.equal(result.processed, 301);
  assert.deepEqual(calls.map((call) => [call.query.postedAfter, call.query.postedBefore]), [["2026-09-27T05:59:59.000Z", "2026-09-27T11:59:59.000Z"], ["2026-09-27T11:59:58.000Z", "2026-09-27T12:00:00.000Z"]]);
  assert.equal(sheet.upserts.length, 1);
  assert.equal(store.item("TASK#finance", taskId)!.status, "done");
  assert.equal(store.log.some((entry) => entry.startsWith("query ") || entry.includes("CHECKPOINT")), false);
  assert.equal(scheduled.length, 0);
});

test("每日任务按规范化哈希跳过键序被打乱的已完成事实，只复查到期待释放项，写断点后 done 且不排 +24h；次日重跑不重放", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-29T00:30:00.000Z") });
  const [o2, o3, o4] = ["222-2222222-2222222", "333-3333333-3333333", "444-4444444-4444444"];
  const shipped = tx("A-ship", { postedDate: "2026-09-25T10:00:00Z" });
  const fee = ledgerTx("B-fee", "2026-09-26T10:00:00Z");
  const deferred = tx("C-deferred", { transactionStatus: "DEFERRED", postedDate: "2026-09-27T10:00:00Z", relatedIdentifiers: orderIds(o2) });
  const notDue = tx("D-not-due", { transactionStatus: "DEFERRED", postedDate: "2026-09-10T10:00:00Z", relatedIdentifiers: orderIds(o3) });
  const releasing = tx("E-release", { transactionType: "Retrocharge", transactionStatus: "DEFERRED", postedDate: "2026-09-12T10:00:00Z", relatedIdentifiers: orderIds(o4) });
  const fresh = ledgerTx("N-new", "2026-09-28T10:00:00Z");
  const leftover = tx("F-leftover", { postedDate: "2026-09-11T10:00:00Z", relatedIdentifiers: orderIds(o3) });
  const inbound = tx("U-fee", { transactionType: "ServiceFee", description: "FBA inbound transportation", postedDate: "2026-09-05T10:00:00Z", relatedIdentifiers: [{ relatedIdentifierName: "SHIPMENT_ID", relatedIdentifierValue: "FBA15UNMATCHED" }], totalAmount: { currencyCode: "USD", currencyAmount: -30 } });
  const store = memoryState([
    { pk: "CHECKPOINT", sk: "finance", until: "2026-09-28T00:27:00.000Z", overlapDays: 7 },
    { pk: "FINANCE", sk: keyOf(shipped), stage: "done", destination: "order", transaction: shipped },
    { pk: "FINANCE", sk: keyOf(fee), stage: "done", destination: "ledger", transaction: fee, transactionHash: canonicalHash(fee) },
    { pk: "FINANCE", sk: keyOf(inbound), stage: "done", destination: "shipment", transaction: inbound, transactionHash: canonicalHash(inbound) },
    { pk: "FINANCE_PENDING", sk: keyOf(deferred), stage: "waiting_release", destination: "order", transaction: deferred, nextAt: "2026-09-28T00:00:00.000Z" },
    { pk: "FINANCE_PENDING", sk: keyOf(notDue), stage: "waiting_release", destination: "order", transaction: notDue, nextAt: "2026-10-03T00:00:00.000Z" },
    { pk: "FINANCE_PENDING", sk: keyOf(releasing), stage: "waiting_release", destination: "order", transaction: releasing },
    { pk: "FINANCE", sk: keyOf(leftover), stage: "done", destination: "order", transaction: leftover, transactionHash: canonicalHash(leftover) },
    { pk: "FINANCE_PENDING", sk: keyOf(leftover), stage: "pending", destination: "order", transaction: leftover },
    { pk: "SHIPMENT_FINANCE_UNMATCHED", sk: "U-fee", status: "pending", transaction: inbound },
    { pk: "SHIPMENT_FINANCE_UNMATCHED", sk: "V-old", status: "done", transaction: tx("V-old") },
  ]);
  const readBack = (await store.state.get("FINANCE", keyOf(shipped)))!.transaction;
  assert.notEqual(JSON.stringify(readBack), JSON.stringify(shipped));
  assert.equal(canonicalHash(readBack), canonicalHash(shipped));
  const byOrder: Record<string, Item[]> = { [o2]: [deferred], [o4]: [{ ...releasing, transactionStatus: "RELEASED" }] };
  const { amazon, calls } = fakeAmazon(({ path, query }) => {
    assert.equal(path, "/finances/2024-06-19/transactions");
    return { transactions: query.relatedIdentifierName === "ORDER_ID" ? byOrder[String(query.relatedIdentifierValue)] ?? [] : inWindow([shipped, fee, deferred, fresh], query) };
  });
  const sheet = memoryFeishu([{ record_id: "row-o4", table: ORDERS, fields: { "订单编号": o4, SKU: "SKU-9" } }]);
  const { scheduled, schedule } = scheduler();
  const taskId = "finance|2026-09-29T00:30:00Z";
  const result = await runFinance({ taskType: "finance", taskId, scheduledAt: "2026-09-29T00:30:00Z" }, config, store.state, amazon, sheet.feishu, schedule);
  assert.deepEqual({ ...result }, { status: "done", mode: "daily", taskId, phase: "unmatched", processed: 2, skipped: 6, deferred: 2, waitingDetail: 0, notDue: 1 });
  assert.equal(store.item("FINANCE_PENDING", keyOf(leftover)), undefined);
  const windows = calls.filter((call) => call.query.postedAfter !== undefined);
  assert.equal(windows[0]?.query.postedAfter, "2026-09-21T00:27:00.000Z");
  assert.equal(windows.at(-1)?.query.postedBefore, "2026-09-29T00:27:00.000Z");
  assert.deepEqual(calls.filter((call) => call.query.relatedIdentifierName === "ORDER_ID").map((call) => call.query.relatedIdentifierValue), [o2, o4]);
  assert.ok(calls.every((call) => call.pace?.key === "finances:listTransactions" && call.pace.minIntervalMs === 2_100));
  assert.deepEqual(sheet.upserts.map((upsert) => upsert.key), [{ "流水唯一键": keyOf(fresh) }]);
  assert.deepEqual(sheet.writes.map((write) => [write.recordId, Object.keys(write.fields)]), [], "订单路由的原始交易只存 FINANCE/，不再写订单表「资金交易明细」");
  assert.equal(store.log.some((entry) => entry === `put FINANCE|${keyOf(shipped)}` || entry === `put FINANCE|${keyOf(fee)}`), false);
  assert.equal(store.item("FINANCE", keyOf(fresh))?.transactionHash, canonicalHash(fresh));
  assert.equal((store.item("FINANCE", keyOf(releasing))?.transaction as Item).transactionStatus, "RELEASED");
  assert.equal(store.item("FINANCE_PENDING", keyOf(releasing)), undefined);
  assert.equal(store.item("FINANCE_PENDING", keyOf(deferred))?.nextAt, "2026-09-29T20:30:00.000Z");
  assert.equal(store.item("FINANCE_PENDING", keyOf(notDue))?.nextAt, "2026-10-03T00:00:00.000Z");
  assert.equal(store.item("SHIPMENT_FINANCE_UNMATCHED", "U-fee")?.status, "done");
  assert.equal(store.item("CHECKPOINT", "finance")?.until, "2026-09-29T00:27:00.000Z");
  const task = store.item("TASK#finance", taskId)!;
  assert.equal(task.status, "done");
  assert.equal(Number(task.expiresAt), Math.floor(Date.now() / 1000) + 30 * 86_400);
  assert.equal(Object.values(task.state as Item).some(Array.isArray), false);
  assert.equal(scheduled.length, 0);

  t.mock.timers.tick(24 * 3_600_000);
  const replay = await runFinance({ taskType: "finance", taskId: "finance|2026-09-30T00:30:00Z", scheduledAt: "2026-09-30T00:30:00Z" }, config, store.state, amazon, sheet.feishu, schedule);
  assert.equal(replay.status, "done");
  assert.equal(replay.processed, 0);
  assert.equal(sheet.upserts.length, 1);
  assert.equal(sheet.writes.length, 0, "次日重跑不重放、不写订单表");
  assert.equal(scheduled.length, 0);
});

test("每日任务单片 300 秒预算用尽时保存计数游标并只排 +60s 续跑，续跑从断点窗口接着扫", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-29T00:30:00.000Z") });
  const store = memoryState([{ pk: "CHECKPOINT", sk: "finance", until: "2026-09-28T00:27:00.000Z" }]);
  let slow = true;
  const { amazon, calls } = fakeAmazon(() => { if (slow) t.mock.timers.tick(100_000); return { transactions: [] }; });
  const { scheduled, schedule } = scheduler();
  const taskId = "finance|2026-09-29T00:30:00Z";
  const first = await runFinance({ taskType: "finance", taskId, scheduledAt: "2026-09-29T00:30:00Z" }, config, store.state, amazon, memoryFeishu().feishu, schedule);
  assert.equal(first.status, "active");
  assert.equal(calls.length, 3);
  const task = store.item("TASK#finance", taskId)!;
  const cursor = task.state as Item;
  assert.equal(task.status, "active");
  assert.equal(task.nextAt, "2026-09-29T00:36:00.000Z");
  assert.equal(cursor.mode, "daily");
  assert.equal(cursor.phase, "scan");
  assert.equal(cursor.windowStartTime, "2026-09-21T18:26:57.000Z");
  assert.equal(Object.values(cursor).some(Array.isArray), false);
  assert.deepEqual(scheduled, [{ event: { taskType: "finance", taskId, scheduledAt: "2026-09-29T00:36:00.000Z" }, when: "2026-09-29T00:36:00.000Z" }]);
  assert.equal(store.item("CHECKPOINT", "finance")?.until, "2026-09-28T00:27:00.000Z");
  slow = false;
  t.mock.timers.tick(60_000);
  const second = await runFinance({ taskType: "finance", taskId, scheduledAt: "2026-09-29T00:36:00.000Z" }, config, store.state, amazon, memoryFeishu().feishu, schedule);
  assert.equal(second.status, "done");
  assert.equal(calls[3]?.query.postedAfter, "2026-09-21T18:26:57.000Z");
  assert.equal(scheduled.length, 1);
  assert.equal(store.item("CHECKPOINT", "finance")?.until, "2026-09-29T00:27:00.000Z");
});

test("唤醒只按通知订单查询并逐笔应用：不扫窗口、不读待处理分区、不写断点、不续期，重复触发空转", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-28T08:00:10.000Z") });
  const store = memoryState();
  const { scheduled, schedule } = scheduler();
  const { taskId } = await scheduleFinanceWake(parseOrderEvent(JSON.stringify(notification()))!, store.state, schedule) as { taskId: string };
  const settled = tx("S-1", { postedDate: "2026-09-28T07:59:00Z" });
  const held = tx("S-2", { transactionStatus: "DEFERRED", postedDate: "2026-09-28T07:59:00Z" });
  const { amazon, calls } = fakeAmazon(({ path }) => {
    if (path === "/finances/2024-06-19/transactions") return { transactions: [settled, held] };
    if (path === `/finances/v0/orders/${ORDER}/financialEvents`) return { payload: { FinancialEvents: { ShipmentEventList: [{ ShipmentItemList: [{ SellerSKU: "SKU-1", ItemFeeList: [{ FeeType: "Commission", FeeAmount: { CurrencyAmount: -3, CurrencyCode: "USD" } }, { FeeType: "FBAPerUnitFulfillmentFee", FeeAmount: { CurrencyAmount: -4.09, CurrencyCode: "USD" } }] }] }] } } };
    throw new Error(`unexpected ${path}`);
  });
  const sheet = memoryFeishu([{ record_id: "row-1", table: ORDERS, fields: { "订单编号": ORDER, SKU: "SKU-1", "数量": 1 } }]);
  t.mock.timers.tick(60_000);
  store.log.length = 0;
  const run = { taskType: "finance", taskId, scheduledAt: scheduled[0]!.event.scheduledAt! };
  const result = await runFinance(run, config, store.state, amazon, sheet.feishu, schedule);
  assert.deepEqual({ ...result }, { status: "done", mode: "wake", taskId, orderId: ORDER, processed: 2, skipped: 0, deferred: 1, waitingDetail: 0 });
  assert.deepEqual(calls.map((call) => call.path), ["/finances/2024-06-19/transactions", `/finances/v0/orders/${ORDER}/financialEvents`]);
  assert.deepEqual(calls[0]?.query, { relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: ORDER, pageSize: 500 });
  assert.deepEqual(calls.map((call) => call.pace?.key), ["finances:listTransactions", "finances:listFinancialEventsByOrderId"]);
  assert.equal(store.log.some((entry) => entry.startsWith("query ") || entry.includes("CHECKPOINT")), false);
  assert.equal(scheduled.length, 1);
  const task = store.item("TASK#finance", taskId)!;
  assert.equal(task.status, "done");
  assert.equal(task.nextAt, undefined);
  assert.equal(Number(task.expiresAt), Math.floor(Date.now() / 1000) + 30 * 86_400);
  assert.deepEqual(sheet.writes.find((write) => "佣金" in write.fields)?.fields, { "佣金": 3, "配送费": 4.09, "促销费用": 0, "费用更新时间": "2026-09-28 00:59:00", "费用币种": "USD" });
  assert.equal(store.item("FINANCE_PENDING", keyOf(held))?.stage, "waiting_release");
  const again = await runFinance(run, config, store.state, amazon, sheet.feishu, schedule);
  assert.equal(again.mode, "terminal");
  assert.equal(calls.length, 2);
});

test("旧订单代码写的 finance|日期| 唤醒从载荷 RelatedIdentifiers 取 ORDER_ID 定向处理，随后的旧续跑空转", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-28T09:00:00.000Z") });
  const taskId = "finance|2026-09-28|";
  const settled = tx("S-done", { postedDate: "2026-09-28T07:59:00Z" });
  const store = memoryState([
    { pk: "TASK#finance", sk: taskId, module: "finance", status: "scheduled", state: { sourceEvent: "TRANSACTION#legacy", occurredAt: "2026-09-28T08:00:05.000Z", payload: { ...notification({ id: "" }), orderId: "", transactionId: "", marketplaceId: "ATVPDKIKX0DER" } }, nextAt: "2026-09-28T08:01:05.000Z" },
    { pk: "FINANCE", sk: keyOf(settled), stage: "done", destination: "order", transaction: settled, transactionHash: canonicalHash(settled) },
  ]);
  const { amazon, calls } = fakeAmazon(() => ({ transactions: [settled] }));
  const { scheduled, schedule } = scheduler();
  const sheet = memoryFeishu();
  const followUp = { taskType: "finance", taskId, scheduledAt: "2026-09-29T08:10:00.000Z", cursor: { startTime: "2026-09-21T00:00:00.000Z", endTime: "2026-09-28T08:10:00.000Z", notifyRefunds: true } };
  const woke = await runFinance(followUp, config, store.state, amazon, sheet.feishu, schedule);
  assert.equal(woke.mode, "wake");
  assert.equal(woke.orderId, ORDER);
  assert.equal(woke.skipped, 1);
  assert.deepEqual(calls.map((call) => call.query), [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: ORDER, pageSize: 500 }]);
  assert.equal(store.item("TASK#finance", taskId)?.status, "done");
  assert.equal((await runFinance({ taskType: "finance", taskId, scheduledAt: "2026-09-28T08:00:05.000Z" }, config, store.state, amazon, sheet.feishu, schedule)).mode, "terminal");
  assert.equal(calls.length, 1);
  assert.equal(scheduled.length, 0);
  assert.equal(sheet.writes.length + sheet.upserts.length, 0);
});

test("无订单号的唤醒只扫 PostedDate 前后 6 小时，且截止不晚于当前时间前 3 分钟", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-28T05:00:00.000Z") });
  const store = memoryState();
  const { scheduled, schedule } = scheduler();
  const event = parseOrderEvent(JSON.stringify(notification({ id: "notif-fba", postedDate: "2026-09-28T02:00:00Z", identifiers: [{ RelatedIdentifierName: "SHIPMENT_ID", RelatedIdentifierValue: "FBA15ABCDEF" }] })))!;
  const { taskId } = await scheduleFinanceWake(event, store.state, schedule) as { taskId: string };
  const { amazon, calls } = fakeAmazon(() => ({ transactions: [] }));
  const result = await runFinance({ taskType: "finance", taskId, scheduledAt: scheduled[0]!.event.scheduledAt! }, config, store.state, amazon, memoryFeishu().feishu, schedule);
  assert.equal(result.status, "done");
  assert.equal(result.mode, "wake");
  assert.deepEqual(calls.map((call) => [call.query.postedAfter, call.query.postedBefore]), [["2026-09-27T20:00:00.000Z", "2026-09-28T02:00:00.000Z"], ["2026-09-28T01:59:59.000Z", "2026-09-28T04:57:00.000Z"]]);
  assert.equal(calls.some((call) => call.query.relatedIdentifierName !== undefined), false);
  assert.equal(scheduled.length, 1);
  assert.equal(store.item("TASK#finance", taskId)?.status, "done");
  assert.equal(store.log.some((entry) => entry.startsWith("query ") || entry.includes("CHECKPOINT")), false);
});

test("唤醒遇 429 每 15 分钟重排自身最多 4 次，之后标记 deferred_to_daily 结束；每日任务的 429 仍交给处理器按断点延期", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-28T08:01:10.000Z") });
  const taskId = "finance-wake|TRANSACTION#n429";
  const store = memoryState([{ pk: "TASK#finance", sk: taskId, module: "finance", status: "scheduled", state: { sourceEvent: "TRANSACTION#n429", occurredAt: "2026-09-28T07:59:00Z", notice: { orderId: ORDER, postedDate: "2026-09-28T07:59:00Z" } }, nextAt: "2026-09-28T08:01:10.000Z" }]);
  const quota = (): HttpError => new HttpError(429, "QuotaExceeded", "", "HTTP 429", true);
  const { amazon, calls } = fakeAmazon(() => { throw quota(); });
  const { scheduled, schedule } = scheduler();
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await runFinance({ taskType: "finance", taskId, scheduledAt: new Date(Date.now()).toISOString() }, config, store.state, amazon, memoryFeishu().feishu, schedule);
    const task = store.item("TASK#finance", taskId)!;
    const nextAt = new Date(Date.now() + 15 * 60_000).toISOString();
    assert.equal(result.status, "waiting_rate_limit");
    assert.equal(result.retries, attempt);
    assert.equal(task.status, "waiting_rate_limit");
    assert.equal(task.nextAt, nextAt);
    assert.equal((task.state as Item).rateLimitRetries, attempt);
    assert.equal((task.state as Item).sourceEvent, "TRANSACTION#n429");
    assert.deepEqual(scheduled.at(-1), { event: { taskType: "finance", taskId, scheduledAt: nextAt }, when: nextAt });
    assert.equal(shouldDeferFinanceRateLimit({ taskType: "finance", taskId }, quota(), task), false);
    t.mock.timers.tick(15 * 60_000);
  }
  const final = await runFinance({ taskType: "finance", taskId, scheduledAt: new Date(Date.now()).toISOString() }, config, store.state, amazon, memoryFeishu().feishu, schedule);
  assert.equal(final.status, "done");
  assert.equal(final.deferredToDaily, true);
  assert.equal(final.reason, "rate_limited");
  const task = store.item("TASK#finance", taskId)!;
  assert.equal(task.status, "deferred_to_daily");
  assert.equal(Number(task.expiresAt), Math.floor(Date.now() / 1000) + 30 * 86_400);
  assert.equal(scheduled.length, 4);
  assert.equal(calls.length, 5);
  assert.equal((await runFinance({ taskType: "finance", taskId }, config, store.state, amazon, memoryFeishu().feishu, schedule)).mode, "terminal");
  const daily = { taskType: "finance", taskId: "finance|2026-09-29T00:30:00Z", scheduledAt: "2026-09-29T00:30:00Z" };
  await assert.rejects(runFinance(daily, config, store.state, amazon, memoryFeishu().feishu, schedule), (error: unknown) => error instanceof HttpError && error.status === 429);
  const saved = store.item("TASK#finance", daily.taskId)!;
  assert.equal(saved.status, "active");
  assert.equal(shouldDeferFinanceRateLimit(daily, quota(), saved), true);
  assert.equal(scheduled.length, 4);
});

test("退款通知只发 PostedDate 晚于 max(切换时刻, 72 小时前) 的退款；状态先比金额币种；退款时间为洛杉矶文本；售后原因唤醒仅首次应用时创建", async (t) => {
  assert.equal(refundNotifyAfter(Date.parse("2026-09-24T00:00:00Z")), Date.parse(REFUND_NOTIFY_CUTOVER));
  assert.equal(refundNotifyAfter(Date.parse("2026-09-30T12:00:00Z")), Date.parse("2026-09-27T12:00:00Z"));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-30T12:00:00.000Z") });
  const adjustment = (id: string, postedDate: string, amount: number): Item => ({ PostedDate: postedDate, ShipmentItemAdjustmentList: [{ OrderAdjustmentItemId: id, SellerSKU: "SKU-1", QuantityShipped: 1, ItemChargeAdjustmentList: [{ ChargeType: "Principal", ChargeAmount: { CurrencyAmount: amount, CurrencyCode: "USD" } }] }] });
  const events = { RefundEventList: [adjustment("adj-pre-cutover", "2026-09-20T10:00:00Z", -5), adjustment("adj-old", "2026-09-25T10:00:00Z", -5), adjustment("adj-new", "2026-09-29T10:00:00Z", -10)] };
  const store = memoryState();
  const sheet = memoryFeishu([{ record_id: "row-1", table: ORDERS, fields: { "订单编号": ORDER, SKU: "SKU-1", "数量": 1, "付款金额": 20, "金额币种": "USD", "下单时间": "2026-09-18 10:00:00" } }]);
  await updateRefunds(config, store.state, sheet.feishu, ORDER, refundFacts(events, ORDER), refundNotifyAfter());
  assert.deepEqual(sheet.sent, [["⚡️订单退款", "SKU-1 x 1", "金额：$10.00", "下单时间：2026-09-18 10:00:00", `订单编号：${ORDER}`]]);
  const row = sheet.rows[0]!.fields;
  assert.equal(row["退款状态"], "全额退款");
  assert.equal(row["退款时间"], "2026-09-29 03:00:00");
  assert.equal(row["退款金额"], -20);

  const refund = tx("R-1", { transactionType: "Refund", postedDate: "2026-09-29T10:00:00Z", totalAmount: { currencyCode: "USD", currencyAmount: -10 } });
  let current = refund;
  const { amazon, calls } = fakeAmazon(({ path }) => path.endsWith("/financialEvents") ? { payload: { FinancialEvents: events } } : { transactions: [current] });
  const { scheduled, schedule } = scheduler();
  const wake = async (id: string) => {
    const taskId = `finance-wake|TRANSACTION#${id}`;
    await store.state.put({ pk: "TASK#finance", sk: taskId, module: "finance", status: "scheduled", state: { sourceEvent: `TRANSACTION#${id}`, occurredAt: "2026-09-29T10:00:00Z", notice: { orderId: ORDER, postedDate: "2026-09-29T10:00:00Z" } } });
    return runFinance({ taskType: "finance", taskId }, config, store.state, amazon, sheet.feishu, schedule);
  };
  assert.equal((await wake("r1")).processed, 1);
  assert.deepEqual(scheduled.map((item) => item.event.taskId), [`refund-reason|${ORDER}|R-1`]);
  current = { ...refund, transactionStatus: "DEFERRED_RELEASED" };
  assert.equal((await wake("r2")).processed, 1);
  current = { ...current };
  assert.equal((await wake("r3")).skipped, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(sheet.sent.length, 1);
  assert.equal(calls.filter((call) => call.path.endsWith("/financialEvents")).length, 2);
});

test("清算明细就绪时佣金、配送费、促销费用都写（缺席写 0）、未就绪整行不写；missingOnly 只填空值并列出不一致；不再写弃置费", async () => {
  const item = (sku: string, fees: Array<[string, number]>, promotions: number[] = []): Item => ({
    SellerSKU: sku, ItemChargeList: [{ ChargeType: "Principal", ChargeAmount: { CurrencyAmount: 20, CurrencyCode: "USD" } }],
    ItemFeeList: fees.map(([type, amount]) => ({ FeeType: type, FeeAmount: { CurrencyAmount: amount, CurrencyCode: "USD" } })),
    PromotionList: promotions.map((amount) => ({ PromotionType: "Coupon", PromotionAmount: { CurrencyAmount: amount, CurrencyCode: "USD" } })),
  });
  const events = {
    ShipmentEventList: [{ ShipmentItemList: [item("SKU-1", [["Commission", -3], ["FBAPerUnitFulfillmentFee", -4.09]], [-1]), item("SKU-2", [["Commission", -2]]), item("SKU-3", [], [-0.5])] }],
    ServiceFeeEventList: [{ FeeList: [{ FeeType: "FBADisposalFee", FeeAmount: { CurrencyAmount: -1.53, CurrencyCode: "USD" } }] }],
  };
  const rows = (values: Item[]): Row[] => values.map((fields, index) => ({ record_id: `row-${index + 1}`, table: ORDERS, fields: { "订单编号": ORDER, ...fields } }));
  const ready = memoryFeishu(rows([{ SKU: "SKU-1" }, { SKU: "SKU-2", "佣金": 9, "配送费": 9, "促销费用": 9 }]));
  assert.equal((await updateShipmentFinance(config, ready.feishu, ORDER, events, "2026-09-27T10:00:00Z")).updatedRows, 2);
  assert.deepEqual(ready.writes.map((write) => write.fields), [
    { "佣金": 3, "配送费": 4.09, "促销费用": 1, "费用更新时间": "2026-09-27 03:00:00", "费用币种": "USD" },
    { "佣金": 2, "配送费": 0, "促销费用": 0, "费用更新时间": "2026-09-27 03:00:00", "费用币种": "USD" },
  ]);
  const notReady = memoryFeishu(rows([{ SKU: "SKU-1" }, { SKU: "SKU-3" }]));
  await assert.rejects(updateShipmentFinance(config, notReady.feishu, ORDER, events, "2026-09-27T10:00:00Z"), /财务费用明细未就绪/);
  assert.equal(notReady.writes.length, 0);
  const partial = memoryFeishu(rows([{ SKU: "SKU-1", "佣金": 3, "配送费": 5, "费用币种": "USD" }, { SKU: "SKU-2" }, { SKU: "SKU-3" }]));
  const filled = await updateShipmentFinance(config, partial.feishu, ORDER, events, "2026-09-27T10:00:00Z", true);
  assert.deepEqual(partial.writes.map((write) => write.fields), [
    { "促销费用": 1, "费用更新时间": "2026-09-27 03:00:00" },
    { "佣金": 2, "配送费": 0, "促销费用": 0, "费用更新时间": "2026-09-27 03:00:00", "费用币种": "USD" },
  ]);
  assert.equal(filled.missingDetails, 1);
  assert.deepEqual(filled.mismatches, [{ recordId: "row-1", sku: "SKU-1", field: "配送费", current: "5", expected: 4.09 }]);
  assert.equal(partial.rows[0]?.fields["配送费"], 5);
  for (const write of [...ready.writes, ...partial.writes]) assert.equal(Object.hasOwn(write.fields, "弃置费"), false);
});

test("amazonLocalTime 输出洛杉矶时区 yyyy-MM-dd HH:mm:ss，遵守夏令时，无效输入为空", () => {
  assert.equal(amazonLocalTime("2026-09-27T10:00:00Z"), "2026-09-27 03:00:00");
  assert.equal(amazonLocalTime("2026-01-15T08:00:00Z"), "2026-01-15 00:00:00");
  assert.equal(amazonLocalTime("2026-11-01T09:30:00Z"), "2026-11-01 01:30:00");
  for (const invalid of ["", "not a date", undefined, null]) assert.equal(amazonLocalTime(invalid), "");
});

test("order-finance-backfill 任务类型已删除", async () => {
  await assert.rejects(runJob({ taskType: "order-finance-backfill" }, { config, state: memoryState().state, amazon: {} as AmazonClient, feishu: {} as FeishuClient }), /未知 taskType/);
});
