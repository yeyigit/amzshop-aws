import type { AppConfig, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { runFinance } from "./finance.js";
import { processOrderEvent } from "./orders.js";
import { probeFbaHistory, runShipments } from "./shipments.js";
import { runInventory } from "./inventory.js";
import { resolveSellerId, runPricing } from "./pricing.js";
import { runAdsReports, runAdsRetention } from "./ads.js";
import { runAdsRunaway } from "./ads-runaway.js";
import { runAdsMemory, runAdsReview } from "./ads-review.js";
import { runOrderReconcile, runCompetitorPrices } from "./orders-periodic.js";
import { runReviews } from "./reviews.js";
import { runOrderReasons } from "./order-reasons.js";
import { runMaintenance } from "./maintenance.js";
import { runBuyboxWatch } from "./buybox.js";
import { runPayouts } from "./payouts.js";
import { runTrafficAlert } from "./traffic.js";
import { runOfferReconcile, runOfferSubscriptionSetup } from "./offer-tasks.js";
import { runBrandWatch } from "./brand-watch.js";
import { runCompetitorRefresh } from "./competitor-sets.js";
import { runForwarderBackfill, runForwarderTracking } from "./forwarder-tracking.js";
import { runOrderPrices } from "./order-prices.js";
import { runStoreReport } from "./store-report.js";
import { runStoreHealth } from "./store-health.js";
import { runInventoryHealth } from "./inventory-health.js";
import { runSqp } from "./sqp.js";
import { resumePendingNotifications } from "../notifications.js";
import { sha256 } from "../util.js";

interface Context { config: AppConfig; state: StateStore; amazon: AmazonClient; feishu: FeishuClient }

async function acceptanceProbe(config: AppConfig, amazon: AmazonClient, feishu: FeishuClient): Promise<JsonObject> {
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const tables = await feishu.listTables(app);
  const discovered = new Map(tables.map((table) => [String(table.name ?? "").trim(), String(table.table_id ?? table.tableId ?? "").trim()]));
  const tableIds = {
    profit: config.optional("FEISHU_BITABLE_TABLE_ID_PROFIT_ESTIMATE") || discovered.get("毛利润预估") || discovered.get("毛利润预估表") || "",
    inventoryParameters: config.optional("FEISHU_BITABLE_TABLE_ID_INVENTORY_PARAMETERS") || discovered.get("库存参数") || "",
    inventoryAlerts: config.optional("FEISHU_BITABLE_TABLE_ID_INVENTORY_ALERTS") || discovered.get("库存预警") || "",
  };
  if (Object.values(tableIds).some((value) => !value)) throw new Error("只读探测未找到毛利润预估、库存参数或库存预警。 ");
  const checks = [
    { name: "订单", id: config.get("FEISHU_BITABLE_TABLE_ID_ORDERS"), required: ["订单编号", "SKU", "金额"], formulas: ["金额"] },
    { name: "毛利润预估", id: tableIds.profit, required: ["SKU编号", "AMZ售价", "毛利", "AMZ促销价", "活动价毛利润"], formulas: ["毛利", "活动价毛利润"] },
    { name: "库存参数", id: tableIds.inventoryParameters, required: ["SKU"], formulas: [] },
    { name: "库存预警", id: tableIds.inventoryAlerts, required: ["SKU"], formulas: [] },
    { name: "货件", id: config.get("FEISHU_BITABLE_TABLE_ID_SHIPMENTS"), required: ["货件编号", "承运商"], formulas: [] },
    { name: "SKU信息表", id: config.get("FEISHU_BITABLE_TABLE_ID_SKUS"), required: ["SKU编号"], formulas: [] },
  ];
  const schema = [];
  for (const check of checks) {
    const fields = await feishu.listFields(app, check.id);
    const byName = new Map(fields.map((field) => [String(field.field_name ?? field.fieldName ?? "").trim(), Number(field.type)]));
    const missing = check.required.filter((name) => !byName.has(name));
    const invalidFormulas = check.formulas.filter((name) => byName.get(name) !== 20);
    if (missing.length || invalidFormulas.length) throw new Error(`${check.name} schema 不符合预期: missing=${missing.join(",")}; formula=${invalidFormulas.join(",")}`);
    schema.push({ name: check.name, fieldCount: fields.length, fieldNameHash: sha256([...byName.keys()].sort().join("\n")) });
  }
  const [participations, profiles, sellerId, fbaHistory] = await Promise.all([
    amazon.sp<JsonObject>("/sellers/v1/marketplaceParticipations"),
    amazon.ads<JsonObject[]>("/v2/profiles"),
    resolveSellerId(config, amazon),
    probeFbaHistory(amazon),
  ]);
  const marketplaces = Array.isArray(participations.payload) ? participations.payload.length : 0;
  if (!marketplaces || !profiles.length || !sellerId) throw new Error("Amazon 只读探测未返回站点、广告 profile 或 Seller ID。 ");
  return { status: "done", marketplaces, adProfiles: profiles.length, sellerIdResolved: true, fbaHistory, tableIds, schema };
}

export async function runJob(event: JobEvent, context: Context): Promise<JsonObject> {
  const { config, state, amazon, feishu } = context;
  switch (event.taskType) {
    case "shipment": return runShipments(event, config, state, amazon, feishu);
    case "finance": return runFinance(event, config, state, amazon, feishu);
    case "order-repair": {
      const ids = event.cursor?.orderIds;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || ids.some((id) => typeof id !== "string" || !/^\d{3}-\d{7}-\d{7}$/.test(id))) throw new Error("订单定向修复需要 1-20 个有效订单编号。");
      let rows = 0;
      for (const orderId of [...new Set(ids)]) {
        const result = await processOrderEvent({ module: "order", entityKey: `order#${orderId}`, eventKey: "ORDER_REPAIR", version: Date.now(), occurredAt: new Date().toISOString(), payload: { orderId, suppressNotifications: true } }, config, state, amazon, feishu);
        rows += Number(result.rows ?? 0);
      }
      return { status: "done", orders: new Set(ids).size, rows };
    }
    case "inventory": return runInventory(event, config, state, amazon, feishu);
    case "pricing": return runPricing(event, config, state, amazon, feishu);
    case "order-reconcile": return runOrderReconcile(event, config, state, amazon, feishu);
    case "order-prices": return runOrderPrices(event, config, amazon, feishu);
    case "store-report": return runStoreReport(event, config, state, amazon, feishu);
    case "store-health": return runStoreHealth(event, config, state, amazon, feishu);
    case "inventory-health": return runInventoryHealth(event, config, state, amazon, feishu);
    case "sqp": return runSqp(event, config, state, amazon);
    case "competitor-prices": return runCompetitorPrices(event, config, state, amazon, feishu);
    case "competitor-refresh": return runCompetitorRefresh(event, config, state, amazon, feishu);
    case "buybox-watch": return runBuyboxWatch(event, config, state, amazon, feishu);
    case "payouts": return runPayouts(event, config, state, amazon, feishu);
    case "traffic-alert": return runTrafficAlert(event, config, state, amazon, feishu);
    case "offer-reconcile": return runOfferReconcile(event, config, state, amazon, feishu);
    case "brand-watch": return runBrandWatch(event, config, state, amazon, feishu);
    case "offer-subscription-setup": return runOfferSubscriptionSetup(event, config, state, amazon);
    case "forwarder-tracking": return runForwarderTracking(event, config, state, amazon, feishu);
    case "forwarder-backfill": return runForwarderBackfill(event, config, state, amazon, feishu);
    case "ads-early": return runAdsReports(event, "EARLY", config, state, amazon, feishu);
    case "ads-daily": return runAdsReports(event, "DAILY", config, state, amazon, feishu);
    case "ads-continue": return runAdsReports(event, event.cursor?.mode === "EARLY" ? "EARLY" : "DAILY", config, state, amazon, feishu);
    // 已停用的旧每日广告决策任务（调价改为人工复盘，见 docs/模块说明.md「广告」）：旧计划若仍触发，直接结束、不记健康。
    case "ads-decision": return { status: "done", retired: true, skipped: true };
    case "ads-runaway": return runAdsRunaway(event, config, state, feishu);
    case "ads-review": return runAdsReview(event, config, state, feishu);
    case "ads-memory": return runAdsMemory(event, config, state, feishu);
    case "ads-retention": return runAdsRetention(event, config, state, amazon, feishu);
    case "review": return runReviews(event, config, state, amazon, feishu);
    case "order-reason": return runOrderReasons(event, config, state, amazon, feishu);
    case "notification-resume": return { status: "done", resumed: await resumePendingNotifications(state, feishu) };
    case "maintenance": return runMaintenance(event, config, state, amazon, feishu);
    case "acceptance-probe": return acceptanceProbe(config, amazon, feishu);
    default: throw new Error(`未知 taskType: ${event.taskType}`);
  }
}
