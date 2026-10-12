import assert from "node:assert/strict";
import test from "node:test";
import {
  accountIssues, accountLines, describeIssue, diffListings, issueFingerprint, listingFacts, metricLabel, parseAccountHealth, runStoreHealth, storeHealthSettings,
  type IssueFact,
} from "../../src/business/store-health.js";
import { auditEncode } from "../../src/util.js";
import { runJob } from "../../src/business/jobs.js";
import { HEALTH_RULES } from "../../src/business/maintenance.js";
import type { AppConfig, FeishuRecord } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const US = "ATVPDKIKX0DER";
const HOUR = 3_600_000;
const configOf = (values: Record<string, string> = {}): AppConfig => {
  const all: Record<string, string> = { SP_API_SELLER_ID: "SELLER1", OFFER_WATCH_MARKETPLACES: US, FEISHU_NOTIFY_USER_IDS: "u1", FEISHU_BITABLE_APP_TOKEN_ORDERS: "app", FEISHU_BITABLE_TABLE_ID_FINANCE_LEDGER: "tbl-ledger", ...values };
  return {
    get: (key: string) => { if (!(key in all)) throw new Error(`缺少配置 ${key}`); return all[key]!; },
    optional: (key: string, fallback = "") => all[key] ?? fallback,
    bool: (key: string, fallback = true) => key in all ? all[key] === "true" : fallback,
    asins: () => [{ sku: "demo-xylo-01", asin: "B0XYLO0001", competitors: [], adMarker: "" }, { sku: "demo-kazoo-01", asin: "B0KAZOO001", competitors: [], adMarker: "" }],
  } as unknown as AppConfig;
};

// 10/11 实测报告的结构（数值改成参数）。
function accountReport(options: { status?: string; ahrStatus?: string; ahrScore?: number; safety?: number; documents?: number; negativeFeedback?: number; lsrStatus?: string } = {}): Row {
  const policy = (count: number) => ({ status: count ? "BAD" : "GOOD", targetValue: 0, targetCondition: "EQUALS", defectsCount: count });
  const defect = (count: number) => ({ status: count ? "BAD" : "NONE", count });
  return {
    accountStatuses: [{ marketplaceId: US, status: options.status ?? "NORMAL" }],
    performanceMetrics: [{
      marketplaceId: US,
      accountHealthRating: { ahrStatus: options.ahrStatus ?? "GREAT", ahrScore: options.ahrScore ?? 280, reportingDateRange: { reportingDateFrom: "2026-04-14T00:00:00Z", reportingDateTo: "2026-10-11T23:59:59Z" } },
      orderDefectRate: {
        afn: { status: "GOOD", orderWithDefects: defect(options.negativeFeedback ?? 0), claims: defect(0), chargebacks: defect(0), negativeFeedback: defect(options.negativeFeedback ?? 0), orderCount: 1490, rate: 0, fulfillmentType: "AFN" },
        mfn: { status: "GOOD", orderWithDefects: defect(0), claims: defect(0), chargebacks: defect(0), negativeFeedback: defect(0), orderCount: 0, rate: 0, fulfillmentType: "MFN" },
      },
      lateShipmentRate: { status: options.lsrStatus ?? "GOOD", rate: 0 }, preFulfillmentCancellationRate: { status: "GOOD" }, validTrackingRate: { status: "GOOD" }, onTimeDeliveryRate: { status: "GOOD" },
      listingPolicyViolations: policy(0), productSafetyCustomerComplaints: policy(options.safety ?? 0), documentRequests: policy(options.documents ?? 0), receivedIntellectualPropertyComplaints: policy(0),
      policyViolationWarnings: { warningsCount: 0 },
      warningStates: [],
    }],
  };
}

const settings = storeHealthSettings(configOf());

test("账户健康：解析 10/11 实测结构；首份全 0 不提醒，首份已有问题照样提醒；之后报计数上升、评分降级与下降 ≥20 分、账户状态与指标状态变差，计数下降不提醒", () => {
  const clean = parseAccountHealth(accountReport());
  assert.equal(clean.status, "NORMAL");
  assert.equal(clean.ahrScore, 280);
  assert.equal(clean.counts.productSafetyCustomerComplaints, 0);
  assert.equal(clean.counts["afn.negativeFeedback"], 0);
  assert.equal(clean.odrOrders, 1490);
  assert.deepEqual(accountLines(undefined, clean, settings), [], "首份全 0：只建基线");
  assert.deepEqual(accountIssues(clean), []);
  const dirty = parseAccountHealth(accountReport({ safety: 1 }));
  assert.deepEqual(accountLines(undefined, dirty, settings), ["⚠️ 产品安全买家投诉：1", "⚠️ 产品安全买家投诉：状态 BAD"], "首份已有问题照样提醒");
  assert.deepEqual(accountLines(clean, dirty, settings), ["⚠️ 产品安全买家投诉：0 → 1", "⚠️ 产品安全买家投诉：状态 GOOD → BAD"]);
  assert.deepEqual(accountLines(dirty, clean, settings), [], "计数因滚动窗口下降：不提醒");
  assert.deepEqual(accountLines(clean, parseAccountHealth(accountReport({ ahrStatus: "AT_RISK", ahrScore: 180 })), settings), ["⚠️ 账户健康评分：280 → 180（GREAT → AT_RISK）"]);
  assert.deepEqual(accountLines(clean, parseAccountHealth(accountReport({ ahrScore: 255 })), settings), ["⚠️ 账户健康评分：280 → 255（GREAT）"], "同一等级下降 ≥20 分");
  assert.deepEqual(accountLines(clean, parseAccountHealth(accountReport({ ahrScore: 265 })), settings), [], "下降不到 20 分不提醒");
  assert.deepEqual(accountLines(clean, parseAccountHealth(accountReport({ status: "AT_RISK" })), settings), ["⚠️ 账户状态：正常（NORMAL） → 有风险（AT_RISK）"]);
  assert.deepEqual(accountLines(parseAccountHealth(accountReport({ status: "AT_RISK" })), clean, settings), ["✅ 账户状态：有风险（AT_RISK） → 正常（NORMAL）"]);
  assert.deepEqual(accountLines(clean, parseAccountHealth(accountReport({ negativeFeedback: 2, documents: 1 })), settings), ["⚠️ 文件索取：0 → 1", "⚠️ 订单缺陷（亚马逊配送）：0 → 2", "⚠️ 差评（亚马逊配送）：0 → 2", "⚠️ 文件索取：状态 GOOD → BAD"], "订单缺陷分项与文件索取：先计数后状态");
  assert.deepEqual(accountLines(clean, parseAccountHealth(accountReport({ lsrStatus: "POOR" })), settings), ["⚠️ 迟发率：状态 GOOD → POOR"]);
  assert.equal(metricLabel("mfn.claims"), "A-to-z 索赔（卖家配送）");
  assert.throws(() => parseAccountHealth({}), /accountStatuses/);
  assert.throws(() => storeHealthSettings(configOf({ STORE_HEALTH_ACCOUNT_HOURS: "0" })), /STORE_HEALTH_ACCOUNT_HOURS/);
});

const issue = (code: string, severity: string, actions: string[], message: string, attributes: string[] = []): Row => ({ code, severity, message, attributeNames: attributes, categories: ["LISTING"], enforcements: { actions: actions.map((action) => ({ action })), exemption: { status: "NOT_EXEMPT" } } });
const listing = (sku: string, asin: string, statuses: string[], issues: Row[] = []): Row => ({ sku, summaries: [{ marketplaceId: US, asin, status: statuses }], issues });

test("Listing 问题指纹：去掉数字与网址（只改截止日期不算新问题），保留文件类型（新的文件索取算新问题）；提醒描述去网址并标截止日期", () => {
  const doc = (type: string, by: string): IssueFact => ({ code: "100390", severity: "ERROR", actions: ["CATALOG_ITEM_REMOVED"], attributes: [], message: `In order to sell this product on the Amazon store, you must provide documents related to ${type}. Failure to provide these documentations by ${by}T03:00:00Z will result in removal. See https://sellercentral.amazon.com/help/hub/reference/external/G55N3JF2WQS` });
  assert.equal(issueFingerprint(doc("ps_toys_dv_ca", "2026-02-26")), issueFingerprint(doc("ps_toys_dv_ca", "2026-03-15")));
  assert.notEqual(issueFingerprint(doc("ps_toys_dv_ca", "2026-02-26")), issueFingerprint(doc("cpc_toys_us", "2026-02-26")));
  const text = describeIssue(doc("ps_toys_dv_us", "2026-11-20"));
  assert.match(text, /^100390（商品被移除） In order to sell/);
  assert.match(text, /｜截止 2026-11-20$/);
  assert.doesNotMatch(text, /sellercentral|https?:/);
  const attribute = (name: string): IssueFact => ({ code: "100720", severity: "ERROR", actions: ["ATTRIBUTE_SUPPRESSED"], attributes: [name], message: `Invalid language data provided for in marketplace www.amazon.com (ATVPDKIKX0DER) for attributes ${name}` });
  assert.notEqual(issueFingerprint(attribute("material")), issueFingerprint(attribute("item_shape")), "每个属性一条，各自独立");
});

test("Listing：首轮只建基线；原在售变不可售、提醒过的恢复在售、在售款新增 ERROR 才提醒；WARNING、不在售款、问题消失不提醒", () => {
  const at1 = "2026-10-11T08:25:00.000Z", at2 = "2026-10-11T09:25:00.000Z", at3 = "2026-10-11T10:25:00.000Z";
  const known = issue("100720", "ERROR", ["ATTRIBUTE_SUPPRESSED"], "Invalid language data provided for in marketplace www.amazon.com (ATVPDKIKX0DER) for attributes Material", ["material"]);
  const base = listingFacts([
    listing("demo-kazoo-01", "B0KAZOO001", ["BUYABLE", "DISCOVERABLE"], [known]),
    listing("demo-xylo-01", "B0XYLO0001", ["BUYABLE", "DISCOVERABLE"]),
    listing("demo-yoyo-01", "B0YOYO0001", ["DISCOVERABLE"], [issue("100390", "ERROR", ["CATALOG_ITEM_REMOVED"], "documents related to x")]),
  ], US);
  const first = diffListings("美国站", undefined, base, at1);
  assert.equal(first.baseline, true);
  assert.deepEqual(first.lines, []);
  const suppressed = issue("18155", "ERROR", ["LISTING_SUPPRESSED"], "Your selling price is below your minimum price threshold. See https://sellercentral.amazon.com/help/x");
  const second = diffListings("美国站", first.skus, listingFacts([
    listing("demo-kazoo-01", "B0KAZOO001", ["DISCOVERABLE"], [known, suppressed]),
    listing("demo-xylo-01", "B0XYLO0001", ["BUYABLE", "DISCOVERABLE"], [issue("18448", "WARNING", [], "missing attribute")]),
    listing("demo-yoyo-01", "B0YOYO0001", ["DISCOVERABLE"], [issue("100390", "ERROR", ["CATALOG_ITEM_REMOVED"], "documents related to x"), issue("99022", "ERROR", [], "invalid value")]),
  ], US), at2);
  assert.deepEqual(second.lines, [
    "⚠️ 美国站 demo-kazoo-01：不可售了（原在售）",
    "⚠️ 美国站 demo-kazoo-01：新问题 18155（压制） Your selling price is below your minimum price threshold. See",
  ], "WARNING 与不在售款（yoyo）的新问题都不提醒");
  assert.equal(second.skus["demo-kazoo-01"]?.lostAt, at2);
  assert.equal(Object.keys(second.skus["demo-kazoo-01"]?.newIssues ?? {}).length, 1);
  const third = diffListings("美国站", second.skus, listingFacts([
    listing("demo-kazoo-01", "B0KAZOO001", ["BUYABLE", "DISCOVERABLE"], [known]),
    listing("demo-yoyo-01", "B0YOYO0001", ["DISCOVERABLE"]),
  ], US), at3);
  assert.deepEqual(third.lines, ["✅ 美国站 demo-kazoo-01：恢复在售", "⚠️ 美国站 demo-xylo-01：不可售了（原在售），listing 已查不到"]);
  assert.equal(third.skus["demo-kazoo-01"]?.lostAt, undefined);
  assert.equal(third.skus["demo-kazoo-01"]?.newIssues, undefined, "问题消失：不再列为当前问题");
  assert.ok(third.skus["demo-yoyo-01"], "不在售款照样保留状态");
});

// ---------- 任务：假亚马逊与假飞书 ----------

function fakes(options: { listings: () => Row[]; report?: () => Row; statuses?: string[] }) {
  const calls: Array<{ path: string; method?: string; body?: Row }> = [];
  let created = 0, polls = 0;
  const statuses = options.statuses ?? ["DONE"];
  const amazon = {
    sp: async (path: string, init: { method?: string; body?: Row; query?: Row } = {}) => {
      calls.push({ path, ...(init.method ? { method: init.method } : {}), ...(init.body ? { body: init.body } : {}) });
      if (path === "/listings/2021-08-01/items/SELLER1") return { items: options.listings(), pagination: {} };
      if (path === "/reports/2021-06-30/reports" && init.method === "POST") { created += 1; return { reportId: `R${created}` }; }
      if (path.startsWith("/reports/2021-06-30/reports/")) { const status = statuses[Math.min(polls, statuses.length - 1)]!; polls += 1; return status === "DONE" ? { processingStatus: "DONE", reportDocumentId: "D1" } : { processingStatus: status }; }
      if (path === "/reports/2021-06-30/documents/D1") return { url: "https://example.invalid/doc" };
      throw new Error(`unexpected ${path}`);
    },
    download: async () => new TextEncoder().encode(JSON.stringify((options.report ?? (() => accountReport()))())),
  } as unknown as AmazonClient;
  return { amazon, calls, created: () => created };
}

const hrrRecord = (key: string, amount: number, asin: string, start: string, end: string, postedAt: number): FeishuRecord => ({
  record_id: `rec-${key}`,
  fields: {
    "流水唯一键": key, "原币金额": amount, "交易时间": postedAt,
    "金额明细": auditEncode({ totalAmount: { currencyAmount: amount, currencyCode: "USD" }, items: [{ description: "CustomerReturnHRRUnitFee", contexts: [{ asin, contextType: "ProductContext" }, { startTime: start, endTime: end, contextType: "TimeRangeContext" }] }] }),
  },
} as unknown as FeishuRecord);

function feishuOf(records: () => FeishuRecord[]) {
  const sent: string[][] = [];
  const searches: Array<Record<string, string>> = [];
  const feishu = {
    searchRecords: async (_app: string, _table: string, fields: Record<string, string>) => { searches.push(fields); return records(); },
    sendText: async (_user: string, lines: string[]) => { sent.push(lines); },
  } as unknown as FeishuClient;
  return { feishu, sent, searches };
}

test("店铺健康任务：首轮建基线、取首份账户报告、高退货率处理费已有行记为已提醒，不发消息；摘要给中台；账户报告记健康", async () => {
  const state = new MemoryState();
  const t0 = Date.parse("2026-10-11T01:25:00Z");
  const { amazon, created } = fakes({ listings: () => [listing("demo-kazoo-01", "B0KAZOO001", ["BUYABLE"])] });
  const ledger = [hrrRecord("k-may", -8.4, "B0XYLO0001", "2026-02-01T08:00:00Z", "2026-04-30T07:00:00Z", Date.parse("2026-05-07T12:00:00Z"))];
  const { feishu, sent, searches } = feishuOf(() => ledger);
  const result = await runStoreHealth({ taskType: "store-health", taskId: "store-health|1" }, configOf(), state.asStore(), amazon, feishu, { now: () => t0, sleep: async () => undefined });
  assert.equal(result.status, "done");
  assert.equal(result.baselines, 1);
  assert.equal(result.account, "fetched");
  assert.equal(created(), 1);
  assert.deepEqual(sent, [], "首轮不发消息");
  assert.deepEqual(searches, [{ "原始描述": "CustomerReturnHRREvent" }]);
  assert.ok((state.item("STORE_HEALTH", "hrr")?.notified as Row)["k-may"], "已有的处理费记为已提醒");
  const summary = state.item("STORE_HEALTH", "summary") as Row;
  assert.deepEqual((summary.account as Row).issues, []);
  assert.equal((summary.account as Row).ahrScore, 280);
  assert.equal(state.item("HEALTH", "account-health")?.lastStatus, "done");
  assert.equal(state.item("STORE_HEALTH", "account")?.pending, undefined);
});

test("店铺健康任务：账户报告 6 小时内不再申请；在售变不可售与新的高退货率处理费合并成一条消息；同日重跑同样内容不重复发", async () => {
  const state = new MemoryState();
  const t0 = Date.parse("2026-10-11T01:25:00Z");
  let kazoo = ["BUYABLE"];
  const ledger: FeishuRecord[] = [];
  const { amazon, created } = fakes({ listings: () => [listing("demo-kazoo-01", "B0KAZOO001", kazoo)] });
  const { feishu, sent } = feishuOf(() => ledger);
  const deps = (at: number) => ({ now: () => at, sleep: async () => undefined });
  await runStoreHealth({ taskType: "store-health", taskId: "store-health|1" }, configOf(), state.asStore(), amazon, feishu, deps(t0));
  kazoo = ["DISCOVERABLE"];
  // 次日（北京日期变了）才会再查流水：新的非 0 行提醒一次，$0 行不提醒。
  ledger.push(hrrRecord("k-oct", -11.6, "B0XYLO0001", "2026-06-01T07:00:00Z", "2026-08-31T07:00:00Z", Date.parse("2026-10-07T12:00:00Z")), hrrRecord("k-zero", 0, "B0KAZOO001", "2026-07-01T07:00:00Z", "2026-09-30T07:00:00Z", Date.parse("2026-10-07T12:00:00Z")));
  const t1 = t0 + 24 * HOUR;
  const second = await runStoreHealth({ taskType: "store-health", taskId: "store-health|2" }, configOf(), state.asStore(), amazon, feishu, deps(t1));
  assert.equal(created(), 2, "距上次成功已满 6 小时，申请新报告");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], [
    "🩺 店铺健康",
    "⚠️ 美国站 demo-kazoo-01：不可售了（原在售）",
    "⚠️ demo-xylo-01（B0XYLO0001） 退货率超过类目阈值（统计 06/01~08/31），亚马逊收高退货率处理费 $11.60",
    "处理时请在本店固定环境登录卖家后台查看（「账户状况」「管理库存」）。",
  ]);
  assert.equal(second.notified, true);
  const summary = state.item("STORE_HEALTH", "summary") as Row;
  assert.deepEqual((summary.listings as Row[]).map((row) => [row.sku, row.kind]), [["demo-kazoo-01", "not-buyable"]]);
  const third = await runStoreHealth({ taskType: "store-health", taskId: "store-health|3" }, configOf(), state.asStore(), amazon, feishu, deps(t1 + HOUR));
  assert.equal(created(), 2, "6 小时内不再申请账户报告");
  assert.equal(third.account, "not-due");
  assert.equal(sent.length, 1, "状态没变、流水当天已查：不再发");
});

test("店铺健康任务：账户报告 3 分钟内没出就挂起，下一轮接着取同一份；所有站点 listing 都失败才让任务失败", async () => {
  const state = new MemoryState();
  const t0 = Date.parse("2026-10-11T01:25:00Z");
  let clock = t0;
  const statuses = Array.from({ length: 30 }, () => "IN_PROGRESS");
  const { amazon, created } = fakes({ listings: () => [listing("demo-kazoo-01", "B0KAZOO001", ["BUYABLE"])], statuses });
  const { feishu } = feishuOf(() => []);
  // 轮询时钟随 sleep 前进：预算 3 分钟用完返回挂起。
  const first = await runStoreHealth({ taskType: "store-health", taskId: "store-health|1" }, configOf(), state.asStore(), amazon, feishu, { now: () => t0, clock: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.equal(first.account, "pending");
  assert.equal((state.item("STORE_HEALTH", "account")?.pending as Row).reportId, "R1");
  assert.equal(state.item("HEALTH", "account-health"), undefined);
  statuses.splice(0, statuses.length, "DONE");
  const second = await runStoreHealth({ taskType: "store-health", taskId: "store-health|2" }, configOf(), state.asStore(), amazon, feishu, { now: () => t0 + HOUR, sleep: async () => undefined });
  assert.equal(second.account, "fetched");
  assert.equal(created(), 1, "接着取挂起的同一份报告");
  const broken = { sp: async () => { throw new Error("HTTP 503"); }, download: async () => new Uint8Array() } as unknown as AmazonClient;
  await assert.rejects(runStoreHealth({ taskType: "store-health", taskId: "store-health|3" }, configOf(), state.asStore(), broken, feishu, { now: () => t0 + 2 * HOUR, sleep: async () => undefined }), /所有站点 listing 都没查成功/);
  assert.equal(clock > t0, true);
});

test("三个新任务接入任务分发；维护任务健康规则：店铺健康 3 小时，账户健康报告、库存健康、SQP 任务 26 小时，SQP 新一周数据 12 天", async () => {
  const off = configOf({ STORE_HEALTH_ENABLED: "false", INVENTORY_HEALTH_ENABLED: "false", SQP_ENABLED: "false" });
  const context = { config: off, state: new MemoryState().asStore(), amazon: {} as AmazonClient, feishu: {} as FeishuClient };
  for (const taskType of ["store-health", "inventory-health", "sqp"]) assert.deepEqual(await runJob({ taskType }, context), { status: "done", disabled: true }, taskType);
  assert.deepEqual([HEALTH_RULES["store-health"], HEALTH_RULES["account-health"], HEALTH_RULES["inventory-health"], HEALTH_RULES.sqp, HEALTH_RULES["sqp-data"]], [3 * HOUR, 26 * HOUR, 26 * HOUR, 26 * HOUR, 12 * 24 * HOUR]);
});

test("店铺健康开关：STORE_HEALTH_ENABLED=false 空跑并记成功", async () => {
  const state = new MemoryState();
  const { amazon, calls } = fakes({ listings: () => [] });
  const { feishu } = feishuOf(() => []);
  const result = await runStoreHealth({ taskType: "store-health" }, configOf({ STORE_HEALTH_ENABLED: "false" }), state.asStore(), amazon, feishu);
  assert.deepEqual(result, { status: "done", disabled: true });
  assert.equal(calls.length, 0);
});
