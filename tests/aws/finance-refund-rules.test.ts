import assert from "node:assert/strict";
import test from "node:test";
import { eventsFromTransactions, refundFacts, refundFactsKey, REFUND_FACTS_PK, updateRefunds } from "../../src/business/finance.js";
import type { AppConfig } from "../../src/types.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const ORDER = "114-0000000-0001024";
// 同一订单项的两笔退款（9/5 运费 -1.50、9/6 运费 -1.49）按结算报告都已结算（订单与各类编号为示例）。
const v0Refund = (postedDate: string, shipping: number): Row => ({ PostedDate: postedDate, ShipmentItemAdjustmentList: [{ OrderAdjustmentItemId: "900001", SellerSKU: "SKU-H", QuantityShipped: 1,
  ItemChargeAdjustmentList: [{ ChargeType: "Tax", ChargeAmount: { CurrencyAmount: -1.11, CurrencyCode: "USD" } }, { ChargeType: "ShippingTax", ChargeAmount: { CurrencyAmount: 0, CurrencyCode: "USD" } }, { ChargeType: "ShippingCharge", ChargeAmount: { CurrencyAmount: shipping, CurrencyCode: "USD" } }, { ChargeType: "Principal", ChargeAmount: { CurrencyAmount: -12.99, CurrencyCode: "USD" } }],
  ItemFeeAdjustmentList: [{ FeeType: "Commission", FeeAmount: { CurrencyAmount: 1.85, CurrencyCode: "USD" } }, { FeeType: "RefundCommission", FeeAmount: { CurrencyAmount: -0.37, CurrencyCode: "USD" } }],
  PromotionAdjustmentList: [{ PromotionAmount: { CurrencyAmount: -shipping, CurrencyCode: "USD" } }, { PromotionAmount: { CurrencyAmount: 0.65, CurrencyCode: "USD" } }] }] });
const usd = (currencyAmount: number, currencyCode = "USD"): Row => ({ currencyAmount, currencyCode });
const node = (breakdownType: string, amount: number, children: Row[] = []): Row => ({ breakdownType, breakdownAmount: usd(amount), breakdowns: children });
const v2024Refund = (transactionId: string, postedDate: string, shipping: number): Row => ({
  transactionId, transactionType: "Refund", transactionStatus: "RELEASED", postedDate, totalAmount: usd(-10.86), sellingPartnerMetadata: { sellingPartnerId: "S", marketplaceId: "US" },
  relatedIdentifiers: [{ relatedIdentifierName: "REFUND_ID", relatedIdentifierValue: transactionId }, { relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: ORDER }],
  items: [{ relatedIdentifiers: [{ itemRelatedIdentifierName: "ORDER_ADJUSTMENT_ITEM_ID", itemRelatedIdentifierValue: "900001" }], contexts: [{ contextType: "ProductContext", sku: "SKU-H", quantityShipped: 1 }], totalAmount: usd(-10.86), breakdowns: [
    node("PromoRebates", -shipping + 0.65, [node("ShippingDiscount", -shipping), node("OurPriceDiscount", 0.65)]), node("Tax", 0, [node("OurPriceTax", -1.11), node("MarketplaceFacilitatorTax-Principal", 1.11)]),
    node("ProductCharges", -12.99, [node("OurPricePrincipal", -12.99)]), node("Shipping", shipping, [node("ShippingPrincipal", shipping)]), node("AmazonFees", 1.48, [node("Commission", 1.85), node("RefundCommission", -0.37)]),
  ] }],
});
const summary = (facts: ReturnType<typeof refundFacts>) => facts.map((fact) => ({ adjustmentId: fact.adjustmentId, quantity: fact.quantity, refund: Math.round(fact.refundAmount * 100), fee: Math.round(fact.feeAdjustment * 100), promotion: Math.round(fact.promotionAdjustment * 100), currencies: fact.currencies, postedDate: fact.postedDate }));
const EXPECTED = [{ adjustmentId: "900001", quantity: 2, refund: -3119, fee: 296, promotion: 429, currencies: ["USD"], postedDate: "2026-09-06T00:47:20Z" }];

test("R1 同一订单项的多笔退款逐笔累加（按结算报告两笔都已结算），不再后者覆盖前者：v0 事件", () => {
  const facts = refundFacts({ RefundEventList: [v0Refund("2026-09-05T22:47:49Z", -1.5), v0Refund("2026-09-06T00:47:20Z", -1.49)] }, ORDER);
  assert.deepEqual(summary(facts), EXPECTED);
  assert.deepEqual(facts[0]!.events?.map((event) => [event.postedDate, Math.round(event.refundAmount * 100), event.quantity]), [["2026-09-05T22:47:49Z", -1560, 1], ["2026-09-06T00:47:20Z", -1559, 1]]);
  const duplicated = refundFacts({ RefundEventList: [v0Refund("2026-09-05T22:47:49Z", -1.5), v0Refund("2026-09-05T22:47:49Z", -1.5)] }, ORDER);
  assert.equal(Math.round(duplicated[0]!.refundAmount * 100), -1560, "完全相同的重复事件只计一次");
});

test("R1 2024-06-19 两笔退款交易（REFUND_ID 不同、无延期配对）与 v0 得到同一结果", () => {
  const facts = refundFacts(eventsFromTransactions([v2024Refund("REFUND-1", "2026-09-06T00:47:20Z", -1.49), v2024Refund("REFUND-2", "2026-09-05T22:47:49Z", -1.5)]), ORDER);
  assert.deepEqual(summary(facts), EXPECTED);
});

test("R2 每笔退款各发一条通知：最早一笔沿用原键不重发，其后的键加入账时间；重跑不重复", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-06T02:00:00.000Z") });
  const state = new MemoryState([{ pk: "NOTIFICATION", sk: `refund|${ORDER}|900001`, status: "done" }]);
  const sent: string[][] = [];
  const rows = [{ record_id: "r1", fields: { "订单编号": ORDER, SKU: "SKU-H", "数量": 2, "付款金额": 29.98, "金额币种": "USD" } as Row }];
  const feishu = { searchRecords: async () => rows.map((row) => ({ ...row, fields: { ...row.fields } })), update: async (_a: string, _t: string, _id: string, fields: Row) => { Object.assign(rows[0]!.fields, fields); }, sendText: async (_u: string, lines: string[]) => { sent.push(lines); } } as unknown as FeishuClient;
  const config = { get: () => "t", optional: (key: string, fallback = "") => key === "FEISHU_NOTIFY_USER_IDS" ? "u1" : fallback } as unknown as AppConfig;
  const facts = refundFacts({ RefundEventList: [v0Refund("2026-09-05T22:47:49Z", -1.5), v0Refund("2026-09-06T00:47:20Z", -1.49)] }, ORDER);
  await updateRefunds(config, state.asStore(), feishu, ORDER, facts, 0);
  assert.deepEqual(sent, [["⚡️订单退款", "SKU-H x 1", "金额：$15.59", `订单编号：${ORDER}`]], "第一笔已按原键发过，只补发第二笔");
  assert.equal(state.item("NOTIFICATION", `refund|${ORDER}|900001|2026-09-06T00:47:20Z`)?.status, "done");
  assert.equal(rows[0]!.fields["退款金额"], -31.19);
  assert.equal(rows[0]!.fields["退款数量"], 2);
  assert.equal(rows[0]!.fields["退款费用返还"], 2.96);
  await updateRefunds(config, state.asStore(), feishu, ORDER, facts, 0);
  assert.equal(sent.length, 1, "重跑不重复");
});

test("R4 退款逐笔事实存状态表 REFUND_FACTS，与已存事实按 adjustmentId 合并（Amazon 不再返回的旧退款不丢），飞书只写可见退款列", async () => {
  const older = { adjustmentId: "100001", orderId: ORDER, sku: "SKU-H", quantity: 1, postedDate: "2026-05-01T00:00:00Z", refundAmount: -5, feeAdjustment: 0.5, promotionAdjustment: 0, currencies: ["USD"], charges: [], fees: [], promotions: [], events: [{ postedDate: "2026-05-01T00:00:00Z", refundAmount: -5, quantity: 1 }] };
  const key = refundFactsKey(ORDER, "SKU-H");
  assert.equal(key, `${ORDER}|sku-h`);
  const state = new MemoryState([{ pk: REFUND_FACTS_PK, sk: key, facts: [older] }]);
  const rows = [{ record_id: "r1", fields: { "订单编号": ORDER, SKU: "SKU-H", "数量": 3, "付款金额": 44.97, "金额币种": "USD" } as Row }];
  const updates: Row[] = [];
  const feishu = { searchRecords: async () => rows.map((row) => ({ ...row, fields: { ...row.fields } })), update: async (_a: string, _t: string, _id: string, fields: Row) => { updates.push(fields); } } as unknown as FeishuClient;
  const config = { get: () => "t", optional: (_key: string, fallback = "") => fallback } as unknown as AppConfig;
  const facts = refundFacts({ RefundEventList: [v0Refund("2026-09-05T22:47:49Z", -1.5), v0Refund("2026-09-06T00:47:20Z", -1.49)] }, ORDER);
  for (let run = 0; run < 2; run += 1) await updateRefunds(config, state.asStore(), feishu, ORDER, facts, Number.POSITIVE_INFINITY);
  assert.deepEqual((state.item(REFUND_FACTS_PK, key)?.facts as Row[]).map((fact) => fact.adjustmentId), ["100001", "900001"]);
  assert.equal(updates.length, 2);
  for (const fields of updates) {
    assert.equal(fields["退款数量"], 3, "旧退款 1 件 + 本单两笔各 1 件");
    assert.equal(fields["退款金额"], -36.19);
    assert.equal(fields["退款费用返还"], 3.46);
    assert.equal(fields["退款状态"], "部分退款");
    assert.equal("退款明细" in fields, false, "退款明细 JSON 不再写飞书（2026-10-06）");
  }
});

test("R3 零金额退款条目无分项时取交易币种，与 v0 的 0 CAD 收费行一致；有金额却无分项按未就绪等待", () => {
  const v0 = refundFacts({ RefundEventList: [{ PostedDate: "2026-09-29T23:49:27Z", ShipmentItemAdjustmentList: [{ OrderAdjustmentItemId: "700001", SellerSKU: "SKU-D", QuantityShipped: 1, ItemChargeAdjustmentList: [{ ChargeType: "Tax", ChargeAmount: { CurrencyAmount: 0, CurrencyCode: "CAD" } }, { ChargeType: "ExportCharge", ChargeAmount: { CurrencyAmount: 0, CurrencyCode: "CAD" } }] }] }] }, ORDER);
  const zero = (itemTotal: number | null): Row => ({ transactionId: "Z", transactionType: "Refund", transactionStatus: "RELEASED", postedDate: "2026-09-29T23:49:27Z", totalAmount: usd(0, "CAD"), relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: ORDER }], breakdowns: [node("Refunded Expenses", 0), node("Refunded Sales", 0)],
    items: [{ relatedIdentifiers: [{ itemRelatedIdentifierName: "ORDER_ADJUSTMENT_ITEM_ID", itemRelatedIdentifierValue: "700001" }], contexts: [{ contextType: "ProductContext", sku: "SKU-D", quantityShipped: 1 }], totalAmount: { currencyAmount: itemTotal, currencyCode: null }, breakdowns: [] }] });
  const v2024 = refundFacts(eventsFromTransactions([zero(0)]), ORDER);
  assert.deepEqual(summary(v2024), summary(v0));
  assert.deepEqual(v2024[0]!.currencies, ["CAD"]);
  assert.throws(() => eventsFromTransactions([zero(-5)]), /财务费用明细未就绪/);
});
