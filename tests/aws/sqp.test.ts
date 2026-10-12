import assert from "node:assert/strict";
import test from "node:test";
import { asinBatches, buildSqpPack, compactSqp, completeWeeks, loadSqpWeek, recentSqpWeeks, runSqp, saveSqpWeek, type AdTermTotals } from "../../src/business/sqp.js";
import type { AppConfig } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const configOf = (values: Record<string, string> = {}, asins = ["B0DEMO0001", "B0DEMO0002"]): AppConfig => ({
  get: (key: string) => values[key] ?? key,
  optional: (key: string, fallback = "") => values[key] ?? fallback,
  bool: (key: string, fallback = true) => key in values ? values[key] === "true" : fallback,
  asins: () => asins.map((asin, index) => ({ sku: `SKU-${index}`, asin, competitors: [], adMarker: "" })),
}) as unknown as AppConfig;

test("目标周：洛杉矶今天之前最近的完整周（周日~周六），新到旧；今天是周六时本周不算", () => {
  assert.deepEqual(completeWeeks("2026-10-11", 4), ["2026-10-04", "2026-09-27", "2026-09-20", "2026-09-13"], "周日");
  assert.deepEqual(completeWeeks("2026-10-10", 2), ["2026-09-27", "2026-09-20"], "周六");
  assert.deepEqual(completeWeeks("2026-10-12", 1), ["2026-10-04"], "周一");
});

test("ASIN 按 200 字符分批（空格分隔，10 位 ASIN 一批最多 18 个）", () => {
  const asins = Array.from({ length: 19 }, (_, index) => `B0${String(index).padStart(8, "0")}`);
  const batches = asinBatches(asins);
  assert.deepEqual(batches.map((batch) => batch.length), [18, 1]);
  assert.ok(batches.every((batch) => batch.join(" ").length <= 200));
});

// SQP 报告行的结构（ASIN 与搜索词为虚构）。
const sqpRow = (asin: string, query: string, values: { score: number; volume: number; impr: [number, number]; click: [number, number]; cart: [number, number]; buy: [number, number]; ourPrice?: number; mktPrice?: number }): Row => ({
  startDate: "2026-09-27", endDate: "2026-10-03", asin,
  searchQueryData: { searchQuery: query, searchQueryScore: values.score, searchQueryVolume: values.volume },
  impressionData: { totalQueryImpressionCount: values.impr[0], asinImpressionCount: values.impr[1], asinImpressionShare: values.impr[0] ? (values.impr[1] / values.impr[0]) * 100 : null },
  clickData: { totalClickCount: values.click[0], asinClickCount: values.click[1], ...(values.ourPrice ? { asinMedianClickPrice: { amount: values.ourPrice, currencyCode: "USD" } } : {}), ...(values.mktPrice ? { totalMedianClickPrice: { amount: values.mktPrice, currencyCode: "USD" } } : {}) },
  cartAddData: { totalCartAddCount: values.cart[0], asinCartAddCount: values.cart[1] },
  purchaseData: { totalPurchaseCount: values.buy[0], asinPurchaseCount: values.buy[1], ...(values.ourPrice ? { asinMedianPurchasePrice: { amount: values.ourPrice, currencyCode: "USD" } } : {}), ...(values.mktPrice ? { totalMedianPurchasePrice: { amount: values.mktPrice, currencyCode: "USD" } } : {}) },
});

test("紧凑格式：搜索词小写，四段漏斗的全市场与本 ASIN 数、中位价；gzip 分片存取往返一致", async () => {
  const week = compactSqp({ reportSpecification: {}, dataByAsin: [
    sqpRow("B0DEMO0001", "Toddler Xylophone", { score: 21, volume: 150, impr: [2800, 30], click: [110, 3], cart: [40, 2], buy: [5, 1], ourPrice: 14.99, mktPrice: 24.99 }),
    sqpRow("b0demo0002", "kids kazoo", { score: 21, volume: 80, impr: [1600, 25], click: [50, 3], cart: [10, 1], buy: [4, 0] }),
  ] });
  assert.deepEqual(Object.keys(week), ["B0DEMO0001", "B0DEMO0002"]);
  assert.deepEqual(week.B0DEMO0001![0], ["toddler xylophone", 21, 150, 2800, 30, 110, 3, 40, 2, 5, 1, 14.99, 24.99, 14.99, 24.99]);
  assert.deepEqual(week.B0DEMO0002![0]!.slice(11), [null, null, null, null], "没有中位价时为空");
  const state = new MemoryState();
  await saveSqpWeek(state.asStore(), "2026-09-27", week, Date.parse("2026-10-11T00:00:00Z"));
  assert.deepEqual(await loadSqpWeek(state.asStore(), "2026-09-27"), week);
  assert.equal(await loadSqpWeek(state.asStore(), "2026-09-20"), undefined);
});

function fakeAmazon(byWeek: (week: string, asins: string) => { status: "DONE"; json: Row } | { status: "FATAL"; error: string }) {
  const requests: Array<{ week: string; asins: string }> = [];
  const reports = new Map<string, ReturnType<typeof byWeek>>();
  const amazon = {
    sp: async (path: string, init: { method?: string; body?: Row } = {}) => {
      if (path === "/reports/2021-06-30/reports" && init.method === "POST") {
        const body = init.body!;
        assert.equal(body.reportType, "GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT");
        const week = String(body.dataStartTime).slice(0, 10);
        const asins = String((body.reportOptions as Row).asin);
        assert.equal((body.reportOptions as Row).reportPeriod, "WEEK");
        assert.equal(String(body.dataEndTime).slice(0, 10), new Date(Date.parse(`${week}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10), "周六结束");
        requests.push({ week, asins });
        const id = `R${requests.length}`;
        reports.set(id, byWeek(week, asins));
        return { reportId: id };
      }
      const match = /^\/reports\/2021-06-30\/reports\/(R\d+)$/.exec(path);
      if (match) { const report = reports.get(match[1]!)!; return { processingStatus: report.status, reportDocumentId: `D-${match[1]}` }; }
      const doc = /^\/reports\/2021-06-30\/documents\/D-(R\d+)$/.exec(path);
      if (doc) return { url: `https://example.invalid/${doc[1]}` };
      throw new Error(`unexpected ${path}`);
    },
    download: async (url: string) => {
      const report = reports.get(url.split("/").at(-1)!)!;
      return new TextEncoder().encode(JSON.stringify(report.status === "DONE" ? report.json : { errorDetails: report.error }));
    },
  } as unknown as AmazonClient;
  return { amazon, requests };
}

const weekJson = (week: string): Row => ({ reportSpecification: { dataStartTime: week }, dataByAsin: [sqpRow("B0DEMO0001", `xylophone ${week}`, { score: 1, volume: 10, impr: [100, 5], click: [10, 1], cart: [3, 1], buy: [2, 1] })] });

test("SQP 任务：最新一周“not available yet”记未就绪、接着取更早还缺的周；存周数据并记 sqp-data 健康；同日重跑只再试未就绪的周", async () => {
  const state = new MemoryState();
  const now = Date.parse("2026-10-11T19:00:00Z");
  const { amazon, requests } = fakeAmazon((week) => week === "2026-10-04" ? { status: "FATAL", error: "Reporting data for end date [2026-10-10] and time period [weekly] is not available yet." } : { status: "DONE", json: weekJson(week) });
  const first = await runSqp({ taskType: "sqp" }, configOf(), state.asStore(), amazon, { now: () => now, sleep: async () => undefined });
  assert.deepEqual([first.stored, first.notReady, first.latestWeek], ["2026-09-27,2026-09-20,2026-09-13", "2026-10-04", "2026-09-27"]);
  assert.deepEqual(requests.map((item) => item.week), ["2026-10-04", "2026-09-27", "2026-09-20", "2026-09-13"]);
  assert.equal(requests[0]!.asins, "B0DEMO0001 B0DEMO0002", "ASIN 去重排序后空格分隔");
  assert.deepEqual(state.item("SQP_META", "state")?.weeks, ["2026-09-27", "2026-09-20", "2026-09-13"]);
  assert.equal(state.item("HEALTH", "sqp-data")?.lastStatus, "done");
  const weeks = await recentSqpWeeks(state.asStore(), 2);
  assert.deepEqual(weeks.map((item) => item.week), ["2026-09-27", "2026-09-20"]);
  assert.equal(weeks[0]!.data.B0DEMO0001![0]![0], "xylophone 2026-09-27");
  const second = await runSqp({ taskType: "sqp" }, configOf(), state.asStore(), amazon, { now: () => now + 3_600_000, sleep: async () => undefined });
  assert.equal(second.notReady, "2026-10-04");
  assert.deepEqual(requests.slice(4).map((item) => item.week), ["2026-10-04"], "只再试未就绪的周");
});

test("SQP 任务：其它 FATAL 原文报错；全部补齐后直接完成不调接口；开关关闭空跑", async () => {
  const bad = fakeAmazon(() => ({ status: "FATAL", error: "dataStartTime must be a Sunday when reportPeriod=WEEK" }));
  await assert.rejects(runSqp({ taskType: "sqp" }, configOf(), new MemoryState().asStore(), bad.amazon, { now: () => Date.parse("2026-10-11T19:00:00Z"), sleep: async () => undefined }), /SQP 2026-10-04 FATAL：.*must be a Sunday/);
  const state = new MemoryState([{ pk: "SQP_META", sk: "state", weeks: ["2026-10-04", "2026-09-27", "2026-09-20", "2026-09-13"] }]);
  const idle = fakeAmazon(() => { throw new Error("不该申请"); });
  assert.equal((await runSqp({ taskType: "sqp" }, configOf(), state.asStore(), idle.amazon, { now: () => Date.parse("2026-10-11T19:00:00Z") })).upToDate, true);
  assert.deepEqual(await runSqp({ taskType: "sqp" }, configOf({ SQP_ENABLED: "false" }), state.asStore(), idle.amazon), { status: "done", disabled: true });
  assert.equal(idle.requests.length, 0);
});

test("SQP 数据包：最近一周重要度前 N 个词，补上有广告花费的搜索词；份额按各周计数合计现算；逐周序列与广告对照", () => {
  const weekA = compactSqp({ dataByAsin: [
    sqpRow("B0DEMO0001", "xylophone for babies", { score: 2, volume: 100, impr: [1000, 10], click: [100, 10], cart: [20, 2], buy: [10, 2], ourPrice: 14.99, mktPrice: 20 }),
    sqpRow("B0DEMO0001", "baby xylophone", { score: 1, volume: 50, impr: [500, 50], click: [50, 20], cart: [10, 8], buy: [5, 4] }),
    sqpRow("B0DEMO0001", "musical toys", { score: 9, volume: 400, impr: [4000, 4], click: [300, 1], cart: [60, 0], buy: [30, 0] }),
  ] });
  const weekB = compactSqp({ dataByAsin: [sqpRow("B0DEMO0001", "xylophone for babies", { score: 3, volume: 60, impr: [600, 6], click: [60, 2], cart: [10, 1], buy: [5, 0] })] });
  const ads = new Map<string, AdTermTotals>([["musical toys", { clicks: 30, orders: 0, spend: 12.4 }], ["xylophone for babies", { clicks: 8, orders: 1, spend: 3.2 }], ["not in sqp", { clicks: 50, orders: 0, spend: 40 }]]);
  const pack = buildSqpPack([{ week: "2026-09-27", data: weekA }, { week: "2026-09-20", data: weekB }], "B0DEMO0001", ads, 2) as Row;
  assert.deepEqual(pack.weeks, ["2026-09-27", "2026-09-20"]);
  const queries = pack.queries as Row[];
  assert.deepEqual(queries.map((item) => item.query), ["baby xylophone", "xylophone for babies", "musical toys"], "前 2 个按重要度，花费 ≥$5 的广告词补在后面；SQP 里没有的广告词不加");
  const xylo = queries[1]!;
  assert.deepEqual([xylo.volume, xylo.imprShare, xylo.clickShare, xylo.buyShare, xylo.ourCvr, xylo.marketCvr, xylo.ourPrice, xylo.marketPrice], [160, 1, 7.5, 13.33, 0.1667, 0.0938, 14.99, 20]);
  assert.deepEqual(xylo.weekly, [["2026-09-27", 100, 10, 2], ["2026-09-20", 60, 2, 0]]);
  assert.deepEqual(xylo.ad30, { clicks: 8, orders: 1, spend: 3.2 });
  assert.equal(queries[0]!.ad30, null);
  assert.deepEqual((queries[0]!.weekly as unknown[])[1], ["2026-09-20", null, null, null], "该周没有这个词");
  assert.equal(buildSqpPack([{ week: "2026-09-27", data: weekA }], "B0OTHER0000", ads, 5), null, "没有该 ASIN 的数据");
  assert.equal(buildSqpPack([], "B0DEMO0001", ads, 5), null);
});
