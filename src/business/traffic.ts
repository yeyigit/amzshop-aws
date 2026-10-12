import { gunzipSync } from "node:zlib";
import type { AppConfig, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { flushNotification, prepareNotification } from "../notifications.js";
import { ensureOneTimeSchedule } from "../scheduling.js";
import { log } from "../log.js";
import { addDaysYmd, ymdInZone } from "../util.js";

type Row = Record<string, unknown>;
type Daily = Map<string, { sessions: number; units: number }>;
const text = (value: unknown): string => String(value ?? "").trim();
const MARKETPLACE = "ATVPDKIKX0DER";
const QUERIES = "/dataKiosk/2023-11-15/queries";
const FILTER_ASINS = 30;
const CONTINUE_AFTER_MS = 5 * 60_000;

export interface TrafficSettings { lagDays: number; sessionDrop: number; sessionMinBaseline: number; cvrDrop: number; cvrMinSessions: number }
export interface MetricResult { status: "alert" | "ok" | "insufficient"; current: number; baseline: number; drop: number; detail: Record<string, number> }

// 阈值默认值是猜的（2026-09-30），之后按实际误报调整：全部可用 /amzshop/prod/config/TRAFFIC_ALERT_* 覆盖。
export function trafficSettings(config: AppConfig): TrafficSettings {
  const read = (key: string, fallback: number, min: number, max: number): number => {
    const raw = text(config.optional(key, String(fallback)));
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min}–${max} 之间的数字。`);
    return value;
  };
  return {
    lagDays: Math.round(read("TRAFFIC_ALERT_LAG_DAYS", 2, 1, 7)),
    sessionDrop: read("TRAFFIC_ALERT_SESSION_DROP", 0.35, 0.01, 0.99),
    sessionMinBaseline: read("TRAFFIC_ALERT_SESSION_MIN_BASELINE", 20, 0, 1_000_000),
    cvrDrop: read("TRAFFIC_ALERT_CVR_DROP", 0.3, 0.01, 0.99),
    cvrMinSessions: read("TRAFFIC_ALERT_CVR_MIN_SESSIONS", 100, 0, 1_000_000),
  };
}

function sum(daily: Daily, end: string, fromOffset: number, toOffset: number): { sessions: number; units: number } {
  let sessions = 0, units = 0;
  for (let offset = fromOffset; offset <= toOffset; offset += 1) { const day = daily.get(addDaysYmd(end, -offset)); sessions += day?.sessions ?? 0; units += day?.units ?? 0; }
  return { sessions, units };
}

// 会话：D 及前 2 天合计 vs 前 14 天日均×3；转化：D 及前 6 天订购/会话 vs 前 21 天。缺天按 0（数据集已覆盖到 D 时缺行即当天无流量）。
export function evaluateTraffic(daily: Daily, evalDay: string, settings: TrafficSettings): { sessions: MetricResult; conversion: MetricResult } {
  const recent3 = sum(daily, evalDay, 0, 2);
  const prior14 = sum(daily, evalDay, 3, 16);
  const mean = prior14.sessions / 14;
  const baseline3 = mean * 3;
  const sessionDrop = baseline3 > 0 ? 1 - recent3.sessions / baseline3 : 0;
  const sessions: MetricResult = {
    status: mean < settings.sessionMinBaseline || baseline3 <= 0 ? "insufficient" : sessionDrop >= settings.sessionDrop - 1e-9 ? "alert" : "ok",
    current: recent3.sessions, baseline: Math.round(baseline3 * 100) / 100, drop: sessionDrop, detail: { mean },
  };
  const recent7 = sum(daily, evalDay, 0, 6);
  const prior21 = sum(daily, evalDay, 7, 27);
  const current = recent7.sessions > 0 ? recent7.units / recent7.sessions : 0;
  const baseline = prior21.sessions > 0 ? prior21.units / prior21.sessions : 0;
  const cvrDrop = baseline > 0 ? 1 - current / baseline : 0;
  const conversion: MetricResult = {
    status: recent7.sessions < settings.cvrMinSessions || baseline <= 0 ? "insufficient" : cvrDrop >= settings.cvrDrop - 1e-9 ? "alert" : "ok",
    current, baseline, drop: cvrDrop, detail: { recentSessions: recent7.sessions, recentUnits: recent7.units, baseSessions: prior21.sessions, baseUnits: prior21.units },
  };
  return { sessions, conversion };
}

export function trafficQuery(asins: string[], startDate: string, endDate: string): string {
  const filters: string[] = [];
  for (let offset = 0; offset < asins.length; offset += FILTER_ASINS) filters.push(`{ marketplaceId: "${MARKETPLACE}", asins: ${JSON.stringify(asins.slice(offset, offset + FILTER_ASINS))} }`);
  return `query AmzshopTrafficAlert { analytics_salesAndTraffic_2024_04_24 { salesAndTrafficTrends(asinAggregation: CHILD, dateAggregation: DAY, startDate: "${startDate}", endDate: "${endDate}", filters: [${filters.join(", ")}]) { startDate endDate childAsin traffic { sessions pageViews buyBoxPercentage unitSessionPercentage } sales { unitsOrdered } } } }`;
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function lines(metric: "sessions" | "conversion", status: "alert" | "ok", result: MetricResult, skus: string[], asin: string, evalDay: string): string[] {
  const head = metric === "sessions" ? (status === "alert" ? "📉 流量下降预警" : "✅ 流量恢复") : (status === "alert" ? "📉 转化率下降预警" : "✅ 转化率恢复");
  const base = [head, `SKU：${skus.join("、")}`, `ASIN：${asin}`, `评估日：${evalDay}（PT）`];
  if (metric === "sessions") return [...base, `近 3 天会话：${result.current}（基线 ${Math.round(result.baseline)}，前 14 天日均 ${(result.detail.mean ?? 0).toFixed(1)}）`, `较基线：${result.drop >= 0 ? "-" : "+"}${pct(Math.abs(result.drop))}`];
  const d = result.detail;
  return [...base, `近 7 天转化：${pct(result.current)}（订购 ${d.recentUnits} / 会话 ${d.recentSessions}）`, `前 21 天转化：${pct(result.baseline)}（订购 ${d.baseUnits} / 会话 ${d.baseSessions}）`, `相对变化：${result.drop >= 0 ? "-" : "+"}${pct(Math.abs(result.drop))}`];
}

export interface TrafficDeps { sleep?: (ms: number) => Promise<void>; schedule?: typeof ensureOneTimeSchedule; pollBudgetMs?: number; pollIntervalMs?: number }

// 流量预警（每天 16:00）：一次 Data Kiosk 查询自有子 ASIN 近 35 天 salesAndTrafficTrends(CHILD, DAY)，超过 30 个 ASIN 分组；
// 查询未在本次运行内完成时保存断点（queryId）并用一次性计划续跑，续跑只轮询同一查询。只在首次触发与恢复时通知，状态存 TRAFFIC 分区，不写飞书表。
export async function runTrafficAlert(event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient, deps: TrafficDeps = {}): Promise<JsonObject> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const schedule = deps.schedule ?? ensureOneTimeSchedule;
  const taskId = event.taskId ?? `traffic-alert|${event.scheduledAt ?? new Date().toISOString()}`;
  const saved = await state.task("traffic-alert", taskId);
  if (saved?.status === "done") return { status: "done", taskId, alreadyDone: true };
  const progress = (saved?.state ?? {}) as Row;
  const settings = trafficSettings(config);
  const skusByAsin = new Map<string, string[]>();
  for (const mapping of config.asins()) if (mapping.asin) skusByAsin.set(mapping.asin, [...(skusByAsin.get(mapping.asin) ?? []), mapping.sku]);
  const asins = [...skusByAsin.keys()];
  const evalDay = text(progress.evalDay) || addDaysYmd(ymdInZone(new Date(), "America/Los_Angeles"), -settings.lagDays);
  const startDate = text(progress.startDate) || addDaysYmd(evalDay, -34);
  if (!asins.length) { await state.saveTask("traffic-alert", taskId, { evalDay, asins: 0 }, "done"); return { status: "done", taskId, asins: 0 }; }
  let queryId = text(progress.queryId);
  if (!queryId) {
    const created = await amazon.sp<JsonObject>(QUERIES, { method: "POST", body: { query: trafficQuery(asins, startDate, evalDay) } });
    queryId = text(created.queryId);
    if (!queryId) throw new Error("Data Kiosk createQuery 未返回 queryId。 ");
    await state.saveTask("traffic-alert", taskId, { evalDay, startDate, queryId, createdAt: new Date().toISOString() }, "waiting_query");
  }
  const snapshot = { evalDay, startDate, queryId, createdAt: text(progress.createdAt) || new Date().toISOString() };
  const budget = deps.pollBudgetMs ?? 8 * 60_000;
  const started = Date.now();
  let status: Row = {};
  for (;;) {
    status = await amazon.sp<JsonObject>(`${QUERIES}/${encodeURIComponent(queryId)}`);
    const processing = text(status.processingStatus).toUpperCase();
    if (["DONE", "FATAL", "CANCELLED"].includes(processing)) break;
    if (Date.now() - started >= budget) {
      const nextAt = new Date(Date.now() + CONTINUE_AFTER_MS);
      await state.saveTask("traffic-alert", taskId, { ...snapshot, lastStatus: processing }, "waiting_query", nextAt.toISOString());
      await schedule({ taskType: "traffic-alert", taskId, ...(event.scheduledAt ? { scheduledAt: event.scheduledAt } : {}) }, nextAt);
      return { status: "waiting_query", taskId, queryId, nextAt: nextAt.toISOString() };
    }
    await sleep(deps.pollIntervalMs ?? 15_000);
  }
  const processing = text(status.processingStatus).toUpperCase();
  const readDocument = async (documentId: string): Promise<string> => {
    const document = await amazon.sp<JsonObject>(`/dataKiosk/2023-11-15/documents/${encodeURIComponent(documentId)}`);
    const bytes = await amazon.download(text(document.documentUrl));
    return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString("utf8") : Buffer.from(bytes).toString("utf8");
  };
  if (processing !== "DONE") {
    const detail = text(status.errorDocumentId) ? (await readDocument(text(status.errorDocumentId))).slice(0, 300) : "";
    await state.saveTask("traffic-alert", taskId, { ...snapshot, lastStatus: processing }, "failed");
    throw new Error(`Data Kiosk 查询 ${processing}：${detail || "无错误文档"}`);
  }
  const documentId = text(status.dataDocumentId);
  const records = documentId ? (await readDocument(documentId)).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as Row) : [];
  const byAsin = new Map<string, Daily>();
  let maxDate = "";
  for (const row of records) {
    const asin = text(row.childAsin);
    const day = text(row.startDate).slice(0, 10);
    if (!asin || !day) continue;
    const daily = byAsin.get(asin) ?? new Map();
    const sessions = Number(((row.traffic ?? {}) as Row).sessions);
    const units = Number(((row.sales ?? {}) as Row).unitsOrdered);
    daily.set(day, { sessions: Number.isFinite(sessions) ? sessions : 0, units: Number.isFinite(units) ? units : 0 });
    byAsin.set(asin, daily);
    if (day > maxDate) maxDate = day;
  }
  if (!maxDate || maxDate < evalDay) {
    log("WARN", "traffic_data_not_ready", { taskId, evalDay, maxDate });
    await state.saveTask("traffic-alert", taskId, { ...snapshot, rows: records.length, maxDate, dataNotReady: true }, "done");
    return { status: "done", taskId, evalDay, dataNotReady: true, rows: records.length };
  }
  let alerts = 0, notified = 0, insufficient = 0;
  for (const asin of asins) {
    const result = evaluateTraffic(byAsin.get(asin) ?? new Map(), evalDay, settings);
    for (const metric of ["sessions", "conversion"] as const) {
      const current = result[metric];
      if (current.status === "insufficient") { insufficient += 1; continue; }
      const sk = `${asin}|${metric}`;
      const previous = await state.get("TRAFFIC", sk);
      const changed = current.status === "alert" ? previous?.status !== "alert" : previous?.status === "alert";
      const eventKey = `traffic|${asin}|${metric}|${current.status}|${text(previous?.since) || "initial"}`;
      const prepared = changed ? await prepareNotification(config, state, eventKey, lines(metric, current.status, current, skusByAsin.get(asin) ?? [], asin, evalDay)) : undefined;
      const now = new Date().toISOString();
      await state.put({ pk: "TRAFFIC", sk, status: current.status, since: changed || !previous ? now : text(previous.since) || now, evalDay, current: current.current, baseline: current.baseline, drop: Math.round(current.drop * 10_000) / 10_000, updatedAt: now });
      if (changed && (await flushNotification(state, feishu, eventKey, prepared)) === "sent") notified += 1;
      if (current.status === "alert") alerts += 1;
    }
  }
  await state.saveTask("traffic-alert", taskId, { ...snapshot, rows: records.length, maxDate, alerts, insufficient }, "done");
  return { status: "done", taskId, evalDay, asins: asins.length, rows: records.length, alerts, notified, insufficient };
}
