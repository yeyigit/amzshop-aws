import { gunzipSync } from "node:zlib";
import type { JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";

// Reports API 2021-06-30 的申请、轮询与取文档（店铺健康、库存健康、SQP 共用；已有模块各自的取数逻辑不动）。
type Row = Record<string, unknown>;
const text = (value: unknown): string => String(value ?? "").trim();
export const REPORTS_PATH = "/reports/2021-06-30";

export type ReportOutcome = { status: "done"; body: string } | { status: "fatal" | "cancelled"; detail: string } | { status: "pending" };
export interface AwaitOptions { budgetMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number }

export async function createReport(amazon: AmazonClient, body: JsonObject): Promise<string> {
  const created = await amazon.sp<JsonObject>(`${REPORTS_PATH}/reports`, { method: "POST", body });
  const reportId = text(created.reportId ?? (created.payload as Row | undefined)?.reportId);
  if (!reportId) throw new Error(`申请报告 ${text(body.reportType)} 未返回 reportId。`);
  return reportId;
}

export async function reportStatus(amazon: AmazonClient, reportId: string): Promise<{ status: string; documentId: string }> {
  const response = await amazon.sp<JsonObject>(`${REPORTS_PATH}/reports/${encodeURIComponent(reportId)}`);
  const report = (response.payload ?? response) as Row;
  return { status: text(report.processingStatus).toUpperCase(), documentId: text(report.reportDocumentId) };
}

// 文档可能是 GZIP（看 compressionAlgorithm，或直接看 gzip 魔数）。
export async function reportDocument(amazon: AmazonClient, documentId: string): Promise<string> {
  const response = await amazon.sp<JsonObject>(`${REPORTS_PATH}/documents/${encodeURIComponent(documentId)}`);
  const meta = (response.payload ?? response) as Row;
  if (!text(meta.url)) throw new Error("报告文档缺少 URL。");
  const bytes = await amazon.download(text(meta.url));
  const gzip = text(meta.compressionAlgorithm).toUpperCase() === "GZIP" || (bytes[0] === 0x1f && bytes[1] === 0x8b);
  return (gzip ? gunzipSync(bytes) : Buffer.from(bytes)).toString("utf8");
}

// 轮询到终态或用完预算。FATAL 时把错误文档原文（如“not available yet”）带回，CANCELLED 表示该期没有数据。
export async function awaitReport(amazon: AmazonClient, reportId: string, options: AwaitOptions): Promise<ReportOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  for (;;) {
    const { status, documentId } = await reportStatus(amazon, reportId);
    if (status === "DONE") {
      if (!documentId) throw new Error(`报告 ${reportId} 已完成但缺少 reportDocumentId。`);
      return { status: "done", body: await reportDocument(amazon, documentId) };
    }
    if (status === "FATAL") return { status: "fatal", detail: documentId ? (await reportDocument(amazon, documentId)).slice(0, 500) : "" };
    if (status === "CANCELLED") return { status: "cancelled", detail: "" };
    if (status !== "IN_QUEUE" && status !== "IN_PROGRESS") throw new Error(`报告 ${reportId} 状态未知：${status || "空"}`);
    if (now() - started >= options.budgetMs) return { status: "pending" };
    await sleep(options.intervalMs);
  }
}

// 制表符分隔的报告：首行为列名，返回逐行对象（缺列补空串）。
export function parseTsv(body: string): Array<Record<string, string>> {
  const lines = body.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const header = lines[0]!.split("\t").map((name) => name.trim());
  return lines.slice(1).map((line) => { const cells = line.split("\t"); return Object.fromEntries(header.map((name, index) => [name, (cells[index] ?? "").trim()])); });
}
