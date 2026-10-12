import assert from "node:assert/strict";
import test from "node:test";
import { applyFinanceWithDetailWait, eventsFromTransactions, financeOrderDetailSource, refundFacts, updateOrderDisposalFee, updateShipmentFinance } from "../../src/business/finance.js";
import type { AppConfig } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import type { StateStore } from "../../src/state.js";

type Row = Record<string, unknown>;
const ORDER = "113-1111111-1111111";
const V2024 = { get: () => "test", optional: (key: string, fallback = "") => key === "FINANCE_ORDER_DETAIL_SOURCE" ? "v2024" : fallback } as unknown as AppConfig;
const usd = (currencyAmount: number | string): Row => ({ currencyAmount, currencyCode: "USD" });
const node = (breakdownType: string, amount: number | string, children: Row[] = []): Row => ({ breakdownType, breakdownAmount: usd(amount), breakdowns: children });
const item = (sku: string, breakdowns: Row[], adjustmentId = "item-1", quantity = 1): Row => ({ relatedIdentifiers: [{ itemRelatedIdentifierName: "ORDER_ADJUSTMENT_ITEM_ID", itemRelatedIdentifierValue: adjustmentId }], contexts: [{ contextType: "ProductContext", sku, quantityShipped: quantity, fulfillmentNetwork: "Amazon" }], breakdowns });
const tx = (transactionId: string, transactionType: string, items: Row[], extra: Row = {}, links: Row[] = []): Row => ({
  transactionId, transactionType, transactionStatus: "RELEASED", postedDate: "2026-09-24T00:00:00Z", totalAmount: usd(0),
  sellingPartnerMetadata: { sellingPartnerId: "seller", marketplaceId: "US" }, relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: ORDER }, ...links], items, ...extra,
});
const memoryState = () => {
  const items = new Map<string, Row>();
  return { items, state: { put: async (entry: Row) => { items.set(`${entry.pk}|${entry.sk}`, entry); }, get: async (pk: string, sk: string) => items.get(`${pk}|${sk}`), delete: async (pk: string, sk: string) => { items.delete(`${pk}|${sk}`); } } as unknown as StateStore };
};

// ---- 复制旧 v0 同场景用例，只换 Amazon 响应固件（2024-06-19 listTransactions），断言不变 ----

test("[v2024] Finance 不用缺失的明细清零费用，原交易等待并可在明细出现后完成", async () => {
  const record = { record_id: "rec-1", fields: { SKU: "SKU-1", "数量": 1, "佣金": 1.95, "配送费": 4.09, "促销费用": 0.5 } };
  const updates: Record<string, unknown>[] = [];
  let fees: Row[] = [];
  const shipment = () => tx("tx-1", "Shipment", [item("SKU-1", [node("ProductCharges", "12", [node("OurPricePrincipal", "12")]), ...(fees.length ? [node("AmazonFees", "-2", fees)] : [])])]);
  const feishu = { searchRecords: async () => [record], update: async (_app: string, _table: string, _id: string, fields: Record<string, unknown>) => { updates.push(fields); } } as unknown as FeishuClient;
  const config = V2024;
  await assert.rejects(() => updateShipmentFinance(config, feishu, ORDER, eventsFromTransactions([tx("tx-0", "Shipment", [])]), "2026-09-24T00:00:00Z"), /费用明细未就绪/);
  await assert.rejects(() => updateShipmentFinance(config, feishu, ORDER, eventsFromTransactions([shipment()]), "2026-09-24T00:00:00Z"), /费用明细未就绪/);
  assert.equal(updates.length, 0);
  const { items, state } = memoryState();
  const amazon = { sp: async () => ({ transactions: [shipment()] }) } as unknown as AmazonClient;
  const transaction = { transactionId: "tx-1", transactionType: "Shipment", transactionStatus: "RELEASED", sellingPartnerMetadata: { sellingPartnerId: "seller", marketplaceId: "US" }, relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: ORDER }] };
  assert.equal(await applyFinanceWithDetailWait(config, state, amazon, feishu, transaction), "waiting_detail");
  assert.equal([...items.values()].find((entry) => entry.pk === "FINANCE_PENDING")?.stage, "pending_detail");
  assert.equal(updates.length, 0);
  fees = [node("Commission", "-2", [node("Base", "-2")])];
  assert.equal(await applyFinanceWithDetailWait(config, state, amazon, feishu, transaction), "done");
  assert.equal(items.size, 1);
  assert.equal(updates[0]?.["佣金"], 2);
  for (const field of ["配送费", "促销费用"]) assert.equal(updates[0]?.[field], 0);
});

test("免费换货单的清算（金额 0、没有任何费用行）：v0 与 v2024 都按已知 0 写佣金、配送费、促销费用，原卡在待明细的复查直接完成；有金额无分项、有收费无费用行仍等明细", async () => {
  // 形状取自 2026-09-29 生产换货单清算（v2024 条目没有分项、条目币种为 null；同一笔 v0 是 6 行 0 金额收费、没有费用行）。
  const replacement = (): Row => tx("tx-free", "Shipment", [{ ...item("SKU-1", []), totalAmount: { currencyAmount: 0, currencyCode: null } }], { postedDate: "2026-09-29T07:36:45Z", description: "Order Payment", breakdowns: [node("Sales", 0), node("Expenses", 0)] });
  const v0Events = { ShipmentEventList: [{ PostedDate: "2026-09-29T07:36:45Z", ShipmentItemList: [{ SellerSKU: "SKU-1", QuantityShipped: 1, ItemChargeList: ["Principal", "Tax", "GiftWrap", "GiftWrapTax", "ShippingCharge", "ShippingTax"].map((ChargeType) => ({ ChargeType, ChargeAmount: { CurrencyCode: "USD", CurrencyAmount: 0 } })) }] }] };
  const expected = { "佣金": 0, "配送费": 0, "促销费用": 0, "费用更新时间": "2026-09-29 00:36:45", "费用币种": "USD" };
  const sheet = (updates: Row[]) => ({ searchRecords: async () => [{ record_id: "rec-1", fields: { SKU: "SKU-1", "数量": 1, "付款金额": 0, "换货单": "true" } }], update: async (_app: string, _table: string, _id: string, fields: Row) => { updates.push(fields); } }) as unknown as FeishuClient;
  for (const [label, events] of [["v0", v0Events], ["v2024", eventsFromTransactions([replacement()])]] as const) {
    const updates: Row[] = [];
    await updateShipmentFinance(V2024, sheet(updates), ORDER, events, "2026-09-29T07:36:45Z");
    assert.deepEqual(updates, [expected], label);
  }
  const untouched = { searchRecords: async () => [{ record_id: "rec-1", fields: { SKU: "SKU-1", "数量": 1 } }], update: async () => { throw new Error("不应写入"); } } as unknown as FeishuClient;
  const paidWithoutBreakdowns = tx("tx-paid", "Shipment", [{ ...item("SKU-1", []), totalAmount: usd(12) }], { totalAmount: usd(12) });
  await assert.rejects(() => updateShipmentFinance(V2024, untouched, ORDER, eventsFromTransactions([paidWithoutBreakdowns]), "2026-09-24T00:00:00Z"), /费用明细未就绪/);
  const v0ChargedWithoutFees = { ShipmentEventList: [{ ShipmentItemList: [{ SellerSKU: "SKU-1", ItemChargeList: [{ ChargeType: "Principal", ChargeAmount: { CurrencyCode: "USD", CurrencyAmount: 12 } }] }] }] };
  await assert.rejects(() => updateShipmentFinance(V2024, untouched, ORDER, v0ChargedWithoutFees, "2026-09-24T00:00:00Z"), /费用明细未就绪/);
  const { items, state } = memoryState();
  const updates: Row[] = [];
  const amazon = { sp: async () => ({ transactions: [replacement()] }) } as unknown as AmazonClient;
  assert.equal(await applyFinanceWithDetailWait(V2024, state, amazon, sheet(updates), replacement()), "done");
  assert.deepEqual(updates, [expected]);
  assert.equal([...items.values()].find((entry) => entry.pk === "FINANCE")?.destination, "order");
  assert.equal([...items.values()].some((entry) => entry.pk === "FINANCE_PENDING"), false);
});

test("[v2024] 订单关联 FBADisposal ServiceFee 后到时仅补缺失弃置费，明细未就绪可待补重试", async () => {
  const record = { record_id: "rec-1", fields: { SKU: "SKU-1", "数量": 1, "付款金额": 14.59, "弃置费": 0, "费用币种": "USD" } as Record<string, unknown> };
  const writes: Record<string, unknown>[] = [];
  const feishu = { searchRecords: async () => [record], update: async (_app: string, _table: string, _id: string, fields: Record<string, unknown>) => { writes.push(fields); Object.assign(record.fields, fields); } } as unknown as FeishuClient;
  const config = V2024;
  const disposal = tx("tx-disposal", "ServiceFee", [{ description: "FBA Removal Order: Disposal Fee", contexts: [{ contextType: "ProductContext" }], breakdowns: [node("FBAFees", -1.53, [node("FBADisposalFee", -1.53, [node("Base", -1.53)])])] }], { description: "FBADisposal", postedDate: "2026-09-27T00:00:00Z", totalAmount: usd(-1.53) });
  const events = eventsFromTransactions([disposal]);
  assert.equal(await updateOrderDisposalFee(config, feishu, ORDER, events, "2026-09-27T00:00:00Z"), 1);
  assert.equal(record.fields["弃置费"], 1.53);
  assert.equal(record.fields["费用更新时间"], "2026-09-26 17:00:00");
  assert.equal(await updateOrderDisposalFee(config, feishu, ORDER, events, "2026-09-27T00:00:00Z"), 0);
  record.fields["弃置费"] = 2;
  await assert.rejects(() => updateOrderDisposalFee(config, feishu, ORDER, events, "2026-09-27T00:00:00Z"), /拒绝覆盖/);
  assert.equal(writes.filter((fields) => Object.hasOwn(fields, "弃置费")).length, 1);

  record.fields["弃置费"] = 0;
  const { items, state } = memoryState();
  let ready = false;
  const amazon = { sp: async () => ({ transactions: ready ? [disposal] : [] }) } as unknown as AmazonClient;
  const transaction = { transactionId: "tx-disposal", transactionType: "ServiceFee", description: "FBADisposal", transactionStatus: "RELEASED", postedDate: "2026-09-27T00:00:00Z", totalAmount: { currencyAmount: -1.53, currencyCode: "USD" }, sellingPartnerMetadata: { sellingPartnerId: "seller", marketplaceId: "US" }, relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: ORDER }] };
  assert.equal(await applyFinanceWithDetailWait(config, state, amazon, feishu, transaction), "waiting_detail");
  assert.equal([...items.values()].find((entry) => entry.pk === "FINANCE_PENDING")?.stage, "pending_detail");
  ready = true;
  assert.equal(await applyFinanceWithDetailWait(config, state, amazon, feishu, transaction), "done");
  assert.equal(record.fields["弃置费"], 1.53);
  assert.equal(items.has("FINANCE_PENDING|seller|US|tx-disposal"), false);
});

test("[v2024] 退款权威明细按 adjustmentId 和 SKU 保留金额、费用与币种", () => {
  const events = eventsFromTransactions([tx("tx-refund", "Refund", [item("SKU-1", [node("ProductCharges", -12.5, [node("OurPricePrincipal", -12.5)]), node("AmazonFees", 2.25, [node("Commission", 2.25, [node("Base", 2.25)])])], "a1")], { postedDate: "2026-09-20T01:00:00Z" })]);
  const facts = refundFacts(events, "111-2222222-3333333");
  assert.deepEqual(facts.map(({ adjustmentId, sku, refundAmount, feeAdjustment, currencies }) => ({ adjustmentId, sku, refundAmount, feeAdjustment, currencies })), [{ adjustmentId: "a1", sku: "SKU-1", refundAmount: -12.5, feeAdjustment: 2.25, currencies: ["USD"] }]);
});

// ---- 2024-06-19 专有规则 ----

test("C2 开关默认 v0：只有明确配置 FINANCE_ORDER_DETAIL_SOURCE=v2024 才从交易条目生成明细", async () => {
  assert.equal(financeOrderDetailSource({ get: () => "" } as unknown as AppConfig), "v0");
  assert.equal(financeOrderDetailSource({ optional: (_k: string, fallback = "") => fallback } as unknown as AppConfig), "v0");
  const paths: string[] = [];
  const amazon = { sp: async (path: string) => { paths.push(path); return path.includes("/v0/") ? { payload: { FinancialEvents: { ShipmentEventList: [{ ShipmentItemList: [{ SellerSKU: "SKU-1", ItemFeeList: [{ FeeType: "Commission", FeeAmount: { CurrencyAmount: -2, CurrencyCode: "USD" } }] }] }] } } } : { transactions: [tx("tx-9", "Shipment", [item("SKU-1", [node("AmazonFees", -2, [node("Commission", -2)])])])] }; } } as unknown as AmazonClient;
  const feishu = { searchRecords: async () => [{ record_id: "r", fields: { SKU: "SKU-1" } }], update: async () => undefined } as unknown as FeishuClient;
  const transaction = tx("tx-9", "Shipment", []);
  await applyFinanceWithDetailWait({ get: () => "t", optional: (_k: string, fallback = "") => fallback } as unknown as AppConfig, memoryState().state, amazon, feishu, transaction);
  assert.deepEqual(paths, [`/finances/v0/orders/${ORDER}/financialEvents`]);
  paths.length = 0;
  await applyFinanceWithDetailWait(V2024, memoryState().state, amazon, feishu, transaction);
  assert.deepEqual(paths, ["/finances/2024-06-19/transactions"]);
});

test("C2 延期原交易与放款交易成对出现只计一次；分批发货（同一条目 ID、无配对）照计；配对分项不一致按未就绪等待", async () => {
  const fees = [node("ProductCharges", 20, [node("OurPricePrincipal", 20)]), node("AmazonFees", -6, [node("Commission", -3, [node("Base", -3)]), node("FBAPerUnitFulfillmentFee", -3, [node("Base", -3.5), node("Promo", 0.5)])]), node("PromoRebates", -1, [node("OurPriceDiscount", -1)])];
  const released = tx("A", "Shipment", [item("SKU-1", fees)], {}, [{ relatedIdentifierName: "DEFERRED_TRANSACTION_ID", relatedIdentifierValue: "B" }]);
  const deferred = tx("B", "Shipment", [item("SKU-1", fees)], { transactionStatus: "DEFERRED_RELEASED" }, [{ relatedIdentifierName: "RELEASE_TRANSACTION_ID", relatedIdentifierValue: "A" }]);
  const second = tx("C", "Shipment", [item("SKU-1", fees)]);
  const updates: Row[] = [];
  const feishu = { searchRecords: async () => [{ record_id: "r", fields: { SKU: "SKU-1" } }], update: async (_a: string, _t: string, _id: string, fields: Row) => { updates.push(fields); } } as unknown as FeishuClient;
  assert.equal((eventsFromTransactions([deferred, released]).ShipmentEventList as unknown[]).length, 1);
  await updateShipmentFinance(V2024, feishu, ORDER, eventsFromTransactions([deferred, released]), "2026-09-24T00:00:00Z");
  assert.deepEqual([updates[0]?.["佣金"], updates[0]?.["配送费"], updates[0]?.["促销费用"]], [3, 3, 1], "成对交易只计一次");
  await updateShipmentFinance(V2024, feishu, ORDER, eventsFromTransactions([deferred, released, second]), "2026-09-24T00:00:00Z");
  assert.deepEqual([updates[1]?.["佣金"], updates[1]?.["配送费"], updates[1]?.["促销费用"]], [6, 6, 2], "另一批发货照计");
  const tampered = tx("B", "Shipment", [item("SKU-1", [node("AmazonFees", -9, [node("Commission", -9)])])], { transactionStatus: "DEFERRED_RELEASED" }, [{ relatedIdentifierName: "RELEASE_TRANSACTION_ID", relatedIdentifierValue: "A" }]);
  assert.throws(() => eventsFromTransactions([released, tampered]), /财务费用明细未就绪/);
});

test("C2 退款金额只算买家侧收费调整，代扣的 MarketplaceFacilitator 税不计；促销来自 PromoRebates", () => {
  const events = eventsFromTransactions([tx("R", "Refund", [item("SKU-1", [node("ProductCharges", -20, [node("OurPricePrincipal", -20)]), node("Tax", -3, [node("OurPriceTax", -1.5), node("MarketplaceFacilitatorTax-Principal", -1.5)]), node("PromoRebates", 1, [node("OurPriceDiscount", 1)]), node("AmazonFees", 2.5, [node("Commission", 3), node("RefundCommission", -0.5)])], "adj-7", 2)])]);
  const [fact] = refundFacts(events, ORDER);
  assert.equal(fact?.adjustmentId, "adj-7");
  assert.equal(fact?.quantity, 2);
  assert.equal(fact?.refundAmount, -21.5);
  assert.equal(fact?.feeAdjustment, 2.5);
  assert.equal(fact?.promotionAdjustment, 1);
});
