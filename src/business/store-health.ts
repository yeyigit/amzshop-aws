import type { AppConfig, FeishuRecord, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { flushNotification, prepareNotification, type PreparedNotification } from "../notifications.js";
import { log } from "../log.js";
import { auditDecode, errorText, feishuFieldText, sha256, ymdInZone } from "../util.js";
import { LISTINGS_PACE, OFFER_MARKETS, watchedMarkets } from "./offers.js";
import { awaitReport, createReport } from "./reports.js";

// 店铺健康（docs/模块说明.md「店铺健康、库龄与 SQP」）：每小时查三站点 listing 在售状态与问题；
// 账户健康报告每 STORE_HEALTH_ACCOUNT_HOURS 小时一份；每个北京日查一次高退货率处理费。
// 对亚马逊只读（GET 与报告申请），飞书只读资金流水；状态只写 STORE_HEALTH/；只在变化时发一条合并消息，不放卖家后台链接。
type Row = Record<string, unknown>;
const text = (value: unknown): string => String(value ?? "").trim();
const list = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
const num = (value: unknown): number | null => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const HOUR = 3_600_000;

export const STORE_HEALTH_PK = "STORE_HEALTH";
export const ACCOUNT_REPORT_TYPE = "GET_V2_SELLER_PERFORMANCE_REPORT";
export const HRR_DESCRIPTION = "CustomerReturnHRREvent";
const MARKETPLACE_US = "ATVPDKIKX0DER";
const ACCOUNT_POLL_BUDGET_MS = 3 * 60_000;
const ACCOUNT_POLL_INTERVAL_MS = 10_000;
// 挂起的账户报告超过 2 小时还没出，丢弃重新申请。
const ACCOUNT_PENDING_MAX_MS = 2 * HOUR;
const FOOTER = "处理时请在本店固定环境登录卖家后台查看（「账户状况」「管理库存」）。";

export interface StoreHealthSettings { accountHours: number; ahrDrop: number }

export function storeHealthSettings(config: AppConfig): StoreHealthSettings {
  const read = (key: string, fallback: number, min: number, max: number): number => {
    const value = Number(text(config.optional(key, String(fallback))));
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 必须是 ${min}–${max} 之间的数字。`);
    return value;
  };
  return { accountHours: read("STORE_HEALTH_ACCOUNT_HOURS", 6, 1, 24), ahrDrop: read("STORE_HEALTH_AHR_DROP", 20, 1, 1000) };
}

// ---------- 账户健康 ----------

const POLICY_LABELS: Record<string, string> = {
  listingPolicyViolations: "Listing 政策违规", productAuthenticityCustomerComplaints: "商品真实性买家投诉", productConditionCustomerComplaints: "商品状况买家投诉",
  productSafetyCustomerComplaints: "产品安全买家投诉", receivedIntellectualPropertyComplaints: "收到的知识产权投诉", restrictedProductPolicyViolations: "受限商品政策违规",
  suspectedIntellectualPropertyViolations: "涉嫌侵犯知识产权", foodAndProductSafetyIssues: "食品和商品安全问题", customerProductReviewsPolicyViolations: "违反买家商品评论政策",
  otherPolicyViolations: "其他违反政策行为", documentRequests: "文件索取",
};
const CHANNELS: Record<string, string> = { afn: "亚马逊配送", mfn: "卖家配送" };
const DEFECT_LABELS: Record<string, string> = { orderWithDefects: "订单缺陷", claims: "A-to-z 索赔", chargebacks: "信用卡拒付", negativeFeedback: "差评" };
const RATE_LABELS: Record<string, string> = { lateShipmentRate: "迟发率", preFulfillmentCancellationRate: "配送前取消率", validTrackingRate: "有效追踪率", onTimeDeliveryRate: "准时送达率", unitOnTimeDeliveryRate: "按件准时送达率", invoiceDefectRate: "发票缺陷率" };
const ACCOUNT_STATUS_LABELS: Record<string, string> = { NORMAL: "正常", AT_RISK: "有风险", DEACTIVATED: "已停用" };
const FINE_METRIC = new Set(["GOOD", "NONE", ""]);
const FINE_AHR = new Set(["GREAT", "GOOD", "NONE", ""]);

export function metricLabel(key: string): string {
  const [channel, defect] = key.split(".");
  if (defect && CHANNELS[channel!]) return `${DEFECT_LABELS[defect] ?? defect}（${CHANNELS[channel!]}）`;
  if (CHANNELS[key]) return `订单缺陷率（${CHANNELS[key]}）`;
  if (key === "policyViolationWarnings") return "政策违规警告";
  return POLICY_LABELS[key] ?? RATE_LABELS[key] ?? key;
}

export interface AccountFacts { marketplaceId: string; status: string; ahrStatus: string; ahrScore: number | null; counts: Record<string, number>; statuses: Record<string, string>; odrRate: number | null; odrOrders: number | null; reportingTo: string }

export function parseAccountHealth(json: Row, marketplaceId = MARKETPLACE_US): AccountFacts {
  const pick = (rows: Row[]): Row => rows.find((row) => text(row.marketplaceId) === marketplaceId) ?? rows[0] ?? {};
  const account = pick(list(json.accountStatuses));
  const metrics = pick(list(json.performanceMetrics));
  if (!Object.keys(account).length && !Object.keys(metrics).length) throw new Error("账户健康报告没有 accountStatuses 与 performanceMetrics。");
  const counts: Record<string, number> = {};
  const statuses: Record<string, string> = {};
  for (const key of Object.keys(POLICY_LABELS)) {
    const metric = (metrics[key] ?? {}) as Row;
    const count = num(metric.defectsCount);
    if (count !== null) counts[key] = count;
    if (text(metric.status)) statuses[key] = text(metric.status).toUpperCase();
  }
  const odr = (metrics.orderDefectRate ?? {}) as Row;
  for (const channel of Object.keys(CHANNELS)) {
    const part = (odr[channel] ?? {}) as Row;
    for (const name of Object.keys(DEFECT_LABELS)) { const count = num(((part[name] ?? {}) as Row).count); if (count !== null) counts[`${channel}.${name}`] = count; }
    if (text(part.status)) statuses[channel] = text(part.status).toUpperCase();
  }
  for (const key of Object.keys(RATE_LABELS)) { const status = text(((metrics[key] ?? {}) as Row).status); if (status) statuses[key] = status.toUpperCase(); }
  const warnings = num(((metrics.policyViolationWarnings ?? {}) as Row).warningsCount);
  if (warnings !== null) counts.policyViolationWarnings = warnings;
  const ahr = (metrics.accountHealthRating ?? {}) as Row;
  const afn = (odr.afn ?? {}) as Row;
  return {
    marketplaceId: text(account.marketplaceId) || marketplaceId, status: text(account.status).toUpperCase(), ahrStatus: text(ahr.ahrStatus).toUpperCase(), ahrScore: num(ahr.ahrScore),
    counts, statuses, odrRate: num(afn.rate), odrOrders: num(afn.orderCount), reportingTo: text(((ahr.reportingDateRange ?? {}) as Row).reportingDateTo),
  };
}

const statusName = (value: string): string => ACCOUNT_STATUS_LABELS[value] ? `${ACCOUNT_STATUS_LABELS[value]}（${value}）` : value || "未知";

// 首份报告只建基线，但已有问题照样提醒；之后报状态变化、评分降级或下降 ≥ ahrDrop、计数上升、指标状态变差。计数因滚动窗口下降不单独提醒。
export function accountLines(previous: AccountFacts | undefined, next: AccountFacts, settings: StoreHealthSettings): string[] {
  const lines: string[] = [];
  if (!previous) {
    if (next.status && next.status !== "NORMAL") lines.push(`⚠️ 账户状态：${statusName(next.status)}`);
    if (!FINE_AHR.has(next.ahrStatus)) lines.push(`⚠️ 账户健康评分：${next.ahrScore ?? "—"}（${next.ahrStatus}）`);
    for (const [key, count] of Object.entries(next.counts)) if (count > 0) lines.push(`⚠️ ${metricLabel(key)}：${count}`);
    for (const [key, status] of Object.entries(next.statuses)) if (!FINE_METRIC.has(status)) lines.push(`⚠️ ${metricLabel(key)}：状态 ${status}`);
    return lines;
  }
  if (next.status && next.status !== previous.status) lines.push(`${next.status === "NORMAL" ? "✅" : "⚠️"} 账户状态：${statusName(previous.status)} → ${statusName(next.status)}`);
  const drop = previous.ahrScore !== null && next.ahrScore !== null ? previous.ahrScore - next.ahrScore : 0;
  if (next.ahrStatus && next.ahrStatus !== previous.ahrStatus) lines.push(`${FINE_AHR.has(next.ahrStatus) ? "✅" : "⚠️"} 账户健康评分：${previous.ahrScore ?? "—"} → ${next.ahrScore ?? "—"}（${previous.ahrStatus || "—"} → ${next.ahrStatus}）`);
  else if (drop >= settings.ahrDrop) lines.push(`⚠️ 账户健康评分：${previous.ahrScore} → ${next.ahrScore}（${next.ahrStatus || "—"}）`);
  for (const [key, count] of Object.entries(next.counts)) { const before = previous.counts[key] ?? 0; if (count > before) lines.push(`⚠️ ${metricLabel(key)}：${before} → ${count}`); }
  for (const [key, status] of Object.entries(next.statuses)) { const before = previous.statuses[key] ?? ""; if (status !== before && !FINE_METRIC.has(status)) lines.push(`⚠️ ${metricLabel(key)}：状态 ${before || "—"} → ${status}`); }
  return lines;
}

// 中台用：当前不正常的项（账户状态、评分、非 0 计数、变差的指标）。
export function accountIssues(facts: AccountFacts | undefined): string[] {
  if (!facts) return [];
  const issues: string[] = [];
  if (facts.status && facts.status !== "NORMAL") issues.push(`账户${ACCOUNT_STATUS_LABELS[facts.status] ?? facts.status}`);
  if (!FINE_AHR.has(facts.ahrStatus)) issues.push(`健康评分 ${facts.ahrScore ?? "—"}（${facts.ahrStatus}）`);
  for (const [key, count] of Object.entries(facts.counts)) if (count > 0) issues.push(`${metricLabel(key)} ${count}`);
  for (const [key, status] of Object.entries(facts.statuses)) if (!FINE_METRIC.has(status)) issues.push(`${metricLabel(key)} ${status}`);
  return issues;
}

// ---------- Listing ----------

export interface IssueFact { code: string; severity: string; actions: string[]; attributes: string[]; message: string }
export interface ListingFact { asin: string; statuses: string[]; issues: Record<string, IssueFact>; lostAt?: string; newIssues?: Record<string, string> }
export interface ListingDiff { lines: string[]; skus: Record<string, ListingFact>; baseline: boolean }

const ACTION_LABELS: Record<string, string> = { LISTING_SUPPRESSED: "压制", ATTRIBUTE_SUPPRESSED: "属性被屏蔽", CATALOG_ITEM_REMOVED: "商品被移除", SEARCH_SUPPRESSED: "搜索屏蔽" };
const stripUrls = (value: string): string => value.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
const isBuyable = (fact: ListingFact | undefined): boolean => !!fact?.statuses.includes("BUYABLE");

// 指纹：问题码、级别、动作、属性名，加去掉数字与网址的英文描述前 100 字（截止日期变了不算新问题，新的文件类型算）。
export function issueFingerprint(issue: IssueFact): string {
  const message = stripUrls(issue.message).toLowerCase().replace(/\d+/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
  return sha256([issue.code, issue.severity, [...issue.actions].sort().join("/"), [...issue.attributes].sort().join("/"), message].join("|")).slice(0, 16);
}

export function describeIssue(issue: IssueFact): string {
  const actions = issue.actions.map((action) => ACTION_LABELS[action] ?? action).join("、");
  const deadline = /\bby (\d{4}-\d{2}-\d{2})/i.exec(issue.message)?.[1];
  return `${issue.code}${actions ? `（${actions}）` : ""} ${stripUrls(issue.message).slice(0, 120)}${deadline ? `｜截止 ${deadline}` : ""}`;
}

export function listingFacts(items: Row[], marketplaceId: string): Record<string, ListingFact> {
  const output: Record<string, ListingFact> = {};
  for (const item of items) {
    const sku = text(item.sku);
    if (!sku) continue;
    const summaries = list(item.summaries);
    const summary = summaries.find((entry) => text(entry.marketplaceId) === marketplaceId) ?? summaries[0] ?? {};
    const issues: Record<string, IssueFact> = {};
    for (const raw of list(item.issues)) {
      const issue: IssueFact = {
        code: text(raw.code), severity: text(raw.severity).toUpperCase(),
        actions: list(((raw.enforcements ?? {}) as Row).actions).map((action) => text(action.action).toUpperCase()).filter(Boolean),
        attributes: (Array.isArray(raw.attributeNames) ? raw.attributeNames : []).map(text).filter(Boolean),
        message: text(raw.message).slice(0, 300),
      };
      issues[issueFingerprint(issue)] = issue;
    }
    output[sku] = { asin: text(summary.asin).toUpperCase(), statuses: (Array.isArray(summary.status) ? summary.status : []).map((status) => text(status).toUpperCase()).filter(Boolean), issues };
  }
  return output;
}

export async function fetchListingFacts(amazon: AmazonClient, sellerId: string, marketplaceId: string): Promise<Record<string, ListingFact>> {
  const items: Row[] = [];
  let pageToken = "";
  for (let page = 0; page < 50; page += 1) {
    const response = await amazon.sp<JsonObject>(`/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`, { query: { marketplaceIds: marketplaceId, includedData: "summaries,issues", pageSize: 20, ...(pageToken ? { pageToken } : {}) }, pace: LISTINGS_PACE });
    items.push(...list(response.items));
    pageToken = text(((response.pagination ?? {}) as Row).nextToken);
    if (!pageToken) break;
  }
  return listingFacts(items, marketplaceId);
}

// 首轮只建基线。之后：原在售变不可售（含查不到）、提醒过的恢复在售、在售（本轮或上轮）款新增 ERROR 级问题。
// WARNING/INFO、不在售款的问题变化、问题消失只记录。lostAt 与 newIssues 留给中台展示当前问题。
export function diffListings(label: string, previous: Record<string, ListingFact> | undefined, current: Record<string, ListingFact>, at: string): ListingDiff {
  if (!previous) return { lines: [], skus: current, baseline: true };
  const lines: string[] = [];
  const skus: Record<string, ListingFact> = {};
  for (const sku of [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort()) {
    const before = previous[sku];
    const now = current[sku];
    const was = isBuyable(before), is = isBuyable(now);
    if (!now && !was) continue;
    const fresh: Array<[string, IssueFact]> = [];
    const newIssues: Record<string, string> = {};
    for (const [fingerprint, issue] of Object.entries(now?.issues ?? {})) {
      const since = before?.newIssues?.[fingerprint];
      if (since) newIssues[fingerprint] = since;
      else if (!before?.issues[fingerprint] && (is || was) && issue.severity === "ERROR") { newIssues[fingerprint] = at; fresh.push([fingerprint, issue]); }
    }
    let lostAt = is ? undefined : before?.lostAt;
    if (was && !is) {
      lostAt = at;
      const known = fresh.length ? [] : Object.values(now?.issues ?? {}).filter((issue) => issue.severity === "ERROR").slice(0, 2).map((issue) => `${issue.code}${issue.actions.length ? `（${issue.actions.map((action) => ACTION_LABELS[action] ?? action).join("、")}）` : ""}`);
      lines.push(`⚠️ ${label} ${sku}：不可售了（原在售）${now ? "" : "，listing 已查不到"}${known.length ? `｜现有问题 ${known.join("、")}` : ""}`);
    }
    if (is && !was && before?.lostAt) lines.push(`✅ ${label} ${sku}：恢复在售`);
    for (const [, issue] of fresh) lines.push(`⚠️ ${label} ${sku}：新问题 ${describeIssue(issue)}`);
    skus[sku] = { asin: now?.asin || before?.asin || "", statuses: now?.statuses ?? [], issues: now?.issues ?? {}, ...(lostAt ? { lostAt } : {}), ...(Object.keys(newIssues).length ? { newIssues } : {}) };
  }
  return { lines, skus, baseline: false };
}

export interface ListingProblem { market: string; sku: string; asin: string; kind: "not-buyable" | "issue"; text: string; since: string }

export function listingProblems(label: string, skus: Record<string, ListingFact>): ListingProblem[] {
  const output: ListingProblem[] = [];
  for (const [sku, fact] of Object.entries(skus)) {
    if (fact.lostAt) output.push({ market: label, sku, asin: fact.asin, kind: "not-buyable", text: "不可售（原在售）", since: fact.lostAt });
    for (const [fingerprint, since] of Object.entries(fact.newIssues ?? {})) { const issue = fact.issues[fingerprint]; if (issue) output.push({ market: label, sku, asin: fact.asin, kind: "issue", text: describeIssue(issue), since }); }
  }
  return output;
}

// ---------- 高退货率处理费 ----------

export interface HrrNotice { key: string; asin: string; amount: number; window: string; at: string }

const laMonthDay = (iso: string): string => { const ms = Date.parse(iso); return Number.isFinite(ms) ? ymdInZone(new Date(ms), "America/Los_Angeles").slice(5).replace("-", "/") : ""; };

export function hrrNotices(records: FeishuRecord[]): HrrNotice[] {
  const output: HrrNotice[] = [];
  for (const record of records) {
    const key = feishuFieldText(record.fields["流水唯一键"]);
    const amount = num(feishuFieldText(record.fields["原币金额"]));
    if (!key || amount === null) continue;
    let detail: Row = {};
    try { detail = auditDecode<Row>(feishuFieldText(record.fields["金额明细"])); } catch { detail = {}; }
    const contexts = list(list(detail.items)[0]?.contexts);
    const product = contexts.find((context) => text(context.contextType) === "ProductContext");
    const range = contexts.find((context) => text(context.contextType) === "TimeRangeContext");
    const posted = num(feishuFieldText(record.fields["交易时间"]));
    output.push({ key, asin: text(product?.asin).toUpperCase(), amount, window: range ? `${laMonthDay(text(range.startTime))}~${laMonthDay(text(range.endTime))}` : "", at: posted === null ? "" : new Date(posted).toISOString() });
  }
  return output;
}

export function hrrLine(notice: HrrNotice, skus: string[]): string {
  const who = skus.length ? `${skus.join("/")}（${notice.asin}）` : notice.asin || "未知商品";
  return `⚠️ ${who} 退货率超过类目阈值${notice.window ? `（统计 ${notice.window}）` : ""}，亚马逊收高退货率处理费 $${Math.abs(notice.amount).toFixed(2)}`;
}

// ---------- 任务 ----------

// now：本轮的业务时间；clock：报告轮询预算用的时钟（测试里随 sleep 前进）。
export interface StoreHealthDeps { now?: () => number; clock?: () => number; sleep?: (ms: number) => Promise<void> }
interface Part { lines: string[]; writes: Row[]; after?: () => Promise<void>; summary: JsonObject }

async function accountPart(amazon: AmazonClient, state: StateStore, settings: StoreHealthSettings, now: number, deps: StoreHealthDeps): Promise<Part> {
  const saved = await state.get(STORE_HEALTH_PK, "account");
  const pending = (saved?.pending ?? {}) as Row;
  let reportId = text(pending.reportId);
  if (reportId && !(now - Date.parse(text(pending.requestedAt)) <= ACCOUNT_PENDING_MAX_MS)) reportId = "";
  const fetchedAt = Date.parse(text(saved?.fetchedAt));
  const due = !Number.isFinite(fetchedAt) || now - fetchedAt >= settings.accountHours * HOUR;
  if (!reportId && !due) return { lines: [], writes: [], summary: { account: "not-due" } };
  const base = { ...(saved ?? {}), pk: STORE_HEALTH_PK, sk: "account" };
  if (!reportId) {
    reportId = await createReport(amazon, { reportType: ACCOUNT_REPORT_TYPE, marketplaceIds: [MARKETPLACE_US] });
    await state.put({ ...base, pending: { reportId, requestedAt: new Date(now).toISOString() }, updatedAt: new Date().toISOString() });
  }
  const outcome = await awaitReport(amazon, reportId, { budgetMs: ACCOUNT_POLL_BUDGET_MS, intervalMs: ACCOUNT_POLL_INTERVAL_MS, ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.clock ? { now: deps.clock } : {}) });
  if (outcome.status === "pending") return { lines: [], writes: [], summary: { account: "pending", reportId } };
  const { pending: _pending, ...rest } = base as Row;
  if (outcome.status !== "done") {
    await state.put({ ...rest, lastError: `${outcome.status}${outcome.detail ? `：${outcome.detail.slice(0, 200)}` : ""}`, lastErrorAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    log("WARN", "store_health_account_report_failed", { reportId, status: outcome.status });
    return { lines: [], writes: [], summary: { account: outcome.status, reportId } };
  }
  const facts = parseAccountHealth(JSON.parse(outcome.body) as Row);
  const previous = saved?.facts as AccountFacts | undefined;
  const lines = accountLines(previous, facts, settings);
  const { lastError: _error, lastErrorAt: _errorAt, ...clean } = rest;
  return {
    lines, summary: { account: "fetched", reportId, ahrScore: facts.ahrScore ?? null, accountLines: lines.length },
    writes: [{ ...clean, facts, fetchedAt: new Date(now).toISOString(), reportId, updatedAt: new Date().toISOString() }],
    after: () => state.recordHealth("account-health", "done", { reportId, ahrStatus: facts.ahrStatus, ahrScore: facts.ahrScore ?? -1 }),
  };
}

async function hrrPart(config: AppConfig, state: StateStore, feishu: FeishuClient, today: string): Promise<Part> {
  const saved = await state.get(STORE_HEALTH_PK, "hrr");
  if (text(saved?.checkedDay) === today) return { lines: [], writes: [], summary: { hrr: "checked-today" } };
  const records = await feishu.searchRecords(config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS"), config.get("FEISHU_BITABLE_TABLE_ID_FINANCE_LEDGER"), { "原始描述": HRR_DESCRIPTION }, { fieldNames: ["流水唯一键", "原币金额", "交易时间", "金额明细"] });
  const notices = hrrNotices(records);
  const notified = { ...((saved?.notified ?? {}) as Record<string, string>) };
  const skusByAsin = new Map<string, string[]>();
  for (const mapping of config.asins()) if (mapping.asin) skusByAsin.set(mapping.asin.toUpperCase(), [...(skusByAsin.get(mapping.asin.toUpperCase()) ?? []), mapping.sku]);
  const lines: string[] = [];
  const at = new Date().toISOString();
  for (const notice of notices) {
    if (notified[notice.key]) continue;
    notified[notice.key] = at;
    // 首轮（没有状态）把已有的记为已提醒，不补发；$0 记录（亚马逊的提示行）不提醒。
    if (saved && notice.amount !== 0) lines.push(hrrLine(notice, skusByAsin.get(notice.asin) ?? []));
  }
  const recent = notices.filter((notice) => notice.amount !== 0).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5).map((notice) => ({ asin: notice.asin, skus: skusByAsin.get(notice.asin) ?? [], amount: notice.amount, window: notice.window, at: notice.at }));
  return { lines, summary: { hrr: notices.length, hrrLines: lines.length }, writes: [{ pk: STORE_HEALTH_PK, sk: "hrr", notified, recent, checkedDay: today, ...(saved ? {} : { baselineAt: at }), updatedAt: at }] };
}

export async function runStoreHealth(event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient, deps: StoreHealthDeps = {}): Promise<JsonObject> {
  if (!config.bool("STORE_HEALTH_ENABLED", true)) return { status: "done", disabled: true };
  const now = deps.now?.() ?? Date.now();
  const at = new Date(now).toISOString();
  const settings = storeHealthSettings(config);
  const own = config.get("SP_API_SELLER_ID");
  const markets = watchedMarkets(config);
  const failures: string[] = [];
  const lines: string[] = [];
  const writes: Row[] = [];
  const problems: ListingProblem[] = [];
  let baselines = 0;
  for (const marketplaceId of markets) {
    const label = OFFER_MARKETS[marketplaceId]?.label ?? marketplaceId;
    const saved = await state.get(STORE_HEALTH_PK, `listings|${marketplaceId}`);
    try {
      const current = await fetchListingFacts(amazon, own, marketplaceId);
      const diff = diffListings(label, saved?.skus as Record<string, ListingFact> | undefined, current, at);
      if (diff.baseline) baselines += 1;
      lines.push(...diff.lines);
      problems.push(...listingProblems(label, diff.skus));
      writes.push({ pk: STORE_HEALTH_PK, sk: `listings|${marketplaceId}`, skus: diff.skus, checkedAt: at, baselineAt: text(saved?.baselineAt) || at, updatedAt: at });
    } catch (error) {
      failures.push(`${OFFER_MARKETS[marketplaceId]?.code ?? marketplaceId}: ${errorText(error).slice(0, 200)}`);
      if (saved?.skus) problems.push(...listingProblems(label, saved.skus as Record<string, ListingFact>));
    }
  }
  let account: Part = { lines: [], writes: [], summary: {} };
  try { account = await accountPart(amazon, state, settings, now, deps); }
  catch (error) { failures.push(`account: ${errorText(error).slice(0, 200)}`); }
  let hrr: Part = { lines: [], writes: [], summary: {} };
  try { hrr = await hrrPart(config, state, feishu, ymdInZone(new Date(now), "Asia/Shanghai")); }
  catch (error) { failures.push(`hrr: ${errorText(error).slice(0, 200)}`); }

  const message = [...account.lines, ...lines, ...hrr.lines];
  // 先持久化通知意图，再写状态，再发送；键含北京日期与内容摘要，状态没写成功时重跑不会重复发。
  const eventKey = message.length ? `store-health|${ymdInZone(new Date(now), "Asia/Shanghai")}|${sha256(message.join("\n")).slice(0, 16)}` : "";
  const prepared: PreparedNotification | undefined = message.length ? await prepareNotification(config, state, eventKey, ["🩺 店铺健康", ...message, FOOTER]) : undefined;
  for (const item of [...account.writes, ...writes, ...hrr.writes]) await state.put(item);
  const savedAccount = account.writes[0] ?? await state.get(STORE_HEALTH_PK, "account");
  const facts = savedAccount?.facts as AccountFacts | undefined;
  await state.put({
    pk: STORE_HEALTH_PK, sk: "summary", updatedAt: at,
    account: facts ? { status: facts.status, ahrStatus: facts.ahrStatus, ahrScore: facts.ahrScore, issues: accountIssues(facts), fetchedAt: text(savedAccount?.fetchedAt), reportingTo: facts.reportingTo } : null,
    listings: problems.slice(0, 50) as unknown as JsonObject[],
    hrr: ((hrr.writes[0] ?? await state.get(STORE_HEALTH_PK, "hrr"))?.recent ?? []) as JsonObject[],
  });
  await account.after?.();
  const sent = eventKey ? await flushNotification(state, feishu, eventKey, prepared) : "none";
  if (failures.length) log("WARN", "store_health_partial", { failures: failures.length, detail: failures.join("; ").slice(0, 300) });
  if (markets.length && failures.filter((item) => !/^(account|hrr):/.test(item)).length === markets.length) throw new Error(`店铺健康：所有站点 listing 都没查成功：${failures.join("；")}`);
  return { status: "done", markets: markets.length, baselines, listingLines: lines.length, problems: problems.length, ...account.summary, ...hrr.summary, notified: sent === "sent", failures: failures.length, ...(failures.length ? { failureDetail: failures.join("；").slice(0, 300) } : {}) };
}
