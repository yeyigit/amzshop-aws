import assert from "node:assert/strict";
import test from "node:test";
import { runMaintenance, WATCHDOG_MAX_ATTEMPTS } from "../../src/business/maintenance.js";
import { busyRetryAt, healthTaskType } from "../../src/handlers/jobs.js";
import { sha256 } from "../../src/util.js";
import type { AppConfig, JobEvent } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { MemoryState } from "./memory-state.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-29T10:05:00.000Z");
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const EVENT: JobEvent = { taskType: "maintenance", scheduledAt: at(0) };

function harness(state: MemoryState) {
  const sent: Array<{ user: string; lines: string[] }> = [];
  const schedules: Array<{ event: JobEvent; when: Date }> = [];
  const emails: Array<{ subject: string; message: string }> = [];
  const feishu = { sendText: async (user: string, lines: string[]) => { sent.push({ user, lines }); } } as unknown as FeishuClient;
  const run = (now = NOW) => runMaintenance(EVENT, {} as AppConfig, state.asStore(), {} as AmazonClient, feishu, {
    now: () => now,
    schedule: async (event, when) => { schedules.push({ event, when }); return "schedule"; },
    publish: async (_topic, subject, message) => { emails.push({ subject, message }); },
    topicArn: "arn:aws:sns:us-east-1:000000000000:amzshop-prod-alerts",
  });
  return { sent, schedules, emails, run };
}

const pending = (eventKey: string, createdAt: string, delivered: Record<string, string> = {}) => [
  { pk: "NOTIFICATION_PENDING", sk: eventKey, createdAt },
  { pk: "NOTIFICATION", sk: eventKey, status: "pending", lines: [`通知 ${eventKey}`], recipients: ["u1", "u2"], delivered, createdAt, updatedAt: createdAt },
];

test("维护任务补发：满 10 分钟逐接收人补发，未满 10 分钟不动，超过 48 小时过期不发，孤儿指针清理", async () => {
  const state = new MemoryState([
    ...pending("new|young", at(-5 * 60_000)),
    ...pending("new|resend", at(-30 * 60_000), { u1: at(-29 * 60_000) }),
    ...pending("cancel|stale", at(-50 * HOUR)),
    { pk: "NOTIFICATION_PENDING", sk: "new|done", createdAt: at(-HOUR) },
    { pk: "NOTIFICATION", sk: "new|done", status: "done", lines: ["x"], recipients: ["u1"], delivered: { u1: at(-HOUR) } },
    { pk: "NOTIFICATION_PENDING", sk: "new|missing", createdAt: at(-HOUR) },
  ]);
  const h = harness(state);
  const result = await h.run();
  assert.deepEqual(h.sent, [{ user: "u2", lines: ["通知 new|resend"] }]);
  assert.equal(state.item("NOTIFICATION", "new|resend")?.status, "done");
  assert.equal(state.item("NOTIFICATION_PENDING", "new|resend"), undefined);
  assert.equal(state.item("NOTIFICATION", "new|young")?.status, "pending");
  assert.ok(state.item("NOTIFICATION_PENDING", "new|young"));
  assert.equal(state.item("NOTIFICATION", "cancel|stale")?.status, "expired");
  assert.equal(state.item("NOTIFICATION_PENDING", "cancel|stale"), undefined);
  assert.equal(state.item("NOTIFICATION_PENDING", "new|done"), undefined);
  assert.equal(state.item("NOTIFICATION_PENDING", "new|missing"), undefined);
  assert.equal(result.resent, 1);
  assert.equal(h.emails.length, 1);
  assert.match(h.emails[0]!.message, /cancel\|stale 超过 48 小时未送达/);
});

test("指针上线前遗留的 9/23 待发新单通知被过期而不是补发，清理干净后不再每日整分区扫描", async () => {
  const legacy = (order: string) => ({ pk: "NOTIFICATION", sk: `new|${order}`, status: "pending", lines: ["💰新订单", "SKU x 1", `订单编号：${order}`], recipients: ["u1"], delivered: {}, updatedAt: "2026-09-23T13:34:00.000Z" });
  const state = new MemoryState([legacy("111-0000000-0000001"), legacy("111-0000000-0000002"), { pk: "NOTIFICATION", sk: "new|old-done", status: "done" }]);
  const h = harness(state);
  const first = await h.run();
  assert.deepEqual(h.sent, []);
  assert.equal(state.item("NOTIFICATION", "new|111-0000000-0000001")?.status, "expired");
  assert.equal(state.item("NOTIFICATION", "new|111-0000000-0000002")?.status, "expired");
  assert.equal(first.expiredNotifications, 2);
  assert.match(h.emails[0]!.message, /new\|111-0000000-0000001 超过 48 小时未送达/);
  assert.equal(state.item("MAINTENANCE", "state")?.legacyClearedAt, undefined);
  await h.run(NOW + HOUR);
  assert.equal(state.item("MAINTENANCE", "state")?.legacySweptAt, at(0), "24 小时内不重复整分区扫描");
  await h.run(NOW + 25 * HOUR);
  assert.equal(state.item("MAINTENANCE", "state")?.legacyClearedAt, at(25 * HOUR));
});

test("孤儿任务按原身份重排并记 watchdogAt，1 小时内不重复；运行中、已排续跑、dryRun 与唤醒任务不动；连续无进展 3 次后只告警", async () => {
  const idle = at(-2 * HOUR);
  const state = new MemoryState([
    { pk: "TASK#finance", sk: "finance|2026-09-28T00:30:00Z", status: "active", state: {}, updatedAt: idle, nextAt: idle },
    { pk: "TASK#finance", sk: "finance-wake|TRANSACTION#abc", status: "scheduled", state: {}, updatedAt: idle, nextAt: idle },
    { pk: "TASK#finance", sk: "finance|2026-09-27T00:30:00Z", status: "done", state: {}, updatedAt: idle, expiresAt: Math.floor(NOW / 1000) + 86_400 },
    { pk: "TASK#finance", sk: "finance|2026-09-26|legacy", status: "waiting_release", state: {}, updatedAt: idle, nextAt: at(20 * HOUR) },
    { pk: "TASK#ads-reports", sk: "ads-daily|2026-09-29T02:00:00Z", status: "waiting_report", state: { mode: "DAILY" }, updatedAt: idle },
    { pk: "TASK#ads-reports", sk: "ads-early|2026-09-29T08:00:00Z", status: "waiting_report", state: { mode: "EARLY" }, updatedAt: idle },
    { pk: `EVENT#job#ads-early`, sk: sha256("ads-early|2026-09-29T08:00:00Z"), stage: "waiting", updatedAt: idle, result: { status: "waiting_external", nextAt: at(12 * HOUR) } },
    { pk: "TASK#review", sk: "review|2026-09-29T17:00:00.000Z", status: "active", state: { dryRun: false, scheduledAt: "2026-09-29T17:00:00Z" }, updatedAt: idle },
    { pk: "TASK#review", sk: "review|2026-09-28T01:00:00.000Z", status: "active", state: { dryRun: true }, updatedAt: idle },
    { pk: "TASK#review", sk: "review|2026-09-14T17:00:00.000Z", status: "active", state: {}, updatedAt: idle },
    { pk: "TASK#review", sk: "review|2026-10-14T17:00:00.000Z", status: "active", state: { dryRun: false }, updatedAt: idle },
    { pk: `EVENT#job#review`, sk: sha256("review|2026-10-14T17:00:00.000Z"), stage: "processing", leaseExpiresAt: NOW + 12 * HOUR, updatedAt: at(-10 * 60_000) },
  ]);
  const h = harness(state);
  const first = await h.run();
  assert.deepEqual(h.schedules.map((item) => item.event), [
    { taskType: "finance", taskId: "finance|2026-09-28T00:30:00Z" },
    { taskType: "ads-continue", taskId: "ads-daily|2026-09-29T02:00:00Z", cursor: { mode: "DAILY" } },
    { taskType: "review", taskId: "review|2026-09-29T17:00:00.000Z", scheduledAt: "2026-09-29T17:00:00Z" },
  ]);
  assert.ok(h.schedules.every((item) => item.when.getTime() === NOW + 60_000));
  assert.equal(first.revived, 3);
  assert.equal(state.item("WATCHDOG", "finance|finance|2026-09-28T00:30:00Z")?.watchdogAt, at(0));
  assert.equal(state.item("WATCHDOG", "finance|finance|2026-09-28T00:30:00Z")?.attempts, 1);
  await h.run(NOW + 30 * 60_000);
  assert.equal(h.schedules.length, 3, "1 小时内不重复重排");
  for (let run = 1; run < WATCHDOG_MAX_ATTEMPTS; run += 1) await h.run(NOW + run * 2 * HOUR);
  assert.equal(h.schedules.filter((item) => item.event.taskId === "finance|2026-09-28T00:30:00Z").length, WATCHDOG_MAX_ATTEMPTS);
  const exhausted = await h.run(NOW + 8 * HOUR);
  assert.equal(exhausted.exhausted, 3);
  assert.equal(h.schedules.filter((item) => item.event.taskId === "finance|2026-09-28T00:30:00Z").length, WATCHDOG_MAX_ATTEMPTS);
  assert.match(h.emails.at(-1)!.message, /已自动重排 3 次仍无进展/);
});

test("健康检查按最近成功时间判断，首次运行以基线起算不误报；同一问题 12 小时内只发一封邮件", async () => {
  const state = new MemoryState([
    { pk: "HEALTH", sk: "shipment", lastStatus: "done", lastSuccessAt: at(-30 * HOUR) },
    { pk: "HEALTH", sk: "pricing", lastStatus: "done", lastSuccessAt: at(-HOUR) },
  ]);
  const h = harness(state);
  const first = await h.run();
  assert.equal(first.freshIssues, 1);
  assert.equal(h.emails.length, 1);
  assert.equal(h.emails[0]!.subject, "AMZShop maintenance: 1 issue(s)");
  assert.match(h.emails[0]!.message, /shipment 已 30\.0 小时没有成功运行/);
  await h.run(NOW + HOUR);
  assert.equal(h.emails.length, 1, "12 小时内同一问题不重复发");
  const later = await h.run(NOW + 27 * HOUR);
  assert.equal(h.emails.length, 2);
  assert.match(h.emails[1]!.message, /shipment 已 57\.0 小时没有成功运行/);
  assert.match(h.emails[1]!.message, /finance 自 2026-09-29T10:05:00.000Z 起从未成功运行/);
  assert.match(h.emails[1]!.message, /pricing 已 28\.0 小时没有成功运行/);
  assert.doesNotMatch(h.emails[1]!.message, /review/, "邀评 16 天阈值内不告警");
  assert.equal(later.emailed, true);
});

test("未配置 ALERT_TOPIC_ARN 时不发邮件也不标记已报告；SNS 失败时抛错交给异步重试", async () => {
  const state = new MemoryState([{ pk: "HEALTH", sk: "shipment", lastSuccessAt: at(-30 * HOUR) }]);
  const feishu = {} as FeishuClient;
  const missing = await runMaintenance(EVENT, {} as AppConfig, state.asStore(), {} as AmazonClient, feishu, { now: () => NOW, topicArn: "" });
  assert.equal(missing.alertTopicMissing, true);
  assert.deepEqual(state.item("MAINTENANCE", "state")?.alerts, {});
  await assert.rejects(runMaintenance(EVENT, {} as AppConfig, state.asStore(), {} as AmazonClient, feishu, { now: () => NOW, topicArn: "arn:aws:sns:us-east-1:000000000000:t", publish: async () => { throw new Error("SNS down"); } }), /SNS down/);
});

test("健康记录命名：ads-continue 按模式、Finance 唤醒单列、旧链终止与 dryRun 不记", () => {
  assert.equal(healthTaskType({ taskType: "ads-continue", cursor: { mode: "EARLY" } }, "ads-early|x", { status: "done" }), "ads-early");
  assert.equal(healthTaskType({ taskType: "ads-continue", cursor: { mode: "DAILY" } }, "ads-daily|x", { status: "done" }), "ads-daily");
  assert.equal(healthTaskType({ taskType: "finance" }, "finance-wake|TRANSACTION#1", { status: "done" }), "finance-wake");
  assert.equal(healthTaskType({ taskType: "finance" }, "finance|2026-09-29T00:30:00Z", { status: "done" }), "finance");
  assert.equal(healthTaskType({ taskType: "finance" }, "finance|2026-09-26|", { status: "done", superseded: true }), undefined);
  assert.equal(healthTaskType({ taskType: "review", dryRun: true }, "review|x", { status: "done" }), undefined);
  assert.equal(healthTaskType({ taskType: "shipment" }, "shipment|x", { status: "done" }), "shipment");
});

test("busy 仅在持有者已超过 Lambda 最长运行时间时于租约到期后补排，正常并发 busy 不补排", () => {
  const now = Date.parse("2026-09-29T10:00:00.000Z");
  assert.equal(busyRetryAt({ status: "busy", item: { updatedAt: new Date(now - 60_000).toISOString(), leaseExpiresAt: now + 900_000 } }, now), undefined);
  assert.equal(busyRetryAt({ status: "busy", item: { updatedAt: new Date(now - 930_000).toISOString(), leaseExpiresAt: now + 30_000 } }, now)?.toISOString(), new Date(now + 60_000).toISOString());
  assert.equal(busyRetryAt({ status: "busy", item: { updatedAt: new Date(now - 930_000).toISOString(), leaseExpiresAt: now - 1 } }, now), undefined);
  assert.equal(busyRetryAt({ status: "busy" }, now), undefined);
});
