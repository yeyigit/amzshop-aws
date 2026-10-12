import type { BusinessEvent, JsonObject } from "../types.js";
import { deepFind, parseJson, sha256, stableKey, timeMs, unwrapNotification, ymdInZone } from "../util.js";

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("消息正文不是 JSON 对象。 ");
  return value as JsonObject;
}

export interface TransactionUpdateFacts { notificationId: string; orderId: string; shipmentId: string; postedDate: string; transactionType: string; marketplaceId: string; sellerId: string; totalAmount: JsonObject | null }

function member(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const wanted = name.toLowerCase();
  return Object.entries(value).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

const memberText = (value: unknown, name: string): string => String(member(value, name) ?? "").trim();

// 单店铺边界（2026-10-08 店铺关联防护）：通知自带的卖家 ID 不是本店时不处理，按配置错误交回 SQS、最终进 DLQ 告警；
// 消息没带卖家 ID 或未配置本店卖家 ID 时不判定。错误里只留对方 ID 的头三位与末两位。
export function assertOwnSeller(type: string, sellerId: string, ownSellerId: string): void {
  const seller = sellerId.trim().toUpperCase();
  const own = ownSellerId.trim().toUpperCase();
  if (!seller || !own || seller === own) return;
  throw new Error(`${type} 通知属于其它卖家账号（${seller.slice(0, 3)}…${seller.slice(-2)}），本系统只服务本店，未处理；请查清是谁把其它店铺订阅到了本队列。`);
}

const identifierName = (value: unknown): string => String(value ?? "").trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();

// Real TRANSACTION_UPDATE: NotificationMetadata.NotificationId + Payload.TransactionUpdateNotification{PostedDate, TransactionType, TotalAmount,
// RelatedIdentifiers[{RelatedIdentifierName, RelatedIdentifierValue}], SellingPartnerMetadata}; it carries no TransactionId.
export function transactionUpdateFacts(payload: unknown): TransactionUpdateFacts {
  const body = member(payload, "Payload");
  const notice = member(body, "TransactionUpdateNotification") ?? member(payload, "TransactionUpdateNotification") ?? body ?? payload;
  const related = member(notice, "RelatedIdentifiers");
  const identifiers = (Array.isArray(related) ? related : []).map((entry) => ({ name: identifierName(member(entry, "RelatedIdentifierName")), value: memberText(entry, "RelatedIdentifierValue") }));
  const identifier = (name: string): string => identifiers.find((entry) => entry.name === name && entry.value)?.value ?? "";
  const orderId = identifier("ORDER_ID");
  const seller = member(notice, "SellingPartnerMetadata");
  const total = member(notice, "TotalAmount");
  return {
    notificationId: memberText(member(payload, "NotificationMetadata"), "NotificationId"),
    orderId: /^\d{3}-\d{7}-\d{7}$/.test(orderId) ? orderId : "",
    shipmentId: identifier("SHIPMENT_ID"),
    postedDate: memberText(notice, "PostedDate"),
    transactionType: memberText(notice, "TransactionType"),
    marketplaceId: memberText(seller, "MarketplaceId"),
    sellerId: memberText(seller, "SellingPartnerId"),
    totalAmount: total && typeof total === "object" && !Array.isArray(total) ? total as JsonObject : null,
  };
}

export function parseOrderEvent(body: string, ignoredTypes: readonly string[] = [], ownSellerId = ""): BusinessEvent | null {
  const payload = object(unwrapNotification(parseJson<unknown>(body, "SQS 消息")));
  const type = String(deepFind(payload, ["NotificationType", "notificationType"]) ?? "ORDER_CHANGE").trim().toUpperCase();
  if (ignoredTypes.map((item) => item.toUpperCase()).includes(type)) return null;
  if (type === "ORDER_CHANGE") {
    // 官方结构：Payload.OrderChangeNotification.SellerId。
    assertOwnSeller(type, memberText(member(member(payload, "Payload"), "OrderChangeNotification"), "SellerId"), ownSellerId);
    const orderId = String(deepFind(payload, ["AmazonOrderId", "amazon_order_id", "orderId", "order_id"]) ?? "").trim();
    if (!orderId) throw new Error("ORDER_CHANGE 缺少 AmazonOrderId。 ");
    const occurredAt = String(deepFind(payload, ["TimeOfOrderChange", "EventTime", "eventTime"]) ?? new Date().toISOString());
    return {
      module: "order",
      entityKey: `order#${orderId}`,
      eventKey: "ORDER_CHANGE",
      version: timeMs(occurredAt) || Date.now(),
      occurredAt,
      payload: { ...payload, orderId },
    };
  }
  if (type === "TRANSACTION_UPDATE") {
    const facts = transactionUpdateFacts(payload);
    assertOwnSeller(type, facts.sellerId, ownSellerId);
    const occurredAt = facts.postedDate || memberText(payload, "EventTime") || new Date().toISOString();
    const identity = facts.notificationId || sha256(JSON.stringify(payload));
    return {
      module: "finance-wake",
      entityKey: facts.orderId ? `order#${facts.orderId}` : `finance#${facts.marketplaceId || "unknown"}`,
      eventKey: `TRANSACTION#${identity}`,
      version: timeMs(occurredAt) || Date.now(),
      occurredAt,
      payload: { ...payload, orderId: facts.orderId, shipmentId: facts.shipmentId, postedDate: facts.postedDate, transactionType: facts.transactionType, marketplaceId: facts.marketplaceId, notificationId: facts.notificationId },
    };
  }
  throw new Error(`未知 NotificationType: ${type}`);
}

export function parseAmsEvent(body: string, configuredProfileId = ""): BusinessEvent | null {
  const payload = object(unwrapNotification(parseJson<unknown>(body, "AMS SQS 消息")));
  const dataset = String(deepFind(payload, ["dataset_id", "datasetId"]) ?? "").trim().toLowerCase();
  const scopeType = String(deepFind(payload, ["budget_scope_type", "budgetScopeType"]) ?? "").trim().toUpperCase();
  if ((dataset && dataset !== "budget-usage") || (scopeType && scopeType !== "CAMPAIGN")) return null;
  const profileId = String(deepFind(payload, ["profileId", "profile_id"]) ?? configuredProfileId).trim();
  const campaignId = String(deepFind(payload, ["campaignId", "campaign_id", "budget_scope_id", "budgetScopeId"]) ?? "").trim();
  const occurredAt = String(deepFind(payload, ["usage_updated_timestamp", "usageUpdatedTimestamp", "eventTime", "timestamp", "timeWindowEnd"]) ?? "").trim();
  const explicitDate = String(deepFind(payload, ["dataDate", "date", "eventDate"]) ?? "").slice(0, 10);
  const dataDate = /^\d{4}-\d{2}-\d{2}$/.test(explicitDate) ? explicitDate : (Number.isFinite(Date.parse(occurredAt)) ? ymdInZone(new Date(occurredAt), "America/Los_Angeles") : "");
  if (!profileId || !campaignId || !dataDate || !Number.isFinite(Date.parse(occurredAt))) throw new Error("AMS budget-usage 消息缺少 profileId/campaignId/有效事件时间。 ");
  return {
    module: "ams",
    entityKey: stableKey("ams", profileId, campaignId, dataDate),
    eventKey: "BUDGET_USAGE",
    version: timeMs(occurredAt) || Date.now(),
    occurredAt,
    payload,
  };
}

export function parsePricingEvent(body: string): { sku: string; asin: string; version: number } | null {
  const payload = object(unwrapNotification(parseJson<unknown>(body, "Pricing SQS 消息")));
  const type = String(deepFind(payload, ["NotificationType", "notificationType"]) ?? "").trim().toUpperCase();
  if (type !== "ANY_OFFER_CHANGED") return null;
  const marketplaceId = String(deepFind(payload, ["MarketplaceId", "marketplaceId"]) ?? "").trim();
  if (marketplaceId && marketplaceId !== "ATVPDKIKX0DER") return null;
  const sku = String(deepFind(payload, ["SellerSKU", "sellerSku"]) ?? "").trim();
  const asin = String(deepFind(payload, ["ASIN", "asin"]) ?? "").trim();
  if (!sku && !asin) return null;
  const occurredAt = String(deepFind(payload, ["EventTime", "eventTime", "TimeOfOfferChange", "timeOfOfferChange"]) ?? "");
  return { sku, asin, version: timeMs(occurredAt) || Date.now() };
}
