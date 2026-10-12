import { gunzipSync } from "node:zlib";
import type { AppConfig, JobEvent, JsonObject } from "../types.js";
import { AmazonClient, type Pace } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { ensureOneTimeSchedule } from "../scheduling.js";
import { flushNotification, prepareNotification } from "../notifications.js";
import { HttpError } from "../http.js";
import { log } from "../log.js";
import { canonicalJson, errorText, ymdInZone, zonedMidnight } from "../util.js";
import { ADS_CLEARANCE_MARGIN, profiles } from "./ads.js";
import { adGroupSkus, latestSnapshotDate, loadSnapshot } from "./ads-snapshot.js";
import { r2, sumDays } from "../report/aggregate.js";
import {
  ORDER_FIELDS, SITE_ZONE, adRatio, budgetDays, budgetSkuAds, campaignSkuAds, computeDayLines, feesForMonth, feishuLine, inventoryFacts, kioskAsinDays, kioskStoreDays, ledgerFeeLines,
  overviewAds, parseOrderReport, reasonDays, refundDays, salesDays, skuCosts, snapshotSkuAds, withB2b,
  type BudgetDay, type FeishuLine, type RefundDay, type ReportLine, type SkuAdsDay, type SkuCost,
} from "../report/facts.js";
import { loadReportInput, parseStored } from "../report/load.js";
import { REPORT_TYPES, addDays, monthEnd, periodOf, shiftMonth, weekdayIndex, type Period, type ReportType } from "../report/periods.js";
import {
  REPORT_DAY_PK, REPORT_META_PK, REPORT_MONTH_PK, REPORT_SCHEMA,
  type AdsPart, type DayFacts, type FeeLine, type InventoryPart, type MonthFacts, type ReasonLine, type ReportMeta, type SalesPart, type SkuDay, type SourceKey, type SourceState,
} from "../report/types.js";
import { buildMessage, buildReportView, finalNote } from "../report/view.js";

// 店铺报告任务（规则见 docs/模块说明.md「店铺报告」）。
// 只读飞书（只查询）与亚马逊（GET、全部订单报告、Data Kiosk 查询）；写入仅限状态表 REPORT_DAY/REPORT_MONTH/REPORT_META 与通知意图。
// 推送轮（洛杉矶 00:15）：重算近 20 天未定稿的日子 → 写入 → 发前一天的日报（周日加周报、月末加月报初版、12/31 加年报初版；22 日定稿上月）→ 排 01:45 刷新轮。
// 刷新轮：同样重算并查 Data Kiosk、等广告报表（最晚 04:30），只更新数据，不发消息。回填（cursor.mode=backfill）：默认只读预览，apply=true 才写，不发消息。
type Row = Record<string, unknown>;
export const SETTLE_DAYS = 20;
export const MONTH_FINAL_DAY = 22;
export const REFRESH_MINUTES = 105;
export const ADS_WAIT_UNTIL_MINUTES = 270;
export const ADS_WAIT_STEP_MS = 15 * 60_000;
const MARKETPLACE = "ATVPDKIKX0DER";
const SALES_PACE: Pace = { key: "store-report-sales", minIntervalMs: 2_100 };
const REPORT_TYPE = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL";
const KIOSK = "/dataKiosk/2023-11-15";
// 飞书订单表从这天起才逐单完整（按自己的数据起点修改）；更早的日子只有销售与流量，没有订单毛利。
export const ORDER_LINES_FROM = "2026-04-01";

export interface StoreReportDeps {
  schedule?: typeof ensureOneTimeSchedule; sleep?: (ms: number) => Promise<void>; now?: () => number;
  portalUrl?: string; reportPollMs?: number; reportPolls?: number; kioskPollMs?: number; kioskBudgetMs?: number;
}
interface Ctx {
  config: AppConfig; state: StateStore; amazon: AmazonClient; feishu: FeishuClient; app: string; nowMs: number; todayMonth: number;
  schedule: typeof ensureOneTimeSchedule; sleep: (ms: number) => Promise<void>; deps: StoreReportDeps;
}

// ---------- 小工具 ----------

const describe = (error: unknown): string => {
  const message = errorText(error);
  if (/99991403/.test(message)) return "飞书本月调用额度已用尽";
  if (/HTTP 429|限流|QuotaExceeded/i.test(message)) return "接口限流";
  if (/timeout|超时|aborted/i.test(message)) return "接口超时";
  return message.slice(0, 120);
};
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };
async function attempt<T>(source: string, run: () => Promise<T>): Promise<Outcome<T>> {
  try { return { ok: true, value: await run() }; }
  catch (error) {
    log("WARN", "store_report_source_failed", { source, error: describe(error) });
    return { ok: false, error: describe(error) };
  }
}
const valueOf = <T>(outcome: Outcome<T> | undefined): T | undefined => outcome?.ok ? outcome.value : undefined;
const errorOf = (outcome: Outcome<unknown> | undefined): string => outcome && !outcome.ok ? outcome.error : "";

async function search(feishu: FeishuClient, app: string, table: string, filter: Row, fieldNames?: string[]): Promise<Array<{ fields: Row }>> {
  const output: Array<{ fields: Row }> = [];
  let pageToken = "";
  do {
    const data = await feishu.request<{ items?: Array<{ fields: Row }>; has_more?: boolean; page_token?: string }>(
      "POST", `/open-apis/bitable/v1/apps/${encodeURIComponent(app)}/tables/${encodeURIComponent(table)}/records/search`,
      { ...(fieldNames ? { field_names: fieldNames } : {}), filter, automatic_fields: false }, { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) },
    );
    output.push(...(data.items ?? []));
    pageToken = data.has_more ? String(data.page_token ?? "") : "";
    if (data.has_more && !pageToken) throw new Error("飞书分页缺少 page_token。");
  } while (pageToken);
  return output;
}
// 报告文档下载是裸 fetch（不经 fetchJson 的重试）：网络错误再试两次。
async function download(ctx: Ctx, url: string): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt += 1) {
    try { return await ctx.amazon.download(url); }
    catch (error) {
      if (attempt >= 3 || !(error instanceof TypeError || /fetch failed|ECONNRESET|socket/i.test(errorText(error)))) throw error;
      await ctx.sleep(2_000 * attempt);
    }
  }
}
const anyOf = (field: string, operator: "contains" | "is", values: string[]): Row => ({ conjunction: "or", conditions: values.map((value) => ({ field_name: field, operator, value: [value] })) });
const after = (field: string, date: string): Row => ({ conjunction: "and", conditions: [{ field_name: field, operator: "isGreater", value: ["ExactDate", String(Date.parse(`${date}T00:00:00Z`))] }] });
const datesBetween = (from: string, to: string): string[] => { const output: string[] = []; for (let date = from; date <= to; date = addDays(date, 1)) output.push(date); return output; };
const chunk = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, index) => list.slice(index * size, index * size + size));

// ---------- 取数 ----------

async function salesSource(ctx: Ctx, from: string, toExclusive: string): Promise<Map<string, SalesPart>> {
  const interval = `${zonedMidnight(from, SITE_ZONE)}--${zonedMidnight(toExclusive, SITE_ZONE)}`;
  const query = { marketplaceIds: MARKETPLACE, interval, granularity: "Day", granularityTimeZone: SITE_ZONE };
  const total = await ctx.amazon.sp<JsonObject>("/sales/v1/orderMetrics", { query, pace: SALES_PACE });
  const days = salesDays(total.payload);
  const business = await ctx.amazon.sp<JsonObject>("/sales/v1/orderMetrics", { query: { ...query, buyerType: "B2B" }, pace: SALES_PACE });
  withB2b(days, salesDays(business.payload));
  return days;
}

// 全部订单报告（与 order-prices 同一种）：等最多约 3 分钟，没出来就记“待补”，本轮费用未到账的行不扣促销。
async function orderReportSource(ctx: Ctx, from: string, toExclusive: string): Promise<ReportLine[] | undefined> {
  const created = await ctx.amazon.sp<JsonObject>("/reports/2021-06-30/reports", { method: "POST", body: { reportType: REPORT_TYPE, marketplaceIds: [MARKETPLACE], dataStartTime: zonedMidnight(from, SITE_ZONE), dataEndTime: zonedMidnight(toExclusive, SITE_ZONE) } });
  const reportId = String(created.reportId ?? (created.payload as JsonObject | undefined)?.reportId ?? "");
  if (!reportId) throw new Error("创建全部订单报告未返回 reportId。");
  for (let poll = 0; poll < (ctx.deps.reportPolls ?? 18); poll += 1) {
    await ctx.sleep(ctx.deps.reportPollMs ?? 10_000);
    const response = await ctx.amazon.sp<JsonObject>(`/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`);
    const report = (response.payload ?? response) as JsonObject;
    const status = String(report.processingStatus ?? "").toUpperCase();
    if (status === "IN_QUEUE" || status === "IN_PROGRESS") continue;
    if (status !== "DONE") throw new Error(`全部订单报告 ${status || "状态未知"}`);
    const document = await ctx.amazon.sp<JsonObject>(`/reports/2021-06-30/documents/${encodeURIComponent(String(report.reportDocumentId ?? ""))}`);
    const meta = (document.payload ?? document) as JsonObject;
    const data = await download(ctx, String(meta.url ?? ""));
    const body = String(meta.compressionAlgorithm ?? "").toUpperCase() === "GZIP" ? gunzipSync(data).toString("utf8") : Buffer.from(data).toString("utf8");
    return parseOrderReport(body).lines;
  }
  return undefined;
}

// Data Kiosk：店铺级按天（业务报告口径）与子 ASIN 按天；一次建好再一起轮询，超出时间预算就留到下次运行。
export function kioskQueries(from: string, to: string, asins: string[]): string[] {
  const store = `query StoreReportDays { analytics_salesAndTraffic_2024_04_24 { salesAndTrafficByDate(startDate: "${from}", endDate: "${to}", aggregateBy: DAY, marketplaceIds: ["${MARKETPLACE}"]) { startDate sales { orderedProductSales { amount currencyCode } unitsOrdered totalOrderItems unitsRefunded refundRate shippedProductSales { amount currencyCode } unitsShipped ordersShipped } traffic { sessions pageViews buyBoxPercentage unitSessionPercentage feedbackReceived negativeFeedbackReceived } } } }`;
  const filters = chunk(asins, 30).map((group) => `{ marketplaceId: "${MARKETPLACE}", asins: ${JSON.stringify(group)} }`).join(", ");
  const byAsin = `query StoreReportAsins { analytics_salesAndTraffic_2024_04_24 { salesAndTrafficTrends(asinAggregation: CHILD, dateAggregation: DAY, startDate: "${from}", endDate: "${to}", filters: [${filters}]) { startDate childAsin traffic { sessions pageViews buyBoxPercentage unitSessionPercentage } sales { unitsOrdered orderedProductSales { amount currencyCode } } } } }`;
  return asins.length ? [store, byAsin] : [store];
}

// 建查询与取文档各约每分钟 1 次（突发 15）：回填连跑十几个月会被限流。429 说明这次没建成、没取到，等一分钟再试是安全的。
// 建查询、轮询、取文档合计不超过预算（默认 6 分钟），回填一段因此最长约 7 分钟，在 Jobs 900 秒超时之内。
export const KIOSK_THROTTLE_WAIT_MS = 60_000;
async function kioskSource(ctx: Ctx, queries: string[]): Promise<Array<Row[] | undefined>> {
  const deadline = Date.now() + (ctx.deps.kioskBudgetMs ?? 6 * 60_000);
  const throttled = async <T>(send: () => Promise<T>): Promise<T> => {
    for (;;) {
      try { return await send(); }
      catch (error) {
        if (!(error instanceof HttpError && error.status === 429) || Date.now() + KIOSK_THROTTLE_WAIT_MS > deadline) throw error;
        log("WARN", "store_report_kiosk_throttled", { waitMs: KIOSK_THROTTLE_WAIT_MS });
        await ctx.sleep(KIOSK_THROTTLE_WAIT_MS);
      }
    }
  };
  const ids: string[] = [];
  for (const query of queries) {
    const created = await throttled(() => ctx.amazon.sp<JsonObject>(`${KIOSK}/queries`, { method: "POST", body: { query } }));
    const queryId = String(created.queryId ?? "");
    if (!queryId) throw new Error("Data Kiosk createQuery 未返回 queryId。");
    ids.push(queryId);
  }
  const results: Array<Row[] | undefined> = ids.map(() => undefined);
  const done = new Set<number>();
  while (done.size < ids.length && Date.now() < deadline) {
    await ctx.sleep(ctx.deps.kioskPollMs ?? 15_000);
    for (const [index, queryId] of ids.entries()) {
      if (done.has(index)) continue;
      const status = await ctx.amazon.sp<JsonObject>(`${KIOSK}/queries/${encodeURIComponent(queryId)}`);
      const processing = String(status.processingStatus ?? "").toUpperCase();
      if (!["DONE", "FATAL", "CANCELLED"].includes(processing)) continue;
      done.add(index);
      const documentId = String(status.dataDocumentId ?? "");
      if (processing !== "DONE") { log("WARN", "store_report_kiosk_failed", { index, status: processing }); continue; }
      if (!documentId) { results[index] = []; continue; }
      const document = await throttled(() => ctx.amazon.sp<JsonObject>(`${KIOSK}/documents/${encodeURIComponent(documentId)}`));
      const bytes = await download(ctx, String(document.documentUrl ?? ""));
      const body = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString("utf8") : Buffer.from(bytes).toString("utf8");
      results[index] = body.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as Row);
    }
  }
  return results;
}

interface SnapshotAds { siteDate: string; byDay: Map<string, SkuAdsDay>; campaignSkus: Map<string, string[]> }
async function snapshotSource(ctx: Ctx, dates: string[]): Promise<SnapshotAds> {
  const siteDate = await latestSnapshotDate(ctx.state);
  const profileId = profiles(ctx.config)[0]?.profileId ?? "";
  const snapshot = await loadSnapshot(ctx.state, siteDate, profileId);
  const series = snapshot.targets.meta.map((meta) => ({ owners: adGroupSkus(snapshot.catalog, meta.adGroupId, meta.campaignId), days: (snapshot.targets.days[meta.id] ?? {}) as Record<string, number[]> }));
  const covered = dates.filter((date) => date <= siteDate && date >= addDays(siteDate, -29));
  return { siteDate, byDay: snapshotSkuAds(series, covered), campaignSkus: new Map(snapshot.catalog.campaigns.map((campaign) => [campaign.campaignId, campaign.skus])) };
}

interface Fetched {
  sales: Outcome<Map<string, SalesPart>>; report?: Outcome<ReportLine[] | undefined>; orders: Outcome<FeishuLine[]>; costs: Outcome<Map<string, SkuCost>>;
  overview: Outcome<Map<string, AdsPart>>; campaignAds: Outcome<Map<string, SkuAdsDay>>; snapshot: Outcome<SnapshotAds>; budget?: Outcome<Map<string, BudgetDay>>;
  refunds: Outcome<Map<string, RefundDay>>; reasons: Outcome<Map<string, ReasonLine[]>>;
  kiosk?: Outcome<Array<Row[] | undefined>>; inventory?: Outcome<{ facts: Record<string, InventoryPart>; syncedAt: string }>; ledger?: Outcome<FeeLine[]>;
}

// 库存预警的同步时间（取最晚一行）：作为库存快照的时间，重跑不变。
function inventorySnapshot(records: Array<{ fields: Row }>): { facts: Record<string, InventoryPart>; syncedAt: string } {
  const times = records.map((record) => Number(record.fields["同步时间"])).filter((ms) => Number.isFinite(ms) && ms > 0);
  return { facts: inventoryFacts(records), syncedAt: times.length ? new Date(Math.max(...times)).toISOString() : "" };
}

async function fetchAll(ctx: Ctx, from: string, to: string, options: { report: boolean; kiosk: boolean; inventory: boolean; ledgerFrom?: string; budget: boolean }): Promise<Fetched> {
  const { config, feishu, app } = ctx;
  const dates = datesBetween(from, to);
  const toExclusive = addDays(to, 1);
  const table = (key: string): string => config.get(`FEISHU_BITABLE_TABLE_ID_${key}`);
  const asins = [...new Set(config.asins().map((item) => item.asin.toUpperCase()).filter(Boolean))];
  const [sales, report, orders, costs, overview, campaignAds, snapshot, refunds, reasons, kiosk, inventory, ledger] = await Promise.all([
    attempt("sales", () => salesSource(ctx, from, toExclusive)),
    options.report ? attempt("orderReport", () => orderReportSource(ctx, from, toExclusive)) : Promise.resolve(undefined),
    attempt("orders", async () => (await Promise.all(chunk(dates, 31).map((group) => search(feishu, app, table("ORDERS"), anyOf("下单时间", "contains", group), ORDER_FIELDS)))).flat().map((record) => feishuLine(record.fields)).filter((line): line is FeishuLine => !!line)),
    attempt("costs", async () => skuCosts(await feishu.listRecords(app, table("PROFIT_ESTIMATE")), await feishu.listRecords(app, table("SKUS")))),
    attempt("overview", async () => overviewAds(await search(feishu, app, table("ADS_DAILY_OVERVIEW"), after("站点日期", addDays(from, -2)), ["站点日期", "花费", "广告销售额", "广告订单", "广告销量", "曝光", "点击"]))),
    attempt("campaignAds", async () => campaignSkuAds(await search(feishu, app, table("ADS_CAMPAIGN_DAILY"), after("站点日期", addDays(from, -2)), ["站点日期", "SKU编号", "花费", "广告销售额", "广告订单", "点击", "曝光"]))),
    attempt("snapshot", () => snapshotSource(ctx, dates)),
    attempt("refunds", async () => refundDays(await ctx.state.list("REFUND_FACTS"))),
    attempt("reasons", async () => reasonDays((await Promise.all(chunk(dates, 31).map((group) => search(feishu, app, table("ORDERS"), anyOf("售后原因时间", "contains", group), ["SKU", "售后原因中文", "售后原因时间"])))).flat(), new Set(dates))),
    options.kiosk ? attempt("kiosk", () => kioskSource(ctx, kioskQueries(from, to, asins))) : Promise.resolve(undefined),
    options.inventory ? attempt("inventory", async () => inventorySnapshot(await feishu.listRecords(app, table("INVENTORY_ALERTS")))) : Promise.resolve(undefined),
    options.ledgerFrom ? attempt("ledger", async () => ledgerFeeLines(await search(feishu, app, table("FINANCE_LEDGER"), after("交易时间", addDays(options.ledgerFrom!, -2)), ["交易时间", "交易状态", "业务分类", "流水名称", "原币金额", "币种", "原始描述"]))) : Promise.resolve(undefined),
  ]);
  // 预算表只在广告报表缺天时才查（推送轮前一天、或报表迟到）：当天加前 14 天，用来估算并求比例。
  const overviewMap = valueOf(overview);
  const missing = dates.filter((date) => !overviewMap?.get(date));
  const budget = options.budget && missing.length ? await attempt("budget", async () => budgetDays(await search(feishu, app, table("ADS"), anyOf("预算日期", "is", datesBetween(addDays(missing[0]!, -14), missing.at(-1)!)), ["预算日期", "已花费预算", "广告活动ID", "所属SKU"]))) : undefined;
  return { sales, ...(report ? { report } : {}), orders, costs, overview, campaignAds, snapshot, ...(budget ? { budget } : {}), refunds, reasons, ...(kiosk ? { kiosk } : {}), ...(inventory ? { inventory } : {}), ...(ledger ? { ledger } : {}) };
}

// ---------- 组装一天 ----------

const AD_FIELDS: Array<keyof SkuDay> = ["adSpend", "adSales", "adOrders", "adClicks", "adImpressions", "adEstimate"];
const REFUND_FIELDS: Array<keyof SkuDay> = ["refundUnits", "refundLoss"];
const LINE_FIELDS: Array<keyof SkuDay> = ["units", "revenue", "promo", "commission", "fba", "cogs", "storageEst", "profit", "lines", "estimatedLines", "costMissing"];

function pick(source: SkuDay | undefined, fields: Array<keyof SkuDay>): Partial<SkuDay> {
  const output: Partial<SkuDay> = {};
  if (!source) return output;
  for (const field of fields) if (source[field] !== undefined) (output as Record<string, unknown>)[field] = source[field];
  return output;
}

// 各块“新取到用新的、没取到沿用上次”，按 SKU 拼回一行。
function composeSkus(previous: Record<string, SkuDay> | undefined, lines: Record<string, SkuDay> | undefined, ads: Record<string, Partial<SkuDay>> | undefined, refunds: Record<string, Partial<SkuDay>> | undefined): Record<string, SkuDay> {
  const output: Record<string, SkuDay> = {};
  const skus = new Set([...Object.keys(previous ?? {}), ...Object.keys(lines ?? {}), ...Object.keys(ads ?? {}), ...Object.keys(refunds ?? {})]);
  for (const sku of skus) {
    const base = lines ? lines[sku] : previous?.[sku] ? (pick(previous[sku], LINE_FIELDS) as SkuDay) : undefined;
    const adPart = ads ? ads[sku] ?? {} : pick(previous?.[sku], AD_FIELDS);
    const refundPart = refunds ? refunds[sku] ?? {} : pick(previous?.[sku], REFUND_FIELDS);
    const row: SkuDay = { units: 0, revenue: 0, promo: 0, commission: 0, fba: 0, cogs: 0, storageEst: 0, profit: 0, lines: 0, estimatedLines: 0, costMissing: 0, ...(base ?? {}), ...adPart, ...refundPart };
    if (!row.lines && !row.units && !row.costMissing && row.adSpend === undefined && row.refundUnits === undefined) continue;
    output[sku] = row;
  }
  return output;
}

export interface AssembleOptions { date: string; yesterday: string; nowIso: string; todayMonth: number; skuAsins: Record<string, string>; inventoryAt?: string }

export function assembleDay(previous: DayFacts | undefined, fetched: Fetched, options: AssembleOptions): DayFacts {
  const { date, nowIso: at } = options;
  const sources: Partial<Record<SourceKey, SourceState>> = { ...(previous?.sources ?? {}) };
  // 取数失败：之前有数据就沿用并写明；一直没有就记“取数失败”（同样的失败不改写，免得每轮都重写）。
  const keep = (key: SourceKey, error: string): void => {
    if (!error) return;
    const prior = previous?.sources?.[key];
    sources[key] = prior && prior.status !== "failed" && prior.status !== "pending"
      ? { ...prior, note: `本次取数失败（${error}），沿用 ${prior.at ?? "上次"} 的数据` }
      : { status: "failed", at: prior?.at ?? at, note: `取数失败（${error}）` };
  };
  const facts: DayFacts = { date, schema: REPORT_SCHEMA, version: previous?.version ?? 0, status: "draft", computedAt: previous?.computedAt ?? at, skus: {}, sources };
  for (const key of ["sales", "lines", "ads", "traffic", "refunds", "other", "unattributedAds", "asinTraffic", "inventory", "inventoryAt", "reasons", "checks", "skuAsins", "clearanceSkus"] as const) {
    if (previous?.[key] !== undefined) (facts as unknown as Record<string, unknown>)[key] = previous[key];
  }

  // 销售（Sales API）：接口按天都会给桶，没给的保持原值。
  const sales = valueOf(fetched.sales)?.get(date);
  if (sales) { facts.sales = sales; sources.sales = { status: "ok", at }; } else keep("sales", errorOf(fetched.sales));

  // 订单逐行（订单表 + 订单报告 + 成本表）。
  const orders = valueOf(fetched.orders), costs = valueOf(fetched.costs);
  const reportLines = fetched.report && fetched.report.ok ? fetched.report.value : undefined;
  let lineSkus: Record<string, SkuDay> | undefined;
  if (date < ORDER_LINES_FROM) {
    // 飞书订单表 2026-04 起才完整：此前没有逐行就不算订单毛利（页面显示“—”并说明），不能当 0。
    delete facts.lines; delete facts.other;
    facts.checks = { reportLines: null, feishuLines: 0, matched: 0, salesVsLines: null, kioskVsSales: null };
    sources.lines = { status: "unavailable", at, note: `飞书订单表 ${ORDER_LINES_FROM.slice(0, 7)} 起才完整，此前不算订单毛利` };
    lineSkus = {};
  } else if (orders && costs) {
    const result = computeDayLines(date, { ...(reportLines ? { reportLines } : {}), feishuLines: orders, costs, todayMonth: options.todayMonth });
    facts.lines = result.lines; lineSkus = result.skus;
    if (result.other) facts.other = result.other; else delete facts.other;
    facts.checks = { reportLines: result.checks.reportLines, feishuLines: result.checks.feishuLines, matched: result.checks.matched, salesVsLines: null, kioskVsSales: null };
    const notes = [result.lines.estimatedLines ? `${result.lines.estimatedLines}/${result.lines.lines} 行费用未到账，按成本表预估` : "", reportLines ? "" : "订单报告未取到：费用未到账的行没扣促销折扣"].filter(Boolean);
    sources.lines = { status: result.lines.estimatedLines || !reportLines ? "estimate" : "ok", at, ...(notes.length ? { note: notes.join("；") } : {}) };
    facts.clearanceSkus = [...costs.values()].filter((cost) => cost.marginRate !== null && cost.marginRate < ADS_CLEARANCE_MARGIN).map((cost) => cost.sku).sort();
  } else keep("lines", errorOf(fetched.orders) || errorOf(fetched.costs));

  // 广告：报表优先；报表没到时按预算表 × 近 14 天比例估算（不覆盖已有的报表值）。
  const overview = valueOf(fetched.overview);
  const report = overview?.get(date);
  let adSkus: Record<string, Partial<SkuDay>> | undefined;
  if (report) {
    facts.ads = report; sources.ads = { status: "ok", at };
    const snapshot = valueOf(fetched.snapshot);
    const byGroup = snapshot?.byDay.get(date);
    const byCampaign = valueOf(fetched.campaignAds)?.get(date);
    const split = byGroup ?? byCampaign;
    if (split) {
      adSkus = {};
      let attributed = 0;
      for (const [sku, value] of split.bySku) { adSkus[sku] = { adSpend: value.spend, adSales: value.sales, adOrders: value.orders, adClicks: value.clicks, adImpressions: value.impressions }; attributed = r2(attributed + value.spend); }
      const rest = r2(report.spend - attributed);
      facts.unattributedAds = { spend: rest > 0.009 ? rest : 0, sales: split.unattributed.sales, orders: split.unattributed.orders };
      sources.skuAds = { status: "ok", at, note: byGroup ? "按广告组归属（广告快照）" : "按广告活动归属（广告活动日报）" };
    } else keep("skuAds", errorOf(fetched.snapshot) || errorOf(fetched.campaignAds) || "广告按 SKU 拆分暂未取到");
  } else if (!previous?.ads || previous.ads.source === "estimate") {
    const budget = fetched.budget ? valueOf(fetched.budget) : undefined;
    const day = budget?.get(date);
    if (day && overview && budget) {
      const ratio = adRatio(overview, budget, date, addDays);
      facts.ads = { source: "estimate", spend: r2(day.total * ratio), budgetRaw: day.total, ratio };
      sources.ads = { status: "estimate", at, note: `广告报表未到：按预算表 ${day.total.toFixed(2)} × 近 14 天报表/预算比例 ${ratio} 估算` };
      const campaignSkus = valueOf(fetched.snapshot)?.campaignSkus ?? new Map<string, string[]>();
      const split = budgetSkuAds(day, ratio, campaignSkus);
      adSkus = {};
      for (const [sku, value] of split.bySku) adSkus[sku] = { adSpend: value.spend, adEstimate: true };
      facts.unattributedAds = { spend: split.unattributed.spend, sales: 0, orders: 0 };
      sources.skuAds = { status: "estimate", at, note: "按预算表与广告目录归属" };
    } else keep("ads", errorOf(fetched.overview) || (fetched.budget ? errorOf(fetched.budget) : ""));
  }

  // 退款：REFUND_FACTS 整个分区读到时，没有退款的日子就是 0。
  const refunds = valueOf(fetched.refunds);
  let refundSkus: Record<string, Partial<SkuDay>> | undefined;
  if (refunds) {
    const day = refunds.get(date);
    facts.refunds = day?.part ?? { events: 0, units: 0, principal: 0, feeBack: 0, promoBack: 0, loss: 0, nonUsd: 0 };
    refundSkus = Object.fromEntries([...(day?.bySku ?? new Map()).entries()].map(([sku, value]) => [sku, { refundUnits: value.units, refundLoss: value.loss }]));
    sources.refunds = { status: "ok", at };
  } else keep("refunds", errorOf(fetched.refunds));

  // 流量（Data Kiosk，约次日出数）：有这一天才更新。
  const kiosk = fetched.kiosk ? valueOf(fetched.kiosk) : undefined;
  if (kiosk) {
    const store = kiosk[0] ? kioskStoreDays(kiosk[0]).get(date) : undefined;
    if (store) { facts.traffic = store; sources.traffic = { status: "ok", at }; }
    else if (!previous?.traffic) sources.traffic = { status: "pending", at, note: "亚马逊业务报告次日出数" };
    // 子 ASIN 的按天数据在店铺级出数前就会返回 0：店铺级有这一天才收（10/09 实测）。
    const asinDay = store && kiosk[1] ? kioskAsinDays(kiosk[1]).get(date) : undefined;
    if (asinDay) facts.asinTraffic = asinDay;
  } else if (fetched.kiosk) keep("traffic", errorOf(fetched.kiosk));
  else if (!previous?.traffic) sources.traffic = { status: "pending", at, note: "亚马逊业务报告次日出数" };

  const reasons = valueOf(fetched.reasons);
  if (reasons) { facts.reasons = reasons.get(date) ?? []; sources.reasons = { status: "ok", at }; } else keep("reasons", errorOf(fetched.reasons));

  const inventory = fetched.inventory ? valueOf(fetched.inventory) : undefined;
  if (inventory && date === options.yesterday) { facts.inventory = inventory.facts; facts.inventoryAt = inventory.syncedAt || options.inventoryAt || previous?.inventoryAt || at; sources.inventory = { status: "ok", at }; }

  facts.skuAsins = options.skuAsins;
  facts.skus = composeSkus(previous?.skus, lineSkus, adSkus, refundSkus);
  if (facts.checks) facts.checks = { ...facts.checks, salesVsLines: facts.lines && facts.sales ? r2(facts.lines.revenue - facts.sales.sales) : null, kioskVsSales: facts.traffic && facts.sales ? r2(facts.traffic.orderedSales - facts.sales.sales) : null };
  return facts;
}

// 比较时去掉时间戳与版本：数据没变就不写（省写入额度，“更新于”也不跳）。
export function comparable(facts: DayFacts | MonthFacts | undefined): string {
  if (!facts) return "";
  const { computedAt: _computedAt, ...rest } = facts as DayFacts & Record<string, unknown>;
  const copy = JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
  delete copy.version;
  for (const source of Object.values((copy.sources ?? {}) as Record<string, Record<string, unknown>>)) delete source.at;
  if (copy.fees) delete (copy.fees as Record<string, unknown>).at;
  if (copy.rollup && copy.rollupThrough === undefined) delete copy.rollupThrough;
  return canonicalJson(copy);
}

async function writeDay(state: StateStore, facts: DayFacts): Promise<void> {
  await state.put({ pk: REPORT_DAY_PK, sk: facts.date, status: facts.status, version: facts.version, schema: facts.schema, computedAt: facts.computedAt, payload: JSON.stringify(facts) });
}
async function writeMonth(state: StateStore, facts: MonthFacts): Promise<void> {
  await state.put({ pk: REPORT_MONTH_PK, sk: facts.month, status: facts.status, schema: facts.schema, computedAt: facts.computedAt, payload: JSON.stringify(facts) });
}

// ---------- 主流程 ----------

export interface RunSummary { mode: string; today: string; days: number; written: number; finalized: number; months: number; pushed: string[]; adsMissing: string[]; failed: string[] }

function failedSources(fetched: Fetched): string[] {
  return Object.entries(fetched).filter(([, outcome]) => outcome && !(outcome as Outcome<unknown>).ok).map(([key]) => key);
}

async function storedDays(state: StateStore, from: string, to: string): Promise<Map<string, DayFacts>> {
  const output = new Map<string, DayFacts>();
  for (const item of await state.queryRange(REPORT_DAY_PK, from, to)) { const day = parseStored<DayFacts>(item); if (day?.date) output.set(day.date, day); }
  return output;
}

// 重算一段日子并写入（dryRun 不写）；返回写入后的天与本次取数结果。
async function recompute(ctx: Ctx, from: string, to: string, options: { report: boolean; kiosk: boolean; inventory: boolean; budget: boolean; ledgerFrom?: string; yesterday: string; dryRun: boolean; finalBefore?: string }): Promise<{ days: Map<string, DayFacts>; fetched: Fetched; written: number }> {
  const [previous, fetched] = await Promise.all([storedDays(ctx.state, from, to), fetchAll(ctx, from, to, options)]);
  const skuAsins = Object.fromEntries(ctx.config.asins().filter((item) => item.asin).map((item) => [item.sku, item.asin.toUpperCase()]));
  const nowIso = new Date(ctx.nowMs).toISOString();
  const days = new Map<string, DayFacts>();
  let written = 0;
  for (const date of datesBetween(from, to)) {
    const prior = previous.get(date);
    if (prior?.status === "final" && prior.schema === REPORT_SCHEMA && !options.finalBefore) { days.set(date, prior); continue; }
    const next = assembleDay(prior, fetched, { date, yesterday: options.yesterday, nowIso, todayMonth: ctx.todayMonth, skuAsins });
    if (options.finalBefore && date < options.finalBefore) { next.status = "final"; next.finalAt = prior?.finalAt ?? nowIso; }
    const changed = comparable(prior) !== comparable(next);
    if (changed) { next.version = (prior?.version ?? 0) + 1; next.computedAt = nowIso; }
    days.set(date, changed ? next : prior!);
    if (changed && !options.dryRun) { await writeDay(ctx.state, next); written += 1; }
  }
  return { days, fetched, written };
}

// 窗口外、仍是初稿的日子定稿（漏跑多日也补上；最多回看 60 天）。
async function finalizeDays(ctx: Ctx, through: string, dryRun: boolean): Promise<number> {
  const meta = parseStored<ReportMeta & { finalizedThrough?: string }>(await ctx.state.get(REPORT_META_PK, "state"));
  const start = meta?.finalizedThrough && meta.finalizedThrough >= addDays(through, -60) ? addDays(meta.finalizedThrough, 1) : addDays(through, -60);
  if (start > through) return 0;
  let count = 0;
  const nowIso = new Date(ctx.nowMs).toISOString();
  for (const [date, day] of await storedDays(ctx.state, start, through)) {
    if (day.status === "final") continue;
    count += 1;
    if (!dryRun) await writeDay(ctx.state, { ...day, status: "final", finalAt: nowIso, date });
  }
  return count;
}

async function updateMonths(ctx: Ctx, months: string[], ledger: FeeLine[] | undefined, today: string, dryRun: boolean): Promise<Map<string, MonthFacts>> {
  const output = new Map<string, MonthFacts>();
  const nowIso = new Date(ctx.nowMs).toISOString();
  for (const month of [...new Set(months)].sort()) {
    const [days, priorItem] = await Promise.all([storedDays(ctx.state, `${month}-01`, monthEnd(month)), ctx.state.get(REPORT_MONTH_PK, month)]);
    const prior = parseStored<MonthFacts>(priorItem);
    const list = [...days.values()].filter((day) => day.date <= addDays(today, -1));
    const next: MonthFacts = { month, schema: REPORT_SCHEMA, status: today >= `${shiftMonth(month, 1)}-${String(MONTH_FINAL_DAY).padStart(2, "0")}` ? "final" : "draft", computedAt: prior?.computedAt ?? nowIso, ...(prior?.finalAt ? { finalAt: prior.finalAt } : {}), ...(prior?.firstDraft ? { firstDraft: prior.firstDraft } : {}) };
    if (list.length) { next.rollup = sumDays(list); next.rollupThrough = list.map((day) => day.date).sort().at(-1)!; }
    if (ledger) { const lines = feesForMonth(ledger, month); next.fees = { lines, storagePosted: lines.some((line) => line.kind === "storage"), at: nowIso }; }
    else if (prior?.fees) next.fees = prior.fees;
    if (next.status === "final" && !next.finalAt) next.finalAt = nowIso;
    const changed = comparable(prior) !== comparable(next);
    if (changed) next.computedAt = nowIso;
    output.set(month, changed ? next : prior!);
    if (changed && !dryRun) await writeMonth(ctx.state, next);
  }
  return output;
}

async function updateMeta(ctx: Ctx, update: { earliest?: string; latest?: string; finalizedThrough?: string }, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const prior = parseStored<ReportMeta & { finalizedThrough?: string }>(await ctx.state.get(REPORT_META_PK, "state"));
  const next = {
    earliest: [prior?.earliest, update.earliest].filter(Boolean).sort()[0] ?? update.latest ?? "",
    latest: [prior?.latest, update.latest].filter(Boolean).sort().at(-1) ?? "",
    finalizedThrough: [prior?.finalizedThrough, update.finalizedThrough].filter(Boolean).sort().at(-1) ?? "",
    updatedAt: new Date(ctx.nowMs).toISOString(),
  };
  await ctx.state.put({ pk: REPORT_META_PK, sk: "state", payload: JSON.stringify(next), updatedAt: next.updatedAt });
}

// ---------- 推送 ----------

export function pushTypes(config: AppConfig): Set<ReportType> {
  const raw = config.optional("STORE_REPORT_PUSH", "day,week,month,year");
  return new Set(raw.split(/[,\s，]+/).map((item) => item.trim()).filter((item): item is ReportType => (REPORT_TYPES as string[]).includes(item)));
}

export function reportUrl(base: string, period: Period): string {
  return `${base.replace(/\/+$/, "")}/report/${period.type}/${period.key}`;
}

// 消息里的链接包一层飞书 AppLink“端内 web”：电脑端在飞书里打开、不跳系统浏览器，手机端照旧在飞书内打开（10/10 用户反馈电脑端会用默认浏览器打开）。
// STORE_REPORT_LINK_MODE：window（默认，独立窗口）、appCenter（导航栏标签）、sidebar-semi（侧边栏）、url（不包，直接用网址）。
const LINK_MODES = new Set(["window", "appCenter", "sidebar-semi"]);
export function reportLink(config: AppConfig, url: string): string {
  const mode = config.optional("STORE_REPORT_LINK_MODE", "window").trim();
  if (mode === "url") return url;
  return `https://applink.feishu.cn/client/web_url/open?mode=${LINK_MODES.has(mode) ? mode : "window"}&url=${encodeURIComponent(url)}`;
}

async function pushReport(ctx: Ctx, period: Period, today: string, kind: "draft" | "final", firstDraft?: MonthFacts["firstDraft"]): Promise<string | undefined> {
  const eventKey = `store-report|${kind === "final" ? `${period.type}-final` : period.type}|${period.key}`;
  if (await ctx.state.notification(eventKey)) return undefined;
  const base = ctx.deps.portalUrl ?? process.env.PORTAL_URL ?? ctx.config.optional("PORTAL_URL", "");
  if (!/^https:\/\//.test(base)) throw new Error("店铺报告缺少中台网址（Jobs 环境变量 PORTAL_URL），无法生成报告链接。");
  const view = buildReportView(await loadReportInput(ctx.state, period, today, ctx.nowMs));
  if (view.empty) { log("WARN", "store_report_push_skipped_empty", { eventKey }); return undefined; }
  const message = buildMessage(view, kind);
  // 定稿消息：净利润后面写出与初版相比的变化。
  const note = kind === "final" ? finalNote(firstDraft, view) : "";
  const lines = message.lines.map((line) => note && line.startsWith("净利润（估）") ? `${line}（${note}）` : line);
  const recipients = ctx.config.optional("STORE_REPORT_NOTIFY_USER_IDS", "").split(/[,\s，]+/).map((item) => item.trim()).filter(Boolean);
  const prepared = await prepareNotification(ctx.config, ctx.state, eventKey, lines.filter(Boolean), { ...(recipients.length ? { recipients } : {}), post: { title: message.title, link: { text: message.linkText, url: reportLink(ctx.config, reportUrl(base, period)) } } });
  if (!prepared) return undefined;
  await flushNotification(ctx.state, ctx.feishu, eventKey, prepared);
  return eventKey;
}

async function recordFirstDraft(ctx: Ctx, period: Period, today: string): Promise<void> {
  const item = await ctx.state.get(REPORT_MONTH_PK, period.key);
  const month = parseStored<MonthFacts>(item);
  if (!month || month.firstDraft) return;
  const view = buildReportView(await loadReportInput(ctx.state, period, today, ctx.nowMs));
  const sales = view.kpis.find((cell) => cell.key === "sales")?.value ?? null;
  const expected = view.kpis.find((cell) => cell.key === "expectedProfit")?.value ?? null;
  await writeMonth(ctx.state, { ...month, firstDraft: { at: new Date(ctx.nowMs).toISOString(), expectedProfit: expected, netProfit: view.net?.netProfit ?? null, sales } });
}

// ---------- 入口 ----------

export async function runStoreReport(event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient, deps: StoreReportDeps = {}): Promise<JsonObject> {
  if (!config.bool("STORE_REPORT_ENABLED", true)) return { status: "done", disabled: true };
  const nowMs = deps.now?.() ?? Date.now();
  const cursor = (event.cursor ?? {}) as Row;
  const mode = String(cursor.mode ?? "push");
  const dryRun = event.dryRun === true;
  const ctx: Ctx = {
    config, state, amazon, feishu, app: config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS"), nowMs, todayMonth: Number(ymdInZone(new Date(nowMs), SITE_ZONE).slice(5, 7)),
    schedule: deps.schedule ?? ensureOneTimeSchedule, sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))), deps,
  };
  if (mode === "backfill") return runBackfill(ctx, cursor, dryRun || cursor.apply !== true);
  // 推送轮以计划时间（洛杉矶 00:15）定“今天”；刷新轮沿用推送轮的“今天”。
  const scheduledMs = Date.parse(String(event.scheduledAt ?? ""));
  const today = typeof cursor.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(cursor.today) ? cursor.today : ymdInZone(new Date(Number.isFinite(scheduledMs) ? scheduledMs : nowMs), SITE_ZONE);
  const yesterday = addDays(today, -1);
  const from = addDays(today, -SETTLE_DAYS);
  const refresh = mode === "refresh";
  const ledgerFrom = `${shiftMonth(today.slice(0, 7), -1)}-01`;
  const { days, fetched, written } = await recompute(ctx, from, yesterday, { report: true, kiosk: refresh, inventory: !refresh, budget: true, ledgerFrom, yesterday, dryRun });
  const finalized = await finalizeDays(ctx, addDays(from, -1), dryRun);
  const monthsTouched = [...new Set([...days.keys()].map((date) => date.slice(0, 7)).concat([shiftMonth(today.slice(0, 7), -1), today.slice(0, 7)]))].filter((month) => `${month}-01` <= yesterday);
  const months = dryRun ? new Map<string, MonthFacts>() : await updateMonths(ctx, monthsTouched, valueOf(fetched.ledger), today, dryRun);
  await updateMeta(ctx, { latest: yesterday, earliest: from, finalizedThrough: addDays(from, -1) }, dryRun);
  const adsMissing = [...days.values()].filter((day) => !day.ads || day.ads.source !== "report").map((day) => day.date);
  const summary: RunSummary = { mode, today, days: days.size, written, finalized, months: months.size, pushed: [], adsMissing, failed: failedSources(fetched) };

  if (dryRun) {
    const day = days.get(yesterday);
    const preview = day ? buildMessage(buildReportView({ period: periodOf("day", yesterday), today, nowMs, days, months: new Map(), meta: null })) : null;
    // 逐日核对表：与后台、订单表、广告每日总览对照用。
    const table = [...days.values()].map((item) => ({
      date: item.date, units: item.sales?.units ?? null, sales: item.sales?.sales ?? null, lineRevenue: item.lines?.revenue ?? null, orderProfit: item.lines?.profit ?? null,
      adSpend: item.ads?.spend ?? null, adSource: item.ads?.source ?? null, expectedProfit: item.lines && item.ads ? r2(item.lines.profit - item.ads.spend) : null,
      lines: item.lines?.lines ?? null, estimated: item.lines?.estimatedLines ?? null, promo: item.lines?.promo ?? null, refundLoss: item.refunds?.loss ?? null, other: item.other?.lines ?? 0, checks: item.checks ?? null,
      sessions: item.traffic?.sessions ?? null, conversion: item.traffic?.unitSessionPct ?? null, asins: Object.keys(item.asinTraffic ?? {}).length, skus: Object.keys(item.skus).length,
    }));
    return {
      status: "done", dryRun: true, ...summary, preview: preview as unknown as JsonObject, table: table as unknown as JsonObject[],
      facts: day ? JSON.parse(JSON.stringify({ sales: day.sales, lines: day.lines, ads: day.ads, refunds: day.refunds, other: day.other ?? null, checks: day.checks ?? null, sources: day.sources, skus: day.skus })) : null,
      // 本机预览页面用（只在 dryRun 返回，不落库）。
      ...(cursor.includeFacts === true ? { days: JSON.parse(JSON.stringify([...days.values()])) } : {}),
    } as unknown as JsonObject;
  }

  if (!refresh) {
    const types = pushTypes(config);
    const pushed: string[] = [];
    const push = async (period: Period, kind: "draft" | "final", firstDraft?: MonthFacts["firstDraft"]): Promise<void> => {
      if (!types.has(period.type)) return;
      const key = await pushReport(ctx, period, today, kind, firstDraft);
      if (key) pushed.push(key);
    };
    // 前一天的数据都没取到（销售与订单都失败）时不发，交给健康检查邮件。
    if (days.get(yesterday)?.sales || days.get(yesterday)?.lines) {
      await push(periodOf("day", yesterday), "draft");
      if (weekdayIndex(yesterday) === 0) await push(periodOf("week", yesterday), "draft");
      if (yesterday === monthEnd(yesterday.slice(0, 7))) { await push(periodOf("month", yesterday), "draft"); await recordFirstDraft(ctx, periodOf("month", yesterday), today); }
      if (yesterday.slice(5) === "12-31") await push(periodOf("year", yesterday), "draft");
    }
    if (Number(today.slice(8)) === MONTH_FINAL_DAY) {
      const month = periodOf("month", `${shiftMonth(today.slice(0, 7), -1)}-01`);
      await push(month, "final", months.get(month.key)?.firstDraft);
      if (today.slice(5, 7) === "01") await push(periodOf("year", `${Number(today.slice(0, 4)) - 1}-01-01`), "final");
    }
    summary.pushed = pushed;
    // 01:45 刷新：广告换成报表实际值、补流量。
    const refreshAt = new Date(Date.parse(zonedMidnight(today, SITE_ZONE)) + REFRESH_MINUTES * 60_000);
    const when = refreshAt.getTime() > nowMs ? refreshAt : new Date(nowMs + 60_000);
    await ctx.schedule({ taskType: "store-report", taskId: `store-report|refresh|${today}`, scheduledAt: when.toISOString(), cursor: { mode: "refresh", today } }, when);
    return { status: "done", ...summary } as unknown as JsonObject;
  }

  // 刷新轮：前一天的广告报表还没到、且没过 04:30，就 15 分钟后再来。
  const deadline = Date.parse(zonedMidnight(today, SITE_ZONE)) + ADS_WAIT_UNTIL_MINUTES * 60_000;
  if (adsMissing.includes(yesterday) && nowMs + ADS_WAIT_STEP_MS <= deadline) {
    const when = new Date(nowMs + ADS_WAIT_STEP_MS);
    await ctx.schedule({ taskType: "store-report", taskId: `store-report|refresh|${today}`, scheduledAt: event.scheduledAt ?? when.toISOString(), cursor: { mode: "refresh", today, attempt: Number(cursor.attempt ?? 0) + 1 } }, when);
    return { status: "waiting_ads", ...summary, nextAt: when.toISOString() } as unknown as JsonObject;
  }
  return { status: "done", ...summary } as unknown as JsonObject;
}

// ---------- 回填（手动） ----------

// cursor：{ mode: "backfill", from, to, apply }。只处理已出窗口的日子（今天往前 21 天以前），按月分段；超出时间预算按原身份续跑。
// 预算只管“还开不开下一段”：一段最长约 7 分钟（Data Kiosk 最多等 6 分钟），6 分钟后不再开新段，整轮在 Jobs 900 秒超时前结束。
export const BACKFILL_BUDGET_MS = 6 * 60_000;
async function runBackfill(ctx: Ctx, cursor: Row, preview: boolean): Promise<JsonObject> {
  const today = ymdInZone(new Date(ctx.nowMs), SITE_ZONE);
  const lastAllowed = addDays(today, -SETTLE_DAYS - 1);
  const origin = String(cursor.from ?? "");
  const begin = String(cursor.next ?? origin);
  const to = String(cursor.to ?? lastAllowed) < lastAllowed ? String(cursor.to ?? lastAllowed) : lastAllowed;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(origin) || !/^\d{4}-\d{2}-\d{2}$/.test(begin) || begin > to) throw new Error(`回填范围无效：${begin} ~ ${to}（只能回填 ${lastAllowed} 及以前）。`);
  const started = Date.now();
  const segments: Array<{ from: string; to: string; days: number; written: number; failed: string[]; sales: number; profit: number | null; ads: number | null }> = [];
  let next: string | undefined = begin;
  while (next && next <= to) {
    const start: string = next;
    const end: string = monthEnd(start.slice(0, 7)) < to ? monthEnd(start.slice(0, 7)) : to;
    const { days, fetched, written } = await recompute(ctx, start, end, { report: false, kiosk: true, inventory: false, budget: false, yesterday: addDays(today, -1), dryRun: preview, finalBefore: addDays(today, -SETTLE_DAYS) });
    const totals = sumDays([...days.values()]);
    segments.push({ from: start, to: end, days: days.size, written, failed: failedSources(fetched), sales: totals.sales?.sales ?? 0, profit: totals.lines ? totals.lines.profit : null, ads: totals.ads ? totals.ads.spend : null });
    next = end < to ? addDays(end, 1) : undefined;
    if (next && Date.now() - started > BACKFILL_BUDGET_MS) break;
  }
  if (!preview) {
    // 月汇总与店铺费用：资金流水从起点前 40 天读到最新（仓储费次月 7 日才扣）。
    const ledger = valueOf(await attempt("ledger", async () => ledgerFeeLines(await search(ctx.feishu, ctx.app, ctx.config.get("FEISHU_BITABLE_TABLE_ID_FINANCE_LEDGER"), after("交易时间", addDays(begin, -40)), ["交易时间", "交易状态", "业务分类", "流水名称", "原币金额", "币种", "原始描述"]))));
    const processedTo = next ? addDays(next, -1) : to;
    const months: string[] = [];
    for (let month = begin.slice(0, 7); month <= processedTo.slice(0, 7); month = shiftMonth(month, 1)) months.push(month);
    await updateMonths(ctx, months, ledger, today, false);
    await updateMeta(ctx, { earliest: origin, finalizedThrough: processedTo }, false);
  }
  if (next) {
    if (preview) return { status: "done", preview: true, segments: segments as unknown as JsonObject[], stoppedAt: next } as unknown as JsonObject;
    const when = new Date(Date.now() + 60_000);
    await ctx.schedule({ taskType: "store-report", taskId: `store-report|backfill|${origin}|${to}|${next}`, scheduledAt: when.toISOString(), cursor: { mode: "backfill", from: origin, to, next, apply: true } }, when);
    return { status: "waiting_backfill", segments: segments as unknown as JsonObject[], next } as unknown as JsonObject;
  }
  return { status: "done", preview, segments: segments as unknown as JsonObject[] } as unknown as JsonObject;
}
