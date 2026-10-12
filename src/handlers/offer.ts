import type { SQSEvent, SQSRecord } from "aws-lambda";
import type { BatchFailureResponse } from "../types.js";
import { getConfig } from "../config.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { OFFER_MARKETS, allowedSellers, parseOfferNotification, processOfferSnapshot, watchedMarkets, type OfferContext } from "../business/offers.js";
import { flushFeishuUsage } from "../feishu-quota.js";
import { log, logError } from "../log.js";

// 逐条处理 ANY_OFFER_CHANGED：不在范围内的消息（其它类型、非全新品、站点不在范围）直接确认；订阅方不是本店的消息按失败交回 SQS（最终进 DLQ 告警）；
// 失败只回报该条 messageId，交回 SQS 重试。
export async function handleOfferRecords(records: readonly SQSRecord[], context: OfferContext, markets: readonly string[]): Promise<BatchFailureResponse["batchItemFailures"]> {
  const failures: BatchFailureResponse["batchItemFailures"] = [];
  for (const record of records) {
    try {
      const parsed = parseOfferNotification(record.body, markets, Date.now(), context.own);
      if ("ignored" in parsed) {
        log("INFO", "offer_ignored", { messageId: record.messageId, reason: parsed.ignored });
        continue;
      }
      const { snapshot } = parsed;
      const outcome = await processOfferSnapshot(snapshot, context);
      // buyBoxFlag：推送是否带“谁持有购物车”（IsBuyBoxWinner）；不带时购物车只能靠每小时对账判定。
      log("INFO", "offer_processed", { messageId: record.messageId, marketplace: OFFER_MARKETS[snapshot.marketplaceId]?.code ?? snapshot.marketplaceId, asin: snapshot.asin, offers: snapshot.offers.length, buyBoxFlag: snapshot.offers.some((offer) => offer.winner !== undefined), stale: outcome.stale, changes: outcome.changes });
    } catch (error) {
      failures.push({ itemIdentifier: record.messageId });
      logError("offer_failed", error, { messageId: record.messageId });
    }
  }
  return failures;
}

export async function handler(sqs: SQSEvent): Promise<BatchFailureResponse> {
  const config = await getConfig();
  const state = new StateStore();
  const context: OfferContext = { config, state, amazon: new AmazonClient(config), feishu: new FeishuClient(config), own: config.get("SP_API_SELLER_ID"), allowed: allowedSellers(config) };
  try {
    return { batchItemFailures: await handleOfferRecords(sqs.Records, context, watchedMarkets(config)) };
  } finally {
    // 本函数无 SNS 权限：飞书调用量（含额度用尽次数）落库，额度用尽邮件由维护任务补发。
    await flushFeishuUsage(state, "offer");
  }
}
