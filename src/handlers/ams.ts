import type { SQSEvent } from "aws-lambda";
import type { BatchFailureResponse } from "../types.js";
import { getConfig } from "../config.js";
import { FeishuClient } from "../clients/feishu.js";
import { AmazonClient } from "../clients/amazon.js";
import { StateStore } from "../state.js";
import { parseAmsEvent } from "../business/events.js";
import { processAmsEvent } from "../business/ams.js";
import { flushFeishuUsage } from "../feishu-quota.js";
import { log, logError } from "../log.js";
import { ownerId } from "../util.js";

export async function handler(sqs: SQSEvent): Promise<BatchFailureResponse> {
  const config = await getConfig();
  const state = new StateStore();
  const feishu = new FeishuClient(config);
  const amazon = new AmazonClient(config);
  const failures: BatchFailureResponse["batchItemFailures"] = [];
  for (const record of sqs.Records) {
    try {
      const event = parseAmsEvent(record.body, config.get("ADS_PROFILE_ID"));
      if (!event) {
        log("INFO", "ams_ignored", { messageId: record.messageId });
        continue;
      }
      const owner = ownerId();
      const claim = await state.claimEvent(event.entityKey, event.eventKey, event.version, owner, 180_000);
      if (claim.status === "duplicate") continue;
      if (claim.status === "busy") throw new Error("同一 AMS 活动日事件正在处理中。 ");
      try {
        const result = await processAmsEvent(event, config, state, amazon, feishu);
        await state.completeEvent(event.entityKey, event.eventKey, owner, result);
        log("INFO", "ams_completed", { messageId: record.messageId, entityKey: event.entityKey });
      } catch (error) {
        await state.failEvent(event.entityKey, event.eventKey, owner, error);
        throw error;
      }
    } catch (error) {
      failures.push({ itemIdentifier: record.messageId });
      logError("ams_failed", error, { messageId: record.messageId });
    }
  }
  // 飞书调用量（含额度用尽次数）落库；本函数无 SNS 权限，额度用尽邮件由维护任务据此补发。
  await flushFeishuUsage(state, "ams");
  return { batchItemFailures: failures };
}
