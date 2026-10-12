import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { AppConfig, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { ensureOneTimeSchedule } from "../scheduling.js";
import { resendPendingNotifications, sweepLegacyNotifications, type ResendSummary } from "../notifications.js";
import { FEISHU_QUOTA_ALERT_KEY, FEISHU_QUOTA_ALERT_REPEAT_MS, beijingDay, monthCalls, quotaExhaustedLines } from "../feishu-quota.js";
import { isReviewAnchor } from "./reviews.js";
import { log } from "../log.js";
import { errorText, sha256 } from "../util.js";

type Row = Record<string, unknown>;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const ORPHAN_IDLE_MS = 20 * MINUTE;
export const WATCHDOG_REPEAT_MS = HOUR;
export const WATCHDOG_MAX_ATTEMPTS = 3;
export const ALERT_REPEAT_MS = 12 * HOUR;
export const LEGACY_SWEEP_INTERVAL_MS = 24 * HOUR;
// 日任务 26 小时、每小时任务（Pricing、Buy Box 巡检、报价对账、物流商轨迹）与每 30 分钟的订单商品小计补写 3 小时、邀评（每 15 天）16 天无成功即告警。
// 关键词跑飞排查（每日广告批次完成后触发，未到期也记成功）50 小时：每日任务失败时 ads-daily 先告警，避免同一故障报两遍。
// 竞品清单每 7 天在 14:00 竞品任务里刷新、失败次日重试：8 天 6 小时无成功＝连续两次每日尝试都失败。
// 单家物流商（forwarder-<物流商>）：有货件要查时 6 小时都没查成功即告警（没货件要查也记成功，不会误报）。
// 店铺报告（store-report，每天洛杉矶 00:15 推送与 01:45 刷新）：26 小时无成功即告警。
// 店铺健康（store-health，每小时）3 小时；其中账户健康报告（account-health，每 6 小时一份）26 小时没取到即告警；
// 库存健康（inventory-health，每天）与 SQP 任务（sqp，每天）26 小时；SQP 新一周数据（sqp-data）12 天没有即告警（正常每周一份，晚 3–5 天出）。
export const HEALTH_RULES: Record<string, number> = { shipment: 26 * HOUR, finance: 26 * HOUR, "order-reconcile": 26 * HOUR, inventory: 26 * HOUR, "ads-runaway": 50 * HOUR, "competitor-prices": 26 * HOUR, "ads-daily": 26 * HOUR, "ads-early": 26 * HOUR, pricing: 3 * HOUR, review: 16 * 24 * HOUR, payouts: 26 * HOUR, "traffic-alert": 26 * HOUR, "buybox-watch": 3 * HOUR, "offer-reconcile": 3 * HOUR, "brand-watch": 26 * HOUR, "offer-subscription": 26 * HOUR, "competitor-sets": 8 * 24 * HOUR + 6 * HOUR, "forwarder-tracking": 3 * HOUR, "forwarder-niuku": 6 * HOUR, "forwarder-jiufang": 6 * HOUR, "forwarder-meishe": 6 * HOUR, "order-prices": 3 * HOUR, "store-report": 26 * HOUR, "store-health": 3 * HOUR, "account-health": 26 * HOUR, "inventory-health": 26 * HOUR, sqp: 26 * HOUR, "sqp-data": 12 * 24 * HOUR };
const DAY = 24 * HOUR;
// Ads 刷新令牌：2026-07-30 起新授权的令牌自授权日起 365 天固定过期；第 335–365 天提醒重新授权。
export const ADS_TOKEN_WARN_FROM_DAY = 335;
export const ADS_TOKEN_LIFETIME_DAYS = 365;
// 飞书单表行数上限（免费版扩容后 2 万行，可用 FEISHU_TABLE_ROW_LIMIT 改）：达 80% 发一次，达 90% 起每天提醒。
export const FEISHU_ROW_LIMIT_DEFAULT = 20_000;
export const FEISHU_ROW_WARN_PERCENT = 80;
export const FEISHU_ROW_DAILY_PERCENT = 90;
// 配置了 FEISHU_MONTHLY_CALL_QUOTA 时，本月用量达 80% 提醒；其它函数记下的额度用尽在 2 小时内纳入维护邮件。
export const FEISHU_QUOTA_WARN_PERCENT = 80;
const QUOTA_REJECTION_RECENT_MS = 2 * HOUR;
const ARCHIVE_PLAN = "docs/模块说明.md「飞书容量与归档」";
const terminal = new Set(["done", "superseded", "deferred_to_daily", "disabled", "failed", "cancelled", "expired"]);
const text = (value: unknown): string => String(value ?? "").trim();
const time = (value: unknown): number => Date.parse(text(value));
const latest = (...values: unknown[]): number => Math.max(0, ...values.map(time).filter(Number.isFinite));
const iso = (ms: number): string => new Date(ms).toISOString();
const hours = (ms: number): string => (ms / HOUR).toFixed(1);

// info：定期报告（如月度飞书用量），不算问题。
export interface Issue { key: string; line: string; info?: boolean }
export interface WatchdogResult { checked: number; revived: string[]; exhausted: string[] }
export interface MaintenanceDeps { now?: () => number; schedule?: typeof ensureOneTimeSchedule; publish?: (topicArn: string, subject: string, message: string) => Promise<void>; topicArn?: string }
interface WatchSource { module: string; prefix: string; limit: number; jobTypes: (item: Row) => string[]; event: (item: Row) => JobEvent | undefined }

function adsMode(item: Row, fallback: "DAILY" | "EARLY"): "DAILY" | "EARLY" {
  const mode = text((item.state as Row | undefined)?.mode).toUpperCase();
  return mode === "EARLY" || mode === "DAILY" ? mode : fallback;
}

// 邀评只接续固定锚点的正式批次，且断点明确记录 dryRun=false；手动批次、dryRun 与迁移遗留任务永不自动接续。
function reviewEvent(item: Row): JobEvent | undefined {
  const taskId = text(item.sk);
  const progress = (item.state ?? {}) as Row;
  const scheduledAt = text(progress.scheduledAt) || taskId.slice("review|".length);
  if (progress.dryRun !== false || !isReviewAnchor(scheduledAt)) return undefined;
  return { taskType: "review", taskId, scheduledAt };
}

// Finance 只看每日/旧链任务（finance| 前缀）；唤醒任务（finance-wake|）数量随通知增长，由每日任务兜底，不逐小时整分区扫描。
const sources: WatchSource[] = [
  { module: "finance", prefix: "finance|", limit: 60, jobTypes: () => ["finance"], event: (item) => ({ taskType: "finance", taskId: text(item.sk) }) },
  ...(["DAILY", "EARLY"] as const).map((mode): WatchSource => ({
    module: "ads-reports", prefix: `ads-${mode.toLowerCase()}|`, limit: 3,
    jobTypes: (item) => [`ads-${adsMode(item, mode).toLowerCase()}`, "ads-continue"],
    event: (item) => ({ taskType: "ads-continue", taskId: text(item.sk), cursor: { mode: adsMode(item, mode) } }),
  })),
  { module: "review", prefix: "review|", limit: 5, jobTypes: () => ["review"], event: reviewEvent },
];

// 孤儿任务：非终态，任务本身与对应 job 认领记录 20 分钟内都没有活动、没有未到期租约或已排续跑，按原身份重排；同一任务 1 小时内不重复，连续 3 次无进展后只告警。
export async function reviveOrphanTasks(state: StateStore, now: number, schedule: typeof ensureOneTimeSchedule = ensureOneTimeSchedule): Promise<WatchdogResult> {
  const result: WatchdogResult = { checked: 0, revived: [], exhausted: [] };
  for (const source of sources) {
    for (const item of await state.queryPartition(`TASK#${source.module}`, { beginsWith: source.prefix, newestFirst: true, limit: source.limit })) {
      const taskId = text(item.sk);
      if (!taskId || terminal.has(text(item.status)) || item.expiresAt !== undefined) continue;
      result.checked += 1;
      if (latest(item.updatedAt, item.nextAt) > now - ORPHAN_IDLE_MS) continue;
      const event = source.event(item);
      if (!event) continue;
      const jobs = await Promise.all(source.jobTypes(item).map((type) => state.get(`EVENT#job#${type}`, sha256(taskId))));
      if (jobs.some((job) => Number(job?.leaseExpiresAt ?? 0) > now)) continue;
      if (latest(...jobs.flatMap((job) => [job?.updatedAt, (job?.result as Row | undefined)?.nextAt])) > now - ORPHAN_IDLE_MS) continue;
      const key = `${source.module}|${taskId}`;
      const marker = await state.get("WATCHDOG", key);
      if (time(marker?.watchdogAt) > now - WATCHDOG_REPEAT_MS) continue;
      const attempts = time(item.updatedAt) > time(marker?.watchdogAt) ? 0 : Number(marker?.attempts ?? 0);
      if (attempts >= WATCHDOG_MAX_ATTEMPTS) { result.exhausted.push(key); continue; }
      await schedule(event, new Date(now + MINUTE));
      await state.put({ pk: "WATCHDOG", sk: key, watchdogAt: iso(now), attempts: attempts + 1, taskStatus: text(item.status), taskUpdatedAt: text(item.updatedAt), event: event as unknown as JsonObject, expiresAt: Math.floor(now / 1000) + 30 * 86_400 });
      result.revived.push(key);
      log("WARN", "maintenance_orphan_rescheduled", { module: source.module, taskId, attempts: attempts + 1 });
    }
  }
  return result;
}

// 健康检查：以最近成功时间判断；从未成功的任务以维护任务首次运行时间与该规则首次被评估时间中较晚者为基线，
// 避免上线首轮（含后来新接入的规则）误报。
export async function healthIssues(state: StateStore, now: number, baselineAt: number, ruleSeenAt: Record<string, string> = {}): Promise<Issue[]> {
  const records = new Map((await state.listHealth()).map((item) => [text(item.sk), item]));
  const issues: Issue[] = [];
  for (const [taskType, limit] of Object.entries(HEALTH_RULES)) {
    const last = time(records.get(taskType)?.lastSuccessAt);
    const seen = time(ruleSeenAt[taskType]);
    const since = Number.isFinite(last) ? last : Math.max(baselineAt, Number.isFinite(seen) ? seen : baselineAt);
    if (now - since <= limit) continue;
    issues.push({
      key: `health|${taskType}`,
      line: Number.isFinite(last)
        ? `${taskType} 已 ${hours(now - last)} 小时没有成功运行（上次成功 ${iso(last)}，阈值 ${hours(limit)} 小时）`
        : `${taskType} 自 ${iso(since)} 起从未成功运行（阈值 ${hours(limit)} 小时）`,
    });
  }
  return issues;
}

// Ads 授权到期：配置了 ADS_REFRESH_TOKEN_ISSUED_AT 时以它为授权日；否则按状态表 ADS_TOKEN/current 推断——只存令牌 sha256 前 12 位指纹与首次见到时间，
// 首次记录的指纹按用户 2026-09-30 决定视为 GAS 时期旧令牌（不适用 365 天新规），此后指纹变化（重新授权）以首次见到时间为授权日。
export async function adsTokenIssues(config: AppConfig, state: StateStore, now: number): Promise<Issue[]> {
  const configured = text(config.optional("ADS_REFRESH_TOKEN_ISSUED_AT"));
  let issuedAt = configured ? Date.parse(configured.length === 10 ? `${configured}T00:00:00+08:00` : configured) : Number.NaN;
  let identity = configured;
  if (configured && !Number.isFinite(issuedAt)) return [{ key: "ads-token|config", line: `ADS_REFRESH_TOKEN_ISSUED_AT 不是有效日期（${configured.slice(0, 40)}），无法计算 Ads 授权到期日` }];
  if (!configured) {
    const token = config.optional("ADS_REFRESH_TOKEN");
    if (!token) return [];
    const fingerprint = sha256(token).slice(0, 12);
    const current = await state.get("ADS_TOKEN", "current");
    if (!current) {
      await state.put({ pk: "ADS_TOKEN", sk: "current", fingerprint, firstSeenAt: iso(now), legacy: true, note: "GAS 时期旧令牌，不适用 365 天新规（用户 2026-09-30 决定）", updatedAt: iso(now) });
      return [];
    }
    if (text(current.fingerprint) !== fingerprint) {
      await state.put({ pk: "ADS_TOKEN", sk: "current", fingerprint, firstSeenAt: iso(now), legacy: false, previousFingerprint: text(current.fingerprint), updatedAt: iso(now) });
      return [];
    }
    if (current.legacy === true) return [];
    issuedAt = time(current.firstSeenAt);
    identity = fingerprint;
    if (!Number.isFinite(issuedAt)) return [];
  }
  const age = (now - issuedAt) / DAY;
  if (age < ADS_TOKEN_WARN_FROM_DAY || age > ADS_TOKEN_LIFETIME_DAYS) return [];
  const expiry = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(issuedAt + ADS_TOKEN_LIFETIME_DAYS * DAY));
  return [{ key: `ads-token-expiry|${identity}`, line: `Ads 授权将于 ${expiry} 过期，请重新授权（授权日 ${new Date(issuedAt).toISOString().slice(0, 10)}，刷新令牌自授权日起 365 天固定过期）` }];
}

export interface RowCheck { issues: Issue[]; levels: Record<string, number>; tables: JsonObject[] }

// 飞书单表行数（只读，每张表 1 次查询）：首次达到 80% 报一次（levels 记已报级别），达到 90% 起每天报（键含日期）。
export async function feishuRowIssues(feishu: FeishuClient, app: string, limit: number, previous: Record<string, number>, today: string): Promise<RowCheck> {
  const result: RowCheck = { issues: [], levels: {}, tables: [] };
  for (const table of await feishu.listTables(app)) {
    const id = text(table.table_id ?? table.tableId);
    if (!id) continue;
    const name = text(table.name) || id;
    const rows = await feishu.countRecords(app, id);
    const percent = Math.floor((rows / limit) * 100);
    const level = percent >= FEISHU_ROW_DAILY_PERCENT ? FEISHU_ROW_DAILY_PERCENT : percent >= FEISHU_ROW_WARN_PERCENT ? FEISHU_ROW_WARN_PERCENT : 0;
    result.levels[id] = level;
    result.tables.push({ id, name, rows });
    const head = `飞书表「${name}」已有 ${rows} 行，达到单表上限 ${limit} 行的 ${percent}%`;
    if (level === FEISHU_ROW_DAILY_PERCENT) result.issues.push({ key: `feishu-rows|${id}|${level}|${today}`, line: `${head}，请尽快归档（方案见 ${ARCHIVE_PLAN}），到上限后该表新记录会写入失败` });
    else if (level === FEISHU_ROW_WARN_PERCENT && (previous[id] ?? 0) < level) result.issues.push({ key: `feishu-rows|${id}|${level}`, line: `${head}，请安排归档（方案见 ${ARCHIVE_PLAN}）` });
  }
  return result;
}

const previousMonth = (month: string): string => {
  const [year, value] = month.split("-").map(Number) as [number, number];
  return value === 1 ? `${year - 1}-12` : `${year}-${String(value - 1).padStart(2, "0")}`;
};

function usageReport(month: string, usage: { total: number; days: Row[] }, quota: number): string {
  const modules: Record<string, number> = {};
  for (const day of usage.days) for (const [key, value] of Object.entries(day)) if (key.startsWith("m_")) modules[key.slice(2)] = (modules[key.slice(2)] ?? 0) + (Number(value) || 0);
  const top = Object.entries(modules).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => `${name} ${count}`).join("、");
  const peak = usage.days.reduce((best, day) => (Number(day.total) || 0) > (Number(best.total) || 0) ? day : best, usage.days[0]!);
  const first = text(usage.days[0]!.sk);
  const rejected = usage.days.reduce((sum, day) => sum + (Number(day.rejected) || 0), 0);
  return [
    `飞书 API 用量 ${month}：成功调用 ${usage.total} 次（${first.endsWith("-01") ? "" : `自 ${first} 起统计，`}有调用 ${usage.days.length} 天，日均 ${Math.round(usage.total / usage.days.length)} 次，最多 ${text(peak.sk)} ${Number(peak.total) || 0} 次）`,
    top ? `；按模块：${top}` : "",
    rejected ? `；额度用尽被拒 ${rejected} 次` : "",
    quota > 0 ? `；占月额度 ${quota} 次的 ${Math.floor((usage.total / quota) * 100)}%` : "；未配置月额度 FEISHU_MONTHLY_CALL_QUOTA，只报用量",
  ].join("");
}

export interface UsageCheck { issues: Issue[]; reportMonth?: string; quotaExhausted: boolean }

// 飞书调用量：每月 1 日后首轮报上月用量（reportMonth 由调用方在发出后保存）；配置月额度时本月达 80% 提醒；
// 订单/AMS 等无 SNS 权限的函数记下的额度用尽，2 小时内且 12 小时内没发过额度邮件（ALERT/feishu-quota）即纳入本封邮件。
export async function feishuUsageIssues(config: AppConfig | undefined, state: StateStore, now: number, reportedMonth: string): Promise<UsageCheck> {
  const today = beijingDay(now);
  const month = today.slice(0, 7);
  const quota = typeof config?.optional === "function" ? Number(config.optional("FEISHU_MONTHLY_CALL_QUOTA", "")) : Number.NaN;
  const result: UsageCheck = { issues: [], quotaExhausted: false };
  const last = previousMonth(month);
  if (reportedMonth !== last) {
    const previous = await monthCalls(state, last);
    if (previous.days.length) result.issues.push({ key: `feishu-usage|${last}`, line: usageReport(last, previous, quota), info: true });
    result.reportMonth = last;
  }
  const current = await monthCalls(state, month);
  if (quota > 0 && current.total >= (quota * FEISHU_QUOTA_WARN_PERCENT) / 100) {
    result.issues.push({ key: `feishu-quota-${FEISHU_QUOTA_WARN_PERCENT}|${month}`, line: `飞书 API 本月（截至 ${today}）已成功调用 ${current.total} 次，达到月额度 ${quota} 次的 ${Math.floor((current.total / quota) * 100)}%；用尽后飞书读写与消息会全部失败到下月 1 日，需要时请升级套餐或降频（Pricing 改为 2–3 小时一次最省）` });
  }
  const lastRejected = latest(...current.days.map((day) => day.lastRejectedAt));
  if (lastRejected > now - QUOTA_REJECTION_RECENT_MS) {
    const alert = await state.get("ALERT", FEISHU_QUOTA_ALERT_KEY);
    if (!(time(alert?.emailedAt) > now - FEISHU_QUOTA_ALERT_REPEAT_MS)) {
      result.issues.push({ key: `feishu-quota-exhausted|${month}`, line: quotaExhaustedLines("订单/广告消息或其它任务", lastRejected, current.total).join("\n  ") });
      result.quotaExhausted = true;
    }
  }
  return result;
}

export async function publishSns(topicArn: string, subject: string, message: string): Promise<void> {
  const region = topicArn.split(":")[3];
  await new SNSClient(region ? { region } : {}).send(new PublishCommand({ TopicArn: topicArn, Subject: subject, Message: message }));
}

function alertMessage(now: number, fresh: Issue[], ongoing: number, resend: ResendSummary | undefined, watch: WatchdogResult | undefined): string {
  const problems = fresh.filter((issue) => !issue.info);
  const reports = fresh.filter((issue) => issue.info);
  return [
    problems.length ? `AMZShop 维护任务（${iso(now)}）发现 ${problems.length} 项新问题：` : `AMZShop 维护任务（${iso(now)}）定期报告：`,
    ...problems.map((issue) => `- ${issue.line}`),
    ...(problems.length && reports.length ? ["定期报告："] : []),
    ...reports.map((issue) => `- ${issue.line}`),
    ...(ongoing ? [`另有 ${ongoing} 项问题已在 12 小时内报告过，仍未恢复。`] : []),
    `本轮：补发通知 ${resend?.resent ?? 0} 条，过期通知 ${resend?.expired.length ?? 0} 条，重排停滞任务 ${watch?.revived.length ?? 0} 个。`,
    "排查入口：CloudWatch 日志组 /aws/lambda/amzshop-prod-jobs；状态表 HEALTH、TASK#<任务>、NOTIFICATION、WATCHDOG 分区。",
  ].join("\n");
}

// 每小时维护：①补发待发通知（10 分钟后补、48 小时过期）②孤儿任务巡检 ③健康检查；问题汇总成一封 SNS 邮件，同一问题 12 小时内不重复。
export async function runMaintenance(_event: JobEvent, config: AppConfig, state: StateStore, _amazon: AmazonClient, feishu: FeishuClient, deps: MaintenanceDeps = {}): Promise<JsonObject> {
  const now = (deps.now ?? Date.now)();
  const saved = (await state.get("MAINTENANCE", "state")) ?? {};
  const baselineAt = Number.isFinite(time(saved.baselineAt)) ? time(saved.baselineAt) : now;
  const ruleSeenAt: Record<string, string> = { ...((saved.ruleSeenAt ?? {}) as Record<string, string>) };
  for (const taskType of Object.keys(HEALTH_RULES)) if (!Number.isFinite(time(ruleSeenAt[taskType]))) ruleSeenAt[taskType] = iso(now);
  const issues: Issue[] = [];
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T | undefined> => {
    try { return await run(); }
    catch (error) {
      issues.push({ key: `maintenance|${name}`, line: `维护步骤 ${name} 失败：${errorText(error).slice(0, 300)}` });
      log("WARN", "maintenance_step_failed", { step: name, error: errorText(error).slice(0, 200) });
      return undefined;
    }
  };
  const resend = await step("resend", () => resendPendingNotifications(state, feishu, { now, deadline: Date.now() + 5 * MINUTE }));
  const legacyDue = !saved.legacyClearedAt && !(time(saved.legacySweptAt) > now - LEGACY_SWEEP_INTERVAL_MS);
  const legacy = legacyDue ? await step("legacy-notifications", () => sweepLegacyNotifications(state, now)) : undefined;
  for (const key of [...(resend?.expired ?? []), ...(legacy?.expired ?? [])]) issues.push({ key: `notification-expired|${key}`, line: `通知 ${key} 超过 48 小时未送达，已标记过期、不再补发` });
  if (resend?.failed.length) issues.push({ key: "notification-resend-failed", line: `通知补发失败 ${resend.failed.length} 条（${resend.failed.slice(0, 5).join("、")}），下一小时自动重试` });
  const watch = await step("watchdog", () => reviveOrphanTasks(state, now, deps.schedule ?? ensureOneTimeSchedule));
  for (const key of watch?.revived ?? []) issues.push({ key: `orphan|${key}`, line: `停滞任务 ${key} 已按原身份自动重排续跑` });
  for (const key of watch?.exhausted ?? []) issues.push({ key: `orphan-exhausted|${key}`, line: `停滞任务 ${key} 已自动重排 ${WATCHDOG_MAX_ATTEMPTS} 次仍无进展，需要人工排查` });
  issues.push(...(await step("health", () => healthIssues(state, now, baselineAt, ruleSeenAt)) ?? []));
  // 配置对象不可读（如只读诊断调用）时跳过授权到期检查，不当作维护失败。
  if (typeof config?.optional === "function") issues.push(...(await step("ads-token", () => adsTokenIssues(config, state, now)) ?? []));
  // 飞书容量：每个北京日期首轮查一次各表行数（每表 1 次只读调用）；用量与额度每轮只读状态表。
  const today = beijingDay(now);
  const app = typeof config?.optional === "function" ? text(config.optional("FEISHU_BITABLE_APP_TOKEN_ORDERS")) : "";
  const savedLevels = (saved.rowLevels ?? {}) as Record<string, number>;
  const rows = app && text(saved.rowsCheckedDay) !== today ? await step("feishu-rows", async () => {
    const limit = Number(config.optional("FEISHU_TABLE_ROW_LIMIT", "")) > 0 ? Number(config.optional("FEISHU_TABLE_ROW_LIMIT")) : FEISHU_ROW_LIMIT_DEFAULT;
    const checked = await feishuRowIssues(feishu, app, limit, savedLevels, today);
    await state.put({ pk: "FEISHU_ROWS", sk: "latest", checkedAt: iso(now), limit, tables: checked.tables, updatedAt: iso(now) });
    return checked;
  }) : undefined;
  issues.push(...(rows?.issues ?? []));
  const usage = await step("feishu-usage", () => feishuUsageIssues(config, state, now, text(saved.usageReportedMonth)));
  issues.push(...(usage?.issues ?? []));

  const alerts = { ...((saved.alerts ?? {}) as Record<string, string>) };
  const fresh = issues.filter((issue) => !(time(alerts[issue.key]) > now - ALERT_REPEAT_MS));
  const topicArn = deps.topicArn ?? process.env.ALERT_TOPIC_ARN ?? "";
  const problems = fresh.filter((issue) => !issue.info).length;
  let emailed = false;
  let emailError: unknown;
  if (fresh.length && topicArn) {
    try {
      await (deps.publish ?? publishSns)(topicArn, problems ? `AMZShop maintenance: ${problems} issue(s)` : "AMZShop maintenance: report", alertMessage(now, fresh, issues.length - fresh.length, resend, watch));
      for (const issue of fresh) alerts[issue.key] = iso(now);
      emailed = true;
    } catch (error) { emailError = error; }
  } else if (fresh.length) log("WARN", "maintenance_alert_topic_missing", { issues: fresh.length });
  for (const [key, at] of Object.entries(alerts)) if (!issues.some((issue) => issue.key === key) && !(time(at) > now - 7 * 24 * HOUR)) delete alerts[key];
  const sent = new Set(emailed ? fresh.map((issue) => issue.key) : []);
  // 行数级别、月度报告只在对应邮件发出后才记为已报；邮件失败时下一轮重报。
  let rowLevels = savedLevels;
  if (rows) {
    rowLevels = {};
    for (const [id, level] of Object.entries(rows.levels)) {
      const raised = rows.issues.find((issue) => issue.key.startsWith(`feishu-rows|${id}|`));
      rowLevels[id] = !raised || sent.has(raised.key) ? level : (savedLevels[id] ?? 0);
    }
  }
  const reportKey = usage?.issues.find((issue) => issue.info)?.key;
  const usageReportedMonth = usage?.reportMonth && (!reportKey || sent.has(reportKey)) ? usage.reportMonth : text(saved.usageReportedMonth);
  if (usage?.quotaExhausted && sent.has(`feishu-quota-exhausted|${today.slice(0, 7)}`)) {
    try { await state.put({ pk: "ALERT", sk: FEISHU_QUOTA_ALERT_KEY, emailedAt: iso(now), details: { source: "maintenance" }, expiresAt: Math.floor(now / 1000) + 30 * 86_400 }); }
    catch (error) { log("WARN", "feishu_quota_alert_mark_failed", { error: errorText(error).slice(0, 200) }); }
  }
  const rowsCheckedDay = rows && !emailError ? today : text(saved.rowsCheckedDay);
  const summary = { resent: resend?.resent ?? 0, expiredNotifications: (resend?.expired.length ?? 0) + (legacy?.expired.length ?? 0), revived: watch?.revived.length ?? 0, exhausted: watch?.exhausted.length ?? 0, issues: issues.length, freshIssues: fresh.length, emailed, ...(rows ? { feishuTables: rows.tables.length } : {}) };
  const legacySweptAt = legacy ? iso(now) : text(saved.legacySweptAt);
  const legacyClearedAt = text(saved.legacyClearedAt) || (legacy && legacy.checked === 0 ? iso(now) : "");
  await state.put({ pk: "MAINTENANCE", sk: "state", baselineAt: iso(baselineAt), ruleSeenAt, ...(legacySweptAt ? { legacySweptAt } : {}), ...(legacyClearedAt ? { legacyClearedAt } : {}), alerts, ...(rowsCheckedDay ? { rowsCheckedDay } : {}), rowLevels, ...(usageReportedMonth ? { usageReportedMonth } : {}), lastRunAt: iso(now), lastSummary: summary, updatedAt: iso(now) });
  if (emailError) throw emailError;
  return { status: "done", ...summary, ...(fresh.length && !topicArn ? { alertTopicMissing: true } : {}) };
}
