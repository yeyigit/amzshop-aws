import assert from "node:assert/strict";
import test from "node:test";
import { pageToken, runPayouts } from "../../src/business/payouts.js";
import { runJob } from "../../src/business/jobs.js";
import { ymdInZone } from "../../src/util.js";
import { HttpError } from "../../src/http.js";
import type { AppConfig } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import type { StateStore } from "../../src/state.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const TABLES = { FEISHU_BITABLE_TABLE_ID_PAYOUTS: "tbl-payouts", FEISHU_BITABLE_TABLE_ID_BALANCES: "tbl-balances" };
const configOf = (values: Record<string, string> = TABLES): AppConfig => ({ get: (key: string) => values[key] ?? key, optional: (key: string, fallback = "") => values[key] ?? (key === "FEISHU_NOTIFY_USER_IDS" ? "u1" : fallback), bool: () => true, asins: () => [] }) as unknown as AppConfig;
const ids = (settlementId: string): Row[] => [{ relatedIdentifierName: "SETTLEMENT_ID", relatedIdentifierValue: settlementId }];
const period = { startDate: "2026-09-16T00:00:00.000Z", endDate: "2026-09-30T00:00:00.000Z" };
const scheduled = (status = "SCHEDULED"): Row => ({ status, amount: { unit: "USD", value: 1234.56 }, scheduledDate: "2026-10-02T00:00:00.000Z", period, relatedIdentifiers: ids("S-100"), paymentMethod: "BANK_ACCOUNT", accountTail: "123", partnerMetadata: { accountType: "STANDARD_ORDERS", marketplaceId: "ATVPDKIKX0DER" } });
const noPayout: Row = { status: "NO_PAYOUT_EXPECTED", amount: {}, scheduledDate: null, period, relatedIdentifiers: ids("S-200"), paymentMethod: null, accountTail: null, partnerMetadata: { accountType: "SELLER_WALLET" } };
const paid = (settlementId: string, id: string, paidAt: string, value = 500): Row => ({ id, currentStatus: "PAID", type: "SCHEDULED", amount: { unit: "USD", value }, creationDate: "2026-09-15T02:00:00.000Z", period, relatedIdentifiers: ids(settlementId), paymentMethod: "BANK_ACCOUNT", accountTail: "123", partnerMetadata: { accountType: "STANDARD_ORDERS" }, statusHistory: [{ status: "STARTED", lastUpdatedDate: "2026-09-15T02:00:00.000Z" }, { status: "PAID", lastUpdatedDate: paidAt }] });
const started = (settlementId: string, id: string, status = "STARTED", value = 1234.56): Row => ({ id, currentStatus: status, type: "SCHEDULED", amount: { unit: "USD", value }, creationDate: "2026-09-30T00:07:00.000Z", period, relatedIdentifiers: ids(settlementId), paymentMethod: "BANK_ACCOUNT", accountTail: "123", partnerMetadata: { accountType: "STANDARD_ORDERS" }, statusHistory: [{ status: "STARTED", lastUpdatedDate: "2026-09-30T00:07:00.000Z" }] });
const balances = { payload: { balances: [{ partnerMetadata: { accountType: "STANDARD_ORDERS" }, balanceType: "TOTAL", amount: { currencyAmount: 100, currencyCode: "USD" }, balances: [
  { balanceType: "AVAILABLE", amount: { currencyAmount: 60, currencyCode: "USD" }, balances: null },
  { balanceType: "RESERVED", amount: { currencyAmount: 40, currencyCode: "USD" }, balances: [{ balanceType: "DEFERRED", amount: { currencyAmount: 30, currencyCode: "USD" } }, { balanceType: "ACCOUNT_LEVEL_RESERVE", amount: { currencyAmount: 10, currencyCode: "USD" } }] },
] }] }, statusCode: 200 };

function harness(options: { expected?: () => Row[]; payouts?: () => Row[]; failExpected?: boolean; state?: MemoryState } = {}) {
  const calls: Array<{ path: string; query: Row }> = [];
  const amazon = { sp: async (path: string, init: { query?: Row } = {}) => {
    calls.push({ path, query: init.query ?? {} });
    if (path.endsWith("/payouts/expected")) { if (options.failExpected) throw new Error("HTTP 503"); return { expectedPayouts: (options.expected ?? (() => [scheduled(), noPayout]))() }; }
    if (path.endsWith("/payouts")) return { payouts: (options.payouts ?? (() => [paid("S-050", "P-1", "2026-09-16T08:00:00.000Z")]))() };
    if (path.endsWith("/balances")) return balances;
    if (path.endsWith("/summary")) return { payload: { summaries: [{ netProceeds: { currencyAmount: 1234.56, currencyCode: "USD" }, relatedIdentifiers: ids(String(init.query?.relatedIdentifierValue)), breakdowns: [{ breakdownType: "OTHERS", breakdownAmount: { currencyAmount: 1234.56, currencyCode: "USD" } }] }] }, statusCode: 200 };
    throw new Error(`unexpected ${path}`);
  } } as unknown as AmazonClient;
  const state = options.state ?? new MemoryState();
  const tables: Record<string, Array<{ record_id: string; fields: Row }>> = { "tbl-payouts": [], "tbl-balances": [] };
  const sent: Array<{ lines: string[]; beforeWrites: number }> = [];
  const intentsAtFirstWrite: string[] = [];
  let writes = 0;
  const feishu = {
    listRecords: async (_app: string, table: string) => structuredClone(tables[table] ?? []),
    upsert: async (_app: string, table: string, key: Row, fields: Row, createOnly: Row = {}, opts: { existing?: Array<{ record_id: string }> } = {}) => {
      if (!writes) intentsAtFirstWrite.push(...state.partition("NOTIFICATION").map((item) => String(item.sk)));
      writes += 1;
      const rows = tables[table]!;
      const found = rows.find((row) => Object.entries(key).every(([name, value]) => row.fields[name] === value));
      assert.equal(opts.existing?.[0]?.record_id, found?.record_id, "复用已读取的行");
      if (found) Object.assign(found.fields, fields); else rows.push({ record_id: `rec-${rows.length + 1}`, fields: { ...fields, ...createOnly } });
      return found?.record_id ?? `rec-${rows.length}`;
    },
    sendText: async (_user: string, lines: string[]) => { sent.push({ lines, beforeWrites: writes }); },
  } as unknown as FeishuClient;
  return { amazon, feishu, state, tables, sent, calls, intentsAtFirstWrite, run: (config = configOf()) => runPayouts({ taskType: "payouts" }, config, state.asStore(), amazon, feishu) };
}

test("B3 首轮：两张新表按 Amazon 原值写入（缺失值不补 0）；预计放款只写表不发消息，在途放款发“放款已发起”且意图先于写表持久化；历史已到账不补发", async () => {
  const h = harness({ payouts: () => [paid("S-050", "P-1", "2026-09-16T08:00:00.000Z"), started("S-090", "P-2")] });
  const result = await h.run();
  assert.equal(result.status, "done");
  const rows = new Map(h.tables["tbl-payouts"]!.map((row) => [String(row.fields["放款唯一键"]), row.fields]));
  assert.deepEqual([...rows.keys()].sort(), ["S-050", "S-090", "S-100", "S-200"]);
  const upcoming = rows.get("S-100")!;
  assert.equal(upcoming["状态"], "SCHEDULED");
  assert.equal(upcoming["金额"], 1234.56);
  assert.equal(upcoming["币种"], "USD");
  assert.equal(upcoming["预计发起日"], Date.parse("2026-10-02T00:00:00.000Z"));
  assert.equal(upcoming["结算期开始"], Date.parse(period.startDate));
  assert.equal(upcoming["卡尾号"], "123");
  assert.equal(upcoming["结算净额"], 1234.56);
  assert.equal("结算分项" in upcoming, false, "结算分项原样 JSON 已删除（2026-10-06），需要时按结算 ID 向亚马逊重查");
  assert.ok(Number(upcoming["首次发现时间"]) > 0 && Number(upcoming["最后同步时间"]) > 0);
  const none = rows.get("S-200")!;
  assert.equal(none["状态"], "NO_PAYOUT_EXPECTED");
  for (const field of ["金额", "币种", "预计发起日", "卡尾号", "收款方式"]) assert.equal(field in none, false, `${field} 缺失时不写`);
  assert.equal(rows.get("S-050")!["放款ID"], "P-1");
  assert.equal(rows.get("S-050")!["状态"], "PAID");
  const balance = h.tables["tbl-balances"]![0]!.fields;
  assert.equal(balance["快照唯一键"], `${ymdInZone(new Date(), "Asia/Shanghai")}|STANDARD_ORDERS|USD`);
  assert.deepEqual([balance["总额"], balance["可用"], balance["预留"], balance["递延"], balance["账户级预留"]], [100, 60, 40, 30, 10]);
  assert.equal(h.sent.length, 1, "预计放款与历史到账都不发，只发在途放款");
  assert.equal(h.sent[0]!.lines[0], "💵 放款已发起");
  assert.ok(h.sent[0]!.lines.includes("结算ID：S-090"));
  assert.ok(h.sent[0]!.lines.includes("金额：$1234.56"));
  assert.ok(h.intentsAtFirstWrite.includes("payout|S-090|STARTED"), "通知意图在写表前持久化");
  assert.equal(h.state.item("NOTIFICATION", "payout|S-100|SCHEDULED"), undefined, "预计放款不建通知意图");
  const summaryCalls = h.calls.filter((call) => call.path.endsWith("/summary"));
  assert.ok(summaryCalls.every((call) => call.query.relatedIdentifierName === "SETTLEMENT_ID" && !("periodStart" in call.query)));
  const payoutCall = h.calls.find((call) => call.path.endsWith("/payouts"))!;
  assert.ok(Date.now() - Date.parse(String(payoutCall.query.createdAfter)) >= 60 * 86_400_000 - 60_000, "listPayouts 取近 60 天");
});

test("B3 预计放款不发消息；状态变为 AT_RISK 立即提醒；放款发起按最终金额只发一次、在途不重复；变为 PAID 发到账确认；键含结算ID与状态，同一状态只发一次；已结清的结算不再重复查汇总", async () => {
  let expected: Row[] = [scheduled()];
  let payouts: Row[] = [];
  const h = harness({ expected: () => expected, payouts: () => payouts });
  await h.run();
  assert.equal(h.sent.length, 0, "预计放款只写表");
  expected = [scheduled("AT_RISK")];
  await h.run();
  assert.equal(h.sent.at(-1)!.lines[0], "⚠️ 放款异常：AT_RISK");
  await h.run();
  assert.equal(h.sent.length, 1, "同一状态只发一次");
  expected = [];
  payouts = [started("S-100", "P-9", "STARTED", 1300.01)];
  await h.run();
  assert.equal(h.sent.at(-1)!.lines[0], "💵 放款已发起");
  assert.ok(h.sent.at(-1)!.lines.includes("金额：$1300.01"));
  payouts = [started("S-100", "P-9", "IN_TRANSIT", 1300.01)];
  await h.run();
  assert.equal(h.sent.length, 2, "在途不重复");
  payouts = [paid("S-100", "P-9", new Date().toISOString(), 1300.01)];
  await h.run();
  assert.equal(h.sent.at(-1)!.lines[0], "✅ 放款到账");
  assert.equal(h.state.item("NOTIFICATION", "payout|S-100|PAID")?.status, "done");
  const row = h.tables["tbl-payouts"]!.find((item) => item.fields["放款唯一键"] === "S-100")!.fields;
  assert.equal(row["状态"], "PAID");
  assert.equal(row["放款ID"], "P-9");
  assert.equal(row["预计发起日"], Date.parse("2026-10-02T00:00:00.000Z"), "预计放款消失后保留表内原值");
  const summaryBefore = h.calls.filter((call) => call.path.endsWith("/summary")).length;
  await h.run();
  assert.equal(h.calls.filter((call) => call.path.endsWith("/summary")).length, summaryBefore, "已到账且已取得汇总的结算不再查");
  assert.equal(h.sent.length, 3);
});

test("B3 接口失败保留表内旧值不写空：预计放款失败时其余来源照写，本轮失败交给重试；未配置表 ID 时消息照发、写表不启用", async () => {
  const state = new MemoryState();
  const ok = harness({ state });
  await ok.run();
  const failing = harness({ state, failExpected: true });
  failing.tables["tbl-payouts"] = structuredClone(ok.tables["tbl-payouts"]!);
  const before = structuredClone(failing.tables["tbl-payouts"]!.find((item) => item.fields["放款唯一键"] === "S-100")!.fields);
  await assert.rejects(failing.run(), /listExpectedPayouts/);
  assert.deepEqual(failing.tables["tbl-payouts"]!.find((item) => item.fields["放款唯一键"] === "S-100")!.fields, before, "失败来源的行不动");
  assert.equal(failing.tables["tbl-balances"]!.length, 1, "余额照写");
  const noTables = harness({ payouts: () => [started("S-100", "P-9")] });
  const result = await noTables.run(configOf({}));
  assert.equal(result.tablesDisabled, true);
  assert.equal(noTables.tables["tbl-payouts"]!.length + noTables.tables["tbl-balances"]!.length, 0);
  assert.equal(noTables.sent.length, 1, "消息照发");
});

test("B3 生产首轮实测：SELLER_WALLET 的 NO_PAYOUT_EXPECTED 结算查汇总必返回 400——无放款的结算不查汇总，单个结算汇总 400 视为无汇总、不让整轮失败", async () => {
  const h = harness({ expected: () => [scheduled(), noPayout, { ...scheduled(), relatedIdentifiers: ids("S-300") }] });
  const amazon = h.amazon as unknown as { sp: (path: string, init?: { query?: Row }) => Promise<unknown> };
  const original = amazon.sp;
  amazon.sp = async (path: string, init: { query?: Row } = {}) => {
    if (path.endsWith("/summary") && init.query?.relatedIdentifierValue === "S-300") { h.calls.push({ path, query: init.query }); throw new HttpError(400, "InvalidInput", "", "HTTP 400 InvalidInput", false); }
    return original(path, init);
  };
  const result = await h.run();
  assert.equal(result.status, "done");
  const summaryIds = h.calls.filter((call) => call.path.endsWith("/summary")).map((call) => call.query.relatedIdentifierValue);
  assert.equal(summaryIds.includes("S-200"), false, "NO_PAYOUT_EXPECTED 不查汇总");
  const row = h.tables["tbl-payouts"]!.find((item) => item.fields["放款唯一键"] === "S-300")!.fields;
  assert.equal("结算净额" in row, false, "无汇总不写空");
  assert.equal(row["金额"], 1234.56);
});

test("B3 生产实测（2026-10-01）：结算提前关闭后，新结算的预计金额仍是上一期结算额——不发预计放款；旧结算放款发起时按最终金额只发一次“放款已发起”，到账再发“到账”", async () => {
  const closing = "10000000001";
  const opened = "10000000002";
  const openPeriod = { startDate: "2026-09-21T07:30:22.455Z", endDate: "2026-10-05T07:30:22.126Z" };
  const closedPeriod = { startDate: "2026-09-21T07:30:22.455Z", endDate: "2026-10-01T00:07:16.791Z" };
  const newPeriod = { startDate: "2026-10-01T00:07:16.791Z", endDate: "2026-10-15T00:07:16.365Z" };
  const expectedOf = (settlementId: string, value: number, window: Row): Row => ({ status: "SCHEDULED", amount: { unit: "USD", value }, scheduledDate: window.endDate, period: window, relatedIdentifiers: ids(settlementId), paymentMethod: "BANK_ACCOUNT", accountTail: "123", partnerMetadata: { accountType: "STANDARD_ORDERS" } });
  const payoutOf = (status: string, history: Row[]): Row => ({ id: closing, currentStatus: status, amount: { unit: "USD", value: 812.4 }, creationDate: "2026-10-01T00:07:23.834Z", period: closedPeriod, relatedIdentifiers: ids(closing), paymentMethod: "BANK_ACCOUNT", accountTail: "123", partnerMetadata: { accountType: "STANDARD_ORDERS" }, statusHistory: history });
  const startedAt = { status: "STARTED", lastUpdatedDate: "2026-10-01T00:07:23.834Z" };
  let expected: Row[] = [expectedOf(closing, 690.5, openPeriod)];
  let payouts: Row[] = [];
  const h = harness({ expected: () => expected, payouts: () => payouts });
  await h.run();
  assert.equal(h.sent.length, 0, "9/30 预计放款 $690.50 只写表");
  expected = [expectedOf(opened, 812.4, newPeriod)];
  payouts = [payoutOf("STARTED", [startedAt])];
  await h.run();
  assert.deepEqual(h.sent.map((item) => item.lines), [["💵 放款已发起", "金额：$812.40", "发起时间：2026-10-01 08:07", "结算期：2026-09-21 至 2026-10-01", "收款：BANK_ACCOUNT 尾号 123", `结算ID：${closing}`, "账户：STANDARD_ORDERS"]], "新结算的过渡金额不发消息");
  expected = [expectedOf(opened, 50.12, newPeriod)];
  payouts = [payoutOf("IN_TRANSIT", [startedAt, { status: "IN_TRANSIT", lastUpdatedDate: "2026-10-02T00:07:17.591Z" }])];
  await h.run();
  assert.equal(h.sent.length, 1, "在途与新结算预计金额变化都不发");
  payouts = [payoutOf("PAID", [startedAt, { status: "PAID", lastUpdatedDate: new Date(Date.now() - 3_600_000).toISOString() }])];
  await h.run();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1]!.lines[0], "✅ 放款到账");
  assert.ok(h.sent[1]!.lines.includes("金额：$812.40"));
  const fresh = h.tables["tbl-payouts"]!.find((row) => row.fields["放款唯一键"] === opened)!.fields;
  assert.equal(fresh["金额"], 50.12, "放款表照常更新新结算的预计金额");
  assert.equal(fresh["状态"], "SCHEDULED");
});

test("B3 生产实测（2026-10-12）：近 60 天放款超过一页（10 条）时，亚马逊给的 nextToken 已做过 URL 编码——先解码再交给查询参数，线上只编码一次；第二页放款照常合并，在途放款照发“放款已发起”", async () => {
  const encoded = "c2Vjb25kLXBhZ2UtdG9rZW4%3D";
  const h = harness();
  const amazon = h.amazon as unknown as { sp: (path: string, init?: { query?: Row }) => Promise<unknown> };
  const original = amazon.sp;
  amazon.sp = async (path: string, init: { query?: Row } = {}) => {
    if (!path.endsWith("/payouts")) return original(path, init);
    h.calls.push({ path, query: init.query ?? {} });
    const token = init.query?.nextToken;
    if (token === undefined) return { payouts: [started("S-110", "P-11")], nextToken: encoded };
    if (token !== "c2Vjb25kLXBhZ2UtdG9rZW4=") throw new HttpError(400, "InvalidInput", "", "HTTP 400 InvalidInput", false);
    return { payouts: [paid("S-050", "P-1", "2026-09-16T08:00:00.000Z")] };
  };
  const result = await h.run();
  assert.equal(result.status, "done");
  const pages = h.calls.filter((call) => call.path.endsWith("/payouts"));
  assert.equal(pages.length, 2);
  assert.equal(pages[1]!.query.createdAfter, pages[0]!.query.createdAfter, "第二页沿用同一 createdAfter");
  // AmazonClient 用 URLSearchParams 拼查询参数：解码后的令牌编码一次，线上即为亚马逊给的原样令牌。
  const url = new URL("/finances/transfers/2024-06-01/payouts", "https://sellingpartnerapi-na.amazon.com");
  url.searchParams.set("nextToken", String(pages[1]!.query.nextToken));
  assert.equal(url.search, `?nextToken=${encoded}`);
  const keys = h.tables["tbl-payouts"]!.map((row) => String(row.fields["放款唯一键"]));
  assert.ok(keys.includes("S-110") && keys.includes("S-050"), "两页的放款都写表");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.lines[0], "💵 放款已发起");
  assert.equal(pageToken("abc+/="), "abc+/=", "不含 %XX 的令牌原样使用");
  assert.equal(pageToken("bad%E0%A4%A"), "bad%E0%A4%A", "解码失败时原样使用");
});

test("B3 payouts 接入任务分发", async () => {
  const h = harness();
  const result = await runJob({ taskType: "payouts", taskId: "payouts|x" }, { config: configOf(), state: h.state.asStore() as StateStore, amazon: h.amazon, feishu: h.feishu });
  assert.equal(result.status, "done");
});
