import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTraffic, runTrafficAlert, trafficSettings } from "../../src/business/traffic.js";
import { runJob } from "../../src/business/jobs.js";
import { addDaysYmd, ymdInZone } from "../../src/util.js";
import type { AppConfig, JobEvent } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import type { StateStore } from "../../src/state.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const configOf = (values: Record<string, string> = {}): AppConfig => ({ get: (key: string) => values[key] ?? key, optional: (key: string, fallback = "") => values[key] ?? (key === "FEISHU_NOTIFY_USER_IDS" ? "u1" : fallback), bool: () => true, asins: () => [{ sku: "SKU-A", asin: "B0A", competitors: [], adMarker: "" }, { sku: "SKU-B", asin: "B0B", competitors: [], adMarker: "" }] }) as unknown as AppConfig;
const D = "2026-09-28";
// days[i] 为 D 往前 i 天（i=0 即 D）的 { sessions, units }。
function series(fill: (offset: number) => { sessions: number; units: number }, length = 35): Map<string, { sessions: number; units: number }> {
  return new Map(Array.from({ length }, (_, offset) => [addDaysYmd(D, -offset), fill(offset)]));
}

test("B4 会话下降：D 及前 2 天会话合计比前 14 天日均的 3 倍低至少 35% 且基线日均≥20 才触发；基线不足记为数据不足", () => {
  const settings = trafficSettings(configOf());
  const drop = evaluateTraffic(series((offset) => ({ sessions: offset <= 2 ? 12 : 30, units: 3 })), D, settings);
  assert.equal(drop.sessions.status, "alert");
  assert.equal(drop.sessions.current, 36);
  assert.equal(drop.sessions.baseline, 90);
  const mild = evaluateTraffic(series((offset) => ({ sessions: offset <= 2 ? 20 : 30, units: 3 })), D, settings);
  assert.equal(mild.sessions.status, "ok", "降 33% 未到 35%");
  const thin = evaluateTraffic(series((offset) => ({ sessions: offset <= 2 ? 1 : 10, units: 1 })), D, settings);
  assert.equal(thin.sessions.status, "insufficient");
  const custom = evaluateTraffic(series((offset) => ({ sessions: offset <= 2 ? 20 : 30, units: 3 })), D, trafficSettings(configOf({ TRAFFIC_ALERT_SESSION_DROP: "0.3" })));
  assert.equal(custom.sessions.status, "alert", "阈值来自配置");
});

test("B4 转化下降：D 及前 6 天订购/会话比前 21 天低至少 30%（相对）且近 7 天会话≥100 才触发", () => {
  const settings = trafficSettings(configOf());
  const drop = evaluateTraffic(series((offset) => ({ sessions: 40, units: offset <= 6 ? 2 : 4 })), D, settings);
  assert.equal(drop.conversion.status, "alert");
  assert.equal(Number(drop.conversion.current.toFixed(4)), 0.05);
  assert.equal(Number(drop.conversion.baseline.toFixed(4)), 0.1);
  assert.equal(evaluateTraffic(series((offset) => ({ sessions: 40, units: offset <= 6 ? 3 : 4 })), D, settings).conversion.status, "ok", "降 25% 未到 30%");
  assert.equal(evaluateTraffic(series((offset) => ({ sessions: 10, units: offset <= 6 ? 0 : 4 })), D, settings).conversion.status, "insufficient", "近 7 天会话不足 100");
});

function kiosk(options: { rows: () => Row[]; doneAfterPolls?: number }) {
  const calls: Array<{ path: string; method?: string; body?: Row }> = [];
  let polls = 0;
  let created = 0;
  const amazon = {
    sp: async (path: string, init: { method?: string; body?: Row } = {}) => {
      calls.push({ path, ...(init.method ? { method: init.method } : {}), ...(init.body ? { body: init.body } : {}) });
      if (path === "/dataKiosk/2023-11-15/queries" && init.method === "POST") { created += 1; return { queryId: `q-${created}` }; }
      if (path.startsWith("/dataKiosk/2023-11-15/queries/")) { polls += 1; return polls > (options.doneAfterPolls ?? 0) ? { queryId: path.split("/").at(-1), processingStatus: "DONE", dataDocumentId: "doc-1" } : { processingStatus: "IN_PROGRESS" }; }
      if (path === "/dataKiosk/2023-11-15/documents/doc-1") return { documentId: "doc-1", documentUrl: "https://example.invalid/doc" };
      throw new Error(`unexpected ${path}`);
    },
    download: async () => new TextEncoder().encode(options.rows().map((row) => JSON.stringify(row)).join("\n")),
  } as unknown as AmazonClient;
  return { amazon, calls, created: () => created };
}

const jsonl = (asin: string, fill: (offset: number) => { sessions: number; units: number }, end: string): Row[] => Array.from({ length: 35 }, (_, offset) => {
  const day = addDaysYmd(end, -offset);
  const value = fill(Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000));
  return { startDate: day, endDate: day, childAsin: asin, traffic: { sessions: value.sessions, pageViews: value.sessions, buyBoxPercentage: 100, unitSessionPercentage: 0 }, sales: { unitsOrdered: value.units } };
});

test("B4 一次查询自有子 ASIN 近 35 天 CHILD/DAY；首次触发与恢复才通知，状态落库；同一状态不重复", async () => {
  const evalDay = addDaysYmd(ymdInZone(new Date(), "America/Los_Angeles"), -2);
  let dropped = true;
  const k = kiosk({ rows: () => [...jsonl("B0A", (offset) => ({ sessions: dropped && offset <= 2 ? 10 : 40, units: 4 }), evalDay), ...jsonl("B0B", () => ({ sessions: 40, units: 4 }), evalDay)] });
  const state = new MemoryState();
  const sent: string[][] = [];
  const feishu = { sendText: async (_u: string, lines: string[]) => { sent.push(lines); } } as unknown as FeishuClient;
  const deps = { sleep: async () => undefined, schedule: async () => "s" };
  const first = await runTrafficAlert({ taskType: "traffic-alert", taskId: "traffic-alert|1" }, configOf(), state.asStore(), k.amazon, feishu, deps);
  assert.equal(first.status, "done");
  const query = String((k.calls[0]!.body as Row).query);
  assert.match(query, /salesAndTrafficTrends\(asinAggregation: CHILD, dateAggregation: DAY/);
  assert.match(query, new RegExp(`startDate: "${addDaysYmd(evalDay, -34)}", endDate: "${evalDay}"`));
  assert.match(query, /asins: \["B0A","B0B"\]/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]![0], "📉 流量下降预警");
  assert.ok(sent[0]!.includes("ASIN：B0A") && sent[0]!.includes("SKU：SKU-A"));
  assert.ok(sent[0]!.some((line) => /近 3 天会话：30（基线 120，前 14 天日均 40\.0）/.test(line)));
  assert.equal(state.item("TRAFFIC", "B0A|sessions")?.status, "alert");
  assert.equal(state.item("TRAFFIC", "B0B|sessions")?.status, "ok");
  await runTrafficAlert({ taskType: "traffic-alert", taskId: "traffic-alert|2" }, configOf(), state.asStore(), k.amazon, feishu, deps);
  assert.equal(sent.length, 1, "持续触发不重复通知");
  dropped = false;
  await runTrafficAlert({ taskType: "traffic-alert", taskId: "traffic-alert|3" }, configOf(), state.asStore(), k.amazon, feishu, deps);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]![0], "✅ 流量恢复");
  assert.equal(state.item("TRAFFIC", "B0A|sessions")?.status, "ok");
});

test("B4 查询未在本次运行内完成：保存断点并用一次性计划续跑，续跑轮询同一查询不重建", async () => {
  const evalDay = addDaysYmd(ymdInZone(new Date(), "America/Los_Angeles"), -2);
  const k = kiosk({ rows: () => jsonl("B0A", () => ({ sessions: 40, units: 4 }), evalDay), doneAfterPolls: 3 });
  const state = new MemoryState();
  const schedules: Array<{ event: JobEvent; when: Date }> = [];
  const deps = { sleep: async () => undefined, schedule: async (event: JobEvent, when: Date) => { schedules.push({ event, when }); return "s"; }, pollBudgetMs: 0 };
  const event: JobEvent = { taskType: "traffic-alert", taskId: "traffic-alert|2026-09-30T08:00:00Z", scheduledAt: "2026-09-30T08:00:00Z" };
  const first = await runTrafficAlert(event, configOf(), state.asStore(), k.amazon, {} as FeishuClient, deps);
  assert.equal(first.status, "waiting_query");
  assert.equal(state.item("TASK#traffic-alert", event.taskId!)?.status, "waiting_query");
  assert.equal((state.item("TASK#traffic-alert", event.taskId!)?.state as Row).queryId, "q-1");
  assert.deepEqual(schedules[0]?.event, { taskType: "traffic-alert", taskId: event.taskId, scheduledAt: event.scheduledAt });
  const finished = await runTrafficAlert(event, configOf(), state.asStore(), k.amazon, { sendText: async () => undefined } as unknown as FeishuClient, { ...deps, pollBudgetMs: 60_000 });
  assert.equal(finished.status, "done");
  assert.equal(k.created(), 1, "续跑不重复创建查询");
  assert.equal(state.item("TASK#traffic-alert", event.taskId!)?.status, "done");
});

test("B4 数据还没到评估日时不评估、不改状态；traffic-alert 接入任务分发", async () => {
  const evalDay = addDaysYmd(ymdInZone(new Date(), "America/Los_Angeles"), -2);
  const k = kiosk({ rows: () => jsonl("B0A", () => ({ sessions: 5, units: 0 }), addDaysYmd(evalDay, -1)) });
  const state = new MemoryState([{ pk: "TRAFFIC", sk: "B0A|sessions", status: "alert", since: "2026-09-20T08:00:00.000Z" }]);
  const result = await runJob({ taskType: "traffic-alert", taskId: "traffic-alert|x" }, { config: configOf(), state: state.asStore() as StateStore, amazon: k.amazon, feishu: {} as FeishuClient });
  assert.equal(result.status, "done");
  assert.equal(result.dataNotReady, true);
  assert.equal(state.item("TRAFFIC", "B0A|sessions")?.status, "alert");
});
