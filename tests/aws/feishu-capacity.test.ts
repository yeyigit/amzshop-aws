import assert from "node:assert/strict";
import test from "node:test";
import { FeishuClient, isFeishuQuotaError, takeFeishuUsage } from "../../src/clients/feishu.js";
import { HttpError } from "../../src/http.js";
import { reportFeishuUsage } from "../../src/handlers/jobs.js";
import { HEALTH_RULES, runMaintenance } from "../../src/business/maintenance.js";
import { FEISHU_QUOTA_SUBJECT, beijingDay, flushFeishuUsage } from "../../src/feishu-quota.js";
import type { AppConfig, JobEvent } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import { MemoryState } from "./memory-state.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TOPIC = "arn:aws:sns:us-east-1:000000000000:t";
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const clientConfig = { get: (key: string) => `${key}-value`, optional: (_key: string, fallback = "") => fallback } as unknown as AppConfig;
const isToken = (url: URL): boolean => url.pathname === "/open-apis/auth/v3/tenant_access_token/internal";
const quotaExceeded = (): Response => json({ code: 99991403, msg: "This month's API call quota has been exceeded" }, 429);

async function withFeishu<T>(steps: Array<() => Response>, run: (client: FeishuClient) => Promise<T>): Promise<{ result?: T; error?: unknown; apiCalls: number; tokenCalls: number; delays: number[] }> {
  const delays: number[] = [];
  let apiCalls = 0;
  let tokenCalls = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (isToken(url)) { tokenCalls += 1; return json({ code: 0, tenant_access_token: "t-1", expire: 7200 }); }
    apiCalls += 1;
    return steps[Math.min(apiCalls, steps.length) - 1]!();
  }) as typeof fetch;
  try {
    const client = new FeishuClient(clientConfig, { sleep: async (milliseconds) => { delays.push(milliseconds); } });
    try { return { result: await run(client), apiCalls, tokenCalls, delays }; }
    catch (error) { return { error, apiCalls, tokenCalls, delays }; }
  } finally { globalThis.fetch = previous; }
}

test("飞书内部错误 1255001 InternalError 按暂态重试（2026-10-06 实测偶发、重跑即成功）；无 client_token 的创建仍不重放", async () => {
  takeFeishuUsage();
  const read = await withFeishu([() => json({ code: 1255001, msg: "InternalError" }), () => json({ code: 0, data: { items: [] } })], (client) => client.listRecords("app", "tbl"));
  assert.equal(read.error, undefined);
  assert.equal(read.apiCalls, 2);
  const create = await withFeishu([() => json({ code: 1255001, msg: "InternalError" }), () => json({ code: 0, data: { record: { record_id: "r" } } })], (client) => client.request("POST", "/open-apis/bitable/v1/apps/app/tables/tbl/records", { fields: {} }));
  assert.equal(create.apiCalls, 1);
  assert.match(String((create.error as Error).message), /飞书 API 失败: InternalError/);
  takeFeishuUsage();
});

test("飞书 99991403（本月额度用尽）立即报不可重试错误、不退避；只有成功调用计入用量，认证与失败调用不计", async () => {
  takeFeishuUsage();
  const ok = await withFeishu([() => json({ code: 0, data: { items: [] } })], (client) => client.listRecords("app", "tbl"));
  assert.equal(ok.error, undefined);
  const retried = await withFeishu([() => json({ code: 1254607, msg: "Data not ready" }), () => json({ code: 0, data: { items: [] } })], (client) => client.listRecords("app", "tbl"));
  assert.equal(retried.apiCalls, 2, "数据未就绪照旧重试");
  const internal = await withFeishu([() => json({ code: 1254002, msg: "Fail" }), () => json({ code: 0, data: { items: [] } })], (client) => client.listRecords("app", "tbl"));
  assert.equal(internal.error, undefined, "飞书内部错误 1254002 按暂态重试");
  assert.equal(internal.apiCalls, 2);
  const create = await withFeishu([() => json({ code: 1254002, msg: "Fail" }), () => json({ code: 0, data: { record: { record_id: "r" } } })], (client) => client.request("POST", "/open-apis/bitable/v1/apps/app/tables/tbl/records", { fields: {} }));
  assert.equal(create.apiCalls, 1, "无 client_token 的创建仍不重放");
  assert.match(String((create.error as Error).message), /飞书 API 失败: Fail/);
  const quota = await withFeishu([quotaExceeded, () => json({ code: 0, data: { items: [] } })], (client) => client.listRecords("app", "tbl"));
  assert.equal(quota.apiCalls, 1, "额度用尽不重试");
  assert.deepEqual(quota.delays, []);
  assert.ok(quota.error instanceof HttpError);
  assert.equal(quota.error.status, 429);
  assert.equal(quota.error.code, "99991403");
  assert.equal(quota.error.retryable, false);
  assert.equal(isFeishuQuotaError(quota.error), true);
  assert.equal(isFeishuQuotaError(new HttpError(429, "99991400", "", "限频", true)), false);
  assert.match(quota.error.message, /本月调用额度已用尽/);
  const usage = takeFeishuUsage();
  assert.equal(usage.calls, 3, "3 次成功调用；失败尝试（数据未就绪、内部错误、创建失败）与认证都不计");
  assert.equal(usage.rejected, 1);
  assert.match(usage.rejectedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(takeFeishuUsage(), { calls: 0, rejected: 0 }, "取出后清零");

  const count = await withFeishu([() => json({ code: 0, data: { total: 4321, has_more: true, items: [{ record_id: "r", fields: {} }] } })], (client) => client.countRecords("app", "tbl"));
  assert.equal(count.result, 4321);
  const broken = await withFeishu([() => json({ code: 0, data: { items: [] } })], (client) => client.countRecords("app", "tbl"));
  assert.match(String((broken.error as Error).message), /未返回有效的 total/);
  takeFeishuUsage();
});

test("Jobs 结束时按北京日期、按模块落库飞书用量；见到 99991403 立即发一封额度邮件，12 小时内不重复，发送失败释放占用；落库失败计数放回", async () => {
  takeFeishuUsage();
  const state = new MemoryState();
  const emails: Array<{ subject: string; message: string }> = [];
  const publish = async (_topic: string, subject: string, message: string) => { emails.push({ subject, message }); };
  await withFeishu([() => json({ code: 0, data: { items: [] } }), quotaExceeded], async (client) => {
    await client.listRecords("app", "tbl");
    await client.listRecords("app", "tbl").catch(() => undefined);
  });
  await reportFeishuUsage(state.asStore(), "pricing", publish, TOPIC);
  const day = state.item("FEISHU_USAGE", beijingDay(Date.now()))!;
  assert.equal(day.total, 1);
  assert.equal(day.m_pricing, 1);
  assert.equal(day.rejected, 1);
  assert.ok(day.lastRejectedAt);
  assert.equal(emails.length, 1);
  assert.equal(emails[0]!.subject, FEISHU_QUOTA_SUBJECT);
  assert.match(emails[0]!.message, /错误码 99991403），由 pricing 于北京时间/);
  assert.match(emails[0]!.message, /本月系统已记录成功调用约 1 次/);
  assert.match(emails[0]!.message, /每月 1 日自动重置/);

  await withFeishu([quotaExceeded], (client) => client.listRecords("app", "tbl").catch(() => undefined));
  await reportFeishuUsage(state.asStore(), "buybox-watch", publish, TOPIC);
  assert.equal(emails.length, 1, "12 小时内不重复");
  assert.equal(state.item("FEISHU_USAGE", beijingDay(Date.now()))!.rejected, 2);

  await state.put({ pk: "ALERT", sk: "feishu-quota", emailedAt: new Date(Date.now() - 13 * HOUR).toISOString() });
  await withFeishu([quotaExceeded], (client) => client.listRecords("app", "tbl").catch(() => undefined));
  await reportFeishuUsage(state.asStore(), "pricing", async () => { throw new Error("SNS down"); }, TOPIC);
  assert.equal(state.item("ALERT", "feishu-quota"), undefined, "发送失败释放占用，下次重发");

  takeFeishuUsage();
  await withFeishu([() => json({ code: 0, data: { items: [] } })], (client) => client.listRecords("app", "tbl"));
  const failing = new MemoryState();
  failing.addFeishuUsage = async () => { throw new Error("throttled"); };
  const kept = await flushFeishuUsage(failing.asStore(), "order");
  assert.equal(kept.calls, 1);
  await flushFeishuUsage(state.asStore(), "order");
  assert.equal(state.item("FEISHU_USAGE", beijingDay(Date.now()))!.m_order, 1, "落库失败的计数下次一并落库");
});

const EVENT: JobEvent = { taskType: "maintenance" };
const configOf = (values: Record<string, string>): AppConfig => ({ get: (key: string) => values[key] ?? key, optional: (key: string, fallback = "") => values[key] ?? fallback, bool: () => false, asins: () => [] }) as unknown as AppConfig;
const healthy = (now: number) => Object.keys(HEALTH_RULES).map((sk) => ({ pk: "HEALTH", sk, lastStatus: "done", lastSuccessAt: new Date(now - HOUR).toISOString() }));

function maintenance(state: MemoryState, values: Record<string, string>, counts: Record<string, number> = {}) {
  const emails: Array<{ subject: string; message: string }> = [];
  const counted: string[] = [];
  let failNext = false;
  const feishu = {
    sendText: async () => undefined,
    listTables: async () => Object.keys(counts).map((id) => ({ table_id: id, name: `表${id}` })),
    countRecords: async (_app: string, id: string) => { counted.push(id); return counts[id]!; },
  } as unknown as FeishuClient;
  const run = async (now: number) => {
    for (const item of healthy(now)) await state.put(item);
    return runMaintenance({ ...EVENT, scheduledAt: new Date(now).toISOString() }, configOf(values), state.asStore(), {} as AmazonClient, feishu, {
      now: () => now, schedule: async () => "s", topicArn: TOPIC,
      publish: async (_topic, subject, message) => { if (failNext) { failNext = false; throw new Error("SNS down"); } emails.push({ subject, message }); },
    });
  };
  return { emails, counted, run, failOnce: () => { failNext = true; } };
}

test("维护任务每个北京日期查一次飞书各表行数：首次达 80% 报一次，达 90% 起每天报，回落后再达 80% 重新报", async () => {
  const day1 = Date.parse("2026-10-06T01:05:00.000Z");
  const counts: Record<string, number> = { A: 15_000, B: 16_500, C: 18_200 };
  const state = new MemoryState();
  const h = maintenance(state, { FEISHU_BITABLE_APP_TOKEN_ORDERS: "app" }, counts);
  await h.run(day1);
  assert.equal(h.emails.length, 1);
  assert.equal(h.emails[0]!.subject, "AMZShop maintenance: 2 issue(s)");
  assert.match(h.emails[0]!.message, /飞书表「表B」已有 16500 行，达到单表上限 20000 行的 82%，请安排归档/);
  assert.match(h.emails[0]!.message, /飞书表「表C」已有 18200 行，达到单表上限 20000 行的 91%，请尽快归档/);
  assert.doesNotMatch(h.emails[0]!.message, /表A/);
  assert.deepEqual(h.counted, ["A", "B", "C"]);
  assert.deepEqual((state.item("FEISHU_ROWS", "latest")!.tables as unknown[]).length, 3);
  assert.deepEqual(state.item("MAINTENANCE", "state")!.rowLevels, { A: 0, B: 80, C: 90 });

  await h.run(day1 + HOUR);
  assert.equal(h.counted.length, 3, "同一北京日期不重复查");
  assert.equal(h.emails.length, 1);

  await h.run(day1 + DAY);
  assert.equal(h.emails.length, 2);
  assert.match(h.emails[1]!.message, /表C/);
  assert.doesNotMatch(h.emails[1]!.message, /表B/, "80% 只报一次");

  counts.B = 15_000;
  await h.run(day1 + 2 * DAY);
  counts.B = 16_100;
  await h.run(day1 + 3 * DAY);
  assert.match(h.emails.at(-1)!.message, /表B」已有 16100 行/, "回落到 80% 以下后再达到重新报");

  const custom = new MemoryState();
  const small = maintenance(custom, { FEISHU_BITABLE_APP_TOKEN_ORDERS: "app", FEISHU_TABLE_ROW_LIMIT: "2000" }, { N: 1_700 });
  await small.run(day1);
  assert.match(small.emails[0]!.message, /已有 1700 行，达到单表上限 2000 行的 85%/);
});

test("行数提醒邮件发送失败时不记已报，下一轮重查重报", async () => {
  const day1 = Date.parse("2026-10-06T01:05:00.000Z");
  const state = new MemoryState();
  const h = maintenance(state, { FEISHU_BITABLE_APP_TOKEN_ORDERS: "app" }, { B: 16_500 });
  h.failOnce();
  await assert.rejects(h.run(day1), /SNS down/);
  assert.equal(state.item("MAINTENANCE", "state")!.rowsCheckedDay, undefined);
  assert.deepEqual(state.item("MAINTENANCE", "state")!.rowLevels, { B: 0 });
  await h.run(day1 + HOUR);
  assert.equal(h.counted.length, 2);
  assert.match(h.emails[0]!.message, /表B」已有 16500 行/);
  assert.equal(state.item("MAINTENANCE", "state")!.rowsCheckedDay, "2026-10-06");
});

test("每月 1 日（北京时间）首轮把上月飞书用量汇总进邮件且只发一次；配置月额度后本月达 80% 提醒", async () => {
  const usage = [
    { pk: "FEISHU_USAGE", sk: "2026-10-06", total: 1000, m_pricing: 400, m_order: 300, m_ams: 300 },
    { pk: "FEISHU_USAGE", sk: "2026-10-07", total: 1200, m_pricing: 500, m_order: 400, m_ams: 300 },
  ];
  const state = new MemoryState(usage);
  const h = maintenance(state, {});
  await h.run(Date.parse("2026-10-31T15:05:00.000Z"));
  assert.equal(h.emails.length, 0, "北京时间仍是 10 月，不报");
  assert.equal(state.item("MAINTENANCE", "state")!.usageReportedMonth, "2026-09", "上月无数据即记为已处理");
  await h.run(Date.parse("2026-10-31T16:05:00.000Z"));
  assert.equal(h.emails.length, 1);
  assert.equal(h.emails[0]!.subject, "AMZShop maintenance: report");
  assert.match(h.emails[0]!.message, /定期报告：/);
  assert.match(h.emails[0]!.message, /飞书 API 用量 2026-10：成功调用 2200 次（自 2026-10-06 起统计，有调用 2 天，日均 1100 次，最多 2026-10-07 1200 次）；按模块：pricing 900、order 700、ams 600；未配置月额度/);
  await h.run(Date.parse("2026-10-31T17:05:00.000Z"));
  assert.equal(h.emails.length, 1, "同月只报一次");

  const quota = new MemoryState(usage);
  const q = maintenance(quota, { FEISHU_MONTHLY_CALL_QUOTA: "2500" });
  await q.run(Date.parse("2026-10-08T02:05:00.000Z"));
  assert.equal(q.emails.length, 1);
  assert.match(q.emails[0]!.message, /飞书 API 本月（截至 2026-10-08）已成功调用 2200 次，达到月额度 2500 次的 88%/);
  const under = maintenance(new MemoryState(usage), { FEISHU_MONTHLY_CALL_QUOTA: "3000" });
  await under.run(Date.parse("2026-10-08T02:05:00.000Z"));
  assert.equal(under.emails.length, 0, "73% 不提醒");
});

test("订单/AMS 记下的额度用尽由维护任务补发邮件并与 Jobs 共用去重：Jobs 已发过则不重复，维护发过后 Jobs 12 小时内也不再发", async () => {
  const now = Date.parse("2026-10-08T02:05:00.000Z");
  const rejected = { pk: "FEISHU_USAGE", sk: "2026-10-08", total: 100, m_order: 100, rejected: 3, lastRejectedAt: new Date(now - 10 * 60_000).toISOString() };
  const state = new MemoryState([rejected]);
  const h = maintenance(state, {});
  await h.run(now);
  assert.equal(h.emails.length, 1);
  assert.match(h.emails[0]!.message, /飞书 API 本月调用额度已用尽（错误码 99991403），由 订单\/广告消息或其它任务/);
  assert.equal(state.item("ALERT", "feishu-quota")!.emailedAt, new Date(now).toISOString());
  assert.equal(await state.claimAlert("feishu-quota", now + HOUR, 12 * HOUR), false, "Jobs 12 小时内不再发");

  const jobsSent = new MemoryState([rejected, { pk: "ALERT", sk: "feishu-quota", emailedAt: new Date(now - HOUR).toISOString() }]);
  const j = maintenance(jobsSent, {});
  await j.run(now);
  assert.equal(j.emails.length, 0, "Jobs 1 小时前已发过");

  const stale = maintenance(new MemoryState([{ ...rejected, lastRejectedAt: new Date(now - 3 * HOUR).toISOString() }]), {});
  await stale.run(now);
  assert.equal(stale.emails.length, 0, "2 小时前的被拒记录不再报（额度已恢复或已报过）");
});
