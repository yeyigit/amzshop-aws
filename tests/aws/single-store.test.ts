import assert from "node:assert/strict";
import test from "node:test";
import type { SQSRecord } from "aws-lambda";
import { parseOrderEvent } from "../../src/business/events.js";
import { parseOfferNotification, type OfferContext } from "../../src/business/offers.js";
import { handleOfferRecords } from "../../src/handlers/offer.js";
import type { AppConfig } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { MemoryState } from "./memory-state.js";

// 单店铺边界（2026-10-08 店铺关联防护）：通知按官方结构带卖家 ID，不是本店的消息不处理、交回 SQS 进 DLQ 告警。
const OWN = "A1OWNSELLER01";
const OTHER = "A9OTHERSELLER";
const US = "ATVPDKIKX0DER";
const ORDER = "111-2222222-3333333";

const orderChange = (sellerId?: string): string => JSON.stringify({
  NotificationVersion: "1.0", NotificationType: "ORDER_CHANGE", PayloadVersion: "1.0", EventTime: "2026-10-08T01:00:00.000Z",
  Payload: { OrderChangeNotification: {
    NotificationLevel: "OrderLevel", ...(sellerId === undefined ? {} : { SellerId: sellerId }), AmazonOrderId: ORDER, OrderChangeType: "OrderStatusChange",
    OrderChangeTrigger: { TimeOfOrderChange: "2026-10-08T00:59:00.000Z", ChangeReason: "BuyerRequestedChange" }, Summary: { MarketplaceId: US, OrderStatus: "Unshipped" },
  } },
  NotificationMetadata: { ApplicationId: "amzn1.sp.solution.test", SubscriptionId: "sub-1", PublishTime: "2026-10-08T01:00:01.000Z", NotificationId: "n-order" },
});

const transactionUpdate = (sellerId: string): string => JSON.stringify({
  NotificationVersion: "1.0", NotificationType: "TRANSACTION_UPDATE", PayloadVersion: "1.0", EventTime: "2026-10-08T01:00:00.000Z",
  Payload: { TransactionUpdateNotification: {
    SellingPartnerMetadata: { SellingPartnerId: sellerId, AccountType: "Standard Orders", MarketplaceId: US },
    RelatedIdentifiers: [{ RelatedIdentifierName: "ORDER_ID", RelatedIdentifierValue: ORDER }],
    TotalAmount: { CurrencyAmount: 12.5, CurrencyCode: "USD" }, TransactionType: "Shipment", PostedDate: "2026-10-08T00:59:00Z",
  } },
  NotificationMetadata: { ApplicationId: "amzn1.sp.solution.test", SubscriptionId: "sub-2", PublishTime: "2026-10-08T01:00:01.000Z", NotificationId: "n-transaction" },
});

const offerChanged = (subscriber: string): string => JSON.stringify({
  NotificationVersion: "1.0", NotificationType: "ANY_OFFER_CHANGED", PayloadVersion: "1.0", EventTime: "2026-10-08T01:00:00.000Z",
  NotificationMetadata: { ApplicationId: "app", SubscriptionId: "sub-3", PublishTime: "2026-10-08T01:00:00.000Z", NotificationId: "n-offer" },
  Payload: { AnyOfferChangedNotification: {
    SellerId: subscriber,
    OfferChangeTrigger: { MarketplaceId: US, ASIN: "B0TEST0001", ItemCondition: "new", TimeOfOfferChange: "2026-10-08T01:00:00.000Z", OfferChangeType: "External" },
    Summary: {},
    Offers: [{ SellerId: OTHER, SubCondition: "new", ListingPrice: { Amount: 9.99, CurrencyCode: "USD" }, Shipping: { Amount: 0, CurrencyCode: "USD" }, IsFulfilledByAmazon: true }],
  } },
});

test("单店铺边界：订单与交易通知的卖家 ID 不是本店时拒绝处理；本店（大小写不敏感）、未带卖家 ID、未配置本店卖家 ID 时照常解析", () => {
  assert.equal(parseOrderEvent(orderChange(OWN), [], OWN)?.entityKey, `order#${ORDER}`);
  assert.equal(parseOrderEvent(orderChange(OWN.toLowerCase()), [], OWN)?.module, "order");
  assert.equal(parseOrderEvent(orderChange(), [], OWN)?.module, "order", "没带卖家 ID 照常处理");
  assert.throws(() => parseOrderEvent(orderChange(OTHER), [], OWN), /ORDER_CHANGE 通知属于其它卖家账号（A9O…ER）/);
  assert.equal(parseOrderEvent(transactionUpdate(OWN), [], OWN)?.module, "finance-wake");
  assert.throws(() => parseOrderEvent(transactionUpdate(OTHER), [], OWN), /TRANSACTION_UPDATE 通知属于其它卖家账号/);
  assert.equal(parseOrderEvent(orderChange(OTHER))?.module, "order", "未配置本店卖家 ID 时不判定");
  assert.equal(parseOrderEvent(JSON.stringify({ Type: "Notification", Message: orderChange(OWN) }), [], OWN)?.module, "order", "SNS 包装同样可读");
  assert.throws(() => parseOrderEvent(JSON.stringify({ Type: "Notification", Message: orderChange(OTHER) }), [], OWN), /其它卖家账号/);
});

test("单店铺边界：报价通知订阅方不是本店时该条交回 SQS，不调亚马逊、不写状态、不发消息；报价列表里的其它卖家（跟卖者）不触发", async () => {
  assert.ok("snapshot" in parseOfferNotification(offerChanged(OWN), [US], Date.now(), OWN));
  assert.throws(() => parseOfferNotification(offerChanged(OTHER), [US], Date.now(), OWN), /ANY_OFFER_CHANGED 通知属于其它卖家账号/);
  const state = new MemoryState();
  const forbidden = (): never => { throw new Error("不应调用"); };
  const config = { get: forbidden, optional: (_key: string, fallback = "") => fallback, bool: forbidden, json: forbidden, asins: () => [], version: "test" } as unknown as AppConfig;
  const context: OfferContext = { config, state: state.asStore(), amazon: { sp: forbidden } as unknown as AmazonClient, feishu: { sendText: forbidden } as unknown as FeishuClient, own: OWN, allowed: new Set() };
  const failures = await handleOfferRecords([{ messageId: "foreign", body: offerChanged(OTHER) } as unknown as SQSRecord], context, [US]);
  assert.deepEqual(failures, [{ itemIdentifier: "foreign" }]);
  assert.equal(state.items.size, 0, "没有写任何状态");
  assert.equal(state.writes.length, 0);
});
