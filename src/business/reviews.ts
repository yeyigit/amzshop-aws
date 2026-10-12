import type { AppConfig, FeishuRecord, JobEvent, JsonObject } from "../types.js";
import { AmazonClient, type Pace } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { ensureOneTimeSchedule } from "../scheduling.js";
import { HttpError } from "../http.js";
import { deliverNotification } from "../notifications.js";
import { log } from "../log.js";
import { errorText, feishuFieldText, nowIso, sha256, ymdInZone } from "../util.js";

type Row = Record<string, unknown>;
type Counts = Record<string, number>;
const DAY = 86_400_000;
const SITES: Array<[string, string]> = [["ATVPDKIKX0DER", "US"], ["A2EUQ1WTGCTBG2", "CA"], ["A1AM78C64UM0Y8", "MX"]];
const siteOf = new Map(SITES);
export const REVIEW_ANCHOR_MS = Date.parse("2026-09-14T17:00:00.000Z");
export const REVIEW_PERIOD_MS = 15 * DAY;
// 资格窗口按送达基准满 5 天、不超过 25 天：宽于 15 天周期，首批 Amazon 尚不可邀的订单下一批再试一次（2026-09-29 用户批准由 20 放宽）。
export const REVIEW_MIN_AGE_DAYS = 5;
export const REVIEW_MAX_AGE_DAYS = 25;
// Finances listTransactions 0.5 次/秒（与 Finance 共用 key）；Solicitations GET/POST 各 1 次/秒。
export const REVIEW_PACE: Record<"finances" | "actions" | "post", Pace> = { finances: { key: "finances:listTransactions", minIntervalMs: 2_100 }, actions: { key: "solicitations-get", minIntervalMs: 1_100 }, post: { key: "solicitations-post", minIntervalMs: 1_100 } };
// 单片 10 分钟（Jobs 超时 900 秒），为最后一个候选订单的飞书/Finances 有限重试留足余量。
const SLICE_MS = 10 * 60_000;
export const REVIEW_TOKEN_MAX_AGE_MS = 23 * 3_600_000;
const RATE_LIMIT_WAIT_MS = 5 * 60_000;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
const text = (value: unknown): string => String(value ?? "").trim();
const emptyCounts = (): Counts => ({ checked: 0, success: 0, wouldSend: 0, alreadyInvited: 0, resultUnknown: 0, refunded: 0, outsideWindow: 0, cancelled: 0, amazonIneligible: 0, dataInsufficient: 0, requestFailed: 0 });
const rateLimited = (error: unknown): boolean => error instanceof HttpError && error.status === 429;
const hashOf = (orderId: string): string => sha256(orderId).slice(0, 8);
const statusText = (record: FeishuRecord): string => feishuFieldText(record.fields["邀评状态"]);
const beijingTime = (ms: number): string => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(ms));

// POST 之后（或 REVIEW/飞书已写入之后）的错误不能按单订单失败吞掉：交给任务重试，由 REVIEW 记录恢复且永不重复 POST。
class SideEffectError extends Error {}

type PostOutcome = { kind: "sent" } | { kind: "throttled" } | { kind: "rejected"; status: number } | { kind: "uncertain" | "unknown"; reason: string };

function marketplaceOf(order: Row): string {
  return text(((order.salesChannel ?? {}) as Row).marketplaceId ?? order.marketplaceId);
}

// 送达基准优先 deliverByWindow.latestDateTime；Amazon 履约订单缺送达窗口时以 createdTime 作保守上界（实际送达必晚于创建）；商家履约缺窗口为数据不足。
export function reviewEligibility(order: Row, now: number): { category: string; basis?: string; at?: string; fulfilledBy?: string } {
  const fulfillment = (order.fulfillment ?? {}) as Row;
  const status = text(fulfillment.fulfillmentStatus ?? order.orderStatus).toUpperCase();
  if (status === "CANCELLED" || status === "CANCELED") return { category: "cancelled" };
  const fulfilledBy = text(fulfillment.fulfilledBy).toUpperCase();
  const delivery = text(((fulfillment.deliverByWindow ?? {}) as Row).latestDateTime);
  const at = delivery || (fulfilledBy === "AMAZON" ? text(order.createdTime) : "");
  const ageDays = (now - Date.parse(at)) / DAY;
  if (!at || !Number.isFinite(ageDays)) return { category: "dataInsufficient" };
  return { category: ageDays >= REVIEW_MIN_AGE_DAYS && ageDays <= REVIEW_MAX_AGE_DAYS ? "candidate" : "outsideWindow", basis: delivery ? "DELIVERY_WINDOW" : "FBA_CREATED_TIME_UPPER_BOUND", at, fulfilledBy };
}

export function isReviewAnchor(value: unknown): boolean {
  const at = Date.parse(text(value));
  return Number.isFinite(at) && at >= REVIEW_ANCHOR_MS && (at - REVIEW_ANCHOR_MS) % REVIEW_PERIOD_MS === 0;
}

export function nextAnchor(after: Date): Date {
  const steps = Math.max(1, Math.floor((after.getTime() - REVIEW_ANCHOR_MS) / REVIEW_PERIOD_MS) + 1);
  return new Date(REVIEW_ANCHOR_MS + steps * REVIEW_PERIOD_MS);
}

export function reviewSummary(input: { counts: Counts; sites: Record<string, Counts>; startedAt: string; dryRun: boolean; truncatedAt?: number }): string[] {
  const { counts: c, sites: s } = input;
  const start = Date.parse(input.startedAt);
  const site = (code: string): string => `${code} ${s[code]?.checked ?? 0}/${s[code]?.success ?? 0}`;
  return [
    input.dryRun ? "🔎 自动邀评只读预演" : "✅ 自动邀评汇总",
    `送达范围：${ymdInZone(new Date(start - REVIEW_MAX_AGE_DAYS * DAY), "Asia/Shanghai")} 至 ${ymdInZone(new Date(start - REVIEW_MIN_AGE_DAYS * DAY), "Asia/Shanghai")}`,
    `站点：${SITES.map(([, code]) => site(code)).join("，")}`,
    `检查数：${c.checked ?? 0}；成功数：${c.success ?? 0}${input.dryRun ? `；预演可邀：${c.wouldSend ?? 0}` : ""}`,
    `已邀：${c.alreadyInvited ?? 0}；结果待核实：${c.resultUnknown ?? 0}；退款：${c.refunded ?? 0}；超窗：${c.outsideWindow ?? 0}`,
    `取消：${c.cancelled ?? 0}；Amazon 判定不可邀：${c.amazonIneligible ?? 0}；数据不足：${c.dataInsufficient ?? 0}；请求失败：${c.requestFailed ?? 0}`,
    ...(input.truncatedAt ? [`按 maxCandidates=${input.truncatedAt} 抽样后提前结束`] : []),
  ];
}

async function refunded(amazon: AmazonClient, orderId: string, marketplaceId: string): Promise<boolean> {
  let nextToken = "";
  const seen = new Set<string>();
  do {
    const response = await amazon.sp<JsonObject>("/finances/2024-06-19/transactions", { query: { marketplaceId, relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: orderId, ...(nextToken ? { nextToken } : {}) }, pace: REVIEW_PACE.finances });
    const payload = (response.payload ?? response) as JsonObject;
    if (rows(payload.transactions).some((transaction) => /refund/i.test(`${text(transaction.transactionType)} ${text(transaction.description)}`))) return true;
    nextToken = text(payload.nextToken);
    if (nextToken && seen.has(nextToken)) throw new Error("邀评退款查询 nextToken 重复。 ");
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return false;
}

async function actionHref(amazon: AmazonClient, orderId: string, marketplaceId: string): Promise<string> {
  const response = await amazon.sp<JsonObject>(`/solicitations/v1/orders/${encodeURIComponent(orderId)}`, { query: { marketplaceIds: marketplaceId }, pace: REVIEW_PACE.actions });
  const links = (response._links ?? {}) as JsonObject;
  const match = rows(links.actions).find((item) => text(item.name) === "productReviewAndSellerFeedback");
  return text(match?.href);
}

function safePath(href: string, orderId: string, marketplaceId: string): string {
  const url = new URL(href, "https://sellingpartnerapi-na.amazon.com");
  const expected = `/solicitations/v1/orders/${encodeURIComponent(orderId)}/solicitations/productReviewAndSellerFeedback`;
  if (url.pathname !== expected || url.searchParams.get("marketplaceIds") !== marketplaceId) throw new Error("Solicitations action href 不符合当前订单与站点。 ");
  return `${url.pathname}${url.search}`;
}

// 201=已发送；429=未受理可稍后重试；其它 4xx=明确拒绝；超时/网络/5xx/非 201 的 2xx=结果不明。
async function post(amazon: AmazonClient, path: string): Promise<PostOutcome> {
  try {
    const status = await amazon.spStatus(path, { method: "POST", pace: REVIEW_PACE.post });
    return status === 201 ? { kind: "sent" } : { kind: "uncertain", reason: `HTTP ${status}` };
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) return { kind: "throttled" };
    if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408) return { kind: "rejected", status: error.status };
    return { kind: "uncertain", reason: error instanceof HttpError ? `HTTP ${error.status}` : errorText(error).slice(0, 200) };
  }
}

export async function runReviews(event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient, schedule = ensureOneTimeSchedule): Promise<JsonObject> {
  const taskId = event.taskId ?? `review|${event.scheduledAt ?? nowIso()}`;
  const saved = await state.task("review", taskId);
  const progress = (saved?.state ?? {}) as Row;
  if (saved?.status === "done") return { status: "done", taskId, alreadyDone: true, counts: (progress.counts ?? {}) as JsonObject };
  const dryRun = event.dryRun === true || progress.dryRun === true;
  if (dryRun && taskId.startsWith("review|") && isReviewAnchor(taskId.slice("review|".length))) return { status: "rejected", taskId, reason: "dryRun 不得使用正式锚点 taskId，以免占用正式批次身份。" };
  const scheduledAt = text(progress.scheduledAt) || text(event.scheduledAt);
  const startedAt = text(progress.startedAt) || nowIso();
  const start = Date.parse(startedAt);
  const maxCandidates = dryRun ? Math.max(0, Math.floor(Number(progress.maxCandidates ?? event.cursor?.maxCandidates ?? 0)) || 0) : 0;
  let nextAnchorAt = text(progress.nextAnchor);
  // 固定锚点批次开跑先幂等创建下一期计划（同名计划重复创建无副作用），手动批次与 dryRun 不改自动计划。
  if (!dryRun && !nextAnchorAt && isReviewAnchor(scheduledAt)) {
    const next = nextAnchor(new Date(scheduledAt));
    await schedule({ taskType: "review", taskId: `review|${next.toISOString()}`, scheduledAt: next.toISOString() }, next);
    nextAnchorAt = next.toISOString();
  }
  // searchOrders 要求 createdBefore 至少早于当前 2 分钟；扫描近 30 天创建的订单。
  const scanEnd = text(progress.scanEnd) || new Date(start - 3 * 60_000).toISOString();
  const scanStart = text(progress.scanStart) || new Date(start - 30 * DAY).toISOString();
  let nextToken = text(progress.nextToken);
  let nextTokenAt = text(progress.nextTokenAt);
  let orderIndex = Number(progress.orderIndex ?? 0);
  // searchOrders 分页令牌 24 小时过期：保存超过 23 小时（旧断点无取得时间时按批次开始时间保守估计）即丢弃，从本批第一页重扫；
  // 已处理订单由 seen 与 REVIEW 记录跳过，不会重复 POST。
  if (nextToken && !(Date.now() - (Date.parse(nextTokenAt) || start) <= REVIEW_TOKEN_MAX_AGE_MS)) {
    log("WARN", "review_page_token_expired", { taskId, tokenAt: nextTokenAt || startedAt });
    nextToken = "";
    nextTokenAt = "";
    orderIndex = 0;
  }
  let complete = progress.complete === true;
  let truncated = progress.truncated === true;
  let candidates = Number(progress.candidates ?? 0);
  const counts: Counts = { ...emptyCounts(), ...((progress.counts ?? {}) as Counts) };
  const sites: Record<string, Counts> = Object.fromEntries(SITES.map(([, code]) => [code, { checked: 0, success: 0, wouldSend: 0, ...(((progress.sites ?? {}) as Record<string, Counts>)[code] ?? {}) }]));
  const seen = new Set(text(progress.seen).match(/.{8}/g) ?? []);
  const wouldSendOrders = Array.isArray(progress.wouldSendOrders) ? progress.wouldSendOrders.map(String) : [];
  const snapshot = (): JsonObject => ({
    scanStart, scanEnd, startedAt, scheduledAt, dryRun, nextToken, ...(nextToken && nextTokenAt ? { nextTokenAt } : {}), orderIndex, complete, truncated, candidates, counts, sites, seen: [...seen].join(""),
    ...(maxCandidates ? { maxCandidates } : {}), ...(nextAnchorAt ? { nextAnchor: nextAnchorAt } : {}), ...(dryRun ? { wouldSendOrders } : {}),
  });
  const save = (status = "active", nextAt?: string): Promise<void> => state.saveTask("review", taskId, snapshot(), status, nextAt);
  const later = async (delayMs: number, status: string): Promise<JsonObject> => {
    const nextAt = new Date(Date.now() + delayMs);
    await save("active", nextAt.toISOString());
    await schedule({ taskType: "review", taskId, ...(event.scheduledAt ? { scheduledAt: event.scheduledAt } : {}), ...(dryRun ? { dryRun: true } : {}), ...(event.cursor ? { cursor: event.cursor } : {}) }, nextAt);
    return { status, taskId, counts, nextAt: nextAt.toISOString() } as JsonObject;
  };
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const table = config.get("FEISHU_BITABLE_TABLE_ID_ORDERS");
  const localCheck = async (orderId: string): Promise<string | FeishuRecord[]> => {
    const records = await feishu.searchRecords(app, table, { "订单编号": orderId });
    if (!records.length) return "dataInsufficient";
    if (records.some((record) => /已发送/.test(statusText(record)))) return "alreadyInvited";
    if (records.some((record) => /结果待核实/.test(statusText(record)))) return "resultUnknown";
    if (records.some((record) => /^(是|true|yes|1|已退款)$/i.test(feishuFieldText(record.fields["已退款"])))) return "refunded";
    return records;
  };
  const mark = async (records: FeishuRecord[], fields: Record<string, unknown>, settled: RegExp): Promise<void> => {
    for (const record of records) if (!settled.test(statusText(record))) await feishu.update(app, table, record.record_id, fields);
  };
  // 已有本地邀评记录：sent 补写飞书且本批次写入的计为成功；posting/unknown 永不再 POST；rejected 不重试。
  const settlePrior = async (prior: Row, orderId: string): Promise<string> => {
    const status = text(prior.status);
    const repair = async (fields: Record<string, unknown>, settled: RegExp): Promise<void> => {
      if (dryRun) return;
      try { await mark(await feishu.searchRecords(app, table, { "订单编号": orderId }), fields, settled); }
      catch (error) { log("WARN", "review_feishu_repair_failed", { taskId, orderId, error: errorText(error).slice(0, 200) }); }
    };
    if (status === "sent") {
      await repair({ "邀评状态": "已发送", "邀评时间": beijingTime(Date.parse(text(prior.sentAt)) || Date.now()) }, /已发送/);
      return prior.taskId === taskId ? "success" : "alreadyInvited";
    }
    if (status === "rejected") return "requestFailed";
    if (status === "unknown" || !(Date.now() - Date.parse(text(prior.updatedAt)) < 30 * 60_000)) await repair({ "邀评状态": "结果待核实" }, /已发送|结果待核实/);
    return "resultUnknown";
  };
  const solicit = async (order: Row, orderId: string, marketplaceId: string, eligible: ReturnType<typeof reviewEligibility>, initialRecords: FeishuRecord[], initialHref: string): Promise<string> => {
    let records = initialRecords;
    const base = { pk: "REVIEW", sk: orderId, taskId, marketplaceId, eligibility: { basis: eligible.basis ?? "", at: eligible.at ?? "", fulfilledBy: eligible.fulfilledBy ?? "" } };
    const path = safePath(initialHref, orderId, marketplaceId);
    try { await state.put({ ...base, status: "posting", href: initialHref, attempts: 1, updatedAt: nowIso() }, "attribute_not_exists(pk)"); }
    catch (error) { if (error instanceof Error && error.name === "ConditionalCheckFailedException") return "resultUnknown"; throw error; }
    let outcome = await post(amazon, path);
    if (outcome.kind === "uncertain") {
      // 结果不明先重新 GET：action 仍在说明 POST 未落地，复核窗口/本地状态/退款后只重试一次；action 消失则结果待核实，永不再 POST。
      let again = "";
      try { again = await actionHref(amazon, orderId, marketplaceId); }
      catch (error) { log("WARN", "review_recheck_action_failed", { taskId, orderId, error: errorText(error).slice(0, 200) }); }
      if (!again) outcome = { kind: "unknown", reason: outcome.reason };
      else {
        const retryPath = safePath(again, orderId, marketplaceId);
        let category = "candidate";
        try {
          category = reviewEligibility(order, Date.now()).category;
          if (category === "candidate") {
            const local = await localCheck(orderId);
            if (typeof local === "string") category = local; else records = local;
          }
          if (category === "candidate" && await refunded(amazon, orderId, marketplaceId)) category = "refunded";
        } catch (error) { await state.delete("REVIEW", orderId); throw error; }
        if (category !== "candidate") { await state.delete("REVIEW", orderId); return category; }
        await state.put({ ...base, status: "posting", href: again, attempts: 2, firstError: outcome.reason, updatedAt: nowIso() });
        outcome = await post(amazon, retryPath);
        if (outcome.kind === "uncertain") outcome = { kind: "unknown", reason: outcome.reason };
      }
    }
    try {
      if (outcome.kind === "sent") {
        const sentAt = Date.now();
        await state.put({ ...base, status: "sent", sentAt: new Date(sentAt).toISOString(), updatedAt: nowIso() });
        await mark(records, { "邀评状态": "已发送", "邀评时间": beijingTime(sentAt) }, /已发送/);
        return "success";
      }
      if (outcome.kind === "throttled") {
        await state.delete("REVIEW", orderId);
        throw new HttpError(429, "QuotaExceeded", "", "邀评 POST 被限流，稍后重试。", true);
      }
      if (outcome.kind === "rejected") {
        await state.put({ ...base, status: "rejected", httpStatus: outcome.status, updatedAt: nowIso() });
        return "requestFailed";
      }
      await state.put({ ...base, status: "unknown", lastError: outcome.kind === "unknown" ? outcome.reason : "", updatedAt: nowIso() });
      await mark(records, { "邀评状态": "结果待核实" }, /已发送|结果待核实/);
      return "resultUnknown";
    } catch (error) {
      throw rateLimited(error) ? error : new SideEffectError(errorText(error), { cause: error });
    }
  };
  const checkCandidate = async (order: Row, orderId: string, marketplaceId: string, eligible: ReturnType<typeof reviewEligibility>): Promise<string> => {
    const prior = await state.get("REVIEW", orderId);
    if (text(prior?.status)) return settlePrior(prior!, orderId);
    const local = await localCheck(orderId);
    if (typeof local === "string") return local;
    if (await refunded(amazon, orderId, marketplaceId)) return "refunded";
    const href = await actionHref(amazon, orderId, marketplaceId);
    if (!href) return "amazonIneligible";
    if (dryRun) return "wouldSend";
    return solicit(order, orderId, marketplaceId, eligible, local, href);
  };
  const tally = (category: string, marketplaceId: string, orderId: string): void => {
    counts.checked = (counts.checked ?? 0) + 1;
    counts[category] = (counts[category] ?? 0) + 1;
    const site = sites[siteOf.get(marketplaceId) ?? ""];
    if (site) {
      site.checked = (site.checked ?? 0) + 1;
      if (category === "success" || category === "wouldSend") site[category] = (site[category] ?? 0) + 1;
    }
    if (orderId) seen.add(hashOf(orderId));
  };

  await save();
  const deadline = Date.now() + SLICE_MS;
  while (!complete) {
    if (Date.now() >= deadline) return later(60_000, "continuing");
    let response: JsonObject;
    try {
      response = await amazon.sp<JsonObject>("/orders/2026-01-01/orders", { query: { createdAfter: scanStart, createdBefore: scanEnd, marketplaceIds: SITES.map(([id]) => id).join(","), maxResultsPerPage: 100, includedData: "FULFILLMENT", ...(nextToken ? { paginationToken: nextToken } : {}) } });
    } catch (error) {
      if (rateLimited(error)) return later(RATE_LIMIT_WAIT_MS, "waiting_rate_limit");
      throw error;
    }
    if (!Array.isArray(response.orders)) throw new Error("Orders v2026 响应缺少 orders。 ");
    const page = rows(response.orders);
    for (; orderIndex < page.length; orderIndex += 1) {
      if (Date.now() >= deadline) return later(60_000, "continuing");
      const order = page[orderIndex]!;
      const orderId = text(order.orderId);
      if (orderId && seen.has(hashOf(orderId))) continue;
      const marketplaceId = marketplaceOf(order);
      if (!orderId || !siteOf.has(marketplaceId)) { tally("dataInsufficient", marketplaceId, orderId); continue; }
      const eligible = reviewEligibility(order, Date.now());
      if (eligible.category !== "candidate") { tally(eligible.category, marketplaceId, orderId); continue; }
      let category: string;
      try { category = await checkCandidate(order, orderId, marketplaceId, eligible); }
      catch (error) {
        if (rateLimited(error) || rateLimited((error as Error).cause)) return later(RATE_LIMIT_WAIT_MS, "waiting_rate_limit");
        if (error instanceof SideEffectError) throw (error.cause ?? error);
        log("WARN", "review_order_check_failed", { taskId, orderId, error: errorText(error).slice(0, 200) });
        category = "requestFailed";
      }
      tally(category, marketplaceId, orderId);
      candidates += 1;
      if (category === "wouldSend" && wouldSendOrders.length < 20) wouldSendOrders.push(orderId);
      if (maxCandidates && candidates >= maxCandidates) { truncated = true; complete = true; orderIndex += 1; break; }
    }
    if (!complete) {
      nextToken = text((response.pagination as Row | undefined)?.nextToken);
      nextTokenAt = nextToken ? nowIso() : "";
      orderIndex = 0;
      complete = !nextToken;
    }
    await save();
  }
  const summary = reviewSummary({ counts, sites, startedAt, dryRun, ...(truncated && maxCandidates ? { truncatedAt: maxCandidates } : {}) });
  if (dryRun) log("INFO", "review_dry_run_summary", { taskId, summary: summary.join(" | ") });
  else await deliverNotification(config, state, feishu, `review-summary|${isReviewAnchor(scheduledAt) ? new Date(scheduledAt).toISOString() : taskId}`, summary);
  await save("done");
  return { status: "done", taskId, counts, sites, summary, ...(dryRun ? { dryRun: true, wouldSendOrders } : {}), ...(truncated ? { truncated: true } : {}), ...(nextAnchorAt ? { nextAnchor: nextAnchorAt } : {}) } as JsonObject;
}
