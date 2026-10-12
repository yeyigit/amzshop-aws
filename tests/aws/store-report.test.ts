import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { AppConfig, JobEvent } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { MemoryState } from "./memory-state.js";
import { HEALTH_RULES } from "../../src/business/maintenance.js";
import { assembleDay, BACKFILL_BUDGET_MS, KIOSK_THROTTLE_WAIT_MS, kioskQueries, reportLink, reportUrl, runStoreReport } from "../../src/business/store-report.js";
import { HttpError } from "../../src/http.js";
import { addDays, comparisons, isoWeek, parsePeriod, periodLabel, periodOf, shiftPeriod, weekKey } from "../../src/report/periods.js";
import { adRatio, budgetSkuAds, computeDayLines, feesForMonth, feishuLine, ledgerFeeLines, parseOrderReport, refundDays, skuCosts, type SkuCost } from "../../src/report/facts.js";
import { sumDays } from "../../src/report/aggregate.js";
import { buildMessage, buildReportView } from "../../src/report/view.js";
import { REPORT_DAY_PK, REPORT_MONTH_PK, type AdsPart, type DayFacts, type MonthFacts } from "../../src/report/types.js";
import { flushNotification, prepareNotification, resendPendingNotifications } from "../../src/notifications.js";

type Row = Record<string, unknown>;
const root = path.resolve(import.meta.dirname, "..");
const t = (value: string): Array<{ type: string; text: string }> => [{ type: "text", text: value }];
const formula = (value: number): Row => ({ type: 2, value: [value] });

// ---------- 周期 ----------

test("周期：ISO 周跨年、键校验、前后翻期、进行中的月与上月同样天数比", () => {
  assert.equal(weekKey("2026-10-07"), "2026-W41");
  assert.deepEqual(parsePeriod("week", "2026-W41"), { type: "week", key: "2026-W41", from: "2026-10-05", to: "2026-10-11" });
  assert.deepEqual(isoWeek("2027-01-01"), { year: 2026, week: 53 }, "2027-01-01 属 2026 年第 53 周");
  assert.equal(weekKey("2027-01-04"), "2027-W01");
  assert.equal(periodLabel(parsePeriod("week", "2026-W53")!), "2026年第53周（12/28–1/3）");
  assert.equal(parsePeriod("week", "2025-W53"), null, "2025 年只有 52 周");
  assert.equal(parsePeriod("day", "2026-02-30"), null);
  assert.equal(parsePeriod("month", "2026-13"), null);
  assert.equal(parsePeriod("year", "26"), null);
  assert.equal(shiftPeriod(parsePeriod("month", "2026-01")!, -1).key, "2025-12");
  assert.equal(shiftPeriod(periodOf("week", "2026-12-31"), 1).key, "2027-W01");
  assert.equal(periodLabel(parsePeriod("day", "2026-10-07")!), "2026-10-07 周三");
  const [previous, lastYear] = comparisons(parsePeriod("month", "2026-10")!, "2026-10-08");
  assert.deepEqual([previous!.from, previous!.to, lastYear!.from, lastYear!.to], ["2026-09-01", "2026-09-08", "2025-10-01", "2025-10-08"]);
  const [, lastWeek] = comparisons(parsePeriod("day", "2026-10-07")!);
  assert.equal(lastWeek!.from, "2026-09-30");
});

// ---------- 订单报告与逐行毛利 ----------

const HEADER = ["amazon-order-id", "merchant-order-id", "purchase-date", "last-updated-date", "order-status", "fulfillment-channel", "sales-channel", "order-channel", "ship-service-level", "product-name", "sku", "asin", "item-status", "quantity", "currency", "item-price", "item-tax", "shipping-price", "shipping-tax", "gift-wrap-price", "gift-wrap-tax", "item-promotion-discount", "ship-promotion-discount", "ship-city", "ship-state", "ship-postal-code", "ship-country", "promotion-ids", "cpf", "is-business-order", "purchase-order-number", "price-designation", "signature-confirmation-recommended", "order-item-id"];
function reportRow(values: Record<string, string>): string {
  const base: Record<string, string> = { "sales-channel": "Amazon.com", "order-status": "Shipped", "item-status": "Shipped", quantity: "1", currency: "USD", "is-business-order": "false", "item-promotion-discount": "0", "ship-promotion-discount": "0", "product-name": 'Toy 3"', "ship-city": "X" };
  return HEADER.map((name) => values[name] ?? base[name] ?? "").join("\t");
}
// 10/08 洛杉矶：A 商品促销 1.00；C 清货；B 已取消；D 只在报告里（飞书缺行）；9/25 一单费用已到账。
const REPORT = [HEADER.join("\t"),
  reportRow({ "amazon-order-id": "111-0000001-0000001", "purchase-date": "2026-10-08T17:00:00+00:00", sku: "SKU-A", asin: "B0000000AA", "item-price": "12.99", "item-promotion-discount": "-1.00" }),
  reportRow({ "amazon-order-id": "111-0000002-0000002", "purchase-date": "2026-10-08T18:00:00+00:00", sku: "SKU-C", asin: "B0000000CC", "item-price": "13.99" }),
  reportRow({ "amazon-order-id": "111-0000003-0000003", "purchase-date": "2026-10-08T19:00:00+00:00", sku: "SKU-B", asin: "B0000000BB", "item-price": "15.99", "order-status": "Cancelled" }),
  reportRow({ "amazon-order-id": "111-0000004-0000004", "purchase-date": "2026-10-09T06:30:00+00:00", sku: "SKU-A", asin: "B0000000AA", "item-price": "12.99" }),
  reportRow({ "amazon-order-id": "111-0000005-0000005", "purchase-date": "2026-09-25T20:00:00+00:00", sku: "SKU-A", asin: "B0000000AA", "item-price": "12.99" }),
  reportRow({ "amazon-order-id": "S01-1111111-1111111", "purchase-date": "2026-10-08T20:00:00+00:00", sku: "SKU-A", "sales-channel": "Non-Amazon", "item-price": "12.99" }),
].join("\n");

test("订单报告：按洛杉矶日期归日（UTC 次日 06:30 仍是洛杉矶当天）、同单同 SKU 合并、取消与站外单不算销售、促销取正数", () => {
  const parsed = parseOrderReport(REPORT);
  assert.equal(parsed.rows, 6);
  const byId = new Map(parsed.lines.map((line) => [line.orderId, line]));
  assert.equal(byId.get("111-0000004-0000004")?.date, "2026-10-08");
  assert.equal(byId.get("111-0000001-0000001")?.promo, 1);
  assert.equal(byId.get("111-0000003-0000003")?.cancelled, true);
  assert.equal(byId.has("S01-1111111-1111111"), false, "多渠道配送单不是亚马逊销售");
  assert.throws(() => parseOrderReport("amazon-order-id\tsku\n1\t2"), /缺少列/);
});

const PROFIT_RECORDS = [
  { record_id: "p1", fields: { "SKU编号": [{ record_ids: ["s1"] }], "AMZ售价": 12.99, "AMZ-FBA配送费": 4.09, "预估佣金": 1.95, "计算用-固定成本-不含佣金配送费": formula(1.85), "毛利": formula(5.1), "毛利率": formula(0.39), "预估仓储费1-9月": 0.08, "预估仓储费10-12月": 0.25 } },
  { record_id: "p2", fields: { "SKU编号": [{ record_ids: ["s2"] }], "AMZ售价": 15.99, "AMZ-FBA配送费": 4.76, "预估佣金": 2.4, "计算用-固定成本-不含佣金配送费": formula(4.25), "毛利": formula(4.58), "毛利率": formula(0.286), "预估仓储费1-9月": 0.21, "预估仓储费10-12月": 0.66 } },
  { record_id: "p3", fields: { "SKU编号": [{ record_ids: ["s3"] }], "AMZ售价": 21.69, "AMZ-FBA配送费": 7.71, "预估佣金": 3.25, "计算用-固定成本-不含佣金配送费": formula(8.8), "毛利": formula(1.93), "毛利率": formula(0.089), "预估仓储费1-9月": 0.89, "预估仓储费10-12月": 2.74 } },
];
const SKU_RECORDS = [{ record_id: "s1", fields: { "SKU编号": "SKU-A" } }, { record_id: "s2", fields: { "SKU编号": "SKU-B" } }, { record_id: "s3", fields: { "SKU编号": "SKU-C" } }];
const orderLookups = (sku: "SKU-A" | "SKU-C"): Row => sku === "SKU-A"
  ? { "AMZ售价": [12.99], "毛利": [formula(5.1)], "计算用-固定成本-不含佣金配送费": [formula(1.85)], "预估佣金": formula(1.95) }
  : { "AMZ售价": [21.69], "毛利": [formula(1.93)], "计算用-固定成本-不含佣金配送费": [formula(8.8)], "预估佣金": formula(3.25) };
function orderRecords(): Array<{ fields: Row }> {
  return [
    { fields: { "订单编号": t("111-0000001-0000001"), SKU: t("SKU-A"), ASIN: t("B0000000AA"), "数量": 1, "订单状态": t("待处理"), "下单时间": t("2026-10-08 10:00:00"), "付款金额": 12.99, "金额": formula(12.99), "预期毛利": formula(5.1), "企业买家": t("false"), "换货单": t("false"), ...orderLookups("SKU-A") } },
    { fields: { "订单编号": t("111-0000002-0000002"), SKU: t("SKU-C"), "数量": 1, "订单状态": t("已发货"), "下单时间": t("2026-10-08 11:00:00"), "付款金额": 13.99, "预期毛利": formula(-4.6162), "企业买家": t("false"), "换货单": t("false"), ...orderLookups("SKU-C") } },
    { fields: { "订单编号": t("111-0000003-0000003"), SKU: t("SKU-B"), "数量": 1, "订单状态": t("已取消"), "下单时间": t("2026-10-08 12:00:00"), "付款金额": 15.99, "预期毛利": formula(4.58) } },
    { fields: { "订单编号": t("S01-1111111-1111111"), SKU: t("SKU-A"), "数量": 1, "订单状态": t("已发货"), "下单时间": t("2026-10-08 13:00:00"), "金额": formula(12.99), "预期毛利": formula(5.1) } },
    // 9/25 费用已到账：订单表公式按今天（10 月）的仓储费率 0.25 扣，报告按 9 月费率 0.08 修正，多 0.17。
    { fields: { "订单编号": t("111-0000005-0000005"), SKU: t("SKU-A"), "数量": 1, "订单状态": t("已发货"), "下单时间": t("2026-09-25 13:00:00"), "付款金额": 12.99, "佣金": 1.95, "配送费": 4.09, "促销费用": 0, "预期毛利": formula(5.1), ...orderLookups("SKU-A") } },
  ];
}

test("逐行毛利：已到账用订单表实际值并按下单月份修正仓储费；未到账按同一公式预估再扣实际促销；飞书缺行按成本表估算；取消不算、多渠道单列；拆解逐行相加等于毛利", () => {
  const costs = skuCosts(PROFIT_RECORDS, SKU_RECORDS);
  assert.equal(costs.get("SKU-C")?.marginRate, 0.089);
  const feishu = orderRecords().map((record) => feishuLine(record.fields)!).filter(Boolean);
  const report = parseOrderReport(REPORT).lines;
  const day = computeDayLines("2026-10-08", { reportLines: report, feishuLines: feishu, costs, todayMonth: 10 });
  // A：5.10 − 促销 1.00；C：13.99 − (21.69−1.93−3.25) − 3.25×13.99/21.69 ≈ −4.6162；飞书缺的那单按成本表 5.10。
  assert.equal(day.lines.profit, 4.58);
  assert.equal(day.lines.lines, 3);
  assert.equal(day.lines.estimatedLines, 3);
  assert.equal(day.lines.promo, 1);
  assert.equal(day.lines.missingInFeishu, 1);
  assert.deepEqual(day.checks, { reportLines: 3, feishuLines: 2, matched: 2 });
  assert.deepEqual(day.other, { lines: 1, units: 1, sales: 12.99, profit: 5.1 });
  const { revenue, promo, commission, fba, cogs, storageEst, profit } = day.lines;
  assert.ok(Math.abs(revenue - promo - commission - fba - cogs - storageEst - profit) < 0.02, "拆解逐项相加等于毛利");
  assert.equal(day.skus["SKU-C"]?.profit, -4.62);
  const september = computeDayLines("2026-09-25", { reportLines: report, feishuLines: feishu, costs, todayMonth: 10 });
  assert.equal(september.lines.profit, 5.27, "5.10 + (0.25 − 0.08)");
  assert.equal(september.lines.storageEst, 0.08);
  assert.equal(september.lines.estimatedLines, 0);
  // 报告没取到：仍按订单表算（取消看飞书），但费用未到账的行没扣促销。
  const noReport = computeDayLines("2026-10-08", { feishuLines: feishu, costs, todayMonth: 10 });
  assert.equal(noReport.lines.profit, 0.48, "5.10 − 4.6162");
  assert.equal(noReport.checks.reportLines, null);
});

test("逐行毛利：免费换货单佣金与配送费为 0；缺成本参数的行不计入并单独计数", () => {
  const costs = new Map<string, SkuCost>([["SKU-A", { sku: "SKU-A", price: 12.99, fba: 4.09, commission: 1.95, fixedCost: 1.85, margin: 5.1, marginRate: 0.39, storage19: 0.08, storage1012: 0.25 }]]);
  const lines = [
    feishuLine({ "订单编号": t("111-0000009-0000009"), SKU: t("SKU-A"), "数量": 1, "订单状态": t("已发货"), "下单时间": t("2026-10-08 09:00:00"), "付款金额": 0, "换货单": t("true"), "预期毛利": formula(-5.94), ...orderLookups("SKU-A") })!,
    feishuLine({ "订单编号": t("111-0000010-0000010"), SKU: t("SKU-Z"), "数量": 2, "订单状态": t("已发货"), "下单时间": t("2026-10-08 09:30:00"), "付款金额": 30 })!,
  ];
  const day = computeDayLines("2026-10-08", { feishuLines: lines, costs, todayMonth: 10 });
  assert.equal(day.lines.profit, -1.85, "换货单只亏商品成本（含按件仓储费）");
  assert.equal(day.lines.commission + day.lines.fba, 0);
  assert.equal(day.lines.costMissingLines, 1);
  assert.equal(day.lines.costMissingUnits, 2);
  assert.equal(day.skus["SKU-Z"]?.costMissing, 1);
});

// ---------- 广告 ----------

test("广告估算：近 14 天两边都有的日子不足 7 天按 1.0，比例限 1.0–1.6；按 SKU 先看广告目录、再看预算表所属 SKU", () => {
  const add = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const report = new Map<string, AdsPart>(), budget = new Map<string, { total: number; campaigns: Array<{ campaignId: string; spend: number; skuHint: string }> }>();
  for (let offset = 1; offset <= 6; offset += 1) { report.set(add("2026-10-08", -offset), { source: "report", spend: 50 }); budget.set(add("2026-10-08", -offset), { total: 40, campaigns: [] }); }
  assert.equal(adRatio(report, budget, "2026-10-08", add), 1, "只有 6 天可比");
  report.set("2026-10-01", { source: "report", spend: 50 }); budget.set("2026-10-01", { total: 40, campaigns: [] });
  assert.equal(adRatio(report, budget, "2026-10-08", add), 1.25);
  for (const date of report.keys()) report.set(date, { source: "report", spend: 200 });
  assert.equal(adRatio(report, budget, "2026-10-08", add), 1.6, "上限 1.6");
  const split = budgetSkuAds({ total: 10, campaigns: [{ campaignId: "C1", spend: 4, skuHint: "" }, { campaignId: "C2", spend: 6, skuHint: "SKU-B" }, { campaignId: "C3", spend: 2, skuHint: "SKU-A, SKU-B" }] }, 1.25, new Map([["C1", ["SKU-A"]], ["C3", []]]));
  assert.equal(split.bySku.get("SKU-A")?.spend, 5);
  assert.equal(split.bySku.get("SKU-B")?.spend, 7.5);
  assert.equal(split.unattributed.spend, 2.5, "所属 SKU 有两个、目录也没有的不归属");
});

// ---------- 退款 ----------

test("退款：不计代收的销售税；退回佣金减退款手续费与冲回促销都计；按入账的洛杉矶日期；多次入账按退款额拆；非美元单列", () => {
  const items = [
    { pk: "REFUND_FACTS", sk: "a", facts: [{ sku: "SKU-A", quantity: 1, postedDate: "2026-10-09T03:00:00Z", refundAmount: -14.03, currencies: ["USD"],
      charges: [{ ChargeType: "Principal", ChargeAmount: { CurrencyAmount: -12.99 } }, { ChargeType: "Tax", ChargeAmount: { CurrencyAmount: -1.04 } }],
      fees: [{ FeeType: "Commission", FeeAmount: { CurrencyAmount: 1.95 } }, { FeeType: "RefundCommission", FeeAmount: { CurrencyAmount: -0.39 } }],
      promotions: [{ PromotionType: "PromotionMetaDataDefinitionValue", PromotionAmount: { CurrencyAmount: 1 } }] }] },
    { pk: "REFUND_FACTS", sk: "b", facts: [{ sku: "SKU-B", quantity: 2, postedDate: "2026-10-08T20:00:00Z", refundAmount: -20, currencies: ["USD"], charges: [{ ChargeType: "Principal", ChargeAmount: { CurrencyAmount: -20 } }], fees: [], promotions: [],
      events: [{ postedDate: "2026-10-07T20:00:00Z", refundAmount: -5, quantity: 1 }, { postedDate: "2026-10-08T20:00:00Z", refundAmount: -15, quantity: 1 }] }] },
    { pk: "REFUND_FACTS", sk: "c", facts: [{ sku: "SKU-A", quantity: 1, postedDate: "2026-10-08T20:00:00Z", refundAmount: -18, currencies: ["CAD"], charges: [], fees: [], promotions: [] }] },
  ];
  const days = refundDays(items);
  const oct8 = days.get("2026-10-08")!.part;
  assert.equal(oct8.loss, -25.43, "−12.99 + 1.56 + 1.00（UTC 10/09 03:00 是洛杉矶 10/08）与 B 的 −15");
  assert.equal(oct8.units, 2);
  assert.equal(oct8.nonUsd, 1);
  assert.equal(days.get("2026-10-07")!.part.principal, -5);
  assert.equal(days.get("2026-10-08")!.bySku.get("SKU-A")?.loss, -10.43);
});

// ---------- 店铺费用 ----------

test("店铺费用：FBA 与 AWD 月度仓储费次月 7 日扣、算回上月；长期仓储费与月租按扣费月；划转与暂缓不计；广告扣款与待分类单列", () => {
  const at = (iso: string): number => Date.parse(iso);
  const rows = [
    { "交易时间": at("2026-10-07T15:44:05Z"), "交易状态": t("已发放"), "业务分类": t("平台费用"), "流水名称": t("亚马逊物流仓储费"), "原币金额": -231.4, "币种": t("USD"), "原始描述": t("FBAStorageBilling") },
    { "交易时间": at("2026-10-07T09:15:01Z"), "交易状态": t("已发放"), "业务分类": t("平台费用"), "流水名称": t("AWD 仓储费"), "原币金额": -42.1, "币种": t("USD"), "原始描述": t("STARStorageBilling") },
    { "交易时间": at("2026-09-19T18:11:27Z"), "交易状态": t("已发放"), "业务分类": t("平台费用"), "流水名称": t("亚马逊物流长期仓储费"), "原币金额": -88.6, "币种": t("USD"), "原始描述": t("FBALongTermStorageBilling") },
    { "交易时间": at("2026-09-12T18:42:03Z"), "交易状态": t("已发放"), "业务分类": t("平台费用"), "流水名称": t("月度服务费"), "原币金额": -175, "币种": t("MXN"), "原始描述": t("Subscription") },
    { "交易时间": at("2026-09-10T18:42:03Z"), "交易状态": t("已发放"), "业务分类": t("账户划转"), "流水名称": t("结算划转"), "原币金额": 1800, "币种": t("USD"), "原始描述": t("Transfer") },
    { "交易时间": at("2026-09-11T18:42:03Z"), "交易状态": t("暂缓"), "业务分类": t("平台费用"), "流水名称": t("Vine 费用"), "原币金额": -200, "币种": t("USD"), "原始描述": t("VineCharge") },
    { "交易时间": at("2026-09-20T18:42:03Z"), "交易状态": t("已发放"), "业务分类": t("广告费用"), "流水名称": t("广告费用"), "原币金额": -500, "币种": t("USD"), "原始描述": t("ProductAdsPayment") },
    { "交易时间": at("2026-09-21T18:42:03Z"), "交易状态": t("已发放"), "业务分类": t("赔偿与补偿"), "流水名称": t("亚马逊物流买家未退货赔偿"), "原币金额": 21.5, "币种": t("USD"), "原始描述": t("REVERSAL_REIMBURSEMENT") },
  ].map((fields) => ({ fields }));
  const september = feesForMonth(ledgerFeeLines(rows), "2026-09");
  assert.deepEqual(september.map((line) => [line.kind, line.amount, line.currency]).sort(), [
    ["adsInvoice", -500, "USD"], ["awdStorage", -42.1, "USD"], ["ltsf", -88.6, "USD"], ["reimbursement", 21.5, "USD"], ["storage", -231.4, "USD"], ["subscription", -175, "MXN"],
  ].sort());
  assert.deepEqual(feesForMonth(ledgerFeeLines(rows), "2026-10"), [], "10/07 扣的仓储费属于 9 月");
});

// ---------- 汇总、视图与消息 ----------

function dayFacts(date: string, overrides: Partial<DayFacts> = {}): DayFacts {
  return {
    date, schema: 1, version: 1, status: "draft", computedAt: `${date}T08:00:00.000Z`, sources: {},
    sales: { units: 10, orders: 10, sales: 100, currency: "USD" },
    lines: { lines: 10, units: 10, revenue: 100, promo: 2, commission: 15, fba: 40, cogs: 18, storageEst: 1, profit: 24, estimatedLines: 0, costMissingLines: 0, costMissingUnits: 0, missingInFeishu: 0, missingInReport: 0, duplicateKeys: 0 },
    ads: { source: "report", spend: 10, sales: 40, orders: 3, units: 3, impressions: 1000, clicks: 50 },
    traffic: { sessions: 100, pageViews: 150, buyBoxPct: 100, unitSessionPct: 10, unitsOrdered: 10, orderedSales: 100, unitsRefunded: 1, refundRate: 10, unitsShipped: 9, shippedSales: 90, feedback: 0, negativeFeedback: 0 },
    refunds: { events: 1, units: 1, principal: -10, feeBack: 1.2, promoBack: 0, loss: -8.8, nonUsd: 0 },
    skus: { "SKU-A": { units: 10, revenue: 100, promo: 2, commission: 15, fba: 40, cogs: 18, storageEst: 1, profit: 24, lines: 10, estimatedLines: 0, costMissing: 0, adSpend: 10, adSales: 40, adOrders: 3 } },
    ...overrides,
  };
}

test("汇总：购物车占比按页面浏览加权，转化率与退款率由合计重算；广告估算天数单独计", () => {
  const a = dayFacts("2026-10-01", { traffic: { ...dayFacts("x").traffic!, sessions: 100, pageViews: 100, buyBoxPct: 100, unitsOrdered: 10 } });
  const b = dayFacts("2026-10-02", { traffic: { ...dayFacts("x").traffic!, sessions: 300, pageViews: 300, buyBoxPct: 80, unitsOrdered: 15, unitsRefunded: 2 }, ads: { source: "estimate", spend: 12, budgetRaw: 10, ratio: 1.2 } });
  const total = sumDays([a, b]);
  assert.equal(total.traffic?.buyBoxPct, 85);
  assert.equal(total.traffic?.unitSessionPct, 6.25);
  assert.equal(total.traffic?.refundRate, 12);
  assert.equal(total.ads?.spend, 22);
  assert.equal(total.ads?.estimateDays, 1);
  assert.equal(total.coverage.adsReport, 1);
});

test("日报视图：5 个数与“较前一天/较上周同日”；广告估算标“估”；亏损款与销售变化写成要点；消息与页面同一份数字", () => {
  const days = new Map<string, DayFacts>();
  for (let index = 0; index < 14; index += 1) {
    const date = new Date(Date.parse("2026-09-25T00:00:00Z") + index * 86_400_000).toISOString().slice(0, 10);
    days.set(date, dayFacts(date));
  }
  days.set("2026-10-08", dayFacts("2026-10-08", {
    sales: { units: 20, orders: 19, sales: 200, currency: "USD" }, ads: { source: "estimate", spend: 15, budgetRaw: 12, ratio: 1.25 },
    lines: { ...dayFacts("x").lines!, revenue: 200, profit: 30 },
    skus: { "SKU-A": { ...dayFacts("x").skus["SKU-A"]!, units: 16, revenue: 160, profit: 55, adSpend: 10, adEstimate: true }, "SKU-C": { units: 4, revenue: 40, promo: 0, commission: 6, fba: 30, cogs: 25, storageEst: 4, profit: -25, lines: 4, estimatedLines: 4, costMissing: 0, adSpend: 5, adEstimate: true } },
    clearanceSkus: ["SKU-C"],
  }));
  const view = buildReportView({ period: periodOf("day", "2026-10-08"), today: "2026-10-09", nowMs: Date.parse("2026-10-09T07:20:00Z"), days, months: new Map(), meta: { earliest: "2026-09-25", latest: "2026-10-08", updatedAt: "" } });
  const kpi = Object.fromEntries(view.kpis.map((cell) => [cell.key, cell]));
  assert.deepEqual([kpi.units!.value, kpi.sales!.value, kpi.orderProfit!.value, kpi.adSpend!.value, kpi.expectedProfit!.value], [20, 200, 30, 15, 15]);
  assert.equal(kpi.adSpend!.estimate, true);
  assert.deepEqual(kpi.sales!.compare.map((cell) => [cell.label, cell.diff, cell.pct]), [["较前一天", 100, 1], ["较上周同日", 100, 1]]);
  assert.equal(view.status.tone, "estimate");
  assert.match(view.highlights[0]!, /^⚠ 清货款 SKU-C 亏 \$30\.00，其余 1 款合计 \+\$45\.00$/);
  assert.match(view.highlights[1]!, /^销售金额较上周同日 \+100%（\+\$100\.00），主要来自 SKU-A（\+6 件）/);
  assert.equal(view.nav.next, null, "最新一期没有下一期");
  assert.equal(view.nav.prev, "2026-10-07");
  const message = buildMessage(view);
  assert.equal(message.title, "📊 日报已生成｜10/08 周四（洛杉矶）");
  assert.deepEqual(message.lines.slice(0, 4), ["销售数量 20　销售金额 $200.00", "订单毛利 $30.00　广告花费 ≈$15.00（估）", "预期毛利 ≈$15.00（毛利率 7.5%）", "较上周同日：销售金额 +100%，预期毛利 +$1.00"]);
  assert.match(message.linkText, /^查看日报 ›（约 1\.5 小时后广告换成实际值）$/);
});

test("月报视图：仓储费没扣前净利润不算并写明；扣了以后用实际仓储费替换按件预估；年报用月汇总", () => {
  const days = new Map<string, DayFacts>();
  for (let day = 1; day <= 30; day += 1) { const date = `2026-09-${String(day).padStart(2, "0")}`; days.set(date, dayFacts(date, { status: "final" })); }
  const fees = (storagePosted: boolean): NonNullable<MonthFacts["fees"]> => ({ storagePosted, at: "", lines: [
    ...(storagePosted ? [{ kind: "storage" as const, name: "亚马逊物流仓储费", amount: -231.4, currency: "USD", postedMonth: "2026-10>2026-09" }] : []),
    { kind: "ltsf", name: "长期仓储费", amount: -88.6, currency: "USD", postedMonth: "2026-09" }, { kind: "reimbursement", name: "赔偿", amount: 21.5, currency: "USD", postedMonth: "2026-09" },
    { kind: "subscription", name: "月度服务费", amount: -175, currency: "MXN", postedMonth: "2026-09" },
  ] });
  const input = (storagePosted: boolean, today: string) => ({ period: periodOf("month", "2026-09-01"), today, nowMs: 0, days, months: new Map<string, MonthFacts>([["2026-09", { month: "2026-09", schema: 1, status: "draft", computedAt: "", fees: fees(storagePosted), rollup: sumDays([...days.values()]), rollupThrough: "2026-09-30" }]]), meta: null });
  const pending = buildReportView(input(false, "2026-10-03"));
  assert.equal(pending.net?.netProfit, null);
  assert.match(pending.net!.pendingNote, /9 月仓储费约 10\/7 扣费/);
  const posted = buildReportView(input(true, "2026-10-09"));
  // 预期毛利 30×(24−10)=420，退款 30×(−8.8)，赔偿 21.5，费用 −320，加回按件仓储费 30。
  assert.equal(posted.net?.netProfit, Math.round((420 - 264 + 21.5 - 320 + 30) * 100) / 100);
  assert.deepEqual(posted.fees?.nonUsd, [{ label: "月度服务费｜月度服务费", amount: -175, currency: "MXN" }]);
  assert.match(buildMessage(posted).lines.join("\n"), /净利润（估）−\$112\.50/);
  const year = buildReportView({ period: periodOf("year", "2026-01-01"), today: "2026-10-09", nowMs: 0, days: new Map(), months: input(true, "2026-10-09").months, meta: null });
  assert.equal(year.kpis.find((cell) => cell.key === "sales")?.value, 3000, "年报直接用 9 月月汇总");
});

test("对比期缺天就不比：报告从 9/19 才有数，10 月不出“较上月”；上周完整照常比；上周某天缺订单逐行，只有订单毛利与预期毛利不比", () => {
  const days = new Map<string, DayFacts>();
  for (let date = "2026-09-19"; date <= "2026-10-20"; date = addDays(date, 1)) days.set(date, dayFacts(date));
  const month = buildReportView({ period: periodOf("month", "2026-10-01"), today: "2026-10-21", nowMs: 0, days, months: new Map(), meta: null });
  const monthSales = month.kpis.find((cell) => cell.key === "sales")!;
  assert.equal(monthSales.value, 2000);
  assert.deepEqual(monthSales.compare, [], "9/1–9/18 没有数据，不拿 9/19–9/20 两天去比 10 月 20 天");
  assert.ok(!buildMessage(month).lines.some((line) => line.startsWith("较上月")));
  const week = (input: Map<string, DayFacts>) => buildReportView({ period: periodOf("week", "2026-10-12"), today: "2026-10-19", nowMs: 0, days: input, months: new Map(), meta: null });
  const pct = (view: ReturnType<typeof buildReportView>, key: string) => view.kpis.find((cell) => cell.key === key)!.compare.map((cell) => [cell.label, cell.pct, cell.diff]);
  assert.deepEqual(pct(week(days), "sales"), [["较上周", 0, 0]]);
  assert.match(buildMessage(week(days)).lines.join("\n"), /较上周：销售金额 持平，/, "取整后为 0 写“持平”，不写“−0.0%”");
  const gap = new Map(days);
  const broken = dayFacts("2026-10-07");
  delete broken.lines;
  gap.set("2026-10-07", broken);
  assert.deepEqual(pct(week(gap), "sales"), [["较上周", 0, 0]], "销售每天都有，照比");
  assert.deepEqual(pct(week(gap), "orderProfit"), [["较上周", null, null]], "上周少一天订单毛利，不比");
  assert.deepEqual(pct(week(gap), "expectedProfit"), [["较上周", null, null]]);
});

// ---------- 任务：推送、刷新、定稿 ----------

const config = (overrides: Record<string, string> = {}): AppConfig => {
  const values: Record<string, string> = {
    FEISHU_BITABLE_APP_TOKEN_ORDERS: "app", FEISHU_BITABLE_TABLE_ID_ORDERS: "tbl-orders", FEISHU_BITABLE_TABLE_ID_PROFIT_ESTIMATE: "tbl-profit", FEISHU_BITABLE_TABLE_ID_SKUS: "tbl-skus",
    FEISHU_BITABLE_TABLE_ID_ADS_DAILY_OVERVIEW: "tbl-overview", FEISHU_BITABLE_TABLE_ID_ADS_CAMPAIGN_DAILY: "tbl-campaign", FEISHU_BITABLE_TABLE_ID_ADS: "tbl-budget",
    FEISHU_BITABLE_TABLE_ID_FINANCE_LEDGER: "tbl-ledger", FEISHU_BITABLE_TABLE_ID_INVENTORY_ALERTS: "tbl-inventory", FEISHU_NOTIFY_USER_IDS: "u-owner,u-wang", ADS_PROFILE_ID: "P1", ...overrides,
  };
  return {
    get: (key: string) => { const value = values[key]; if (!value) throw new Error(`缺少 Parameter Store 配置 ${key}。`); return value; },
    optional: (key: string, fallback = "") => values[key] ?? fallback,
    bool: (key: string, fallback = false) => { const raw = values[key]; return raw === undefined ? fallback : ["1", "true", "yes", "on"].includes(raw.toLowerCase()); },
    json: <T>(key: string): T => JSON.parse(values[key] ?? "null") as T,
    asins: () => [{ sku: "SKU-A", asin: "B0000000AA", competitors: [], adMarker: "" }, { sku: "SKU-B", asin: "B0000000BB", competitors: [], adMarker: "" }, { sku: "SKU-C", asin: "B0000000CC", competitors: [], adMarker: "" }],
    version: "test",
  };
};

interface Harness { amazon: AmazonClient; feishu: FeishuClient; sent: Array<{ to: string; title: string; lines: string[]; link?: { text: string; url: string } }>; schedules: Array<{ event: JobEvent; when: Date }>; calls: string[] }
function harness(options: { overviewDates?: string[]; salesFails?: boolean } = {}): Harness {
  const calls: string[] = [];
  const add = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const overviewDates = options.overviewDates ?? Array.from({ length: 40 }, (_, index) => add("2026-10-08", -index));
  const amazon = {
    sp: async (requestPath: string, init: Row = {}) => {
      calls.push(`${String(init.method ?? "GET")} ${requestPath}`);
      if (requestPath === "/sales/v1/orderMetrics") {
        if (options.salesFails) throw new Error("HTTP 请求超时。");
        const query = init.query as Row;
        const [startIso, endIso] = String(query.interval).split("--");
        const output: Row[] = [];
        for (let ms = Date.parse(startIso!); ms < Date.parse(endIso!); ms += 86_400_000) {
          const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms + 3_600_000));
          const units = query.buyerType === "B2B" ? 0 : date === "2026-10-08" ? 3 : date === "2026-09-25" ? 1 : 0;
          const sales = date === "2026-10-08" ? 39.97 : date === "2026-09-25" ? 12.99 : 0;
          output.push({ interval: `${date}T00:00-07:00--${add(date, 1)}T00:00-07:00`, unitCount: units, orderCount: units, totalSales: { amount: query.buyerType === "B2B" ? 0 : sales, currencyCode: "USD" } });
        }
        return { payload: output };
      }
      if (requestPath === "/reports/2021-06-30/reports" && init.method === "POST") return { reportId: "R1" };
      if (requestPath === "/reports/2021-06-30/reports/R1") return { processingStatus: "DONE", reportDocumentId: "D1" };
      if (requestPath === "/reports/2021-06-30/documents/D1") return { url: "https://reports.example/d1" };
      throw new Error(`unexpected ${requestPath}`);
    },
    download: async () => new TextEncoder().encode(REPORT),
  } as unknown as AmazonClient;
  const sent: Harness["sent"] = [];
  const feishu = {
    sendPost: async (to: string, post: { title: string; lines: string[]; link?: { text: string; url: string } }, uuid: string) => { assert.ok(uuid); sent.push({ to, ...post }); },
    sendText: async () => { throw new Error("店铺报告只发富文本"); },
    request: async (method: string, requestPath: string, body: Row) => {
      calls.push(`${method} ${requestPath}`);
      assert.equal(method, "POST");
      assert.match(requestPath, /\/records\/search$/);
      const table = requestPath.split("/tables/")[1]!.split("/")[0];
      const filter = body.filter as { conditions: Array<{ field_name: string; value: string[] }> };
      const wanted = filter.conditions.map((condition) => condition.value[0]);
      if (table === "tbl-orders" && filter.conditions[0]?.field_name === "下单时间") return { items: orderRecords().filter((record) => wanted.some((day) => JSON.stringify(record.fields["下单时间"]).includes(String(day)))), has_more: false };
      if (table === "tbl-orders") return { items: [{ fields: { SKU: t("SKU-A"), "售后原因中文": t("[退货] 不想要了"), "售后原因时间": t("2026-10-08 15:00:00｜退货报告") } }], has_more: false };
      if (table === "tbl-overview") return { items: overviewDates.map((date) => ({ fields: { "站点日期": Date.parse(`${date}T12:00:00Z`), "花费": 6, "广告销售额": 12.99, "广告订单": 1, "广告销量": 1, "曝光": 1000, "点击": 10 } })), has_more: false };
      if (table === "tbl-campaign") return { items: [{ fields: { "站点日期": Date.parse("2026-10-08T12:00:00Z"), "SKU编号": t("SKU-A"), "花费": 6, "广告销售额": 12.99, "广告订单": 1, "点击": 10, "曝光": 1000 } }], has_more: false };
      if (table === "tbl-budget") return { items: wanted.map((date) => ({ fields: { "预算日期": t(String(date)), "已花费预算": 4.8, "广告活动ID": t("C1"), "所属SKU": t("SKU-A") } })), has_more: false };
      if (table === "tbl-ledger") return { items: [{ fields: { "交易时间": Date.parse("2026-10-07T15:44:05Z"), "交易状态": t("已发放"), "业务分类": t("平台费用"), "流水名称": t("亚马逊物流仓储费"), "原币金额": -231.4, "币种": t("USD"), "原始描述": t("FBAStorageBilling") } }], has_more: false };
      throw new Error(`unexpected table ${table}`);
    },
    listRecords: async (_app: string, table: string) => {
      calls.push(`GET ${table}`);
      if (table === "tbl-profit") return PROFIT_RECORDS;
      if (table === "tbl-skus") return SKU_RECORDS;
      if (table === "tbl-inventory") return [{ record_id: "i1", fields: { SKU: "SKU-A", "FBA可售": 30, "FBA可售覆盖天数": 10, "预警等级": "即将补货" } }];
      throw new Error(`unexpected list ${table}`);
    },
  } as unknown as FeishuClient;
  return { amazon, feishu, sent, schedules: [], calls };
}
const deps = (h: Harness, nowIso: string) => ({ schedule: async (event: JobEvent, when: Date) => { h.schedules.push({ event, when }); return "s"; }, sleep: async () => undefined, now: () => Date.parse(nowIso), portalUrl: "https://portal.example.on.aws/", reportPollMs: 0, kioskPollMs: 0 });
const stored = (state: MemoryState, date: string): DayFacts => JSON.parse(String(state.item(REPORT_DAY_PK, date)?.payload)) as DayFacts;

test("推送轮：重算近 20 天并写入；发前一天的日报（富文本＋这一期的链接，发给通知接收人）；排 01:45 刷新；同一期不重发", async () => {
  const state = new MemoryState([{ pk: "REFUND_FACTS", sk: "x", facts: [{ sku: "SKU-A", quantity: 1, postedDate: "2026-10-08T20:00:00Z", refundAmount: -12.99, currencies: ["USD"], charges: [{ ChargeType: "Principal", ChargeAmount: { CurrencyAmount: -12.99 } }], fees: [], promotions: [] }] }]);
  const h = harness({ overviewDates: Array.from({ length: 30 }, (_, index) => new Date(Date.parse("2026-10-07T00:00:00Z") - index * 86_400_000).toISOString().slice(0, 10)) });
  const event: JobEvent = { taskType: "store-report", scheduledAt: "2026-10-09T07:15:00Z" };
  const result = await runStoreReport(event, config(), state.asStore(), h.amazon, h.feishu, deps(h, "2026-10-09T07:15:30Z"));
  assert.equal(result.status, "done");
  assert.equal(result.days, 20);
  assert.equal(result.written, 20);
  const day = stored(state, "2026-10-08");
  assert.equal(day.lines?.profit, 4.58);
  assert.equal(day.ads?.source, "estimate", "10/08 广告报表还没到");
  assert.equal(day.ads?.spend, 6, "预算 4.8 × 近 14 天比例 6/4.8=1.25");
  assert.equal(day.ads?.ratio, 1.25);
  assert.equal(day.skus["SKU-A"]?.adEstimate, true);
  assert.equal(day.refunds?.loss, -12.99);
  assert.equal(day.inventory?.["SKU-A"]?.daysOfCover, 10);
  assert.deepEqual(day.clearanceSkus, ["SKU-C"]);
  assert.deepEqual(day.reasons, [{ sku: "SKU-A", text: "[退货] 不想要了" }]);
  assert.deepEqual(h.sent.map((item) => item.to), ["u-owner", "u-wang"]);
  assert.equal(h.sent[0]!.title, "📊 日报已生成｜10/08 周四（洛杉矶）");
  assert.deepEqual(h.sent[0]!.link, { text: "查看日报 ›（约 1.5 小时后广告换成实际值）", url: "https://applink.feishu.cn/client/web_url/open?mode=window&url=https%3A%2F%2Fportal.example.on.aws%2Freport%2Fday%2F2026-10-08" }, "电脑端在飞书独立窗口打开，不跳系统浏览器");
  assert.match(h.sent[0]!.lines[1]!, /广告花费 ≈\$6\.00（估）/);
  assert.equal(h.schedules.length, 1);
  assert.equal(h.schedules[0]!.when.toISOString(), "2026-10-09T08:45:00.000Z", "洛杉矶 01:45（夏令时）");
  assert.deepEqual(h.schedules[0]!.event.cursor, { mode: "refresh", today: "2026-10-09" });
  assert.ok(h.calls.every((call) => !/dataKiosk/.test(call)), "推送轮不查 Data Kiosk");
  const again = await runStoreReport(event, config(), state.asStore(), h.amazon, h.feishu, deps(h, "2026-10-09T07:20:00Z"));
  assert.equal(h.sent.length, 2, "同一期只发一次");
  assert.equal(again.written, 0, "数据没变不重写");
});

test("刷新轮：不发消息；广告报表没到就 15 分钟后再来（最晚 04:30）；到了就换成报表实际值", async () => {
  const state = new MemoryState();
  const late = harness({ overviewDates: ["2026-10-07"] });
  const refresh: JobEvent = { taskType: "store-report", scheduledAt: "2026-10-09T08:45:00Z", taskId: "store-report|refresh|2026-10-09", cursor: { mode: "refresh", today: "2026-10-09" } };
  const noKiosk = { ...deps(late, "2026-10-09T08:45:10Z"), kioskBudgetMs: 0 };
  const waiting = await runStoreReport(refresh, config(), state.asStore(), late.amazon, late.feishu, noKiosk);
  assert.equal(waiting.status, "waiting_ads");
  assert.equal(late.schedules[0]!.when.toISOString(), "2026-10-09T09:00:10.000Z");
  assert.equal(late.sent.length, 0);
  const tooLate = await runStoreReport(refresh, config(), state.asStore(), late.amazon, late.feishu, { ...deps(late, "2026-10-09T11:20:00Z"), kioskBudgetMs: 0 });
  assert.equal(tooLate.status, "done", "过了 04:30 不再等，次日运行补上");
  const ready = harness();
  const done = await runStoreReport(refresh, config(), state.asStore(), ready.amazon, ready.feishu, { ...deps(ready, "2026-10-09T09:00:10Z"), kioskBudgetMs: 0 });
  assert.equal(done.status, "done");
  const day = stored(state, "2026-10-08");
  assert.deepEqual([day.ads?.source, day.ads?.spend, day.skus["SKU-A"]?.adSpend, day.skus["SKU-A"]?.adEstimate], ["report", 6, 6, undefined]);
  assert.equal(ready.sent.length, 0);
});

test("Data Kiosk 限流（回填连跑十几个月时会遇到）：建查询、取文档遇 429 等一分钟再试，流量照样补上", async () => {
  const state = new MemoryState();
  const h = harness();
  const base = h.amazon as unknown as { sp: (requestPath: string, init?: Row) => Promise<unknown>; download: (url: string) => Promise<Uint8Array> };
  const throttle = new HttpError(429, "QuotaExceeded", "req-1", "HTTP 429 QuotaExceeded", true);
  const row = JSON.stringify({ startDate: "2026-10-08", childAsin: "B0000000AA", traffic: { sessions: 40, pageViews: 52, buyBoxPercentage: 100, unitSessionPercentage: 7.5 }, sales: { unitsOrdered: 3, orderedProductSales: { amount: 39.97, currencyCode: "USD" } } });
  let creates = 0, documents = 0;
  const amazon = {
    sp: async (requestPath: string, init: Row = {}) => {
      if (requestPath === "/dataKiosk/2023-11-15/queries" && init.method === "POST") { creates += 1; if (creates === 1) throw throttle; return { queryId: `Q${creates}` }; }
      if (requestPath.startsWith("/dataKiosk/2023-11-15/queries/")) return { processingStatus: "DONE", dataDocumentId: `D-${requestPath.split("/").pop()}` };
      if (requestPath.startsWith("/dataKiosk/2023-11-15/documents/")) { documents += 1; if (documents === 1) throw throttle; return { documentUrl: `https://kiosk.example/${requestPath.split("/").pop()}` }; }
      return base.sp(requestPath, init);
    },
    download: async (url: string) => url.startsWith("https://kiosk.example/") ? new TextEncoder().encode(`${row}\n`) : base.download(url),
  } as unknown as AmazonClient;
  const waits: number[] = [];
  const refresh: JobEvent = { taskType: "store-report", scheduledAt: "2026-10-09T08:45:00Z", taskId: "store-report|refresh|2026-10-09", cursor: { mode: "refresh", today: "2026-10-09" } };
  const result = await runStoreReport(refresh, config(), state.asStore(), amazon, h.feishu, { ...deps(h, "2026-10-09T09:00:10Z"), sleep: async (ms: number) => { waits.push(ms); } });
  assert.ok(!(result.failed as string[]).includes("kiosk"));
  assert.equal(creates, 3, "限流的那次没建成，重试后店铺级与子 ASIN 两个查询都建了");
  assert.equal(waits.filter((ms) => ms === KIOSK_THROTTLE_WAIT_MS).length, 2, "建查询、取文档各等一分钟");
  const day = stored(state, "2026-10-08");
  assert.equal(day.traffic?.sessions, 40);
  assert.equal(day.asinTraffic?.["B0000000AA"]?.sessions, 40);
});

test("取数失败保留旧值并标明，不写 0；窗口外的初稿定稿；STORE_REPORT_ENABLED=false 空跑、STORE_REPORT_PUSH 置空不发消息", async () => {
  const state = new MemoryState([{ pk: REPORT_DAY_PK, sk: "2026-09-18", status: "draft", payload: JSON.stringify(dayFacts("2026-09-18")) }]);
  const first = harness();
  await runStoreReport({ taskType: "store-report", scheduledAt: "2026-10-09T07:15:00Z" }, config({ STORE_REPORT_PUSH: "" }), state.asStore(), first.amazon, first.feishu, deps(first, "2026-10-09T07:16:00Z"));
  assert.equal(first.sent.length, 0);
  assert.equal(stored(state, "2026-09-18").status, "final", "9/18 已出 20 天窗口");
  const failing = harness({ salesFails: true });
  await runStoreReport({ taskType: "store-report", scheduledAt: "2026-10-09T08:45:00Z", cursor: { mode: "refresh", today: "2026-10-09" } }, config(), state.asStore(), failing.amazon, failing.feishu, { ...deps(failing, "2026-10-09T08:46:00Z"), kioskBudgetMs: 0 });
  const day = stored(state, "2026-10-08");
  assert.equal(day.sales?.units, 3, "销售接口失败，沿用上次的值");
  assert.match(day.sources.sales?.note ?? "", /本次取数失败（接口超时），沿用/);
  assert.deepEqual(await runStoreReport({ taskType: "store-report" }, config({ STORE_REPORT_ENABLED: "false" }), state.asStore(), first.amazon, first.feishu), { status: "done", disabled: true });
});

test("月末发月报初版并记初版快照；周日发周报；22 日定稿上月并发“已定稿”（写出与初版相比的变化）", async () => {
  const state = new MemoryState();
  for (let day = 1; day <= 31; day += 1) {
    const date = `2026-10-${String(day).padStart(2, "0")}`;
    if (date < "2026-10-12") await state.put({ pk: REPORT_DAY_PK, sk: date, status: "final", payload: JSON.stringify(dayFacts(date, { status: "final" })) });
  }
  const h = harness({ overviewDates: [] });
  await runStoreReport({ taskType: "store-report", scheduledAt: "2026-11-01T07:15:00Z" }, config(), state.asStore(), h.amazon, h.feishu, deps(h, "2026-11-01T07:16:00Z"));
  assert.deepEqual(h.sent.map((item) => item.title).filter((title, index, list) => list.indexOf(title) === index), ["📊 日报已生成｜10/31 周六（洛杉矶）", "📊 月报已生成（初版）｜2026年10月"]);
  const month = JSON.parse(String(state.item(REPORT_MONTH_PK, "2026-10")?.payload)) as MonthFacts;
  assert.ok(month.firstDraft?.at, "月报初版快照");
  const sunday = harness({ overviewDates: [] });
  await runStoreReport({ taskType: "store-report", scheduledAt: "2026-11-02T08:15:00Z" }, config(), state.asStore(), sunday.amazon, sunday.feishu, deps(sunday, "2026-11-02T08:16:00Z"));
  assert.ok(sunday.sent.some((item) => item.title === "📊 周报已生成｜第44周 10/26–11/1"), "11/1 是周日；冬令时洛杉矶 00:15＝08:15Z");
  assert.ok(sunday.sent.some((item) => item.link && new URL(item.link.url).searchParams.get("url") === "https://portal.example.on.aws/report/week/2026-W44"));
  const final = harness({ overviewDates: [] });
  await runStoreReport({ taskType: "store-report", scheduledAt: "2026-11-22T08:15:00Z" }, config(), state.asStore(), final.amazon, final.feishu, deps(final, "2026-11-22T08:16:00Z"));
  const finalMessage = final.sent.find((item) => item.title === "📊 月报已定稿｜2026年10月");
  assert.ok(finalMessage, "22 日定稿上月");
  assert.equal(JSON.parse(String(state.item(REPORT_MONTH_PK, "2026-10")?.payload)).status, "final");
});

test("组装一天：新取到的块用新的，没取到的沿用上次（按 SKU 拆开拼回）", () => {
  const previous = dayFacts("2026-10-08", { sources: { sales: { status: "ok", at: "2026-10-08T08:00:00Z" } } });
  const failed = { ok: false as const, error: "接口超时" };
  const next = assembleDay(previous, { sales: failed, orders: failed, costs: failed, overview: failed, campaignAds: failed, snapshot: failed, refunds: failed, reasons: failed }, { date: "2026-10-08", yesterday: "2026-10-08", nowIso: "2026-10-09T08:00:00Z", todayMonth: 10, skuAsins: {} });
  assert.deepEqual([next.sales, next.lines, next.ads, next.refunds], [previous.sales, previous.lines, previous.ads, previous.refunds]);
  assert.equal(next.skus["SKU-A"]?.adSpend, 10);
  assert.match(next.sources.sales?.note ?? "", /沿用 2026-10-08T08:00:00Z 的数据/);
});

test("2026-04 以前的日子：飞书订单表不完整，订单毛利记“没有”而不是 0；销售照常", () => {
  const ok = <T>(value: T) => ({ ok: true as const, value });
  const failed = { ok: false as const, error: "接口超时" };
  const sales = new Map([["2026-03-15", { units: 2, orders: 2, sales: 25.98, currency: "USD", b2bSales: 0, b2bUnits: 0 }]]);
  const fetched = { sales: ok(sales), orders: ok([]), costs: ok(new Map()), overview: failed, campaignAds: failed, snapshot: failed, refunds: failed, reasons: failed };
  const options = { yesterday: "2026-10-08", nowIso: "2026-10-09T08:00:00Z", todayMonth: 10, skuAsins: {} };
  const march = assembleDay(undefined, fetched as Parameters<typeof assembleDay>[1], { ...options, date: "2026-03-15" });
  assert.equal(march.lines, undefined, "不能按 0 算订单毛利");
  assert.equal(march.sources.lines?.status, "unavailable");
  assert.equal(march.sales?.sales, 25.98);
  const april = assembleDay(undefined, { ...fetched, sales: ok(new Map([["2026-04-01", sales.get("2026-03-15")!]])) } as Parameters<typeof assembleDay>[1], { ...options, date: "2026-04-01" });
  assert.ok(april.lines, "4 月起照常逐行计算");
  assert.equal(sumDays([march]).lines, undefined);
});

test("消息带链接：意图里存标题与链接，补发时照样发富文本", async () => {
  const state = new MemoryState();
  const messages: Row[] = [];
  const feishu = { sendPost: async (to: string, post: Row) => { messages.push({ to, ...post }); }, sendText: async () => { throw new Error("不应发纯文本"); } } as unknown as FeishuClient;
  const prepared = await prepareNotification(config(), state.asStore(), "store-report|day|2026-10-08", ["销售数量 3"], { recipients: ["u-owner"], post: { title: "📊 日报已生成", link: { text: "查看日报 ›", url: "https://p/report/day/2026-10-08" } } });
  assert.equal(state.item("NOTIFICATION", "store-report|day|2026-10-08")?.post !== undefined, true);
  const old = state.item("NOTIFICATION", "store-report|day|2026-10-08")!;
  state.items.set(`NOTIFICATION_PENDING\u0000store-report|day|2026-10-08`, { pk: "NOTIFICATION_PENDING", sk: "store-report|day|2026-10-08", createdAt: new Date(Date.now() - 20 * 60_000).toISOString() });
  old.createdAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const summary = await resendPendingNotifications(state.asStore(), feishu);
  assert.equal(summary.resent, 1);
  assert.deepEqual(messages[0], { to: "u-owner", title: "📊 日报已生成", lines: ["销售数量 3"], link: { text: "查看日报 ›", url: "https://p/report/day/2026-10-08" } });
  assert.equal(await flushNotification(state.asStore(), feishu, "store-report|day|2026-10-08", prepared), "done");
});

// ---------- 其它边界 ----------

test("报告链接、Data Kiosk 查询（店铺级按天 + 子 ASIN 按天带销售额，30 个 ASIN 一组）、健康检查阈值", () => {
  assert.equal(reportUrl("https://x.on.aws/", periodOf("week", "2026-10-07")), "https://x.on.aws/report/week/2026-W41");
  const page = "https://x.on.aws/report/day/2026-10-09";
  assert.equal(reportLink(config(), page), "https://applink.feishu.cn/client/web_url/open?mode=window&url=https%3A%2F%2Fx.on.aws%2Freport%2Fday%2F2026-10-09");
  assert.match(reportLink(config({ STORE_REPORT_LINK_MODE: "sidebar-semi" }), page), /\?mode=sidebar-semi&url=/);
  assert.match(reportLink(config({ STORE_REPORT_LINK_MODE: "tab" }), page), /\?mode=window&url=/, "写错的取值按默认的独立窗口");
  assert.equal(reportLink(config({ STORE_REPORT_LINK_MODE: "url" }), page), page, "url：退回直接用网址");
  const [store, asins] = kioskQueries("2026-09-19", "2026-10-08", Array.from({ length: 31 }, (_, index) => `B0000000${String(index).padStart(2, "0")}`));
  assert.match(store!, /salesAndTrafficByDate\(startDate: "2026-09-19", endDate: "2026-10-08", aggregateBy: DAY/);
  assert.match(asins!, /asinAggregation: CHILD, dateAggregation: DAY/);
  assert.match(asins!, /orderedProductSales/);
  assert.equal((asins!.match(/marketplaceId:/g) ?? []).length, 2);
  assert.equal(HEALTH_RULES["store-report"], 26 * 3_600_000);
});

test("报告源码边界：src/report 只读（不写状态表、不调飞书与亚马逊写接口）；任务只写 REPORT_* 分区；不出现任何飞书表写方法", async () => {
  const directory = path.join(root, "src", "report");
  for (const name of await readdir(directory)) {
    const source = await readFile(path.join(directory, name), "utf8");
    assert.doesNotMatch(source, /\.put\(|\.request\s*[<(]|\.sp\s*[<(]|saveNotification|sendText|sendPost/, name);
  }
  const job = await readFile(path.join(root, "src", "business", "store-report.ts"), "utf8");
  assert.doesNotMatch(job, /\.(upsert|update|batchCreate|batchUpdate|batchDelete|delete)\(/, "不写飞书表、不删状态");
  assert.deepEqual([...job.matchAll(/state\.put\(\{\s*pk:\s*(\w+)/g)].map((match) => match[1]).sort(), ["REPORT_DAY_PK", "REPORT_META_PK", "REPORT_MONTH_PK"]);
  assert.deepEqual([...new Set([...job.matchAll(/method:\s*"(\w+)"/g)].map((match) => match[1]))], ["POST"], "只有建报告与 Data Kiosk 查询用 POST");
  assert.deepEqual([...job.matchAll(/sp<JsonObject>\("([^"]+)", \{ method: "POST"/g)].map((match) => match[1]), ["/reports/2021-06-30/reports"]);
  assert.match(job, /sp<JsonObject>\(`\$\{KIOSK\}\/queries`, \{ method: "POST"/);
});

// ---------- 中台报告页 ----------

test("报告页：未登录先走飞书登录、登录后回到原链接；页面带 nonce 与这一期数据；/report 跳最新一期；写错的期 404；/api/report 给切换用的数据", async () => {
  const { createPortalHandler } = await import("../../src/handlers/portal.js");
  const { SESSION_COOKIE, STATE_COOKIE, TOKEN_URL, USER_INFO_URL } = await import("../../src/portal/auth.js");
  const NOW = Date.parse("2026-10-09T08:00:00Z");
  const state = new MemoryState([
    ...["2026-10-07", "2026-10-08"].map((date) => ({ pk: REPORT_DAY_PK, sk: date, status: "draft", payload: JSON.stringify(dayFacts(date)) })),
    { pk: "REPORT_META", sk: "state", payload: JSON.stringify({ earliest: "2026-10-07", latest: "2026-10-08", updatedAt: "" }) },
    { pk: "PORTAL_CACHE", sk: "catalog", payload: JSON.stringify({ items: [{ sku: "SKU-A", title: "Baby Kazoo </script>", image: "https://m.media-amazon.com/images/I/a.jpg", asin: "B0000000AA", buyable: true, price: 12.99 }] }) },
  ]);
  const portalConfig = { get: (key: string) => ({ PORTAL_FEISHU_APP_ID: "cli_x", PORTAL_FEISHU_APP_SECRET: "secret" } as Record<string, string>)[key] ?? "", optional: (key: string, fallback = "") => ({ PORTAL_FEISHU_APP_ID: "cli_x", PORTAL_FEISHU_APP_SECRET: "secret", PORTAL_ALLOWED_USER_IDS: "u-owner" } as Record<string, string>)[key] ?? fallback, bool: (_key: string, fallback = false) => fallback, json: <T>() => ({}) as T, asins: () => [], version: "t" } as unknown as AppConfig;
  const fetcher = async (input: string | URL): Promise<Response> => String(input) === TOKEN_URL ? new Response(JSON.stringify({ code: 0, access_token: "tok" })) : String(input) === USER_INFO_URL ? new Response(JSON.stringify({ code: 0, data: { user_id: "u-owner", open_id: "ou", name: "Owner" } })) : new Response("{}", { status: 404 });
  const handler = createPortalHandler({ config: async () => portalConfig, state: state.asStore(), amazon: () => ({}) as AmazonClient, feishu: () => ({}) as FeishuClient, fetcher, now: () => NOW, nonce: () => "n1" });
  const request = (rawPath: string, options: { cookies?: string[]; query?: Record<string, string> } = {}) => handler({ version: "2.0", rawPath, rawQueryString: "", headers: {}, ...(options.cookies ? { cookies: options.cookies } : {}), ...(options.query ? { queryStringParameters: options.query } : {}), isBase64Encoded: false, requestContext: { domainName: "portal.example.on.aws", http: { method: "GET", path: rawPath } } } as never);
  const start = await request("/report/day/2026-10-08");
  assert.equal(start.statusCode, 302);
  const location = new URL(String(start.headers?.location));
  const stateCookie = (start.cookies ?? []).find((item) => item.startsWith(`${STATE_COOKIE}=`))!.split(";")[0]!;
  const callback = await request("/auth/callback", { query: { code: "c", state: location.searchParams.get("state")! }, cookies: [stateCookie] });
  assert.equal(callback.headers?.location, "/report/day/2026-10-08", "登录后回到消息里的那一期");
  const session = (callback.cookies ?? []).find((item) => item.startsWith(`${SESSION_COOKIE}=`))!.split(";")[0]!;
  const page = await request("/report/day/2026-10-08", { cookies: [session] });
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers?.["content-security-policy"]), /script-src 'nonce-n1'/);
  assert.match(String(page.body), /id="report-data"/);
  assert.equal(String(page.body).match(/<\/script>/g)?.length, 2, "商品标题里的 </script> 已转义");
  assert.equal((await request("/report", { cookies: [session] })).headers?.location, "/report/day/2026-10-08");
  assert.equal((await request("/report/day/2026-02-30", { cookies: [session] })).statusCode, 404);
  const api = await request("/api/report", { cookies: [session], query: { type: "week", period: "2026-W41" } });
  const view = JSON.parse(String(api.body));
  assert.deepEqual([view.type, view.key, view.from, view.to], ["week", "2026-W41", "2026-10-05", "2026-10-11"]);
  assert.equal(view.kpis.find((cell: { key: string }) => cell.key === "sales").value, 200, "10/07、10/08 两天");
  assert.equal((await request("/api/report", { query: { type: "day", period: "2026-10-08" } })).statusCode, 401);
  assert.equal((await request("/api/report", { cookies: [session], query: { type: "quarter", period: "2026-Q4" } })).statusCode, 400);
});

test("报告页脚本可解析、不用 innerHTML、不设内联 style 属性（CSP 不允许）", async () => {
  const { reportClientMain } = await import("../../src/portal/report-client.js");
  const source = reportClientMain.toString();
  assert.doesNotThrow(() => new Function(`(${source})`));
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.doesNotMatch(source, /style:\s*"/, "内联 style 属性会被 CSP 拦截，宽度改用 element.style");
});

test("模板：店铺报告计划任务洛杉矶 00:15、随自动入口启停；Jobs 带中台网址", async () => {
  const template = await readFile(path.join(root, "infra", "template.yaml"), "utf8");
  const block = template.split(/^(?= {2}[A-Za-z][A-Za-z0-9]*:)/m).find((part) => part.startsWith("  StoreReportSchedule:")) ?? "";
  assert.match(block, /ScheduleExpression: cron\(15 0 \* \* \? \*\)\r?\n\s+ScheduleExpressionTimezone: America\/Los_Angeles/);
  assert.match(block, /State: !Ref AutomationState/);
  assert.match(block, /"taskType":"store-report"/);
  const jobs = template.split(/^(?= {2}[A-Za-z][A-Za-z0-9]*:)/m).find((part) => part.startsWith("  JobsFunction:")) ?? "";
  assert.match(jobs, /PORTAL_URL: !GetAtt PortalFunctionUrl\.FunctionUrl/);
  // 回填在预算内才开新的一段；最后一段最长 = Data Kiosk 等待 6 分钟 + 约 1 分钟取数与写入，必须在 Jobs 超时前结束，否则超时报错并发告警邮件。
  const timeoutSeconds = Number(/\n\s+Timeout: (\d+)/.exec(jobs)?.[1]);
  assert.ok(BACKFILL_BUDGET_MS + 7 * 60_000 <= timeoutSeconds * 1000, `回填预算 ${BACKFILL_BUDGET_MS / 60_000} 分钟 + 一段 7 分钟超过 Jobs 超时 ${timeoutSeconds} 秒`);
});
