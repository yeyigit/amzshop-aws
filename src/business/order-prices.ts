import { gunzipSync } from "node:zlib";
import type { AppConfig, FeishuRecord, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { log } from "../log.js";
import { feishuFieldText, losAngelesTimeMs } from "../util.js";

// 订单商品小计补写（规则见 docs/模块说明.md「订单商品小计补写」）：订单表「付款金额」＝后台“商品小计”（ItemPrice）。
// 订单接口对 Pending 订单与免费换货单不给价，全部订单报告给：只补「付款金额」为空的行，同时补为空的「金额币种」，不覆盖、不写其它字段、不发消息。
export const ORDER_PRICE_REPORT_TYPE = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL";
export const ORDER_PRICE_WINDOW_DAYS = 30;
export const ORDER_PRICE_REPORT_POLLS = 30;
export const ORDER_PRICE_POLL_MS = 10_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const AMAZON_ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;
const REQUIRED_COLUMNS = ["amazon-order-id", "order-status", "item-status", "sku", "currency", "item-price"];
const text = (value: unknown): string => String(value ?? "").trim();

type SkipReason = "cancelled" | "malformed" | "no_price" | "no_currency" | "mixed_currency";
export interface ReportPrice { amount: number; currency: string; lines: number; reason?: SkipReason }
export interface OrderPriceDeps { sleep?: (milliseconds: number) => Promise<void>; now?: () => number }

// 报告是不加引号的制表符文本（商品名里的英寸号 " 原样出现），逐行逐列切分；某行列数与表头不符时整单不写。
// 同一订单同一 SKU 多行时商品价相加；行级已取消的行不计入，全部行都已取消或订单已取消记 cancelled；缺价格、缺币种、币种不一致都不写。
export function parseOrderPriceReport(source: string): { rows: number; prices: Map<string, ReportPrice> } {
  const lines = source.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!lines.length) return { rows: 0, prices: new Map() };
  const header = lines[0]!.split("\t").map((name) => name.trim());
  const missing = REQUIRED_COLUMNS.filter((name) => !header.includes(name));
  if (missing.length) throw new Error(`全部订单报告缺少列：${missing.join(",")}`);
  const column = (cells: string[], name: string): string => text(cells[header.indexOf(name)]);
  const prices = new Map<string, ReportPrice>();
  const malformed = new Set<string>();
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const orderId = column(cells, "amazon-order-id");
    if (cells.length !== header.length) { if (orderId) malformed.add(orderId); continue; }
    const key = `${orderId}|${column(cells, "sku").toLowerCase()}`;
    const entry = prices.get(key) ?? { amount: 0, currency: "", lines: 0 };
    prices.set(key, entry);
    if (/cancel/i.test(column(cells, "order-status"))) { entry.reason = "cancelled"; continue; }
    if (/cancel/i.test(column(cells, "item-status"))) continue;
    entry.lines += 1;
    if (entry.reason) continue;
    const rawPrice = column(cells, "item-price");
    const currency = column(cells, "currency");
    const amount = Number(rawPrice);
    if (rawPrice === "") entry.reason = "no_price";
    else if (!Number.isFinite(amount)) entry.reason = "malformed";
    else if (!currency) entry.reason = "no_currency";
    else if (entry.currency && entry.currency !== currency) entry.reason = "mixed_currency";
    else { entry.amount += amount; entry.currency = currency; }
  }
  for (const [key, entry] of prices) {
    if (malformed.has(key.slice(0, key.indexOf("|")))) entry.reason = "malformed";
    else if (!entry.reason && entry.lines === 0) entry.reason = "cancelled";
    if (!entry.reason) entry.amount = Number(entry.amount.toFixed(2));
  }
  return { rows: lines.length - 1, prices };
}

type ReportFetch = { status: "done"; body: string } | { status: "waiting"; reportId: string } | { status: "cancelled"; reportId: string };

async function fetchReport(amazon: AmazonClient, marketplaceId: string, dataStartTime: string, sleep: (milliseconds: number) => Promise<void>): Promise<ReportFetch> {
  const created = await amazon.sp<JsonObject>("/reports/2021-06-30/reports", { method: "POST", body: { reportType: ORDER_PRICE_REPORT_TYPE, marketplaceIds: [marketplaceId], dataStartTime } });
  const reportId = text(created.reportId ?? (created.payload as JsonObject | undefined)?.reportId);
  if (!reportId) throw new Error("创建全部订单报告未返回 reportId。");
  for (let poll = 0; poll < ORDER_PRICE_REPORT_POLLS; poll += 1) {
    await sleep(ORDER_PRICE_POLL_MS);
    const response = await amazon.sp<JsonObject>(`/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`);
    const report = (response.payload ?? response) as JsonObject;
    const status = text(report.processingStatus).toUpperCase();
    if (status === "IN_QUEUE" || status === "IN_PROGRESS") continue;
    if (status === "CANCELLED") return { status: "cancelled", reportId };
    if (status !== "DONE") throw new Error(`全部订单报告失败或状态未知：${status}`);
    const documentId = text(report.reportDocumentId);
    if (!documentId) throw new Error("DONE 全部订单报告缺少 reportDocumentId。");
    const document = await amazon.sp<JsonObject>(`/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`);
    const meta = (document.payload ?? document) as JsonObject;
    if (!meta.url) throw new Error("全部订单报告 document 缺少 URL。");
    const data = await amazon.download(text(meta.url));
    return { status: "done", body: text(meta.compressionAlgorithm).toUpperCase() === "GZIP" ? gunzipSync(data).toString("utf8") : Buffer.from(data).toString("utf8") };
  }
  return { status: "waiting", reportId };
}

// 候选行：付款金额为空、未取消、亚马逊订单号（不含 S01- 多渠道单）、30 天内下单；没有候选行不申请报告。
// 报告时间窗从最早一条候选行下单前 1 小时起；本轮 5 分钟内未完成不写，下一轮重新申请。dryRun 只返回将写的行。
export async function runOrderPrices(event: JobEvent, config: AppConfig, amazon: AmazonClient, feishu: FeishuClient, deps: OrderPriceDeps = {}): Promise<JsonObject> {
  if (!config.bool("ORDER_PRICES_ENABLED", true)) return { status: "done", disabled: true };
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = deps.now?.() ?? Date.now();
  const dryRun = event.dryRun === true;
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const table = config.get("FEISHU_BITABLE_TABLE_ID_ORDERS");
  const rows = await feishu.searchRecords(app, table, {}, {
    fieldNames: ["订单编号", "SKU", "下单时间", "订单状态", "付款金额", "金额币种"],
    conditions: [{ field_name: "付款金额", operator: "isEmpty", value: [] }, { field_name: "订单状态", operator: "isNot", value: ["已取消"] }],
  });
  const candidates = rows.filter((record) => {
    const purchasedAt = losAngelesTimeMs(record.fields["下单时间"]);
    return AMAZON_ORDER_ID.test(feishuFieldText(record.fields["订单编号"])) && feishuFieldText(record.fields["付款金额"]) === ""
      && !/取消/.test(feishuFieldText(record.fields["订单状态"])) && purchasedAt > now - ORDER_PRICE_WINDOW_DAYS * DAY;
  });
  if (!candidates.length) return { status: "done", candidates: 0 };

  const earliest = Math.min(...candidates.map((record) => losAngelesTimeMs(record.fields["下单时间"])));
  const dataStartTime = new Date(Math.max(now - ORDER_PRICE_WINDOW_DAYS * DAY, earliest - HOUR)).toISOString();
  const marketplaceIds = config.optional("MARKETPLACE_IDS", config.optional("MARKETPLACE_ID", "ATVPDKIKX0DER")).split(",").map((item) => item.trim()).filter(Boolean);
  const prices = new Map<string, ReportPrice>();
  let reportRows = 0;
  for (const marketplaceId of marketplaceIds) {
    const report = await fetchReport(amazon, marketplaceId, dataStartTime, sleep);
    if (report.status === "waiting") {
      log("WARN", "order_prices_report_waiting", { marketplaceId, reportId: report.reportId, candidates: candidates.length });
      return { status: "waiting_report", candidates: candidates.length, reportId: report.reportId };
    }
    if (report.status === "cancelled") continue;
    const parsed = parseOrderPriceReport(report.body);
    reportRows += parsed.rows;
    for (const [key, price] of parsed.prices) prices.set(key, price);
  }

  const byKey = new Map<string, FeishuRecord[]>();
  for (const record of candidates) {
    const key = `${feishuFieldText(record.fields["订单编号"])}|${feishuFieldText(record.fields.SKU).toLowerCase()}`;
    byKey.set(key, [...(byKey.get(key) ?? []), record]);
  }
  const updates: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
  const preview: JsonObject[] = [];
  const skippedReasons: Record<string, number> = {};
  const skip = (reason: string, count = 1): void => { skippedReasons[reason] = (skippedReasons[reason] ?? 0) + count; };
  let notInReport = 0, noPrice = 0, zeroFilled = 0;
  for (const [key, records] of byKey) {
    const price = prices.get(key);
    if (!price) { notInReport += records.length; continue; }
    if (records.length > 1) { skip("duplicate_rows", records.length); continue; }
    if (price.reason === "no_price") { noPrice += 1; continue; }
    if (price.reason) { skip(price.reason); continue; }
    const record = records[0]!;
    const currentCurrency = feishuFieldText(record.fields["金额币种"]);
    if (currentCurrency && currentCurrency !== price.currency) { skip("currency_conflict"); continue; }
    updates.push({ recordId: record.record_id, fields: { "付款金额": price.amount, ...(currentCurrency ? {} : { "金额币种": price.currency }) } });
    if (price.amount === 0) zeroFilled += 1;
    if (dryRun) preview.push({ orderId: key.slice(0, key.indexOf("|")), sku: feishuFieldText(record.fields.SKU), amount: price.amount, currency: price.currency });
  }
  if (!dryRun && updates.length) await feishu.batchUpdate(app, table, updates);
  const skipped = Object.values(skippedReasons).reduce((sum, count) => sum + count, 0);
  const summary = { candidates: candidates.length, reportRows, filled: dryRun ? 0 : updates.length, zeroFilled, noPrice, notInReport, skipped };
  log("INFO", "order_prices_done", { ...summary, ...(dryRun ? { dryRun: true, wouldFill: updates.length } : {}) });
  return { status: "done", ...summary, ...(skipped ? { skippedReasons } : {}), ...(dryRun ? { dryRun: true, wouldFill: updates.length, preview } : {}) };
}
