import type { AppConfig, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { flushNotification, prepareNotification } from "../notifications.js";
import { competitiveSummaries, type OfferView } from "./competitive.js";

const text = (value: unknown): string => String(value ?? "").trim();
const channel = (offer: OfferView): string => offer.fulfillmentType === "AFN" ? "FBA" : "自发货";
const describe = (offer: OfferView, own: string): string => `${offer.sellerId === own ? "自家" : "他人"}（${channel(offer)}）$${offer.landed.toFixed(2)}，浏览占比 ${offer.weight}%`;

// 自家 Buy Box 巡检（每小时第 20 分钟）：对自有 ASIN 调一次 getCompetitiveSummary(featuredBuyingOptions)。
// 主 segment（浏览占比最大）的 featured offer 不是自家或没有 featured offer 判为丢失；其余 segment 只在消息里列出占比。
// 按库存预警同款规则只在首次丢失与恢复时通知：通知意图先持久化，再写 BUYBOX 状态，最后发送；取数失败的 ASIN 保留原状态。
// 报价推送（offer）接管购物车提醒后，把 BUYBOX_WATCH_ENABLED 设为 false 即停用本巡检（不调接口、不发通知，仍记成功以免健康检查误报）。
export async function runBuyboxWatch(_event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient): Promise<JsonObject> {
  if (!config.bool("BUYBOX_WATCH_ENABLED", true)) return { status: "done", retired: true, checked: 0 };
  const own = config.get("SP_API_SELLER_ID");
  const skusByAsin = new Map<string, string[]>();
  for (const mapping of config.asins()) if (mapping.asin) skusByAsin.set(mapping.asin, [...(skusByAsin.get(mapping.asin) ?? []), mapping.sku]);
  const asins = [...skusByAsin.keys()];
  const summaries = asins.length ? await competitiveSummaries(amazon, asins, ["featuredBuyingOptions"]) : new Map();
  let checked = 0, lost = 0, newlyLost = 0, recovered = 0;
  const unavailable: string[] = [];
  for (const asin of asins) {
    const summary = summaries.get(asin);
    if (!summary?.ok) { unavailable.push(asin); continue; }
    const main: OfferView | undefined = summary.featured[0];
    const status = main && main.sellerId === own ? "won" : "lost";
    const previous = await state.get("BUYBOX", asin);
    const prior = text(previous?.status);
    const now = new Date().toISOString();
    const changed = status === "lost" ? prior !== "lost" : prior === "lost";
    const skus = skusByAsin.get(asin) ?? [];
    const others = summary.featured.slice(1).filter((offer: OfferView) => offer.sellerId !== own).map((offer: OfferView) => `其余细分：${offer.membership || "未知"} ${offer.weight}% 为他人（${channel(offer)}）$${offer.landed.toFixed(2)}`);
    const eventKey = `buybox|${asin}|${status}|${text(previous?.since) || "initial"}`;
    const lines = [status === "lost" ? "⚠️ Buy Box 丢失" : "✅ Buy Box 恢复", `SKU：${skus.join("、")}`, `ASIN：${asin}`, main ? `当前 Buy Box：${describe(main, own)}` : "当前 Buy Box：无 featured offer", ...others];
    const prepared = changed ? await prepareNotification(config, state, eventKey, lines) : undefined;
    await state.put({
      pk: "BUYBOX", sk: asin, status, since: changed || !previous ? now : text(previous.since) || now, checkedAt: now, updatedAt: now,
      sellerIsOwn: !!main && main.sellerId === own, fulfillment: main ? channel(main) : "", price: main ? main.landed : null, weight: main ? main.weight : null,
      ...(changed ? { lastNotificationKey: eventKey } : previous?.lastNotificationKey ? { lastNotificationKey: previous.lastNotificationKey } : {}),
    });
    if (changed) await flushNotification(state, feishu, eventKey, prepared);
    checked += 1;
    if (status === "lost") lost += 1;
    if (changed && status === "lost") newlyLost += 1;
    if (changed && status === "won") recovered += 1;
  }
  return { status: "done", checked, lost, newlyLost, recovered, unavailable };
}
