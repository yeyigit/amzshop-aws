import type { SQSEvent } from "aws-lambda";
import type { BatchFailureResponse } from "../types.js";
import { getConfig } from "../config.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { parsePricingEvent } from "../business/events.js";
import { runPricing } from "../business/pricing.js";
import { flushFeishuUsage } from "../feishu-quota.js";
import { log, logError } from "../log.js";
import { ownerId } from "../util.js";

export async function handler(sqs: SQSEvent): Promise<BatchFailureResponse> {
  const accepted = sqs.Records.map((record) => ({ record, event: parsePricingEvent(record.body) })).filter((item) => item.event !== null);
  if (!accepted.length) return { batchItemFailures: [] };
  const config = await getConfig();
  const state = new StateStore();
  const owner = ownerId();
  const version = Math.max(...accepted.map((item) => item.event!.version));
  const claim = await state.claimEvent("pricing#global", "ANY_OFFER_CHANGED", version, owner, 840_000);
  if (claim.status === "duplicate") return { batchItemFailures: [] };
  if (claim.status === "busy") return { batchItemFailures: accepted.map((item) => ({ itemIdentifier: item.record.messageId })) };
  try {
    const result = await runPricing({ taskType: "pricing", taskId: `pricing-queue|${version}`, scheduledAt: new Date(version).toISOString() }, config, state, new AmazonClient(config), new FeishuClient(config));
    await state.completeEvent("pricing#global", "ANY_OFFER_CHANGED", owner, result);
    log("INFO", "pricing_queue_completed", { messages: accepted.length, version });
    return { batchItemFailures: [] };
  } catch (error) {
    await state.failEvent("pricing#global", "ANY_OFFER_CHANGED", owner, error);
    logError("pricing_queue_failed", error, { messages: accepted.length, version });
    return { batchItemFailures: accepted.map((item) => ({ itemIdentifier: item.record.messageId })) };
  } finally {
    await flushFeishuUsage(state, "pricing-queue");
  }
}
