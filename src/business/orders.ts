import type { AppConfig, BusinessEvent, FeishuRecord, Json, JsonObject } from "../types.js";
import { AmazonClient, type Pace } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { amazonLocalTime, booleanFact, deepFind, feishuFieldText, losAngelesTimeMs, timeMs } from "../util.js";
import { flushNotification, prepareNotification, type PreparedNotification } from "../notifications.js";
import { ensureOneTimeSchedule } from "../scheduling.js";

interface OrderItem { SellerSKU?: string; sellerSKU?: string; ASIN?: string; asin?: string; QuantityOrdered?: number; quantityOrdered?: number; ItemPrice?: { Amount?: string; CurrencyCode?: string } }
export interface OrderProcessOptions { pace?: boolean; now?: number }

// Orders v0 getOrder / getOrderItems 与 v2026 getOrder 官方速率各 0.5 次/秒；批量刷新时按 key 节流。
export const ORDER_PACE: { order: Pace; items: Pace; order2026: Pace } = { order: { key: "orders-getOrder", minIntervalMs: 2_100 }, items: { key: "orders-getOrderItems", minIntervalMs: 2_100 }, order2026: { key: "orders2026-getOrder", minIntervalMs: 2_100 } };
export type OrdersApiVersion = "v0" | "v2026";
type Row = Record<string, unknown>;

// 开关 ORDERS_API_VERSION：默认 v0（官方 2027-03-27 移除）；只有明确配置 v2026 才走新版。配置不可读时按 v0。
export function ordersApiVersion(config: AppConfig): OrdersApiVersion {
  const raw = typeof config.optional === "function" ? config.optional("ORDERS_API_VERSION", "v0") : "v0";
  return String(raw ?? "").trim().toLowerCase() === "v2026" ? "v2026" : "v0";
}

// v2026 时间带毫秒、v0 截断到秒：比较、去重和写飞书前统一截断到秒，保持 v0 的字符串形态。
export function truncateToSeconds(value: unknown): string {
  return String(value ?? "").trim().replace(/\.\d+(?=Z$|[+-]\d{2}:?\d{2}$)/, "");
}

const V2026_STATUS: Record<string, string> = { PENDING: "Pending", PENDING_AVAILABILITY: "PendingAvailability", UNSHIPPED: "Unshipped", PARTIALLY_SHIPPED: "PartiallyShipped", SHIPPED: "Shipped", CANCELLED: "Canceled", CANCELED: "Canceled", UNFULFILLABLE: "Unfulfillable", INVOICE_UNCONFIRMED: "InvoiceUnconfirmed" };

// 按官方迁移指南把 v2026 getOrder(includedData=PROCEEDS,FULFILLMENT) 转成 v0 同形，后续写入逻辑与 v0 完全共用：
// 状态大写→v0 写法（CANCELLED→Canceled）；企业单＝programs 含 AMAZON_BUSINESS；换货单＝associatedOrders 的 REPLACEMENT/EXCHANGE_ORIGINAL_ID；
// 商品价＝orderItems[].proceeds.breakdowns[type=ITEM].subtotal；订单总额＝proceeds.grandTotal；时间截断到秒。
export function orderFromV2026(source: Row): { order: Row; items: OrderItem[] } {
  const fulfillment = (source.fulfillment ?? {}) as Row;
  const rawStatus = String(fulfillment.fulfillmentStatus ?? "").trim();
  const programs = Array.isArray(source.programs) ? source.programs.map((item) => String(item).toUpperCase()) : [];
  const associated = (Array.isArray(source.associatedOrders) ? source.associatedOrders as Row[] : []).find((item) => ["REPLACEMENT_ORIGINAL_ID", "EXCHANGE_ORIGINAL_ID"].includes(String(item.associationType ?? "").toUpperCase()));
  const grandTotal = ((source.proceeds ?? {}) as Row).grandTotal as Row | undefined;
  const order: Row = {
    AmazonOrderId: source.orderId,
    ...(rawStatus ? { OrderStatus: V2026_STATUS[rawStatus.toUpperCase()] ?? rawStatus } : {}),
    ...(source.createdTime ? { PurchaseDate: truncateToSeconds(source.createdTime) } : {}),
    ...(source.lastUpdatedTime ? { LastUpdateDate: truncateToSeconds(source.lastUpdatedTime) } : {}),
    IsBusinessOrder: programs.includes("AMAZON_BUSINESS"),
    IsReplacementOrder: !!associated,
    ...(associated?.orderId ? { ReplacedOrderId: String(associated.orderId) } : {}),
    ...(grandTotal ? { OrderTotal: { Amount: grandTotal.amount, CurrencyCode: grandTotal.currencyCode } } : {}),
  };
  const items = (Array.isArray(source.orderItems) ? source.orderItems as Row[] : []).map((item): OrderItem => {
    const product = (item.product ?? {}) as Row;
    const subtotal = ((((item.proceeds ?? {}) as Row).breakdowns ?? []) as Row[]).find((entry) => String(entry.type ?? "").toUpperCase() === "ITEM")?.subtotal as Row | undefined;
    return {
      ...(product.sellerSku !== undefined ? { SellerSKU: String(product.sellerSku) } : {}),
      ...(product.asin !== undefined ? { ASIN: String(product.asin) } : {}),
      ...(item.quantityOrdered !== undefined ? { QuantityOrdered: Number(item.quantityOrdered) } : {}),
      ...(subtotal ? { ItemPrice: { Amount: subtotal.amount as string, CurrencyCode: subtotal.currencyCode as string } } : {}),
    };
  });
  return { order, items };
}

export async function loadOrder(amazon: AmazonClient, orderId: string, version: OrdersApiVersion, pace = false): Promise<{ order: Row; items: OrderItem[] }> {
  if (version === "v2026") {
    // 实测（2026-09-30）：只带 PROCEEDS 时不返回 fulfillment（无订单状态），须同时带 FULFILLMENT。
    const response = await amazon.sp<JsonObject>(`/orders/2026-01-01/orders/${encodeURIComponent(orderId)}`, { query: { includedData: "PROCEEDS,FULFILLMENT" }, ...(pace ? { pace: ORDER_PACE.order2026 } : {}) });
    return orderFromV2026(((response as Row).order ?? response) as Row);
  }
  const [orderResponse, items] = await Promise.all([
    amazon.sp<JsonObject>(`/orders/v0/orders/${encodeURIComponent(orderId)}`, pace ? { pace: ORDER_PACE.order } : {}),
    orderItems(amazon, orderId, pace ? ORDER_PACE.items : undefined),
  ]);
  return { order: (orderResponse.payload ?? orderResponse) as Row, items };
}

// 由订单与商品行算出将写入飞书的事实（v0/v2026 共用，双读比对也用它）。
export function orderFacts(order: Row, items: OrderItem[], asinBySku: Map<string, string>, occurredAt: string) {
  const grouped = groupItems(items, asinBySku);
  const status = normalizeStatus(value(order, "OrderStatus", "orderStatus"));
  return {
    grouped, status, cancelled: /取消|cancel/i.test(status),
    statusAt: String(value(order, "LastUpdateDate", "lastUpdateDate") ?? occurredAt),
    purchaseAt: amazonLocalTime(value(order, "PurchaseDate", "purchaseDate")),
    business: booleanFact(value(order, "IsBusinessOrder", "isBusinessOrder")),
    replacement: booleanFact(value(order, "IsReplacementOrder", "isReplacementOrder")),
    replacedOrderId: String(value(order, "ReplacedOrderId", "replacedOrderId") ?? ""),
  };
}

function value(object: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (object[key] !== undefined) return object[key];
  return undefined;
}

function normalizeStatus(status: unknown): string {
  const input = String(status ?? "").trim();
  return ({ pending: "待处理", unshipped: "未发货", partiallyshipped: "部分发货", shipped: "已发货", canceled: "已取消", cancelled: "已取消", unfulfillable: "无法履约" } as Record<string, string>)[input.toLowerCase()] ?? input;
}

function groupItems(items: OrderItem[], asinBySku: Map<string, string>): Array<{ sku: string; asin: string; qty: number; amount?: number; currency?: string }> {
  const grouped = new Map<string, { sku: string; asin: string; qty: number; amount?: number; currency?: string }>();
  for (const item of items) {
    const sku = String(item.SellerSKU ?? item.sellerSKU ?? "").trim();
    if (!sku) throw new Error("订单商品缺少 SellerSKU。 ");
    const current = grouped.get(sku) ?? { sku, asin: String(item.ASIN ?? item.asin ?? asinBySku.get(sku) ?? ""), qty: 0 };
    const quantity = Number(item.QuantityOrdered ?? item.quantityOrdered ?? 0);
    current.qty += Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
    const rawAmount = item.ItemPrice?.Amount;
    if (rawAmount !== undefined && rawAmount !== null && String(rawAmount).trim() !== "") {
      const amount = Number(rawAmount);
      if (Number.isFinite(amount)) current.amount = (current.amount ?? 0) + amount;
    }
    const currency = String(item.ItemPrice?.CurrencyCode ?? "");
    if (currency) {
      if (current.currency && current.currency !== currency) throw new Error(`订单 ${sku} 商品金额币种混合。`);
      current.currency = currency;
    }
    grouped.set(sku, current);
  }
  return [...grouped.values()];
}

async function orderItems(amazon: AmazonClient, orderId: string, pace?: Pace): Promise<OrderItem[]> {
  const output: OrderItem[] = [];
  let nextToken = "";
  const seen = new Set<string>();
  do {
    const response = await amazon.sp<JsonObject>(`/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`, { query: nextToken ? { NextToken: nextToken } : {}, ...(pace ? { pace } : {}) });
    const payload = (response.payload ?? response) as JsonObject;
    output.push(...((payload.OrderItems ?? payload.orderItems ?? []) as unknown as OrderItem[]));
    nextToken = String(payload.NextToken ?? payload.nextToken ?? "");
    if (nextToken && seen.has(nextToken)) throw new Error("订单商品分页 NextToken 重复。 ");
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return output;
}

export async function orderItemPrices(amazon: AmazonClient, orderId: string): Promise<Map<string, { amount: number; currency: string }>> {
  const prices = new Map<string, { amount: number; currency: string; complete: boolean }>();
  for (const item of await orderItems(amazon, orderId)) {
    const sku = String(item.SellerSKU ?? item.sellerSKU ?? "").trim().toLowerCase();
    if (!sku) continue;
    const raw = item.ItemPrice?.Amount;
    const currency = String(item.ItemPrice?.CurrencyCode ?? "").trim();
    const amount = raw === undefined || raw === null || String(raw).trim() === "" ? NaN : Number(raw);
    const current = prices.get(sku) ?? { amount: 0, currency: "", complete: true };
    if (!Number.isFinite(amount) || !currency || (current.currency && current.currency !== currency)) current.complete = false;
    else { current.amount += amount; current.currency = currency; }
    prices.set(sku, current);
  }
  return new Map([...prices].filter(([, value]) => value.complete).map(([sku, value]) => [sku, { amount: Number(value.amount.toFixed(2)), currency: value.currency }]));
}

export function financeWakeTaskId(event: BusinessEvent): string {
  const eventKey = String(event.eventKey ?? "").trim();
  if (!eventKey) throw new Error("Finance 唤醒缺少稳定事件身份。 ");
  return `finance-wake|${eventKey}`;
}

// One wake task per notification; it never renews itself (the daily Finance run is the only periodic scan).
export async function scheduleFinanceWake(event: BusinessEvent, state: StateStore, schedule = ensureOneTimeSchedule): Promise<JsonObject> {
  const taskId = financeWakeTaskId(event);
  const nextAt = new Date(Date.now() + 60_000);
  const notice = Object.fromEntries(["orderId", "shipmentId", "postedDate", "transactionType", "marketplaceId", "notificationId"].map((key) => [key, String(event.payload[key] ?? "").trim()])) as JsonObject;
  let existing: Record<string, unknown> | undefined;
  try {
    await state.put({ pk: "TASK#finance", sk: taskId, module: "finance", status: "scheduled", state: { sourceEvent: event.eventKey, occurredAt: event.occurredAt, notice }, nextAt: nextAt.toISOString(), updatedAt: new Date().toISOString() }, "attribute_not_exists(pk) AND attribute_not_exists(sk)");
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
    existing = await state.get("TASK#finance", taskId);
    if (!existing || (existing.state as Record<string, unknown> | undefined)?.sourceEvent !== event.eventKey) throw new Error("Finance 唤醒任务身份冲突。 ");
  }
  if (existing && existing.status !== "scheduled") return { scheduled: false, taskId, status: String(existing.status ?? "unknown") };
  // A redelivery while the first schedule is still pending re-confirms that same schedule; only a lapsed one is re-armed.
  const planned = Date.parse(String(existing?.nextAt ?? ""));
  const when = !existing ? nextAt : planned > Date.now() ? new Date(planned) : new Date(Date.now() + 60_000);
  await schedule({ taskType: "finance", taskId, scheduledAt: when.toISOString() }, when);
  return { scheduled: true, taskId };
}

function sameField(current: unknown, next: unknown): boolean {
  const text = feishuFieldText(current);
  return typeof next === "number" ? text !== "" && Number(text) === next : text === String(next ?? "").trim();
}

// 新订单通知首行的下单距今（如“2 小时前”），亚马逊推送晚了几个小时一眼可见：按准备通知的时刻向下取整，满 48 小时改按天；下单时间未知不写。
export function orderAge(purchaseDate: unknown, now = Date.now()): string {
  const placed = Date.parse(String(purchaseDate ?? ""));
  if (!Number.isFinite(placed)) return "";
  const minutes = Math.floor((now - placed) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  return minutes < 48 * 60 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`;
}

export function cancelAmountLine(order: Record<string, unknown>, grouped: Array<{ amount?: number; currency?: string }>, existing: FeishuRecord[]): string {
  const priced = grouped.filter((item) => item.amount !== undefined);
  let amount = priced.reduce((sum, item) => sum + (item.amount ?? 0), 0);
  let currencies = new Set(priced.map((item) => item.currency).filter(Boolean));
  let amountKnown = priced.length === grouped.length && currencies.size === 1;
  const orderTotal = (value(order, "OrderTotal", "orderTotal") ?? {}) as Record<string, unknown>;
  const rawTotalAmount = value(orderTotal, "Amount", "amount");
  const totalAmount = rawTotalAmount === undefined || rawTotalAmount === null || String(rawTotalAmount).trim() === "" ? NaN : Number(rawTotalAmount);
  const totalCurrency = String(value(orderTotal, "CurrencyCode", "currencyCode") ?? "").trim();
  if (!amountKnown && Number.isFinite(totalAmount) && totalCurrency) { amount = totalAmount; currencies = new Set([totalCurrency]); amountKnown = true; }
  if (!amountKnown && existing.length) {
    const paid = existing.map((record) => {
      const value = feishuFieldText(record.fields["付款金额"]);
      return value === "" ? NaN : Number(value);
    });
    const paidCurrencies = new Set(existing.map((record) => feishuFieldText(record.fields["金额币种"]) || feishuFieldText(record.fields["费用币种"]) || totalCurrency).filter(Boolean));
    if (paid.every(Number.isFinite) && paidCurrencies.size === 1) { amount = paid.reduce((sum, item) => sum + item, 0); currencies = paidCurrencies; amountKnown = true; }
  }
  const currency = [...currencies][0] ?? "";
  return amountKnown ? `金额：${currency === "USD" ? "$" : ""}${Number(amount.toFixed(2))}${currency === "USD" ? "" : ` ${currency}`}` : "金额：待核实";
}

// 通知意图在任何飞书写入前持久化，写完后发送；每次处理（含重试、定向修复、周期校准）末尾补发该订单未完成的 new|/cancel| 意图。
export async function processOrderEvent(event: BusinessEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient, options: OrderProcessOptions = {}): Promise<JsonObject> {
  if (event.module === "finance-wake") return scheduleFinanceWake(event, state);

  const orderId = String(event.payload.orderId ?? "");
  const { order, items } = await loadOrder(amazon, orderId, ordersApiVersion(config), options.pace === true);
  const { grouped, status, cancelled, statusAt, purchaseAt, business, replacement, replacedOrderId } = orderFacts(order, items, new Map(config.asins().map((item) => [item.sku, item.asin])), event.occurredAt);
  if (!grouped.length) throw new Error(`订单 ${orderId} 没有商品明细。`);
  const appToken = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const tableId = config.get("FEISHU_BITABLE_TABLE_ID_ORDERS");
  const existing = await feishu.searchRecords(appToken, tableId, { "订单编号": orderId });
  const oldStatuses = new Set(existing.map((record) => feishuFieldText(record.fields["订单状态"])));
  const writes: Array<{ sku: string; rows: FeishuRecord[]; fields: Record<string, unknown> }> = [];
  for (const item of grouped) {
    const rows = existing.filter((record) => feishuFieldText(record.fields.SKU).toLowerCase() === item.sku.toLowerCase());
    const matching = rows[0];
    const oldQtyText = feishuFieldText(matching?.fields["数量"]);
    const oldQty = oldQtyText === "" ? NaN : Number(oldQtyText);
    if (cancelled && Number.isFinite(oldQty) && oldQty > item.qty) item.qty = oldQty;
    // 表里存洛杉矶本地时间文本（历史行可能是 UTC ISO），飞书读回是富文本数组：按洛杉矶时区解析后再比较先后。
    const oldVersion = losAngelesTimeMs(matching?.fields["订单状态更新时间"]);
    const newVersion = timeMs(statusAt);
    const oldPayment = feishuFieldText(matching?.fields["付款金额"]);
    const hasOldPayment = oldPayment !== "" && Number.isFinite(Number(oldPayment));
    const newPayment = !hasOldPayment && item.amount !== undefined && !!item.currency;
    const oldStatus = feishuFieldText(matching?.fields["订单状态"]);
    const statusFields = oldVersion && newVersion && newVersion < oldVersion
      ? (normalizeStatus(oldStatus) !== oldStatus
        ? { "订单状态": normalizeStatus(oldStatus) }
        : {})
      : { "订单状态": status, "订单状态更新时间": amazonLocalTime(statusAt) || statusAt };
    const fields: Record<string, unknown> = {
      "订单编号": orderId,
      SKU: item.sku,
      "数量": item.qty,
      ...(item.asin ? { ASIN: item.asin } : {}),
      ...(purchaseAt ? { "下单时间": purchaseAt } : {}),
      ...(business.known ? { "企业买家": String(business.value) } : {}),
      ...(replacement.known ? { "换货单": String(replacement.value) } : {}),
      ...(replacedOrderId ? { "换货订单号": replacedOrderId } : {}),
      ...(item.currency ? { "金额币种": item.currency } : {}),
      ...(newPayment ? { "付款金额": Number(item.amount!.toFixed(2)) } : {}),
      ...statusFields,
    };
    writes.push({ sku: item.sku, rows, fields });
  }
  const lines = grouped.map((item) => `${item.sku} x ${item.qty}`);
  const suppressNotifications = event.payload.suppressNotifications === true;
  const prepared = new Map<string, PreparedNotification | undefined>();
  if (!suppressNotifications && cancelled && ![...oldStatuses].some((item) => /取消|cancel/i.test(item))) {
    const purchaseLine = purchaseAt || feishuFieldText(existing[0]?.fields["下单时间"]);
    const cancelLines = ["❌ 订单取消", ...lines, cancelAmountLine(order, grouped, existing), ...(purchaseLine ? [`下单时间：${purchaseLine}`] : []), `订单编号：${orderId}`];
    prepared.set(`cancel|${orderId}`, await prepareNotification(config, state, `cancel|${orderId}`, cancelLines));
  } else if (!suppressNotifications && !cancelled && existing.length === 0 && replacement.known && !replacement.value) {
    const title = ["💰新订单", orderAge(value(order, "PurchaseDate", "purchaseDate"), options.now), business.known && business.value ? "企业买家" : ""].filter(Boolean).join("  ");
    const newLines = [title, ...lines, `订单编号：${orderId}`];
    prepared.set(`new|${orderId}`, await prepareNotification(config, state, `new|${orderId}`, newLines));
  }
  let written = 0;
  for (const write of writes) {
    const current = write.rows.length === 1 ? write.rows[0] : undefined;
    if (current && Object.entries(write.fields).every(([name, next]) => sameField(current.fields[name], next))) continue;
    await feishu.upsert(appToken, tableId, { "订单编号": orderId, SKU: write.sku }, write.fields, {}, { existing: write.rows });
    written += 1;
  }
  const notified: Record<string, string> = {};
  for (const key of [`new|${orderId}`, `cancel|${orderId}`]) {
    const outcome = await flushNotification(state, feishu, key, prepared.get(key));
    if (outcome !== "none") notified[key.slice(0, key.indexOf("|"))] = outcome;
  }
  return { orderId, rows: grouped.length, written, status, ...(Object.keys(notified).length ? { notifications: notified } : {}) } as JsonObject;
}

export function transactionIdentifiers(payload: JsonObject): { orderId: string; shipmentId: string } {
  const orderId = String(payload.orderId ?? deepFind(payload, ["AmazonOrderId", "ORDER_ID"]) ?? "");
  const shipmentId = String(deepFind(payload, ["ShipmentId", "SHIPMENT_ID"]) ?? "");
  return { orderId, shipmentId };
}
