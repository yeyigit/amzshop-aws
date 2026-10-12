import type { SQSEvent } from "aws-lambda";
import type { BatchFailureResponse, BusinessEvent } from "../types.js";
import { getConfig } from "../config.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore, type ClaimResult } from "../state.js";
import { parseOrderEvent } from "../business/events.js";
import { processOrderEvent } from "../business/orders.js";
import { flushFeishuUsage } from "../feishu-quota.js";
import { delay } from "../http.js";
import { log, logError } from "../log.js";
import { ownerId } from "../util.js";

export interface ClaimRetryOptions { attempts?: number; intervalMs?: number; sleep?: (milliseconds: number) => Promise<void> }

// 同一订单事件正被另一实例处理时，先在函数内每 3 秒重试认领、最多约 20 秒，仍忙才交回 SQS（可见性超时 30 分钟）。
export async function claimOrderEvent(state: StateStore, event: BusinessEvent, owner: string, options: ClaimRetryOptions = {}): Promise<ClaimResult> {
  const attempts = options.attempts ?? 7;
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  for (let attempt = 1; ; attempt += 1) {
    const claim = await state.claimEvent(event.entityKey, event.eventKey, event.version, owner, 360_000);
    // 只有另一实例持有未到期租约时才值得等待；版本冲突等其它 busy 直接交回 SQS。
    if (claim.status !== "busy" || attempt >= attempts || !(Number(claim.item?.leaseExpiresAt ?? 0) > Date.now())) return claim;
    await sleep(options.intervalMs ?? 3_000);
  }
}

export async function handler(sqs: SQSEvent): Promise<BatchFailureResponse> {
  const config = await getConfig();
  const state = new StateStore();
  const amazon = new AmazonClient(config);
  const feishu = new FeishuClient(config);
  const failures: BatchFailureResponse["batchItemFailures"] = [];
  const ignored = config.optional("IGNORED_NOTIFICATION_TYPES_JSON", "[]");
  let ignoredTypes: string[];
  try { ignoredTypes = JSON.parse(ignored) as string[]; } catch { throw new Error("IGNORED_NOTIFICATION_TYPES_JSON 格式无效。 "); }
  // 单店铺边界：通知里的卖家 ID 不是本店时该条失败交回 SQS（最终进 DLQ 告警），不调接口、不写飞书。
  const ownSellerId = config.optional("SP_API_SELLER_ID", "").trim();

  for (const record of sqs.Records) {
    try {
      const event = parseOrderEvent(record.body, ignoredTypes, ownSellerId);
      if (!event) {
        log("INFO", "order_ignored", { messageId: record.messageId });
        continue;
      }
      const owner = ownerId();
      const claim = await claimOrderEvent(state, event, owner);
      if (claim.status === "duplicate") {
        log("INFO", "order_duplicate", { messageId: record.messageId, entityKey: event.entityKey, eventKey: event.eventKey });
        continue;
      }
      if (claim.status === "busy") throw new Error("同一订单事件正在处理中。 ");
      try {
        const result = await processOrderEvent(event, config, state, amazon, feishu);
        await state.completeEvent(event.entityKey, event.eventKey, owner, result);
        log("INFO", "order_completed", { messageId: record.messageId, entityKey: event.entityKey, eventKey: event.eventKey });
      } catch (error) {
        await state.failEvent(event.entityKey, event.eventKey, owner, error);
        throw error;
      }
    } catch (error) {
      failures.push({ itemIdentifier: record.messageId });
      logError("order_failed", error, { messageId: record.messageId });
    }
  }
  // 飞书调用量（含额度用尽次数）落库；本函数无 SNS 权限，额度用尽邮件由维护任务据此补发。
  await flushFeishuUsage(state, "order");
  return { batchItemFailures: failures };
}
