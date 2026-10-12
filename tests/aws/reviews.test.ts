import assert from "node:assert/strict";
import test from "node:test";
import { isReviewAnchor, nextAnchor, reviewEligibility, reviewSummary, runReviews } from "../../src/business/reviews.js";
import { HttpError } from "../../src/http.js";
import type { AppConfig, FeishuRecord, JobEvent, JsonObject } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const DAY = 86_400_000;
const US = "ATVPDKIKX0DER";
const ANCHOR_EVENT: JobEvent = { taskType: "review", taskId: "review|2026-09-29T17:00:00.000Z", scheduledAt: "2026-09-29T17:00:00Z" };
const config = { get: (key: string) => key === "FEISHU_BITABLE_APP_TOKEN_ORDERS" ? "app" : "orders", optional: (key: string, fallback = "") => key === "FEISHU_NOTIFY_USER_IDS" ? "u1" : fallback } as unknown as AppConfig;
const order = (orderId: string, ageDays: number, extra: Row = {}): Row => ({ orderId, createdTime: new Date(Date.now() - ageDays * DAY).toISOString(), salesChannel: { marketplaceId: US }, fulfillment: { fulfilledBy: "AMAZON", fulfillmentStatus: "SHIPPED" }, ...extra });
const httpError = (status: number): HttpError => new HttpError(status, status === 429 ? "QuotaExceeded" : "Error", "", `HTTP ${status}`, status === 429 || status >= 500);

interface Scenario { pages: Row[][]; refunds?: string[]; actions?: Record<string, boolean[]>; posts?: Record<string, Array<number | Error>>; financeErrors?: Record<string, Error[]>; orderErrors?: Error[]; feishuDown?: string[]; feishuRows?: Record<string, Row>; updateError?: Error }

function harness(scenario: Scenario) {
  const log: string[] = [];
  const queries: Array<Record<string, unknown>> = [];
  const posts: string[] = [];
  const updates: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
  const sent: string[][] = [];
  const schedules: Array<{ event: JobEvent; when: Date }> = [];
  const pace: string[] = [];
  const amazon = {
    sp: async (path: string, init: { query?: Record<string, unknown>; pace?: { key: string } }) => {
      if (init.pace) pace.push(init.pace.key);
      if (path === "/orders/2026-01-01/orders") {
        log.push("searchOrders");
        queries.push(init.query ?? {});
        const error = scenario.orderErrors?.shift();
        if (error) throw error;
        const index = init.query?.paginationToken ? Number(String(init.query.paginationToken).slice(1)) : 0;
        return { orders: scenario.pages[index] ?? [], ...(index + 1 < scenario.pages.length ? { pagination: { nextToken: `p${index + 1}` } } : {}) };
      }
      if (path === "/finances/2024-06-19/transactions") {
        const orderId = String(init.query?.relatedIdentifierValue);
        log.push(`finances:${orderId}`);
        const error = scenario.financeErrors?.[orderId]?.shift();
        if (error) throw error;
        return { payload: { transactions: scenario.refunds?.includes(orderId) ? [{ transactionType: "Refund" }] : [{ transactionType: "Shipment" }] } };
      }
      const orderId = decodeURIComponent(path.split("/").at(-1) ?? "");
      log.push(`get:${orderId}`);
      const offered = scenario.actions?.[orderId]?.shift() ?? true;
      return { _links: { actions: offered ? [{ name: "productReviewAndSellerFeedback", href: `/solicitations/v1/orders/${orderId}/solicitations/productReviewAndSellerFeedback?marketplaceIds=${US}` }] : [] } };
    },
    spStatus: async (path: string, init: { method?: string; pace?: { key: string } }) => {
      assert.equal(init.method, "POST");
      if (init.pace) pace.push(init.pace.key);
      const orderId = decodeURIComponent(path.split("/")[4] ?? "");
      posts.push(orderId);
      log.push(`post:${orderId}`);
      const outcome = scenario.posts?.[orderId]?.shift() ?? 201;
      if (outcome instanceof Error) throw outcome;
      if (outcome >= 200 && outcome < 300) return outcome;
      throw httpError(outcome);
    },
  } as unknown as AmazonClient;
  const rowsOf = new Map<string, FeishuRecord>();
  const feishu = {
    searchRecords: async (_app: string, _table: string, fields: Record<string, string>) => {
      const orderId = fields["订单编号"]!;
      if (scenario.feishuDown?.includes(orderId)) throw new Error("飞书 API 失败: internal error");
      if (!rowsOf.has(orderId)) rowsOf.set(orderId, { record_id: `rec-${orderId}`, fields: { "订单编号": orderId, "已退款": "否", ...(scenario.feishuRows?.[orderId] ?? {}) } });
      return [structuredClone(rowsOf.get(orderId)!)];
    },
    update: async (_app: string, _table: string, recordId: string, fields: Record<string, unknown>) => {
      if (scenario.updateError) throw scenario.updateError;
      updates.push({ recordId, fields });
      const record = [...rowsOf.values()].find((item) => item.record_id === recordId);
      if (record) Object.assign(record.fields, fields);
    },
    sendText: async (_user: string, lines: string[]) => { sent.push(lines); },
  } as unknown as FeishuClient;
  const schedule = async (event: JobEvent, when: Date): Promise<string> => { log.push(`schedule:${event.taskId}`); schedules.push({ event, when }); return "schedule"; };
  return { amazon, feishu, schedule, log, queries, posts, updates, sent, schedules, pace };
}

test("锚点计算：9/29 17:00Z 批次的下一期为 10/14 17:00Z，手动时间不是锚点", () => {
  assert.equal(nextAnchor(new Date("2026-09-29T17:00:00Z")).toISOString(), "2026-10-14T17:00:00.000Z");
  assert.equal(isReviewAnchor("2026-09-29T17:00:00Z"), true);
  assert.equal(isReviewAnchor("2026-09-29T09:00:00Z"), false);
  assert.equal(isReviewAnchor(""), false);
});

test("Orders v2026 实际形态：Amazon 履约缺送达窗口用 createdTime 上界，商家履约缺窗口为数据不足", () => {
  const now = Date.now();
  assert.equal(reviewEligibility(order("A", 10), now).category, "candidate");
  assert.equal(reviewEligibility(order("A", 10), now).basis, "FBA_CREATED_TIME_UPPER_BOUND");
  assert.equal(reviewEligibility(order("A", 3), now).category, "outsideWindow");
  assert.equal(reviewEligibility(order("A", 21), now).category, "candidate", "20–25 天是首批不可邀订单的第二次机会");
  assert.equal(reviewEligibility(order("A", 26), now).category, "outsideWindow");
  assert.equal(reviewEligibility(order("A", 10, { fulfillment: { fulfilledBy: "MERCHANT", fulfillmentStatus: "SHIPPED", shipByWindow: { latestDateTime: new Date(now - 8 * DAY).toISOString() } } }), now).category, "dataInsufficient");
  assert.equal(reviewEligibility(order("A", 10, { fulfillment: { fulfilledBy: "MERCHANT", deliverByWindow: { latestDateTime: new Date(now - 6 * DAY).toISOString() } } }), now).category, "candidate");
  assert.equal(reviewEligibility(order("A", 10, { fulfillment: { fulfilledBy: "AMAZON", fulfillmentStatus: "CANCELLED" } }), now).category, "cancelled");
});

test("资格窗口 5–25 天宽于 15 天周期：上一批 5–10 天的订单在下一批仍在窗口内，汇总送达范围随之展示", () => {
  const anchor = Date.parse("2026-09-29T17:00:00.000Z");
  const next = anchor + 15 * DAY;
  for (const ageAtFirst of [5, 7.5, 10]) {
    const created = new Date(anchor - ageAtFirst * DAY).toISOString();
    const row = { ...order("A", 0), createdTime: created };
    assert.equal(reviewEligibility(row, anchor).category, "candidate");
    assert.equal(reviewEligibility(row, next).category, "candidate", `首批满 ${ageAtFirst} 天的订单下一批应再检查一次`);
  }
  assert.equal(reviewEligibility({ ...order("A", 0), createdTime: new Date(anchor - 10.5 * DAY).toISOString() }, next).category, "outsideWindow");
  const summary = reviewSummary({ counts: {}, sites: {}, startedAt: "2026-09-29T17:00:00.000Z", dryRun: false });
  assert.equal(summary[1], "送达范围：2026-09-05 至 2026-09-25");
});

test("正式锚点批次先建下一期计划再扫描；createdBefore 至少早于当前 2 分钟，汇总按稳定键只发一条", async () => {
  const state = new MemoryState();
  const h = harness({ pages: [[order("111-0000000-0000001", 10)]] });
  const startedAt = Date.now();
  const result = await runReviews(ANCHOR_EVENT, config, state.asStore(), h.amazon, h.feishu, h.schedule);
  assert.equal(h.log[0], "schedule:review|2026-10-14T17:00:00.000Z");
  assert.equal(h.log[1], "searchOrders");
  assert.deepEqual(h.schedules[0]?.event, { taskType: "review", taskId: "review|2026-10-14T17:00:00.000Z", scheduledAt: "2026-10-14T17:00:00.000Z" });
  assert.equal(h.schedules[0]?.when.toISOString(), "2026-10-14T17:00:00.000Z");
  const query = h.queries[0]!;
  assert.ok(Date.parse(String(query.createdBefore)) <= startedAt - 2 * 60_000, "createdBefore 必须至少早于当前 2 分钟");
  assert.ok(Math.abs(Date.parse(String(query.createdAfter)) - (startedAt - 30 * DAY)) < 60_000);
  assert.equal(query.marketplaceIds, "ATVPDKIKX0DER,A2EUQ1WTGCTBG2,A1AM78C64UM0Y8");
  assert.equal(query.includedData, "FULFILLMENT");
  assert.equal(result.status, "done");
  assert.equal(result.nextAnchor, "2026-10-14T17:00:00.000Z");
  assert.deepEqual(h.posts, ["111-0000000-0000001"]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]![0], "✅ 自动邀评汇总");
  assert.match(h.sent[0]![1]!, /^送达范围：\d{4}-\d{2}-\d{2} 至 \d{4}-\d{2}-\d{2}$/);
  assert.equal(h.sent[0]![2], "站点：US 1/1，CA 0/0，MX 0/0");
  assert.equal(h.sent[0]![3], "检查数：1；成功数：1");
  assert.equal(state.item("NOTIFICATION", "review-summary|2026-09-29T17:00:00.000Z")?.status, "done");
  assert.equal(state.item("TASK#review", ANCHOR_EVENT.taskId!)?.status, "done");
  assert.equal((state.item("TASK#review", ANCHOR_EVENT.taskId!)?.state as Row).dryRun, false);
  assert.deepEqual(new Set(h.pace), new Set(["finances:listTransactions", "solicitations-get", "solicitations-post"]));
  const replay = await runReviews(ANCHOR_EVENT, config, state.asStore(), h.amazon, h.feishu, h.schedule);
  assert.equal(replay.alreadyDone, true);
  assert.equal(h.sent.length, 1);
});

test("POST 分类：201 已发送（北京时间）、4xx 拒绝不重试、不明时重新 GET：动作消失记待核实，仍在则复核后只重试一次", async () => {
  const state = new MemoryState([
    { pk: "REVIEW", sk: "F-posting", status: "posting", taskId: "review|old", updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() },
    { pk: "REVIEW", sk: "G-unknown", status: "unknown", taskId: "review|old", updatedAt: new Date(Date.now() - DAY).toISOString() },
    { pk: "REVIEW", sk: "H-sent", status: "sent", taskId: "review|old", sentAt: "2026-09-20T01:02:03.000Z", updatedAt: "2026-09-20T01:02:03.000Z" },
  ]);
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const h = harness({
    pages: [[order("A-sent", 10), order("B-rejected", 10), order("C-timeout", 10), order("D-retry", 10), order("E-twice", 10), order("F-posting", 10), order("G-unknown", 10), order("H-sent", 10), order("I-feishu", 10), order("J-refund", 10), order("K-none", 10), order("L-cancel", 10, { fulfillment: { fulfilledBy: "AMAZON", fulfillmentStatus: "CANCELLED" } }), order("M-mfn", 10, { fulfillment: { fulfilledBy: "MERCHANT", fulfillmentStatus: "SHIPPED" } }), order("N-new", 2)]],
    posts: { "B-rejected": [400], "C-timeout": [timeout], "D-retry": [503, 201], "E-twice": [503, 500] },
    actions: { "C-timeout": [true, false], "K-none": [false] },
    refunds: ["J-refund"],
    feishuDown: ["I-feishu"],
  });
  const result = await runReviews(ANCHOR_EVENT, config, state.asStore(), h.amazon, h.feishu, h.schedule);
  assert.equal(result.status, "done");
  assert.deepEqual(h.posts, ["A-sent", "B-rejected", "C-timeout", "D-retry", "D-retry", "E-twice", "E-twice"]);
  const review = (orderId: string): Row | undefined => state.item("REVIEW", orderId);
  assert.equal(review("A-sent")?.status, "sent");
  assert.equal(review("B-rejected")?.status, "rejected");
  assert.equal(review("B-rejected")?.httpStatus, 400);
  assert.equal(review("C-timeout")?.status, "unknown");
  assert.equal(review("D-retry")?.status, "sent");
  assert.equal(review("E-twice")?.status, "unknown");
  assert.equal(review("F-posting")?.status, "posting", "残留 posting 不改 DDB、不再 POST");
  const fieldsOf = (orderId: string): Record<string, unknown> => Object.assign({}, ...h.updates.filter((item) => item.recordId === `rec-${orderId}`).map((item) => item.fields));
  assert.equal(fieldsOf("A-sent")["邀评状态"], "已发送");
  assert.match(String(fieldsOf("A-sent")["邀评时间"]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(fieldsOf("B-rejected"), {});
  assert.equal(fieldsOf("C-timeout")["邀评状态"], "结果待核实");
  assert.equal(fieldsOf("E-twice")["邀评状态"], "结果待核实");
  assert.equal(fieldsOf("F-posting")["邀评状态"], "结果待核实");
  assert.equal(fieldsOf("H-sent")["邀评状态"], "已发送");
  assert.equal(fieldsOf("H-sent")["邀评时间"], "2026-09-20 09:02:03", "DDB 已发送而飞书缺失时按北京时间补写");
  assert.equal(h.log.includes("get:J-refund"), false, "已退款订单不再查询邀评动作");
  const counts = result.counts as Record<string, number>;
  assert.deepEqual({ ...counts }, { checked: 14, success: 2, wouldSend: 0, alreadyInvited: 1, resultUnknown: 4, refunded: 1, outsideWindow: 1, cancelled: 1, amazonIneligible: 1, dataInsufficient: 1, requestFailed: 2 });
  assert.deepEqual(h.sent[0]!.slice(3), ["检查数：14；成功数：2", "已邀：1；结果待核实：4；退款：1；超窗：1", "取消：1；Amazon 判定不可邀：1；数据不足：1；请求失败：2"]);
});

test("任一只读调用 429 保存断点并 5 分钟后续跑，不抛错；POST 429 撤销 posting 后重试只发一次", async () => {
  const state = new MemoryState();
  const h = harness({ pages: [[order("A", 10), order("B", 10)]], financeErrors: { B: [httpError(429)] }, posts: { A: [429, 201] } });
  const before = Date.now();
  const first = await runReviews(ANCHOR_EVENT, config, state.asStore(), h.amazon, h.feishu, h.schedule);
  assert.equal(first.status, "waiting_rate_limit");
  assert.equal(state.item("REVIEW", "A"), undefined, "POST 429 撤销 posting 记录");
  const continuation = h.schedules.at(-1)!;
  assert.deepEqual(continuation.event, { taskType: "review", taskId: ANCHOR_EVENT.taskId, scheduledAt: ANCHOR_EVENT.scheduledAt });
  assert.ok(continuation.when.getTime() - before >= 5 * 60_000 - 1_000);
  assert.equal((state.item("TASK#review", ANCHOR_EVENT.taskId!)?.state as Row).orderIndex, 0);
  const second = await runReviews(ANCHOR_EVENT, config, state.asStore(), h.amazon, h.feishu, h.schedule);
  assert.equal(second.status, "waiting_rate_limit", "B 的 Finances 429 同样只暂停");
  assert.equal(state.item("REVIEW", "A")?.status, "sent");
  assert.equal((state.item("TASK#review", ANCHOR_EVENT.taskId!)?.state as Row).orderIndex, 1);
  const third = await runReviews(ANCHOR_EVENT, config, state.asStore(), h.amazon, h.feishu, h.schedule);
  assert.equal(third.status, "done");
  assert.deepEqual(h.posts, ["A", "A", "B"]);
  assert.equal((third.counts as Record<string, number>).success, 2);
  assert.equal((third.counts as Record<string, number>).checked, 2);
  assert.equal(h.schedules.filter((item) => item.event.taskId === "review|2026-10-14T17:00:00.000Z").length, 1, "下一期计划只在首片创建");

  const listed = harness({ pages: [[order("C", 10)]], orderErrors: [httpError(429)] });
  const paused = await runReviews({ ...ANCHOR_EVENT, taskId: "review|2026-10-14T17:00:00.000Z", scheduledAt: "2026-10-14T17:00:00.000Z" }, config, new MemoryState().asStore(), listed.amazon, listed.feishu, listed.schedule);
  assert.equal(paused.status, "waiting_rate_limit");
});

test("POST 成功后飞书回写失败：任务失败交给重试，重放按 REVIEW 记录补写且计为成功、不再 POST", async () => {
  const state = new MemoryState();
  const scenario: Scenario = { pages: [[order("A", 10)]], updateError: new Error("飞书 API 失败: internal error") };
  const h = harness(scenario);
  await assert.rejects(runReviews(ANCHOR_EVENT, config, state.asStore(), h.amazon, h.feishu, h.schedule), /internal error/);
  assert.equal(state.item("REVIEW", "A")?.status, "sent");
  delete scenario.updateError;
  const result = await runReviews(ANCHOR_EVENT, config, state.asStore(), h.amazon, h.feishu, h.schedule);
  assert.equal(result.status, "done");
  assert.deepEqual(h.posts, ["A"]);
  assert.equal((result.counts as Record<string, number>).success, 1);
  assert.equal(h.updates.at(-1)?.fields["邀评状态"], "已发送");
});

test("跨页重复订单只统计与处理一次", async () => {
  const state = new MemoryState();
  const h = harness({ pages: [[order("A", 10), order("B", 3)], [order("B", 3), order("C", 30)]] });
  const result = await runReviews(ANCHOR_EVENT, config, state.asStore(), h.amazon, h.feishu, h.schedule);
  assert.equal((result.counts as Record<string, number>).checked, 3);
  assert.equal((result.counts as Record<string, number>).outsideWindow, 2);
});

test("dryRun 无任何副作用：不写 REVIEW/飞书、不 POST、不建下一期计划、不发汇总；maxCandidates 抽样提前结束", async () => {
  const state = new MemoryState([{ pk: "REVIEW", sk: "S-sent", status: "sent", taskId: "review|old", sentAt: "2026-09-20T01:02:03.000Z" }]);
  const h = harness({ pages: [[order("S-sent", 10), order("A", 10), order("B", 10), order("C", 10)]] });
  const event: JobEvent = { taskType: "review", taskId: "review-dry|probe", scheduledAt: "2026-09-29T17:00:00Z", dryRun: true, cursor: { maxCandidates: 2 } };
  const result = await runReviews(event, config, state.asStore(), h.amazon, h.feishu, h.schedule);
  assert.equal(result.status, "done");
  assert.equal(result.dryRun, true);
  assert.equal(result.truncated, true);
  assert.deepEqual(h.posts, []);
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.schedules, []);
  assert.deepEqual(state.writes.filter((item) => item.pk !== "TASK#review"), [], "只允许写入本次预演自己的进度");
  assert.deepEqual(result.wouldSendOrders, ["A"]);
  const summary = result.summary as string[];
  assert.equal(summary[0], "🔎 自动邀评只读预演");
  assert.equal(summary[3], "检查数：2；成功数：0；预演可邀：1");
  assert.equal(summary.at(-1), "按 maxCandidates=2 抽样后提前结束");
  assert.equal(h.log.includes("get:B"), false);
  const rejected = await runReviews({ taskType: "review", taskId: "review|2026-09-29T17:00:00.000Z", scheduledAt: "2026-09-29T17:00:00Z", dryRun: true }, config, new MemoryState().asStore(), h.amazon, h.feishu, h.schedule);
  assert.equal(rejected.status, "rejected", "dryRun 不得占用正式锚点 taskId");
});

test("手动真实批次不修改自动锚点计划，汇总按任务身份去重", async () => {
  const state = new MemoryState();
  const h = harness({ pages: [[]] });
  const result = await runReviews({ taskType: "review", taskId: "review|2026-10-01T03:00:00.000Z", scheduledAt: "2026-10-01T03:00:00.000Z" } as JobEvent, config, state.asStore(), h.amazon, h.feishu, h.schedule);
  assert.equal(result.status, "done");
  assert.deepEqual(h.schedules, []);
  assert.equal(state.item("NOTIFICATION", "review-summary|review|2026-10-01T03:00:00.000Z")?.status, "done");
  void (result as JsonObject);
});
