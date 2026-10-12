import { gunzipSync, gzipSync } from "node:zlib";
import type { AppConfig, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { StateStore } from "../state.js";
import { log } from "../log.js";
import { addDaysYmd, sha256, ymdInZone } from "../util.js";
import { awaitReport, createReport } from "./reports.js";

// SQP 搜索查询表现（docs/模块说明.md「店铺健康、库龄与 SQP」）：每天补齐最近 SQP_BACKFILL_WEEKS 个完整周（周日~周六，洛杉矶），
// 只进调广告数据包，不进中台、不发消息。对亚马逊只读（报告申请），状态只写 SQP/、SQP_META/。
type Row = Record<string, unknown>;
const text = (value: unknown): string => String(value ?? "").trim();
const list = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
const isYmd = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);
const n = (value: unknown): number | null => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

export const SQP_REPORT_TYPE = "GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT";
export const SQP_PK = "SQP";
export const SQP_META_PK = "SQP_META";
const MARKETPLACE_US = "ATVPDKIKX0DER";
// reportOptions.asin 是空格分隔的 ASIN，官方限 200 字符（约 18 个）。
export const ASIN_OPTION_MAX = 200;
const CHUNK_CHARS = 300_000;
const TTL_DAYS = 400;
const META_WEEKS = 60;
const MAX_WEEKS_PER_RUN = 4;
const POLL_BUDGET_MS = 6 * 60_000;
const POLL_INTERVAL_MS = 15_000;
const EXTRA_TERM_SPEND = 5;
const EXTRA_TERMS = 10;

export interface SqpSettings { backfillWeeks: number; packQueries: number }

export function sqpSettings(config: AppConfig): SqpSettings {
  const read = (key: string, fallback: number, min: number, max: number): number => {
    const value = Number(text(config.optional(key, String(fallback))));
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min}–${max} 之间的数字。`);
    return Math.round(value);
  };
  return { backfillWeeks: read("SQP_BACKFILL_WEEKS", 4, 1, 12), packQueries: read("SQP_PACK_QUERIES", 25, 5, 100) };
}

// 洛杉矶“今天”之前最近 count 个完整周的周日日期，新到旧（今天是周六时本周还没过完，不算）。
export function completeWeeks(todayLa: string, count: number): string[] {
  const dow = new Date(`${todayLa}T00:00:00Z`).getUTCDay();
  const lastSaturday = addDaysYmd(todayLa, -(dow + 1));
  return Array.from({ length: count }, (_, index) => addDaysYmd(lastSaturday, -6 - index * 7));
}

export function asinBatches(asins: string[], max = ASIN_OPTION_MAX): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  for (const asin of asins) {
    if (current.length && [...current, asin].join(" ").length > max) { batches.push(current); current = []; }
    current.push(asin);
  }
  if (current.length) batches.push(current);
  return batches;
}

// 紧凑行：[搜索词, 重要度, 搜索量, 曝光(全市场, 本ASIN), 点击(全, 本), 加购(全, 本), 购买(全, 本), 本ASIN点击中位价, 全市场点击中位价, 本ASIN购买中位价, 全市场购买中位价]。
export type SqpRow = [string, ...Array<number | null>];
export type SqpWeek = Record<string, SqpRow[]>;
export const ROW = { query: 0, score: 1, volume: 2, totImpr: 3, ourImpr: 4, totClick: 5, ourClick: 6, totCart: 7, ourCart: 8, totBuy: 9, ourBuy: 10, ourClickPrice: 11, mktClickPrice: 12, ourBuyPrice: 13, mktBuyPrice: 14 } as const;

// 搜索词对照口径：小写、首尾去空白、连续空白合成一个（广告搜索词报表里会有“Rocket  Toy”这种写法）。
export const normalizeQuery = (value: unknown): string => text(value).toLowerCase().replace(/\s+/g, " ");

export function compactSqp(json: Row): SqpWeek {
  const output: SqpWeek = {};
  for (const row of list(json.dataByAsin)) {
    const asin = text(row.asin).toUpperCase();
    const q = (row.searchQueryData ?? {}) as Row, i = (row.impressionData ?? {}) as Row, c = (row.clickData ?? {}) as Row, a = (row.cartAddData ?? {}) as Row, p = (row.purchaseData ?? {}) as Row;
    const query = normalizeQuery(q.searchQuery);
    if (!asin || !query) continue;
    const price = (value: unknown): number | null => n((value as Row | undefined)?.amount);
    (output[asin] ??= []).push([query, n(q.searchQueryScore), n(q.searchQueryVolume), n(i.totalQueryImpressionCount), n(i.asinImpressionCount), n(c.totalClickCount), n(c.asinClickCount), n(a.totalCartAddCount), n(a.asinCartAddCount), n(p.totalPurchaseCount), n(p.asinPurchaseCount), price(c.asinMedianClickPrice), price(c.totalMedianClickPrice), price(p.asinMedianPurchasePrice), price(p.totalMedianPurchasePrice)]);
  }
  return output;
}

// ---------- 存取：gzip+base64 分片；先写其余分片、最后写 000 号，读取只认与 000 号同版本的分片 ----------

export async function saveSqpWeek(state: StateStore, weekStart: string, week: SqpWeek, now = Date.now()): Promise<number> {
  const encoded = gzipSync(Buffer.from(JSON.stringify(week), "utf8")).toString("base64");
  const chunks = Math.max(1, Math.ceil(encoded.length / CHUNK_CHARS));
  const version = `${now}-${sha256(encoded).slice(0, 8)}`;
  const expiresAt = Math.floor(now / 1000) + TTL_DAYS * 86_400;
  for (let index = chunks - 1; index >= 0; index -= 1) {
    await state.put({ pk: SQP_PK, sk: `${weekStart}|${String(index).padStart(3, "0")}`, version, chunks, data: encoded.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS), createdAt: new Date(now).toISOString(), expiresAt });
  }
  return chunks;
}

export async function loadSqpWeek(state: StateStore, weekStart: string): Promise<SqpWeek | undefined> {
  const items = await state.queryPartition(SQP_PK, { beginsWith: `${weekStart}|`, limit: 200 });
  const head = items.find((item) => text(item.sk).endsWith("|000"));
  if (!head) return undefined;
  const version = text(head.version), chunks = Number(head.chunks ?? 0);
  const pieces: string[] = [];
  for (let index = 0; index < chunks; index += 1) {
    const piece = items.find((item) => text(item.sk) === `${weekStart}|${String(index).padStart(3, "0")}` && text(item.version) === version);
    if (!piece) throw new Error(`SQP ${weekStart} 分片 ${index} 不完整。`);
    pieces.push(text(piece.data));
  }
  return JSON.parse(gunzipSync(Buffer.from(pieces.join(""), "base64")).toString("utf8")) as SqpWeek;
}

export async function recentSqpWeeks(state: StateStore, count: number): Promise<Array<{ week: string; data: SqpWeek }>> {
  const meta = await state.get(SQP_META_PK, "state");
  const weeks = (Array.isArray(meta?.weeks) ? meta!.weeks as unknown[] : []).map(text).filter(isYmd).sort().reverse().slice(0, count);
  const output: Array<{ week: string; data: SqpWeek }> = [];
  for (const week of weeks) { const data = await loadSqpWeek(state, week); if (data) output.push({ week, data }); }
  return output;
}

// ---------- 调广告数据包 ----------

export interface AdTermTotals { clicks: number; orders: number; spend: number }

const share = (ours: number, total: number, any: boolean): number | null => any && total > 0 ? Math.round((ours / total) * 10_000) / 100 : null;
const rate = (top: number, bottom: number, any: boolean): number | null => any && bottom > 0 ? Math.round((top / bottom) * 10_000) / 10_000 : null;

// 最近一周重要度前 limit 个词 + 近 30 天广告花费 ≥ $5、出现在 SQP 里但不在前 limit 的广告搜索词（最多 10 个）。
// 份额、转化按所选各周的计数合计现算；价格取最近一周有值的；广告按小写全文对照，没有就为空。
export function buildSqpPack(weeks: Array<{ week: string; data: SqpWeek }>, asin: string, adTerms: Map<string, AdTermTotals>, limit: number): JsonObject | null {
  if (!asin || !weeks.length) return null;
  const byWeek = weeks.map(({ week, data }) => ({ week, rows: new Map((data[asin] ?? []).map((row) => [row[ROW.query] as string, row])) }));
  if (!byWeek.some((entry) => entry.rows.size)) return null;
  const latest = byWeek.find((entry) => entry.rows.size)!;
  const ranked = [...latest.rows.values()].sort((a, b) => ((a[ROW.score] as number | null) ?? 1e9) - ((b[ROW.score] as number | null) ?? 1e9) || ((b[ROW.volume] as number | null) ?? 0) - ((a[ROW.volume] as number | null) ?? 0));
  const chosen = ranked.slice(0, limit).map((row) => row[ROW.query] as string);
  const seen = new Set(byWeek.flatMap((entry) => [...entry.rows.keys()]));
  const extra = [...adTerms].filter(([term, totals]) => totals.spend >= EXTRA_TERM_SPEND && seen.has(term) && !chosen.includes(term)).sort((a, b) => b[1].spend - a[1].spend).slice(0, EXTRA_TERMS).map(([term]) => term);
  const queries = [...chosen, ...extra].map((query) => {
    const sums = new Map<number, number>();
    const has = new Set<number>();
    for (const entry of byWeek) {
      const row = entry.rows.get(query);
      if (!row) continue;
      for (const index of [ROW.volume, ROW.totImpr, ROW.ourImpr, ROW.totClick, ROW.ourClick, ROW.totCart, ROW.ourCart, ROW.totBuy, ROW.ourBuy]) {
        const value = row[index] as number | null;
        if (value === null) continue;
        has.add(index);
        sums.set(index, (sums.get(index) ?? 0) + value);
      }
    }
    const get = (index: number): number => sums.get(index) ?? 0;
    const priceOf = (index: number): number | null => { for (const entry of byWeek) { const value = entry.rows.get(query)?.[index] as number | null | undefined; if (value !== null && value !== undefined) return value; } return null; };
    const ad = adTerms.get(query);
    return {
      query, score: (latest.rows.get(query)?.[ROW.score] as number | null | undefined) ?? null, volume: has.has(ROW.volume) ? get(ROW.volume) : null,
      imprShare: share(get(ROW.ourImpr), get(ROW.totImpr), has.has(ROW.totImpr)), clickShare: share(get(ROW.ourClick), get(ROW.totClick), has.has(ROW.totClick)),
      cartShare: share(get(ROW.ourCart), get(ROW.totCart), has.has(ROW.totCart)), buyShare: share(get(ROW.ourBuy), get(ROW.totBuy), has.has(ROW.totBuy)),
      ourClicks: get(ROW.ourClick), ourBuys: get(ROW.ourBuy), marketBuys: get(ROW.totBuy),
      ourCvr: rate(get(ROW.ourBuy), get(ROW.ourClick), has.has(ROW.ourClick)), marketCvr: rate(get(ROW.totBuy), get(ROW.totClick), has.has(ROW.totClick)),
      ourPrice: priceOf(ROW.ourBuyPrice) ?? priceOf(ROW.ourClickPrice), marketPrice: priceOf(ROW.mktBuyPrice) ?? priceOf(ROW.mktClickPrice),
      weekly: byWeek.map((entry) => { const row = entry.rows.get(query); return row ? [entry.week, row[ROW.volume] ?? null, row[ROW.ourClick] ?? null, row[ROW.ourBuy] ?? null] : [entry.week, null, null, null]; }),
      ad30: ad ? { clicks: ad.clicks, orders: ad.orders, spend: Math.round(ad.spend * 100) / 100 } : null,
    };
  });
  return { weeks: byWeek.map((entry) => entry.week), latestWeek: latest.week, queries } as unknown as JsonObject;
}

// ---------- 任务 ----------

// now：本轮的业务时间；clock：报告轮询预算用的时钟（测试里随 sleep 前进）。
export interface SqpDeps { now?: () => number; clock?: () => number; sleep?: (ms: number) => Promise<void> }

export async function runSqp(_event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, deps: SqpDeps = {}): Promise<JsonObject> {
  if (!config.bool("SQP_ENABLED", true)) return { status: "done", disabled: true };
  const now = deps.now?.() ?? Date.now();
  const settings = sqpSettings(config);
  const targets = completeWeeks(ymdInZone(new Date(now), "America/Los_Angeles"), settings.backfillWeeks);
  const meta = await state.get(SQP_META_PK, "state");
  const stored = new Set((Array.isArray(meta?.weeks) ? meta!.weeks as unknown[] : []).map(text).filter(isYmd));
  const missing = targets.filter((week) => !stored.has(week)).slice(0, MAX_WEEKS_PER_RUN);
  const asins = [...new Set(config.asins().map((item) => text(item.asin).toUpperCase()).filter((asin) => /^[A-Z0-9]{10}$/.test(asin)))].sort();
  if (!missing.length || !asins.length) return { status: "done", upToDate: !missing.length, asins: asins.length, latestWeek: [...stored].sort().at(-1) ?? "" };
  const batches = asinBatches(asins);
  const storedNow: string[] = [], notReady: string[] = [], pending: string[] = [];
  for (const week of missing) {
    const merged: SqpWeek = {};
    let complete = true;
    for (const batch of batches) {
      const reportId = await createReport(amazon, {
        reportType: SQP_REPORT_TYPE, marketplaceIds: [MARKETPLACE_US], dataStartTime: `${week}T00:00:00Z`, dataEndTime: `${addDaysYmd(week, 6)}T00:00:00Z`,
        reportOptions: { reportPeriod: "WEEK", asin: batch.join(" ") },
      });
      const outcome = await awaitReport(amazon, reportId, { budgetMs: POLL_BUDGET_MS, intervalMs: POLL_INTERVAL_MS, ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.clock ? { now: deps.clock } : {}) });
      if (outcome.status === "done") { Object.assign(merged, compactSqp(JSON.parse(outcome.body) as Row)); continue; }
      complete = false;
      // 数据还没出（FATAL 且错误文档写 not available yet）或该期取消：记未就绪，次日再试；没等到结果：次日重新申请。
      if ((outcome.status === "fatal" && /not available yet/i.test(outcome.detail)) || outcome.status === "cancelled") notReady.push(week);
      else if (outcome.status === "pending") pending.push(week);
      else throw new Error(`SQP ${week} FATAL：${outcome.detail || "无错误文档"}`);
      break;
    }
    if (!complete) continue;
    await saveSqpWeek(state, week, merged, now);
    stored.add(week);
    storedNow.push(week);
  }
  const weeks = [...stored].filter(isYmd).sort().reverse().slice(0, META_WEEKS);
  await state.put({ pk: SQP_META_PK, sk: "state", weeks, notReady, pending, asins: asins.length, lastRunAt: new Date(now).toISOString(), updatedAt: new Date().toISOString() });
  if (storedNow.length) await state.recordHealth("sqp-data", "done", { weeks: storedNow.join(",") });
  log("INFO", "sqp_done", { stored: storedNow.join(","), notReady: notReady.join(","), pending: pending.join(",") });
  return { status: "done", asins: asins.length, batches: batches.length, stored: storedNow.join(","), notReady: notReady.join(","), pending: pending.join(","), latestWeek: weeks[0] ?? "" };
}
