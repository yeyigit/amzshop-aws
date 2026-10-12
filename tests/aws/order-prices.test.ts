import assert from "node:assert/strict";
import test from "node:test";
import { ORDER_PRICE_REPORT_POLLS, ORDER_PRICE_REPORT_TYPE, parseOrderPriceReport, runOrderPrices } from "../../src/business/order-prices.js";
import { HEALTH_RULES } from "../../src/business/maintenance.js";
import type { AppConfig, FeishuRecord, JsonObject } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient, FeishuCondition } from "../../src/clients/feishu.js";

type Row = Record<string, unknown>;
const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-06T14:30:00Z");
const HEADER = ["amazon-order-id", "merchant-order-id", "purchase-date", "last-updated-date", "order-status", "fulfillment-channel", "sales-channel", "order-channel", "ship-service-level", "product-name", "sku", "asin", "item-status", "quantity", "currency", "item-price", "item-tax", "shipping-price", "shipping-tax", "gift-wrap-price", "gift-wrap-tax", "item-promotion-discount", "ship-promotion-discount", "ship-city", "ship-state", "ship-postal-code", "ship-country", "promotion-ids", "cpf", "is-business-order", "purchase-order-number", "price-designation", "signature-confirmation-recommended", "order-item-id"];

// 合成报告行：只填用到的列，其余为空；product-name 可带英寸号等原样字符。
function line(values: Partial<Record<string, string>>): string {
  return HEADER.map((name) => values[name] ?? "").join("\t");
}
function report(lines: Array<Partial<Record<string, string>>>): string {
  return [HEADER.join("\t"), ...lines.map(line)].join("\r\n") + "\r\n";
}
const item = (orderId: string, sku: string, price: string, extra: Partial<Record<string, string>> = {}): Partial<Record<string, string>> =>
  ({ "amazon-order-id": orderId, "order-status": "Pending", "item-status": "Unshipped", sku, quantity: "1", currency: price === "" ? "" : "USD", "item-price": price, "product-name": "Baby Toy", ...extra });

test("全部订单报告解析：同 SKU 多行相加；换货单 0.0 是已知 0；空价格、已取消、币种不一致不写；商品名带英寸号不错位；列数不符整单不写；缺必需列报错", () => {
  const source = report([
    item("111-0000000-0000001", "SKU-A", "12.99", { "product-name": "Baby Doll 12\" Soft" }),
    item("111-0000000-0000001", "SKU-A", "12.99", { "order-item-id": "2" }),
    item("111-0000000-0000002", "SKU-B", "0.0", { "order-status": "Shipped", "item-status": "Shipped" }),
    item("111-0000000-0000003", "SKU-C", ""),
    item("111-0000000-0000004", "SKU-D", "", { "order-status": "Cancelled", "item-status": "Cancelled" }),
    item("111-0000000-0000005", "SKU-E", "14.49"),
    item("111-0000000-0000005", "SKU-E", "9.99", { currency: "CAD" }),
    item("111-0000000-0000006", "SKU-F", "21.69", { "item-status": "Cancelled" }),
    item("111-0000000-0000006", "SKU-G", "13.99"),
  ]) + `111-0000000-0000007\t\t\t\tPending\t\t\t\t\tBroken\tname\tSKU-H\tB0X\tUnshipped\t1\tUSD\t13.99\r\n` + line(item("111-0000000-0000007", "SKU-I", "9.99")) + "\r\n";
  const { rows, prices } = parseOrderPriceReport(`﻿${source}`);
  assert.equal(rows, 11);
  assert.deepEqual(prices.get("111-0000000-0000001|sku-a"), { amount: 25.98, currency: "USD", lines: 2 });
  assert.deepEqual(prices.get("111-0000000-0000002|sku-b"), { amount: 0, currency: "USD", lines: 1 }, "免费换货单 0.0 是亚马逊明确给的 0");
  assert.equal(prices.get("111-0000000-0000003|sku-c")?.reason, "no_price");
  assert.equal(prices.get("111-0000000-0000004|sku-d")?.reason, "cancelled");
  assert.equal(prices.get("111-0000000-0000005|sku-e")?.reason, "mixed_currency");
  assert.equal(prices.get("111-0000000-0000006|sku-f")?.reason, "cancelled", "行级已取消且无其它行");
  assert.deepEqual(prices.get("111-0000000-0000006|sku-g"), { amount: 13.99, currency: "USD", lines: 1 });
  assert.equal(prices.get("111-0000000-0000007|sku-i")?.reason, "malformed", "同一订单有列数不符的行时整单不写");
  assert.throws(() => parseOrderPriceReport("amazon-order-id\tsku\titem-price\r\n"), /缺少列：order-status,item-status,currency/);
  assert.equal(parseOrderPriceReport("").rows, 0);
});

interface Harness {
  amazon: AmazonClient; feishu: FeishuClient; config: AppConfig;
  calls: Array<{ path: string; method?: string; body?: unknown }>; searches: Array<{ fields: Record<string, string>; conditions?: FeishuCondition[]; fieldNames?: string[] }>; updates: Array<{ recordId: string; fields: Row }[]>;
}
function harness(options: { rows: FeishuRecord[]; statuses?: string[]; body?: string; enabled?: string; marketplaceIds?: string }): Harness {
  const calls: Harness["calls"] = [];
  const searches: Harness["searches"] = [];
  const updates: Harness["updates"] = [];
  const statuses = [...(options.statuses ?? ["IN_PROGRESS", "DONE"])];
  const amazon = {
    sp: async (path: string, init: { method?: string; body?: unknown } = {}) => {
      calls.push({ path, ...(init.method ? { method: init.method } : {}), ...(init.body ? { body: init.body } : {}) });
      if (path === "/reports/2021-06-30/reports") return { reportId: "r1" };
      if (path === "/reports/2021-06-30/reports/r1") { const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!; return { processingStatus: status, ...(status === "DONE" ? { reportDocumentId: "d1" } : {}) }; }
      if (path === "/reports/2021-06-30/documents/d1") return { url: "https://example.test/d1" };
      throw new Error(`unexpected ${path}`);
    },
    download: async () => Buffer.from(options.body ?? ""),
  } as unknown as AmazonClient;
  const feishu = {
    searchRecords: async (_app: string, _table: string, fields: Record<string, string>, opts: { fieldNames?: string[]; conditions?: FeishuCondition[] } = {}) => { searches.push({ fields, ...opts }); return options.rows; },
    batchUpdate: async (_app: string, _table: string, rows: Array<{ recordId: string; fields: Row }>) => { updates.push(rows); },
  } as unknown as FeishuClient;
  const config = {
    get: (key: string) => key,
    optional: (key: string, fallback = "") => key === "MARKETPLACE_IDS" ? options.marketplaceIds ?? fallback : fallback,
    bool: (key: string, fallback = false) => key === "ORDER_PRICES_ENABLED" && options.enabled !== undefined ? options.enabled === "true" : fallback,
  } as unknown as AppConfig;
  return { amazon, feishu, config, calls, searches, updates };
}
const row = (id: string, orderId: string, sku: string, purchasedAt: string, extra: Row = {}): FeishuRecord => ({ record_id: id, fields: { "订单编号": [{ type: "text", text: orderId }], SKU: [{ type: "text", text: sku }], "下单时间": [{ type: "text", text: purchasedAt }], "订单状态": [{ type: "text", text: "待处理" }], ...extra } });
const fast = { sleep: async () => {}, now: () => NOW };

test("补写：只写付款金额与为空的金额币种；换货单写 0；S01- 多渠道单与 30 天前的行不算候选；报告时间窗从最早候选前 1 小时起；查询带 isEmpty/isNot 条件", async () => {
  const rows = [
    row("rec-pending", "113-0000000-0000001", "demo-xylo-01", "2026-10-06 05:31:30"),
    row("rec-replace", "113-0000000-0000002", "demo-kazoo-01", "2026-09-28 09:36:50", { "订单状态": "已发货" }),
    row("rec-usd", "113-0000000-0000003", "Demo-Rail-01", "2026-10-05 18:43:59", { "金额币种": [{ type: "text", text: "USD" }] }),
    row("rec-nonprice", "113-0000000-0000004", "demo-kazoo-02", "2026-10-06 07:30:00"),
    row("rec-missing", "113-0000000-0000005", "demo-kazoo-02", "2026-10-06 07:40:00"),
    row("rec-mcf", "S01-0000000-0000006", "demo-kazoo-01", "2026-09-25 08:42:40", { "订单状态": "已发货" }),
    row("rec-old", "113-0000000-0000007", "demo-kazoo-01", "2026-08-01 10:00:00"),
    row("rec-cancelled", "113-0000000-0000008", "demo-kazoo-01", "2026-10-06 01:00:00"),
  ];
  const body = report([
    item("113-0000000-0000001", "demo-xylo-01", "14.49"),
    item("113-0000000-0000002", "demo-kazoo-01", "0.0", { "order-status": "Shipped", "item-status": "Shipped" }),
    item("113-0000000-0000003", "demo-rail-01", "27.98", { quantity: "2" }),
    item("113-0000000-0000004", "demo-kazoo-02", ""),
    item("S01-0000000-0000006", "demo-kazoo-01", ""),
    item("113-0000000-0000008", "demo-kazoo-01", "", { "order-status": "Cancelled", "item-status": "Cancelled" }),
  ]);
  const h = harness({ rows, body });
  const result = await runOrderPrices({ taskType: "order-prices" }, h.config, h.amazon, h.feishu, fast);
  assert.deepEqual(h.searches[0]?.conditions, [{ field_name: "付款金额", operator: "isEmpty", value: [] }, { field_name: "订单状态", operator: "isNot", value: ["已取消"] }]);
  assert.deepEqual(h.searches[0]?.fields, {});
  const created = h.calls.find((call) => call.method === "POST");
  // 最早候选：9/28 09:36:50 洛杉矶（夏令时 UTC-7）＝ 16:36:50Z，往前 1 小时。
  assert.deepEqual(created?.body, { reportType: ORDER_PRICE_REPORT_TYPE, marketplaceIds: ["ATVPDKIKX0DER"], dataStartTime: "2026-09-28T15:36:50.000Z" });
  assert.deepEqual(h.updates, [[
    { recordId: "rec-pending", fields: { "付款金额": 14.49, "金额币种": "USD" } },
    { recordId: "rec-replace", fields: { "付款金额": 0, "金额币种": "USD" } },
    { recordId: "rec-usd", fields: { "付款金额": 27.98 } },
  ]]);
  for (const update of h.updates.flat()) assert.deepEqual(Object.keys(update.fields).filter((name) => !["付款金额", "金额币种"].includes(name)), [], "只写付款金额与金额币种");
  assert.deepEqual(result, { status: "done", candidates: 6, reportRows: 6, filled: 3, zeroFilled: 1, noPrice: 1, notInReport: 1, skipped: 1, skippedReasons: { cancelled: 1 } });
});

test("预览只返回将写的行不写表；没有候选行不申请报告；开关关闭空跑；同键多行与币种冲突不写", async () => {
  const rows = [row("rec-1", "113-0000000-0000001", "SKU-A", "2026-10-06 05:31:30"), row("rec-2", "113-0000000-0000001", "SKU-A", "2026-10-06 05:31:30"), row("rec-3", "113-0000000-0000002", "SKU-B", "2026-10-06 06:00:00", { "金额币种": "CAD" }), row("rec-4", "113-0000000-0000003", "SKU-C", "2026-10-06 06:10:00")];
  const body = report([item("113-0000000-0000001", "SKU-A", "12.99"), item("113-0000000-0000002", "SKU-B", "13.99"), item("113-0000000-0000003", "SKU-C", "9.99")]);
  const preview = harness({ rows, body });
  const result = await runOrderPrices({ taskType: "order-prices", dryRun: true }, preview.config, preview.amazon, preview.feishu, fast);
  assert.deepEqual(preview.updates, [], "预览不写表");
  assert.deepEqual(result.preview, [{ orderId: "113-0000000-0000003", sku: "SKU-C", amount: 9.99, currency: "USD" }]);
  assert.equal(result.wouldFill, 1);
  assert.deepEqual(result.skippedReasons, { duplicate_rows: 2, currency_conflict: 1 });

  const empty = harness({ rows: [row("rec-mcf", "S01-0000000-0000006", "SKU-A", "2026-10-06 05:31:30")] });
  assert.deepEqual(await runOrderPrices({ taskType: "order-prices" }, empty.config, empty.amazon, empty.feishu, fast), { status: "done", candidates: 0 });
  assert.equal(empty.calls.length, 0, "没有候选行不申请报告");

  const disabled = harness({ rows, body, enabled: "false" });
  assert.deepEqual(await runOrderPrices({ taskType: "order-prices" }, disabled.config, disabled.amazon, disabled.feishu, fast), { status: "done", disabled: true });
  assert.equal(disabled.searches.length + disabled.calls.length, 0, "开关关闭不调接口");
});

test("报告 5 分钟内未完成本轮不写；CANCELLED 记成功不写；FATAL 报错；多站点逐站申请", async () => {
  const rows = [row("rec-1", "113-0000000-0000001", "SKU-A", "2026-10-06 05:31:30")];
  const slow = harness({ rows, statuses: ["IN_QUEUE"] });
  const waiting = await runOrderPrices({ taskType: "order-prices" }, slow.config, slow.amazon, slow.feishu, fast);
  assert.deepEqual(waiting, { status: "waiting_report", candidates: 1, reportId: "r1" });
  assert.equal(slow.calls.filter((call) => call.path.endsWith("/r1")).length, ORDER_PRICE_REPORT_POLLS);
  assert.deepEqual(slow.updates, []);

  const cancelled = harness({ rows, statuses: ["CANCELLED"] });
  const none = await runOrderPrices({ taskType: "order-prices" }, cancelled.config, cancelled.amazon, cancelled.feishu, fast) as JsonObject;
  assert.equal(none.status, "done");
  assert.equal(none.notInReport, 1);
  assert.deepEqual(cancelled.updates, []);

  const fatal = harness({ rows, statuses: ["FATAL"] });
  await assert.rejects(runOrderPrices({ taskType: "order-prices" }, fatal.config, fatal.amazon, fatal.feishu, fast), /全部订单报告失败或状态未知：FATAL/);

  const multi = harness({ rows, body: report([item("113-0000000-0000001", "SKU-A", "12.99")]), statuses: ["DONE"], marketplaceIds: "ATVPDKIKX0DER, A2EUQ1WTGCTBG2" });
  await runOrderPrices({ taskType: "order-prices" }, multi.config, multi.amazon, multi.feishu, fast);
  assert.deepEqual(multi.calls.filter((call) => call.method === "POST").map((call) => (call.body as Row).marketplaceIds), [["ATVPDKIKX0DER"], ["A2EUQ1WTGCTBG2"]]);
});

test("订单商品小计补写 3 小时没有成功即告警", () => {
  assert.equal(HEALTH_RULES["order-prices"], 3 * HOUR);
});
