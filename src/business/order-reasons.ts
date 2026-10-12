import { gunzipSync } from "node:zlib";
import type { AppConfig, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { amazonLocalTime, canonicalJson, feishuFieldText, stableKey } from "../util.js";

type Row = Record<string, unknown>;
interface ReasonEvent { eventKey: string; eventTime: string; timeBasis: string; reasonRaw: string; reasonZh: string; comment: string; type: string; source: string; orderId: string; sku: string; asin: string; scope: "sku" | "order" }
interface PendingRef { key: string; reportId: string; marketplaceId: string; rowIndex: number; eventKey: string; attempts: number; nextAt: string }
interface PendingEvent extends ReasonEvent { attempts?: number; nextAt?: string }
const text = (value: unknown): string => String(value ?? "").trim();
const retryLater = (event: ReasonEvent, attempts: number): PendingEvent => ({ ...event, attempts, nextAt: new Date(Date.now() + Math.min(7 * 86_400_000, 3_600_000 * 2 ** (attempts - 1))).toISOString() });

const translations: Record<string, string> = {
  CUSTOMER_DAMAGED: "买家损坏", DEFECTIVE: "商品有缺陷", NOT_AS_DESCRIBED: "与描述不符", WRONG_ITEM: "收到错误商品",
  UNWANTED_ITEM: "不再需要", MISORDERED_ITEM: "误购", ORDERED_WRONG_ITEM: "订错商品", MISSING_PARTS: "缺少部件",
  DAMAGED_BY_CARRIER: "承运商运输损坏", UNDELIVERABLE_UNKNOWN: "无法配送", BETTER_PRICE: "找到更低价格", NO_REASON_GIVEN: "未提供原因", NOT_COMPATIBLE: "不兼容",
};

function parseTsv(source: string): string[][] {
  const output: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "\t" && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell); cell = "";
      if (row.some(Boolean)) output.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some(Boolean)) output.push(row);
  return output;
}

function parseReturnReportRows(source: string): Array<ReasonEvent | null> {
  const table = parseTsv(source.replace(/^\uFEFF/, ""));
  if (!table.length) return [];
  const header = table[0]!.map((item) => item.trim().toLowerCase());
  const index = new Map(header.map((name, position) => [name, position]));
  for (const name of ["return-date", "order-id", "sku", "reason", "customer-comments"]) if (!index.has(name)) throw new Error(`退货报告缺少关键表头: ${name}`);
  return table.slice(1).map((row) => {
    const get = (name: string): string => String(row[index.get(name)!] ?? "").trim();
    const eventTime = new Date(get("return-date")).toISOString();
    const reasonRaw = get("reason");
    const orderId = get("order-id");
    const sku = get("sku");
    return {
      eventKey: `return|${orderId}|${sku}|${eventTime}|${reasonRaw}`,
      eventTime,
      timeBasis: "退货入仓时间",
      reasonRaw,
      reasonZh: translations[reasonRaw.replace(/[\s-]+/g, "_").toUpperCase()] ?? `未映射：${reasonRaw}`,
      comment: String(row[index.get("customer-comments")!] ?? ""),
      type: "退货",
      source: "FBA退货报告｜SKU级",
      orderId,
      sku,
      asin: index.has("asin") ? get("asin") : "",
      scope: "sku" as const,
    };
  }).map((event) => event.orderId && event.sku ? event : null);
}

export function parseReturnReport(source: string): ReasonEvent[] {
  return parseReturnReportRows(source).filter((event): event is ReasonEvent => event !== null);
}

interface Technical { version: 1; currentTime: string; events: ReasonEvent[]; pending: unknown; syncedAt?: string }

// 同步进度（事件明细、待匹配、当前时间）存状态表 ORDER_REASON/<订单号>|<小写SKU>，飞书只写四个可见列（2026-10-06 字段精简）。
// 先记 synced=false 再写飞书、写完改 true：飞书没写成功时下次处理先补写，不会因“状态已有该事件”而漏掉飞书。
export const ORDER_REASON_PK = "ORDER_REASON";
export const orderReasonKey = (orderId: string, sku: string): string => stableKey(orderId, sku.trim().toLowerCase());

function readTechnical(stored: Record<string, unknown> | undefined): Technical {
  const value = stored?.technical;
  if (value === undefined || value === null) return { version: 1, currentTime: "", events: [], pending: null };
  const parsed = value as Technical;
  if (parsed.version === 1 && Array.isArray(parsed.events)) return parsed;
  throw new Error("售后原因同步状态损坏，拒绝覆盖旧状态。");
}

function visible(technical: Technical): Record<string, unknown> {
  const events = [...technical.events].sort((a, b) => a.eventKey.localeCompare(b.eventKey));
  const prefix = (event: ReasonEvent, value: string): string => events.length > 1 ? `[${event.type}] ${value}` : value;
  return {
    "售后原因原文": events.map((event) => prefix(event, event.reasonRaw)).join("\n"),
    "售后原因中文": events.map((event) => prefix(event, event.reasonZh)).join("\n"),
    "买家备注原文": events.filter((event) => event.comment).map((event) => prefix(event, event.comment)).join("\n"),
    // 洛杉矶本地时间文本（飞书 TODATE 不识别 UTC 的 Z）；状态里的 eventTime 仍是 UTC ISO，用于比较先后。
    "售后原因时间": events[0] ? `${amazonLocalTime(events[0].eventTime) || events[0].eventTime}${[...new Set(events.map((event) => event.timeBasis).filter(Boolean))].length ? `｜${[...new Set(events.map((event) => event.timeBasis).filter(Boolean))].sort().join("、")}` : ""}` : "",
  };
}

async function applyEvent(config: AppConfig, state: StateStore, feishu: FeishuClient, event: ReasonEvent): Promise<boolean> {
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const table = config.get("FEISHU_BITABLE_TABLE_ID_ORDERS");
  const records = await feishu.searchRecords(app, table, { "订单编号": event.orderId });
  const targets = records.filter((record) => feishuFieldText(record.fields.SKU).toLowerCase() === event.sku.toLowerCase());
  if (!targets.length) return false;
  for (const record of targets) {
    const key = orderReasonKey(event.orderId, feishuFieldText(record.fields.SKU));
    const stored = await state.get(ORDER_REASON_PK, key);
    const technical = readTechnical(stored);
    const save = (next: Technical, synced: boolean): Promise<void> => state.put({ pk: ORDER_REASON_PK, sk: key, orderId: event.orderId, sku: event.sku.toLowerCase(), technical: next, synced, updatedAt: new Date().toISOString() });
    if (stored?.synced === false) {
      await feishu.update(app, table, record.record_id, visible(technical));
      await save(technical, true);
    }
    if (!event.reasonRaw) {
      const pending = { eventKey: event.eventKey, eventTime: event.eventTime, type: event.type, source: event.source, reasonPending: true };
      if (canonicalJson(technical.pending) !== canonicalJson(pending)) await save({ ...technical, pending }, true);
      continue;
    }
    const incoming = Date.parse(event.eventTime);
    const current = Date.parse(technical.currentTime);
    if (Number.isFinite(current) && incoming < current) continue;
    const events = Number.isFinite(current) && incoming === current ? [...technical.events] : [];
    const position = events.findIndex((item) => item.eventKey === event.eventKey);
    if (position >= 0 && canonicalJson(events[position]) === canonicalJson(event)) continue;
    if (position >= 0) events[position] = event; else events.push(event);
    const oldPending = technical.pending as { eventTime?: string } | null;
    const next: Technical = { version: 1, currentTime: event.eventTime, events, pending: oldPending && Date.parse(text(oldPending.eventTime)) > incoming ? oldPending : null, syncedAt: new Date().toISOString() };
    await save(next, false);
    await feishu.update(app, table, record.record_id, visible(next));
    await save(next, true);
  }
  return true;
}

async function reportDocument(amazon: AmazonClient, documentId: string): Promise<string> {
  const response = await amazon.sp<JsonObject>(`/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`);
  const payload = (response.payload ?? response) as JsonObject;
  if (!payload.url) throw new Error("退货报告 document 缺少 URL。 ");
  const data = await amazon.download(text(payload.url));
  return text(payload.compressionAlgorithm).toUpperCase() === "GZIP" ? gunzipSync(data).toString("utf8") : Buffer.from(data).toString("utf8");
}

export async function runOrderReasons(event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient): Promise<JsonObject> {
  if (!config.bool("ORDER_REASON_ENABLED", false)) return { status: "disabled" };
  const enabledAt = config.get("ORDER_REASON_ENABLED_AT");
  const enabledMs = Date.parse(enabledAt);
  if (!Number.isFinite(enabledMs)) throw new Error("ORDER_REASON_ENABLED_AT 不是有效时间。");
  const marketplaceIds = config.optional("MARKETPLACE_IDS", config.optional("MARKETPLACE_ID", "ATVPDKIKX0DER")).split(",").map((item) => item.trim()).filter(Boolean);
  let processed = 0;
  let waiting = 0;
  let pendingRequiresOrderMatch = 0;
  for (const marketplaceId of marketplaceIds) {
    const taskId = marketplaceId;
    const saved = await state.task("order-reason", taskId);
    const progress = { ...((saved?.state ?? {}) as JsonObject) };
    const forcePending = progress.forcePending === true || text(event.taskId).startsWith("refund-reason|");
    const pendingRefs = Array.isArray(progress.pendingRefs) ? [...progress.pendingRefs] as unknown as PendingRef[] : [];
    const dueRef = pendingRefs.findIndex((ref) => !Number.isFinite(Date.parse(ref.nextAt)) || Date.parse(ref.nextAt) <= Date.now());
    if (dueRef >= 0) {
      const ref = pendingRefs[dueRef]!;
      const response = await amazon.sp<JsonObject>(`/reports/2021-06-30/reports/${encodeURIComponent(ref.reportId)}`);
      const report = (response.payload ?? response) as JsonObject;
      if (text(report.processingStatus).toUpperCase() !== "DONE" || !report.reportDocumentId) throw new Error(`待匹配退货报告尚不可读取: ${ref.reportId}`);
      const rows = parseReturnReportRows(await reportDocument(amazon, text(report.reportDocumentId)));
      const candidate = rows[ref.rowIndex];
      if (!candidate || candidate.eventKey !== ref.eventKey) throw new Error(`待匹配退货报告行已变化: ${ref.key}`);
      if (await applyEvent(config, state, feishu, candidate)) pendingRefs.splice(dueRef, 1);
      else {
        const attempts = Number(ref.attempts || 0) + 1;
        pendingRefs[dueRef] = { ...ref, attempts, nextAt: new Date(Date.now() + Math.min(30 * 86_400_000, 2 ** Math.min(attempts, 8) * 3_600_000)).toISOString() };
      }
    }
    // 待匹配事件（订单行尚未出现）按 attempts/nextAt 指数退避：1 小时起、封顶 7 天，未到期不重试。
    const pending = Array.isArray(progress.pending) ? progress.pending as unknown as PendingEvent[] : [];
    const stillPending: PendingEvent[] = [];
    for (const item of pending) {
      if (Date.parse(text(item.nextAt)) > Date.now()) { stillPending.push(item); continue; }
      const { attempts, nextAt: _nextAt, ...reason } = item;
      if (!(await applyEvent(config, state, feishu, reason))) stillPending.push(retryLater(reason, Number(attempts ?? 0) + 1));
    }
    progress.pending = stillPending as unknown as JsonObject[];
    progress.pendingRefs = pendingRefs as unknown as JsonObject[];
    pendingRequiresOrderMatch += stillPending.length + pendingRefs.length;
    let reportId = text(progress.reportId);
    if (!reportId) {
      const lastCompletedAt = Date.parse(text(progress.lastCompletedAt));
      const lastRequestedAt = Date.parse(text(progress.lastRequestedAt));
      const lastCreateAttemptAt = Date.parse(text(progress.lastCreateAttemptAt));
      const nextRetryAt = Date.parse(text(progress.nextRetryAt));
      if ((Number.isFinite(lastRequestedAt) && Date.now() - lastRequestedAt < 4 * 3_600_000)
        || (Number.isFinite(lastCreateAttemptAt) && Date.now() - lastCreateAttemptAt < 4 * 3_600_000)
        || (Number.isFinite(nextRetryAt) && Date.now() < nextRetryAt)) {
        await state.saveTask("order-reason", taskId, { ...progress, forcePending }, "waiting_interval");
        continue;
      }
      // 只有退款唤醒/forcePending 可把报表周期缩短到 4 小时；普通待匹配事件靠自身退避重试，不再触发新报表。
      if (Number.isFinite(lastCompletedAt) && Date.now() - lastCompletedAt < 24 * 3_600_000 && !forcePending) {
        await state.saveTask("order-reason", taskId, progress, stillPending.length || pendingRefs.length ? "pending_match" : "idle");
        continue;
      }
      const recentStart = Math.max(enabledMs, Date.now() - 30 * 86_400_000);
      const reviewStart = Date.parse(text(progress.reviewCursor) || enabledAt);
      const reviewDue = Number(progress.reportCount ?? 0) % 4 === 3 && Number.isFinite(reviewStart) && reviewStart < recentStart;
      const forcedWindow = (progress.forcedWindow ?? {}) as JsonObject;
      const mode = text(forcedWindow.mode) || (reviewDue ? "review" : "recent");
      const startTime = text(forcedWindow.startTime) || new Date(reviewDue ? reviewStart : recentStart).toISOString();
      const endTime = text(forcedWindow.endTime) || new Date(reviewDue ? Math.min(reviewStart + 30 * 86_400_000, recentStart) : Date.now()).toISOString();
      if (!Number.isFinite(Date.parse(startTime)) || !Number.isFinite(Date.parse(endTime)) || Date.parse(startTime) > Date.parse(endTime)) throw new Error("退货报告时间窗无效。");
      await state.saveTask("order-reason", taskId, { ...progress, lastCreateAttemptAt: new Date().toISOString(), forcedWindow: { mode, startTime, endTime } }, "creating_report");
      const created = await amazon.sp<JsonObject>("/reports/2021-06-30/reports", { method: "POST", body: { reportType: "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA", marketplaceIds: [marketplaceId], dataStartTime: startTime, dataEndTime: endTime } });
      reportId = text(created.reportId ?? (created.payload as JsonObject | undefined)?.reportId);
      if (!reportId) throw new Error("创建 FBA 退货报告未返回 reportId。 ");
      await state.saveTask("order-reason", taskId, { ...progress, reportId, mode, startTime, endTime, rowIndex: 0, forcedWindow: null, lastRequestedAt: new Date().toISOString(), forcePending: false }, "waiting_report");
      waiting += 1;
      continue;
    }
    const reportResponse = await amazon.sp<JsonObject>(`/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`);
    const report = (reportResponse.payload ?? reportResponse) as JsonObject;
    const status = text(report.processingStatus).toUpperCase();
    if (["IN_QUEUE", "IN_PROGRESS"].includes(status)) {
      await state.saveTask("order-reason", taskId, progress, "waiting_report");
      waiting += 1;
      continue;
    }
    if (status === "CANCELLED") {
      const { reportId: _reportId, rowIndex: _rowIndex, ...rest } = progress;
      await state.saveTask("order-reason", taskId, { ...rest, forcedWindow: { mode: progress.mode ?? "recent", startTime: progress.startTime ?? "", endTime: progress.endTime ?? "" }, nextRetryAt: new Date(Date.now() + 4 * 3_600_000).toISOString(), lastStatus: status }, "waiting_retry");
      continue;
    }
    if (status !== "DONE") throw new Error(`退货报告失败或状态未知: ${status}`);
    const documentId = text(report.reportDocumentId);
    if (!documentId) throw new Error("DONE 退货报告缺少 reportDocumentId。 ");
    const events = parseReturnReportRows(await reportDocument(amazon, documentId));
    const rowIndex = Number(progress.rowIndex ?? 0);
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex > events.length) throw new Error(`退货报告 ${reportId} 断点行号无效。`);
    for (let index = rowIndex; index < events.length; index += 1) {
      const item = events[index];
      if (!item) throw new Error(`退货报告 ${reportId} 第 ${index} 行无有效订单或 SKU。`);
      if (Date.parse(item.eventTime) < enabledMs) continue;
      if (await applyEvent(config, state, feishu, item)) processed += 1; else { stillPending.push(retryLater(item, 1)); pendingRequiresOrderMatch += 1; }
    }
    const { reportId: _reportId, rowIndex: _rowIndex, ...rest } = progress;
    await state.saveTask("order-reason", taskId, {
      ...rest, pending: stillPending as unknown as JsonObject[], lastCompletedAt: new Date().toISOString(),
      lastReportId: reportId, rows: events.length, forcePending: false,
      reportCount: Number(progress.reportCount ?? 0) + 1,
      ...(progress.mode === "review" ? { reviewCursor: progress.endTime } : {}),
      handledWakeAt: progress.wakeAt ?? "",
    }, stillPending.length || pendingRefs.length ? "pending_match" : "idle"); // 常驻进度用非终态 idle，避免 done 的 30 天 TTL 删除报表游标与待匹配状态。
  }
  return { status: waiting ? "waiting_report" : "done", processed, waiting, pendingRequiresOrderMatch };
}
