import type { AppConfig, BusinessEvent, JsonObject } from "../types.js";
import { FeishuClient } from "../clients/feishu.js";
import { AmazonClient } from "../clients/amazon.js";
import { StateStore } from "../state.js";
import { deliverNotification } from "../notifications.js";
import { amazonLocalTime, deepFind } from "../util.js";

// 活动名实例内缓存 6 小时，避免每条预算消息都查询一次 Ads 活动列表；查询失败回退为活动 ID 且不缓存。
const CAMPAIGN_NAME_TTL_MS = 6 * 3_600_000;
const campaignNames = new Map<string, { name: string; at: number }>();
export function clearCampaignNameCache(): void { campaignNames.clear(); }

export async function processAmsEvent(event: BusinessEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient): Promise<JsonObject> {
  const profileId = String(deepFind(event.payload, ["profileId", "profile_id"]) ?? config.get("ADS_PROFILE_ID"));
  const campaignId = String(deepFind(event.payload, ["campaignId", "campaign_id", "budget_scope_id", "budgetScopeId"]) ?? "");
  const dataDate = event.entityKey.split("|").at(-1) ?? "";
  const budget = Number(deepFind(event.payload, ["campaignBudget", "budget"]));
  const suppliedPercent = Number(deepFind(event.payload, ["budget_usage_percentage", "budgetUsagePercentage"]));
  const suppliedSpent = Number(deepFind(event.payload, ["spend", "spentBudget", "cost"]));
  const percent = Number.isFinite(suppliedPercent) ? suppliedPercent : (budget > 0 && Number.isFinite(suppliedSpent) ? suppliedSpent / budget * 100 : 0);
  const spent = Number.isFinite(suppliedSpent) ? suppliedSpent : budget * percent / 100;
  if (!Number.isFinite(budget) || !Number.isFinite(spent) || !Number.isFinite(percent) || budget < 0 || spent < 0 || percent < 0) throw new Error("AMS 消息预算或花费无效。 ");
  let campaignName = String(deepFind(event.payload, ["campaignName", "name"]) ?? "").trim();
  const cacheKey = `${profileId}|${campaignId}`;
  const cached = campaignNames.get(cacheKey);
  if (!campaignName && cached && Date.now() - cached.at < CAMPAIGN_NAME_TTL_MS) campaignName = cached.name;
  if (!campaignName) {
    try {
      const listed = await amazon.ads<JsonObject>("/sp/campaigns/list", {
        method: "POST", profileId, mediaType: "application/vnd.spcampaign.v3+json",
        body: { campaignIdFilter: { include: [campaignId] }, stateFilter: { include: ["ENABLED", "PAUSED", "ARCHIVED"] } },
      });
      const campaigns = Array.isArray(listed.campaigns) ? listed.campaigns as Array<Record<string, unknown>> : [];
      const found = String(campaigns[0]?.name ?? campaigns[0]?.campaignName ?? "").trim();
      if (found) campaignNames.set(cacheKey, { name: found, at: Date.now() });
      campaignName = found || campaignId;
    } catch { campaignName = campaignId; }
  }
  const relatedSkus = config.asins().filter((item) => item.adMarker && campaignName.includes(item.adMarker)).map((item) => item.sku);
  await feishu.upsert(
    config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS"),
    config.get("FEISHU_BITABLE_TABLE_ID_ADS"),
    { "广告账户ID": profileId, "广告活动ID": campaignId, "预算日期": dataDate },
    {
      "广告账户ID": profileId,
      "广告活动ID": campaignId,
      "广告活动名称": campaignName,
      "广告活动预算": Number(budget.toFixed(2)),
      "预算使用比例": Number(percent.toFixed(2)),
      "已花费预算": Number(spent.toFixed(2)),
      // 洛杉矶本地时间文本（与 GAS 旧行一致）：飞书 TODATE 不识别 UTC 的 Z，写 UTC 会让「AMZ/LA时间」偏 7–8 小时。
      "预算更新时间": amazonLocalTime(event.occurredAt),
      "预算日期": dataDate,
      "所属SKU": relatedSkus.join(", "),
    },
  );
  const threshold = Number(config.optional("AMS_BUDGET_WARNING_PERCENT", "90"));
  if (percent >= threshold) {
    await deliverNotification(config, state, feishu, `ams-budget|${profileId}|${campaignId}|${dataDate}`, [
      "⚠️ 广告预算预警",
      `${campaignName}：${percent.toFixed(1)}%`,
      `花费/预算：${spent.toFixed(2)} / ${budget.toFixed(2)}`,
    ]);
  }
  return { profileId, campaignId, dataDate, percent: Number(percent.toFixed(2)) };
}
