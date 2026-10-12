import assert from "node:assert/strict";
import test from "node:test";
import {
  agingForecast, cashBasis, inventoryAlerts, inventoryHealthRows, inventoryHealthSettings, inventoryTotals, previewDue, previewLines, runInventoryHealth, weekKey,
} from "../../src/business/inventory-health.js";
import { parseTsv } from "../../src/business/reports.js";
import type { SkuCost } from "../../src/report/facts.js";
import type { AppConfig, JobEvent } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const configOf = (values: Record<string, string> = {}): AppConfig => {
  const all: Record<string, string> = { FEISHU_NOTIFY_USER_IDS: "u1", FEISHU_BITABLE_APP_TOKEN_ORDERS: "app", FEISHU_BITABLE_TABLE_ID_PROFIT_ESTIMATE: "tbl-profit", FEISHU_BITABLE_TABLE_ID_SKUS: "tbl-skus", ...values };
  return {
    get: (key: string) => { if (!(key in all)) throw new Error(`缺少配置 ${key}`); return all[key]!; },
    optional: (key: string, fallback = "") => all[key] ?? fallback,
    bool: (key: string, fallback = true) => key in all ? all[key] === "true" : fallback,
    asins: () => [],
  } as unknown as AppConfig;
};

// 亚马逊库存健康报告的列（只取用到的列，其余列名照抄）；各行均为虚构的示例数据。
const COLUMNS = ["snapshot-date", "sku", "asin", "condition", "available", "inv-age-0-to-90-days", "inv-age-91-to-180-days", "inv-age-181-to-270-days", "inv-age-271-to-365-days", "inv-age-366-to-455-days", "inv-age-456-plus-days",
  "units-shipped-t30", "units-shipped-t90", "your-price", "recommended-action", "days-of-supply", "estimated-excess-quantity", "featuredoffer-price", "estimated-storage-cost-next-month", "inbound-quantity",
  "estimated-ais-181-210-days", "estimated-ais-211-240-days", "estimated-ais-241-270-days", "estimated-ais-271-300-days", "estimated-ais-301-330-days", "estimated-ais-331-365-days", "estimated-ais-366-455-days", "estimated-ais-456-plus-days",
  "quantity-to-be-charged-ais-241-270-days", "fba-inventory-level-health-status", "Low-Inventory-Level fee applied in current week?", "is-seasonal-in-next-3-months", "season-name"];
type Spec = Partial<Record<(typeof COLUMNS)[number], string>>;
const tsv = (rows: Spec[]): string => [COLUMNS.join("\t"), ...rows.map((row) => COLUMNS.map((column) => row[column] ?? "").join("\t"))].join("\n");
const ais = (values: string[]): Spec => Object.fromEntries(["181-210", "211-240", "241-270", "271-300", "301-330", "331-365", "366-455", "456-plus"].map((bucket, index) => [`estimated-ais-${bucket}-days`, values[index] ?? ""]));
const RAIL: Spec = { "snapshot-date": "2026-10-10", sku: "demo-rail-01", asin: "B0RAIL0001", condition: "New", available: "180", "inv-age-91-to-180-days": "4", "inv-age-181-to-270-days": "190", "units-shipped-t30": "30", "units-shipped-t90": "60", "your-price": "15.99", "featuredoffer-price": "15.99", "days-of-supply": "300", "estimated-excess-quantity": "120", "estimated-storage-cost-next-month": "230.40", "fba-inventory-level-health-status": "Excess", "Low-Inventory-Level fee applied in current week?": "No", "is-seasonal-in-next-3-months": "Y", "season-name": "Holiday Season", "quantity-to-be-charged-ais-241-270-days": "188", ...ais(["0.0", "0.80", "89.60", "0.0", "0.0", "0.0", "0.0", "0.0"]) };
const SPIN: Spec = { "snapshot-date": "2026-10-10", sku: "demo-spin-01", asin: "B0SPIN0001", condition: "New", available: "120", "inv-age-0-to-90-days": "8", "inv-age-91-to-180-days": "50", "inv-age-181-to-270-days": "20", "inv-age-271-to-365-days": "60", "units-shipped-t30": "35", "units-shipped-t90": "110", "your-price": "12.49", "featuredoffer-price": "10.99", "days-of-supply": "70", "estimated-storage-cost-next-month": "31.20", "fba-inventory-level-health-status": "Healthy", "Low-Inventory-Level fee applied in current week?": "No", ...ais(["1.20", "0.30", "0.90", "15.85", "0.0", "0.0", "0.0", "0.0"]) };
const SAND: Spec = { "snapshot-date": "2026-10-10", sku: "demo-sand-01", asin: "B0SAND0001", condition: "New", available: "200", "inv-age-0-to-90-days": "90", "inv-age-91-to-180-days": "6", "inv-age-181-to-270-days": "104", "units-shipped-t30": "50", "units-shipped-t90": "220", "your-price": "13.49", "featuredoffer-price": "13.49", "days-of-supply": "95", "estimated-storage-cost-next-month": "48.30", "inbound-quantity": "30", "fba-inventory-level-health-status": "Healthy" };
const KAZOO: Spec = { "snapshot-date": "2026-10-10", sku: "demo-kazoo-01", asin: "B0KAZOO001", condition: "New", available: "800", "inv-age-0-to-90-days": "900", "units-shipped-t30": "150", "units-shipped-t90": "450", "your-price": "11.99", "featuredoffer-price": "11.99", "days-of-supply": "200", "estimated-storage-cost-next-month": "62.40", "inbound-quantity": "1000", "fba-inventory-level-health-status": "Healthy" };
const cost = (sku: string, price: number, fba: number, commission: number): SkuCost => ({ sku, price, fba, commission, fixedCost: null, margin: null, marginRate: null, storage19: 0, storage1012: 0 });
const COSTS = new Map([["demo-rail-01", cost("demo-rail-01", 15.99, 8.1, 3.6)], ["demo-spin-01", cost("demo-spin-01", 12.49, 4.6, 1.9)]]);

test("库存健康报告解析：超 180 天合计、91–180 天、超龄附加费（全空为“未给估算”）、持有成本含在途、卖完月数；非全新与空行跳过", () => {
  const rows = inventoryHealthRows(parseTsv(tsv([RAIL, SPIN, SAND, KAZOO, { ...KAZOO, sku: "used-1", condition: "Used" }, { sku: "empty-1", condition: "New", available: "0" }])), COSTS);
  assert.deepEqual(rows.map((row) => row.sku), ["demo-rail-01", "demo-kazoo-01", "demo-sand-01", "demo-spin-01"], "按下月仓储从高到低");
  const [rail, kazoo, sand, spin] = rows;
  assert.deepEqual([rail!.aged181, rail!.aged91to180, rail!.newAged90, rail!.willAge90, rail!.aisNextMonth, rail!.aisUnits, rail!.holdingPerUnit, rail!.monthsToClear], [190, 4, 134, 4, 90.4, 188, 1.28, 6]);
  assert.deepEqual([rail!.status, rail!.excess, rail!.seasonal, rail!.lowInventoryFee], ["Excess", 120, "Holiday Season", false]);
  assert.deepEqual([spin!.aged181, spin!.newAged90, spin!.willAge90, spin!.aisNextMonth, spin!.price], [80, 20, 20, 18.25, 10.99], "现价取推荐报价价格");
  assert.equal(sand!.aisNextMonth, null, "超龄附加费各列全空：未给估算，不当 0");
  assert.equal(sand!.holdingPerUnit, 0.21, "48.30 ÷（200 + 30）");
  assert.equal(kazoo!.holdingPerUnit, 0.03, "62.40 ÷（800 + 1000）");
  assert.deepEqual(inventoryTotals(rows), { storageNextMonth: 372.3, aisNextMonth: 108.65, excessSkus: 1, aged181: 374 });
});

test("每件回款：现价×(1−佣金率)−FBA 配送费；佣金率取预估佣金÷售价，不在 5%–20% 时按 15%；缺配送费或现价不算", () => {
  assert.deepEqual(cashBasis(15.99, COSTS.get("demo-rail-01")), { commissionRate: 0.15, fbaFee: 8.1, cashPerUnit: 5.49, cashAcos: 0.3433 }, "预估佣金 3.60 ÷ 售价超过 20%（售价改了而佣金没改），按 15%");
  assert.deepEqual(cashBasis(10.99, COSTS.get("demo-spin-01")), { commissionRate: 0.1521, fbaFee: 4.6, cashPerUnit: 4.72, cashAcos: 0.4295 });
  assert.deepEqual(cashBasis(12.99, undefined), { commissionRate: 0.15, fbaFee: null, cashPerUnit: null, cashAcos: null });
  assert.equal(cashBasis(null, COSTS.get("demo-spin-01")).cashPerUnit, null);
});

test("先进先出估算：近 90 天发货先消化超 180 天的，剩下再消化 91–180 天的", () => {
  assert.deepEqual(agingForecast(0, 150, 100), { newAged90: 50, willAge90: 50 }, "150 件 91–180 天，近 90 天卖 100");
  assert.deepEqual(agingForecast(0, 140, 40), { newAged90: 100, willAge90: 100 }, "140 件 91–180 天，近 90 天卖 40");
  assert.deepEqual(agingForecast(150, 6, 40), { newAged90: 116, willAge90: 6 }, "老货还剩 110，91–180 天的 6 件全部超龄");
  assert.deepEqual(agingForecast(10, 20, 100), { newAged90: 0, willAge90: 0 });
});

test("提醒：首轮对现有冗余与超龄附加费 ≥ $10 都提醒；同月不重复；冗余恢复提醒；次月超龄附加费再提醒；低库存费每周一次", () => {
  const settings = inventoryHealthSettings(configOf());
  const rows = inventoryHealthRows(parseTsv(tsv([RAIL, SPIN, SAND, KAZOO])), COSTS);
  const first = inventoryAlerts(undefined, rows, settings, "2026-10-11");
  assert.deepEqual(first.lines, [
    "🔴 demo-rail-01 被亚马逊标为冗余：可售 180 件，按近 30 天 30 件约 6 个月卖完；下月仓储约 $230（含超龄 $90.40），每件每月 $1.28；现价每件回款约 $5.49（不计采购与头程），广告 ACOS 低于 34% 就比放着强",
    "⚠️ demo-rail-01 下月超龄附加费约 $90.40（190 件超 180 天）",
    "⚠️ demo-spin-01 下月超龄附加费约 $18.25（80 件超 180 天）",
  ]);
  assert.deepEqual(inventoryAlerts(first.next, rows, settings, "2026-10-12").lines, [], "同月同状态不重复");
  const recovered = inventoryHealthRows(parseTsv(tsv([{ ...RAIL, "fba-inventory-level-health-status": "Healthy" }, SPIN])), COSTS);
  assert.deepEqual(inventoryAlerts(first.next, recovered, settings, "2026-10-13").lines, ["✅ demo-rail-01 不再是冗余（亚马逊状态 Healthy）"]);
  assert.deepEqual(inventoryAlerts(first.next, rows, settings, "2026-11-02").lines, ["⚠️ demo-rail-01 下月超龄附加费约 $90.40（190 件超 180 天）", "⚠️ demo-spin-01 下月超龄附加费约 $18.25（80 件超 180 天）"], "次月再提醒");
  const lilf = inventoryHealthRows(parseTsv(tsv([{ ...KAZOO, "Low-Inventory-Level fee applied in current week?": "Yes" }])), COSTS);
  const week1 = inventoryAlerts(undefined, lilf, settings, "2026-10-12");
  assert.deepEqual(week1.lines, ["⚠️ demo-kazoo-01 本周被收低库存费（库存相对销量偏低）"]);
  assert.deepEqual(inventoryAlerts(week1.next, lilf, settings, "2026-10-18").lines, [], "同一周（周一起）不重复");
  assert.equal(inventoryAlerts(week1.next, lilf, settings, "2026-10-19").lines.length, 1, "下一周再提醒");
  assert.deepEqual([weekKey("2026-10-12"), weekKey("2026-10-18"), weekKey("2026-10-19")], ["2026-10-12", "2026-10-12", "2026-10-19"]);
  assert.equal(inventoryAlerts(undefined, rows, inventoryHealthSettings(configOf({ INVENTORY_HEALTH_AIS_MIN: "50" })), "2026-10-11").lines.length, 2, "提醒线来自配置：spin-01 $18 不到 $50");
});

test("每月预告：北京日期 5–14 日之间、本月没发过才发；列出超龄附加费与 3 个月内新进入超龄的件数", () => {
  const settings = inventoryHealthSettings(configOf());
  assert.equal(previewDue(undefined, settings, "2026-10-04"), false);
  assert.equal(previewDue(undefined, settings, "2026-10-05"), true);
  assert.equal(previewDue(undefined, settings, "2026-10-14"), true, "5 日那轮失败，之后补发");
  assert.equal(previewDue(undefined, settings, "2026-10-15"), false, "15 日已计费");
  assert.equal(previewDue({ skus: {}, previewMonth: "2026-10" }, settings, "2026-10-06"), false);
  const rows = inventoryHealthRows(parseTsv(tsv([RAIL, SPIN, SAND, KAZOO])), COSTS);
  assert.deepEqual(previewLines(rows, inventoryTotals(rows), "2026-10-10"), [
    "📦 本月 15 日超龄附加费预告",
    "下月仓储估算合计 $372，其中超龄附加费 $109",
    "· demo-rail-01：超 180 天 190 件，约 $90.40",
    "· demo-spin-01：超 180 天 80 件，约 $18.25",
    "3 个月内会新进入超龄（估）：demo-spin-01 20 件、demo-rail-01 4 件",
    "亚马逊按 15 日的库龄计费；是否降价、加推广或移除由你决定。",
    "数据：亚马逊库存健康报告 2026-10-10",
  ]);
});

function fakes(body: string, statuses: string[] = ["DONE"]) {
  const calls: Array<{ path: string; method?: string }> = [];
  let polls = 0;
  const amazon = {
    sp: async (path: string, init: { method?: string; body?: Row } = {}) => {
      calls.push({ path, ...(init.method ? { method: init.method } : {}) });
      if (path === "/reports/2021-06-30/reports" && init.method === "POST") { assert.equal(init.body?.reportType, "GET_FBA_INVENTORY_PLANNING_DATA"); return { reportId: "R1" }; }
      if (path === "/reports/2021-06-30/reports/R1") { const status = statuses[Math.min(polls, statuses.length - 1)]!; polls += 1; return status === "DONE" ? { processingStatus: "DONE", reportDocumentId: "D1" } : { processingStatus: status }; }
      if (path === "/reports/2021-06-30/documents/D1") return { url: "https://example.invalid/doc" };
      throw new Error(`unexpected ${path}`);
    },
    download: async () => new TextEncoder().encode(body),
  } as unknown as AmazonClient;
  const sent: string[][] = [];
  const feishu = { listRecords: async () => [], sendText: async (_user: string, lines: string[]) => { sent.push(lines); } } as unknown as FeishuClient;
  return { amazon, feishu, calls, sent };
}

test("库存健康任务：首轮发一条“压货与仓储费”，写 latest、alerts、当天汇总并记完成；同日重跑同一任务直接完成；预告与每日提醒同轮合并成一条，只有预告时单独发", async () => {
  const state = new MemoryState();
  const { amazon, feishu, sent } = fakes(tsv([RAIL, SPIN, KAZOO]));
  // 北京 10/16：不在每月预告的 5–14 日之间，只发每日提醒。
  const event: JobEvent = { taskType: "inventory-health", taskId: "inventory-health|2026-10-16T01:15:00Z", scheduledAt: "2026-10-16T01:15:00Z" };
  const now = Date.parse("2026-10-16T01:15:30Z");
  const result = await runInventoryHealth(event, configOf(), state.asStore(), amazon, feishu, { now: () => now, sleep: async () => undefined });
  assert.equal(result.status, "done");
  assert.equal(result.excessSkus, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]![0], "📦 压货与仓储费");
  assert.match(sent[0]![1]!, /^🔴 demo-rail-01 被亚马逊标为冗余：可售 180 件/);
  assert.match(sent[0]![1]!, /下月仓储约 \$230（含超龄 \$90\.40），每件每月 \$1\.28$/, "飞书里没有成本时不写回款");
  assert.equal(sent[0]!.at(-1), "数据：亚马逊库存健康报告 2026-10-10");
  assert.equal((state.item("INVENTORY_HEALTH", "latest")?.totals as Row).excessSkus, 1);
  assert.ok(state.item("INVENTORY_HEALTH", "day|2026-10-16")?.expiresAt, "当天汇总带 TTL");
  assert.equal(((state.item("INVENTORY_HEALTH", "alerts")?.skus as Row)["demo-rail-01"] as Row).status, "Excess");
  assert.equal(state.item("TASK#inventory-health", event.taskId!)?.status, "done");
  assert.equal((await runInventoryHealth(event, configOf(), state.asStore(), amazon, feishu, { now: () => now })).alreadyDone, true);
  // 预告日（北京 11/05）且同一轮也有每日提醒：合并成一条，预告作为第二段，数据来源只写一次。
  const november = new MemoryState();
  const second = fakes(tsv([RAIL, SPIN]));
  const merged = await runInventoryHealth({ taskType: "inventory-health", taskId: "inventory-health|p" }, configOf(), november.asStore(), second.amazon, second.feishu, { now: () => Date.parse("2026-11-05T01:15:00Z"), sleep: async () => undefined });
  assert.equal(second.sent.length, 1, "一轮最多一条消息");
  assert.equal(second.sent[0]![0], "📦 压货与仓储费");
  assert.ok(second.sent[0]!.includes("📦 本月 15 日超龄附加费预告"));
  assert.equal(second.sent[0]!.filter((line) => line.startsWith("数据：")).length, 1);
  assert.deepEqual([merged.notified, merged.preview], [true, true]);
  assert.equal(november.item("INVENTORY_HEALTH", "alerts")?.previewMonth, "2026-11");
  // 预告日但每日没有新变化（冗余照旧、没有超龄附加费）：单独发一条预告；本月不再发。
  const quietState = new MemoryState();
  const quiet = fakes(tsv([{ ...RAIL, ...ais(["0.0", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0"]) }]));
  await runInventoryHealth({ taskType: "inventory-health", taskId: "inventory-health|q1" }, configOf(), quietState.asStore(), quiet.amazon, quiet.feishu, { now: () => Date.parse("2026-10-20T01:15:00Z"), sleep: async () => undefined });
  await runInventoryHealth({ taskType: "inventory-health", taskId: "inventory-health|q2" }, configOf(), quietState.asStore(), quiet.amazon, quiet.feishu, { now: () => Date.parse("2026-11-05T01:15:00Z"), sleep: async () => undefined });
  await runInventoryHealth({ taskType: "inventory-health", taskId: "inventory-health|q3" }, configOf(), quietState.asStore(), quiet.amazon, quiet.feishu, { now: () => Date.parse("2026-11-06T01:15:00Z"), sleep: async () => undefined });
  assert.deepEqual(quiet.sent.map((lines) => lines[0]), ["📦 压货与仓储费", "📦 本月 15 日超龄附加费预告"]);
  assert.ok(quiet.sent[1]!.includes("· 本月没有预计收超龄附加费的商品"));
  assert.ok(quietState.item("NOTIFICATION", "inventory-health-month|2026-11"));
});

test("库存健康任务：报告 8 分钟内没出就存断点、5 分钟后按原身份续跑；FATAL 让任务失败；开关关闭空跑", async () => {
  const state = new MemoryState();
  let clock = Date.parse("2026-10-11T01:15:00Z");
  const scheduled: Array<{ event: JobEvent; at: Date }> = [];
  const { amazon, feishu } = fakes(tsv([RAIL]), Array.from({ length: 100 }, () => "IN_PROGRESS"));
  const event: JobEvent = { taskType: "inventory-health", taskId: "inventory-health|w", scheduledAt: "2026-10-11T01:15:00Z" };
  const waiting = await runInventoryHealth(event, configOf(), state.asStore(), amazon, feishu, { clock: () => clock, sleep: async (ms) => { clock += ms; }, schedule: async (next, at) => { scheduled.push({ event: next, at }); return "s"; } });
  assert.equal(waiting.status, "waiting_report");
  assert.deepEqual(scheduled.map((item) => [item.event.taskType, item.event.taskId]), [["inventory-health", "inventory-health|w"]]);
  assert.equal(state.item("TASK#inventory-health", "inventory-health|w")?.status, "waiting_report");
  const fatal = fakes("", ["FATAL"]);
  await assert.rejects(runInventoryHealth({ taskType: "inventory-health", taskId: "inventory-health|f" }, configOf(), new MemoryState().asStore(), fatal.amazon, fatal.feishu, { sleep: async () => undefined }), /库存健康报告 fatal/);
  const off = fakes("");
  assert.deepEqual(await runInventoryHealth({ taskType: "inventory-health" }, configOf({ INVENTORY_HEALTH_ENABLED: "false" }), new MemoryState().asStore(), off.amazon, off.feishu), { status: "done", disabled: true });
  assert.equal(off.calls.length, 0);
});
