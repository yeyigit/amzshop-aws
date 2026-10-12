import type { JobEvent, JsonObject } from "../types.js";
import { randomUUID } from "node:crypto";
import { getConfig } from "../config.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient, isFeishuQuotaError } from "../clients/feishu.js";
import { StateStore, type ClaimResult } from "../state.js";
import { runJob } from "../business/jobs.js";
import { publishSns } from "../business/maintenance.js";
import { alertFeishuQuota, flushFeishuUsage } from "../feishu-quota.js";
import { log, logError } from "../log.js";
import { ensureOneTimeSchedule } from "../scheduling.js";
import { HttpError } from "../http.js";
import { errorText, sha256 } from "../util.js";

// 健康记录名：ads-continue 按 cursor.mode 记为 ads-daily/ads-early；Finance 唤醒记为 finance-wake，旧链终止不冒充每日 finance；dryRun 不记。
// 竞品比价平时跳过的轮次（skipped）不算成功，免得掩盖 14:00 那轮的真实失败。
export function healthTaskType(event: JobEvent, taskId: string, result: JsonObject): string | undefined {
  if (event.dryRun === true || result.skipped === true) return undefined;
  if (event.taskType === "ads-continue") return event.cursor?.mode === "EARLY" ? "ads-early" : "ads-daily";
  if (event.taskType === "finance") return taskId.startsWith("finance-wake|") ? "finance-wake" : result.superseded === true ? undefined : "finance";
  return event.taskType;
}

function healthSummary(taskId: string, result: JsonObject): JsonObject {
  const summary: JsonObject = { taskId };
  for (const [key, value] of Object.entries(result)) if (key !== "status" && ["number", "string", "boolean"].includes(typeof value)) summary[key] = typeof value === "string" ? value.slice(0, 200) : value;
  return summary;
}

// 事件记录里存的结果：超过 64 KB（如广告调价数据包）只存状态与标量摘要，完整结果只在本次调用返回里（DynamoDB 单条上限 400 KB）。
export const STORED_RESULT_MAX_BYTES = 64_000;
export function storedResult(taskId: string, result: JsonObject): JsonObject {
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  return bytes <= STORED_RESULT_MAX_BYTES ? result : { ...healthSummary(taskId, result), status: result.status ?? null, truncated: true, bytes };
}

// busy 且持有者认领已超过 Jobs 最长运行时间（900 秒）仍未释放：持有者已超时死亡，在租约到期后按原身份补排一次，避免成为孤儿任务。
export function busyRetryAt(claim: ClaimResult, now = Date.now()): Date | undefined {
  const heldSince = Date.parse(String(claim.item?.updatedAt ?? ""));
  const leaseUntil = Number(claim.item?.leaseExpiresAt ?? 0);
  if (!Number.isFinite(heldSince) || now - heldSince <= 905_000 || !(leaseUntil > now)) return undefined;
  return new Date(leaseUntil + 30_000);
}

export function shouldRetryDataNotReady(event: JobEvent, error: unknown): boolean {
  if (!(error instanceof Error) || !error.message.includes("Data not ready, please try again later")) return false;
  const retries = Number(event.cursor?.dataNotReadyRetries ?? 0);
  if (["ads-early", "ads-daily", "ads-continue"].includes(event.taskType)) return retries < 24;
  return event.taskType === "pricing" && retries < 3;
}

export function shouldRetryAdsTransientError(event: JobEvent, error: unknown): boolean {
  return ["ads-early", "ads-daily", "ads-continue"].includes(event.taskType)
    && Number(event.cursor?.dataNotReadyRetries ?? 0) < 24
    && ((error instanceof HttpError && error.retryable) || (error instanceof Error && (error.name === "TimeoutError" || error.message === "HTTP 请求超时。")));
}

export function shouldDeferFinanceRateLimit(event: JobEvent, error: unknown, task: Record<string, unknown> | undefined): boolean {
  const state = task?.state as JsonObject | undefined;
  return event.taskType === "finance" && error instanceof HttpError && error.status === 429 && error.retryable
    && !!state && typeof state.startTime === "string" && typeof state.endTime === "string"
    && Number(state.financeRateLimitRetries ?? 0) < 6;
}

export async function handler(event: JobEvent): Promise<JsonObject> {
  const config = await getConfig();
  const state = new StateStore();
  const amazon = new AmazonClient(config);
  const feishu = new FeishuClient(config);
  const scheduledAt = event.scheduledAt ?? new Date().toISOString();
  const taskId = event.taskId ?? `${event.taskType}|${scheduledAt}`;
  const eventKey = sha256(taskId);
  const owner = randomUUID();
  const claim = await state.claimEvent(`job#${event.taskType}`, eventKey, Date.parse(scheduledAt) || Date.now(), owner, 960_000);
  if (claim.status === "duplicate") return { status: "duplicate", taskId };
  if (claim.status === "busy") {
    const retryAt = busyRetryAt(claim);
    if (!retryAt) return { status: "busy", taskId };
    await ensureOneTimeSchedule({ ...event, taskId, scheduledAt }, retryAt);
    log("WARN", "job_busy_rescheduled", { taskType: event.taskType, taskId, retryAt: retryAt.toISOString() });
    return { status: "busy", taskId, retryAt: retryAt.toISOString() };
  }
  let financeLease = false;
  try {
    if (event.taskType === "finance") {
      financeLease = await state.acquireLease("finance", "global", owner, 960_000);
      if (!financeLease) {
        const nextAt = new Date(Date.now() + 120_000);
        await ensureOneTimeSchedule({ ...event, taskId, scheduledAt }, nextAt);
        const waiting = { status: "waiting_finance_lock", taskId, nextAt: nextAt.toISOString() };
        await state.continueEvent(`job#${event.taskType}`, eventKey, owner, waiting);
        return waiting;
      }
    }
    const result = await runJob({ ...event, taskId, scheduledAt }, { config, state, amazon, feishu });
    if (["done", "disabled"].includes(String(result.status))) await state.completeEvent(`job#${event.taskType}`, eventKey, owner, storedResult(taskId, result));
    else await state.continueEvent(`job#${event.taskType}`, eventKey, owner, storedResult(taskId, result));
    const healthName = result.status === "done" ? healthTaskType(event, taskId, result) : undefined;
    if (healthName) {
      try { await state.recordHealth(healthName, "done", healthSummary(taskId, result)); }
      catch (error) { log("WARN", "health_record_failed", { taskType: healthName, taskId, error: errorText(error).slice(0, 200) }); }
    }
    log("INFO", "job_completed", { taskType: event.taskType, taskId });
    return result;
  } catch (error) {
    let failure = error;
    const saved = event.taskType === "finance" && error instanceof HttpError && error.status === 429 ? await state.task("finance", taskId) : undefined;
    if (shouldDeferFinanceRateLimit(event, error, saved)) {
      try {
        const nextAt = new Date(Date.now() + 15 * 60_000).toISOString();
        const cursor = saved!.state as JsonObject;
        const retries = Number(cursor.financeRateLimitRetries ?? 0) + 1;
        await state.saveTask("finance", taskId, { ...cursor, financeRateLimitRetries: retries }, String(saved!.status ?? "active"), nextAt);
        await ensureOneTimeSchedule({ taskType: "finance", taskId, scheduledAt: nextAt }, new Date(nextAt));
        const waiting = { status: "waiting_rate_limit", taskId, nextAt, retries };
        await state.continueEvent(`job#${event.taskType}`, eventKey, owner, waiting);
        log("WARN", "job_deferred", { taskType: event.taskType, taskId, nextAt });
        return waiting;
      } catch (secondary) { failure = secondary; }
    }
    const dataNotReadyRetries = Number(event.cursor?.dataNotReadyRetries ?? 0);
    if (shouldRetryDataNotReady(event, failure) || shouldRetryAdsTransientError(event, failure)) {
      const nextAt = new Date(Date.now() + 15 * 60_000).toISOString();
      await ensureOneTimeSchedule({ ...event, taskId, scheduledAt: nextAt, cursor: { ...event.cursor, dataNotReadyRetries: dataNotReadyRetries + 1 } }, new Date(nextAt));
      const waiting = { status: "waiting_external", taskId, nextAt, dataNotReadyRetries: dataNotReadyRetries + 1 };
      await state.continueEvent(`job#${event.taskType}`, eventKey, owner, waiting);
      log("WARN", "job_deferred", { taskType: event.taskType, taskId, nextAt });
      return waiting;
    }
    await state.failEvent(`job#${event.taskType}`, eventKey, owner, failure);
    if (isFeishuQuotaError(failure)) {
      // 飞书额度用尽：记失败但正常返回，不触发 Lambda 异步重试与逐次失败邮件；额度邮件在 finally 里只发一封。
      const healthName = healthTaskType(event, taskId, { status: "feishu_quota_exhausted" });
      if (healthName) {
        try { await state.recordHealth(healthName, "feishu_quota_exhausted", { taskId }); }
        catch (error) { log("WARN", "health_record_failed", { taskType: healthName, taskId, error: errorText(error).slice(0, 200) }); }
      }
      logError("job_feishu_quota_exhausted", failure, { taskType: event.taskType, taskId });
      return { status: "feishu_quota_exhausted", taskId };
    }
    logError("job_failed", failure, { taskType: event.taskType, taskId });
    throw failure;
  } finally {
    if (financeLease) await state.releaseLease("finance", "global", owner);
    await reportFeishuUsage(state, event.taskType);
  }
}

// 落库本次飞书调用量；本次见到额度用尽（含被模块内部吞掉的）就立即发额度邮件。不抛错，不影响任务结果。
export async function reportFeishuUsage(state: StateStore, module: string, publish = publishSns, topicArn = process.env.ALERT_TOPIC_ARN ?? ""): Promise<void> {
  const usage = await flushFeishuUsage(state, module);
  if (!usage.rejected) return;
  try { await alertFeishuQuota(state, publish, topicArn, module); }
  catch (error) { log("WARN", "feishu_quota_alert_failed", { module, error: errorText(error).slice(0, 200) }); }
}
