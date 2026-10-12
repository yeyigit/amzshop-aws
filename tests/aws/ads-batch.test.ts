import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { AdsRun, adsContinueDelayMs, processReport, runAdsReports } from "../../src/business/ads.js";
import type { AppConfig, FeishuRecord, JobEvent, JsonObject } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuBatchOptions, FeishuClient } from "../../src/clients/feishu.js";
import type { StateStore } from "../../src/state.js";

type Fields = Record<string, unknown>;
type Job = Parameters<typeof processReport>[0];
interface Failure { op: "create" | "update" | "delete"; table: string; applied: boolean }

const tableIds: Record<string, string> = {
  FEISHU_BITABLE_APP_TOKEN_ORDERS: "app", FEISHU_BITABLE_TABLE_ID_ADS_CAMPAIGN_DAILY: "campaign", FEISHU_BITABLE_TABLE_ID_ADS_DAILY_OVERVIEW: "overview",
  FEISHU_BITABLE_TABLE_ID_SKUS: "skus", FEISHU_BITABLE_TABLE_ID_PROFIT_ESTIMATE: "profits",
};
const configFor = (profileId: string): AppConfig => ({
  get: (key: string) => tableIds[key] ?? key,
  optional: (key: string, fallback = "") => key === "ADS_PROFILES_JSON" ? JSON.stringify([{ profileId, marketplaceId: "ATVPDKIKX0DER", countryCode: "US", currencyCode: "USD" }]) : fallback,
  asins: () => [],
}) as unknown as AppConfig;
const siteMs = (date: string): number => Date.parse(`${date}T12:00:00Z`);
const inChunks = <T>(items: T[]): T[][] => { const output: T[][] = []; for (let offset = 0; offset < items.length; offset += 500) output.push(items.slice(offset, offset + 500)); return output; };
const emptyCatalog = { ads: async () => ({}) } as unknown as AmazonClient;
const later = (): number => Date.now() + 60_000;

// 内存版飞书多维表：批量写每块 ≤500、回执核对通过后才回调 onChunk；读出时文本转成富文本数组，与飞书 OpenAPI 一致。
class FakeBitable {
  private readonly tables = new Map<string, Map<string, Fields>>();
  private serial = 0;
  readonly calls: string[] = [];
  readonly failures: Failure[] = [];

  seed(table: string, rows: Fields[]): string[] { return rows.map((fields) => this.insert(table, fields)); }
  rows(table: string): Array<{ id: string; fields: Fields }> { return [...(this.tables.get(table) ?? new Map<string, Fields>()).entries()].map(([id, fields]) => ({ id, fields })); }
  keys(table: string): string[] { return this.rows(table).map((row) => String(row.fields["记录唯一键"] ?? "")); }
  writes(): string[] { return this.calls.filter((call) => !call.startsWith("list:")); }

  private insert(table: string, fields: Fields): string {
    const id = `rec${String(++this.serial).padStart(5, "0")}`;
    const stored: Fields = {};
    for (const [name, value] of Object.entries(fields)) if (value !== null && value !== undefined && value !== "") stored[name] = value;
    const rows = this.tables.get(table) ?? new Map<string, Fields>();
    rows.set(id, stored);
    this.tables.set(table, rows);
    return id;
  }

  private failure(op: Failure["op"], table: string): Failure | undefined {
    const index = this.failures.findIndex((item) => item.op === op && item.table === table);
    return index < 0 ? undefined : this.failures.splice(index, 1)[0];
  }

  client(): FeishuClient {
    const present = (fields: Fields): Fields => Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, typeof value === "string" ? [{ type: "text", text: value }] : value]));
    const refuse = (what: string) => async (): Promise<never> => { throw new Error(`广告批量发布不应${what}`); };
    return {
      listRecords: async (_app: string, table: string): Promise<FeishuRecord[]> => {
        this.calls.push(`list:${table}`);
        return this.rows(table).map((row) => ({ record_id: row.id, fields: present(row.fields) }));
      },
      batchCreate: async (_app: string, table: string, rows: Fields[], options: FeishuBatchOptions = {}): Promise<string[]> => {
        const ids: string[] = [];
        for (const [index, chunk] of inChunks(rows).entries()) {
          this.calls.push(`create:${table}:${chunk.length}`);
          const failure = this.failure("create", table);
          if (failure?.applied) for (const fields of chunk) this.insert(table, fields);
          if (failure) throw new Error("飞书批量创建回执与请求记录不一致。");
          for (const fields of chunk) ids.push(this.insert(table, fields));
          await options.onChunk?.(index * 500 + chunk.length);
        }
        return ids;
      },
      batchUpdate: async (_app: string, table: string, rows: Array<{ recordId: string; fields: Fields }>, options: FeishuBatchOptions = {}): Promise<void> => {
        for (const [index, chunk] of inChunks(rows).entries()) {
          this.calls.push(`update:${table}:${chunk.length}`);
          const apply = (): void => {
            for (const row of chunk) {
              const stored = this.tables.get(table)?.get(row.recordId);
              if (!stored) throw new Error(`RecordIdNotFound ${row.recordId}`);
              for (const [name, value] of Object.entries(row.fields)) {
                if (value === undefined) continue;
                if (value === null || value === "") delete stored[name]; else stored[name] = value;
              }
            }
          };
          const failure = this.failure("update", table);
          if (failure?.applied) apply();
          if (failure) throw new Error("飞书批量更新回执与请求记录不一致。");
          apply();
          await options.onChunk?.(index * 500 + chunk.length);
        }
      },
      batchDelete: refuse("删除飞书记录"),
      searchRecords: refuse("逐条搜索飞书"),
      upsert: refuse("逐条 upsert"),
      update: refuse("逐条更新"),
      delete: refuse("逐条删除"),
      request: refuse("直接调用飞书 request"),
    } as unknown as FeishuClient;
  }
}

function memoryState(initial: Record<string, Record<string, unknown>> = {}) {
  const tasks = new Map(Object.entries(initial));
  const items = new Map<string, Record<string, unknown>>();
  const puts: Array<Record<string, unknown>> = [];
  const state = {
    task: async (_type: string, id: string) => tasks.get(id),
    saveTask: async (_type: string, id: string, value: JsonObject, status: string, nextAt?: string) => { tasks.set(id, { sk: id, status, state: structuredClone(value), ...(nextAt ? { nextAt } : {}) }); },
    get: async (pk: string, sk: string) => items.get(`${pk}|${sk}`),
    put: async (item: Record<string, unknown>) => { puts.push(item); items.set(`${String(item.pk)}|${String(item.sk)}`, item); },
  } as unknown as StateStore;
  const jobsOf = (id: string): Array<Record<string, unknown>> => ((tasks.get(id)?.state as { jobs?: Array<Record<string, unknown>> } | undefined)?.jobs ?? []);
  return { state, tasks, items, puts, jobsOf };
}

function scheduleSpy() {
  const calls: Array<{ event: JobEvent; delay: number }> = [];
  const schedule = async (event: JobEvent, when: Date): Promise<string> => { calls.push({ event, delay: when.getTime() - Date.now() }); return "schedule"; };
  return { calls, schedule };
}

test("活动日报与总览按日期分块批量写入：回执不一致不推进游标，重跑幂等且不重复创建", async () => {
  const profileId = "P_BATCH_CAMPAIGN";
  const config = configFor(profileId);
  const bitable = new FakeBitable();
  const feishu = bitable.client();
  bitable.seed("overview", [{ "记录唯一键": `${profileId}|2026-09-21`, "站点日期": siteMs("2026-09-21"), "总销售额": 100, "总订单": 10, "总销量": 12 }]);
  bitable.seed("campaign", [{ "记录唯一键": `${profileId}|2026-09-21|C1`, "站点日期": siteMs("2026-09-21"), "活动ID": "C1", "花费": 1, "SKU编号": "SKU-KEEP" }]);
  const data = [
    { date: "2026-09-21", campaignId: "C1", campaignName: "Camp 1", campaignStatus: "ENABLED", campaignBudgetAmount: 20, impressions: 100, clicks: 10, cost: 5, sales7d: 20, purchases7d: 2, unitsSoldClicks7d: 2 },
    { date: "2026-09-21", campaignId: "C2", campaignName: "Camp 2", campaignStatus: "ENABLED", campaignBudgetAmount: 10, impressions: 50, clicks: 5, cost: 2, sales7d: 0, purchases7d: 0, unitsSoldClicks7d: 0 },
    { date: "2026-09-22", campaignId: "C1", campaignName: "Camp 1", campaignStatus: "ENABLED", campaignBudgetAmount: 20, impressions: 200, clicks: 20, cost: 9, sales7d: 30, purchases7d: 3, unitsSoldClicks7d: 3 },
  ];
  const job: Job = { key: "campaign", kind: "campaign", profileId, startDate: "2026-09-21", endDate: "2026-09-22", status: "PUBLISHING", attempts: 1 };
  const cursors: number[] = [];
  const checkpoint = async (): Promise<void> => { cursors.push(job.publishCursor ?? 0); };

  bitable.failures.push({ op: "create", table: "campaign", applied: true });
  await assert.rejects(processReport(job, data, new AdsRun(config, emptyCatalog, feishu, later(), checkpoint)), /回执与请求记录不一致/);
  assert.equal(job.publishCursor, undefined);
  assert.deepEqual(cursors, []);

  assert.equal(await processReport(job, data, new AdsRun(config, emptyCatalog, feishu, later(), checkpoint)), true);
  assert.equal(job.publishCursor, 2);
  assert.deepEqual(cursors, [2]);
  assert.deepEqual(bitable.keys("campaign").sort(), [`${profileId}|2026-09-21|C1`, `${profileId}|2026-09-21|C2`, `${profileId}|2026-09-22|C1`]);
  const first = bitable.rows("campaign").find((row) => row.fields["记录唯一键"] === `${profileId}|2026-09-21|C1`)!.fields;
  assert.equal(first["花费"], 5);
  assert.equal(first["ACOS"], 0.25);
  assert.equal(first["站点日期"], siteMs("2026-09-21"));
  assert.equal(Object.hasOwn(first, "数据新鲜度"), false, "活动日报不再写恒为“完整”的数据新鲜度（总览表照写）");
  assert.equal(first["SKU编号"], "SKU-KEEP");
  const overview = new Map(bitable.rows("overview").map((row) => [row.fields["记录唯一键"], row.fields]));
  assert.equal(overview.size, 2);
  assert.equal(overview.get(`${profileId}|2026-09-21`)?.["数据新鲜度"], "完整");
  assert.equal(overview.get(`${profileId}|2026-09-21`)?.["自然订单（估算）"], 8);
  assert.equal(overview.get(`${profileId}|2026-09-21`)?.["总销售额"], 100);
  assert.equal(overview.get(`${profileId}|2026-09-22`)?.["数据新鲜度"], "广告报表已完成，等待总销售");
  assert.equal(Object.hasOwn(overview.get(`${profileId}|2026-09-22`) ?? {}, "总销售额"), false);

  const writes = bitable.writes().length;
  job.publishCursor = 0;
  assert.equal(await processReport(job, data, new AdsRun(config, emptyCatalog, feishu, later(), checkpoint)), true);
  assert.equal(bitable.writes().length, writes);
  assert.equal(bitable.rows("campaign").length, 3);
});

test("活动日报只写盈亏平衡ACOS（即毛利率）不再另写「毛利率」，清货按毛利率 < 10%；旧断点里的 placement 与 salesSku30 任务直接记完成、不再请求", async () => {
  const profileId = "P_FIELD_CLEANUP";
  const bitable = new FakeBitable();
  bitable.seed("skus", [{ "SKU编号": "SKU-1", "SKU名称": "火箭玩具" }, { "SKU编号": "SKU-2", "SKU名称": "跳舞机器人" }]);
  bitable.seed("profits", [{ "SKU编号": "SKU-1", "毛利率": 0.3 }, { "SKU编号": "SKU-2", "毛利率": 0.18 }]);
  const job: Job = { key: "adv", kind: "advertisedProduct", profileId, startDate: "2026-09-21", endDate: "2026-09-21", status: "PUBLISHING", attempts: 1 };
  const data = [
    { date: "2026-09-21", campaignId: "C1", adGroupId: "G1", adId: "A1", advertisedSku: "SKU-1", advertisedAsin: "B0TEST0001", impressions: 100, clicks: 10, cost: 2, sales7d: 10, purchases7d: 1, unitsSoldClicks7d: 1 },
    { date: "2026-09-21", campaignId: "C2", adGroupId: "G2", adId: "A2", advertisedSku: "SKU-2", advertisedAsin: "B0TEST0002", impressions: 100, clicks: 10, cost: 2, sales7d: 10, purchases7d: 1, unitsSoldClicks7d: 1 },
  ];
  assert.equal(await processReport(job, data, new AdsRun(configFor(profileId), emptyCatalog, bitable.client(), later())), true);
  const row = bitable.rows("campaign").find((item) => item.fields["记录唯一键"] === `${profileId}|2026-09-21|C1`)!.fields;
  assert.equal(row["盈亏平衡ACOS"], 0.3);
  assert.equal(Number(row["目标ACOS"]).toFixed(2), "0.20");
  assert.equal(Object.hasOwn(row, "毛利率"), false);
  assert.equal(bitable.rows("campaign").find((item) => item.fields["记录唯一键"] === `${profileId}|2026-09-21|C2`)!.fields["清货"], "否", "毛利率 18% 不再算清货");

  const taskId = "ads-daily|2026-10-06T02:00:00Z";
  const { state, jobsOf } = memoryState({ [taskId]: { status: "waiting_report", state: { mode: "DAILY", jobs: [
    { key: "p", kind: "placement", profileId, startDate: "2026-09-23", endDate: "2026-10-05", reportId: "rp", status: "PENDING", attempts: 1 },
    { key: "k", kind: "salesSku30", profileId, startDate: "2026-09-06", endDate: "2026-10-05", sku: "SKU-1", status: "NEW", attempts: 0 },
    { key: "c", kind: "campaign", profileId, startDate: "2026-09-23", endDate: "2026-10-05", status: "DONE", attempts: 1, publishComplete: true },
  ] } } });
  const calls: string[] = [];
  const amazon = { ads: async (path: string) => { calls.push(path); return {}; }, sp: async () => { throw new Error("不应再查逐 SKU 客单价"); } } as unknown as AmazonClient;
  const result = await runAdsReports({ taskType: "ads-continue", taskId, scheduledAt: "2026-10-06T02:00:00Z", cursor: { mode: "DAILY" } }, "DAILY", configFor(profileId), state, amazon, new FakeBitable().client(), scheduleSpy().schedule);
  assert.equal(result.status, "done");
  assert.deepEqual(calls.filter((path) => path.startsWith("/reporting")), [], "不查询也不新建 placement 报表");
  assert.deepEqual(jobsOf(taskId).map((item) => [item.kind, item.status]), [["placement", "DONE"], ["salesSku30", "DONE"], ["campaign", "DONE"]]);
});

test("报表 FAILURE 清空 reportId 回到 NEW 自动重建，累计 3 次才报错；只等报表时 5 分钟续跑", async () => {
  const profileId = "P_REPORT_FAILURE";
  const created: string[] = [];
  const amazon = {
    ads: async (path: string, init: { method?: string } = {}) => {
      if (path === "/reporting/reports" && init.method === "POST") { const id = `r${created.length + 2}`; created.push(id); return { reportId: id }; }
      if (path.startsWith("/reporting/reports/")) return { status: "FAILURE" };
      return {};
    },
  } as unknown as AmazonClient;
  const taskId = "ads-daily|2026-09-26T02:00:00Z";
  const { state, jobsOf, tasks } = memoryState({ [taskId]: { status: "waiting_report", state: { mode: "DAILY", jobs: [{ key: "c", kind: "campaign", profileId, startDate: "2026-09-12", endDate: "2026-09-25", reportId: "r1", status: "PENDING", attempts: 1 }] } } });
  const spy = scheduleSpy();
  const event: JobEvent = { taskType: "ads-continue", taskId, scheduledAt: "2026-09-26T02:00:00Z", cursor: { mode: "DAILY" } };
  const run = () => runAdsReports(event, "DAILY", configFor(profileId), state, amazon, {} as FeishuClient, spy.schedule);

  assert.equal((await run()).status, "waiting_report");
  assert.deepEqual([jobsOf(taskId)[0]?.failures, jobsOf(taskId)[0]?.reportId, jobsOf(taskId)[0]?.status], [1, "r2", "PENDING"]);
  assert.equal(spy.calls.length, 1);
  assert.deepEqual(spy.calls[0]!.event, { taskType: "ads-continue", taskId, scheduledAt: "2026-09-26T02:00:00Z", cursor: { mode: "DAILY" } });
  assert.ok(spy.calls[0]!.delay > 290_000 && spy.calls[0]!.delay <= 300_000);
  assert.ok(typeof tasks.get(taskId)?.nextAt === "string");

  await run();
  assert.deepEqual([jobsOf(taskId)[0]?.failures, jobsOf(taskId)[0]?.reportId], [2, "r3"]);
  await assert.rejects(run(), /已累计 3 次/);
  assert.equal(jobsOf(taskId)[0]?.failures, 3);
  assert.deepEqual(created, ["r2", "r3"]);
  assert.equal(spy.calls.length, 2);
});

test("续跑间隔：只等待亚马逊生成报表时 5 分钟，有可立即处理的工作时 60 秒", () => {
  const plan = (): Parameters<typeof adsContinueDelayMs>[0] => [
    { key: "c", kind: "campaign", profileId: "P1", startDate: "2026-09-12", endDate: "2026-09-25", reportId: "r1", status: "PROCESSING", attempts: 1 },
    { key: "t", kind: "targeting", profileId: "P1", startDate: "2026-08-27", endDate: "2026-09-25", reportId: "r2", status: "PENDING", attempts: 1 },
    { key: "s", kind: "searchTerm", profileId: "P1", startDate: "2026-08-27", endDate: "2026-09-25", status: "DONE", attempts: 3 },
    { key: "k", kind: "skuSales", profileId: "P1", startDate: "2026-08-27", endDate: "2026-09-25", sku: "SKU-1", status: "DONE", attempts: 1 },
    { key: "d", kind: "sales", profileId: "P1", startDate: "2026-09-25", endDate: "2026-09-25", status: "DONE", attempts: 1 },
  ];
  assert.equal(adsContinueDelayMs(plan()), 300_000);
  const publishing = plan(); publishing[0]!.status = "PUBLISHING";
  const rebuilt = plan(); delete rebuilt[0]!.reportId; rebuilt[0]!.status = "NEW";
  const skuSales = plan(); skuSales[3]!.status = "NEW";
  const sales = plan(); sales[4]!.status = "NEW";
  for (const jobs of [publishing, rebuilt, skuSales, sales]) assert.equal(adsContinueDelayMs(jobs), 60_000);
});

test("DAILY：逐 SKU 每日销售与投放报表存进快照（不写飞书），全部完成才存目录、更新指针并排一次跑飞排查", async () => {
  const profileId = "P_SNAPSHOT";
  const report = [
    { date: "2026-09-24", keywordId: "K1", keyword: "rocket", matchType: "EXACT", keywordBid: 0.8, campaignId: "C1", adGroupId: "G1", impressions: 10, clicks: 2, cost: 1.2, sales7d: 0, purchases7d: 0 },
    { date: "2026-09-25", keywordId: "K1", keyword: "rocket", matchType: "EXACT", keywordBid: 0.9, campaignId: "C1", adGroupId: "G1", impressions: 20, clicks: 3, cost: 2.1, sales7d: 15, purchases7d: 1 },
  ];
  let reportStatus = "PENDING";
  const spQueries: Array<Record<string, unknown>> = [];
  const amazon = {
    ads: async (path: string) => path === "/reporting/reports/rt" ? { status: reportStatus, url: "https://example.invalid/report.json.gz" }
      : path === "/sp/campaigns/list" ? { campaigns: [{ campaignId: "C1", name: "Camp 1", state: "ENABLED", targetingType: "MANUAL", budget: { budget: 20, budgetType: "DAILY" }, dynamicBidding: { strategy: "LEGACY_FOR_SALES", placementBidding: [{ placement: "PLACEMENT_TOP", percentage: 30 }] } }] }
      : path === "/sp/productAds/list" ? { productAds: [{ adId: "A1", campaignId: "C1", adGroupId: "G1", sku: "SKU-1", asin: "B0TEST0001", state: "ENABLED" }] } : {},
    adsDownload: async () => gzipSync(JSON.stringify(report)),
    sp: async (_path: string, init: { query: Record<string, unknown> }) => { spQueries.push(init.query); return { payload: [{ interval: "2026-09-25T00:00-07:00--2026-09-26T00:00-07:00", orderCount: 2, unitCount: 3, totalSales: { amount: 40 } }] }; },
  } as unknown as AmazonClient;
  const taskId = "ads-daily|2026-09-26T02:00:00Z";
  const { state, jobsOf, tasks, items, puts } = memoryState({ [taskId]: { status: "waiting_report", state: { mode: "DAILY", jobs: [
    { key: "t", kind: "targeting", profileId, startDate: "2026-08-27", endDate: "2026-09-25", reportId: "rt", status: "PENDING", attempts: 1 },
    { key: "k", kind: "skuSales", profileId, startDate: "2026-08-27", endDate: "2026-09-25", sku: "SKU-1", asin: "B0TEST0001", status: "NEW", attempts: 0 },
  ] } } });
  const spy = scheduleSpy();
  const bitable = new FakeBitable();
  const run = () => runAdsReports({ taskType: "ads-continue", taskId, scheduledAt: "2026-09-26T02:00:00Z", cursor: { mode: "DAILY" } }, "DAILY", configFor(profileId), state, amazon, bitable.client(), spy.schedule);

  assert.equal((await run()).status, "waiting_report");
  assert.deepEqual(spQueries.map((query) => [query.sku, query.granularity]), [["SKU-1", "Day"]], "逐 SKU 销售不再等投放报表");
  assert.deepEqual(jobsOf(taskId).map((job) => job.status), ["PENDING", "DONE"]);
  assert.ok(items.has("ADS_SNAPSHOT|2026-09-25|P_SNAPSHOT|skuSales:SKU-1|000"));
  assert.equal(items.has("ADS_LATEST_DAILY|ALL"), false);
  assert.deepEqual(spy.calls.map((call) => call.event.taskType), ["ads-continue"]);

  reportStatus = "COMPLETED";
  assert.equal((await run()).status, "done");
  assert.equal(tasks.get(taskId)?.status, "done");
  assert.deepEqual(bitable.writes(), [], "投放报表不写飞书");
  const parts = puts.filter((item) => item.pk === "ADS_SNAPSHOT").map((item) => item.part);
  assert.deepEqual(parts, ["skuSales:SKU-1", "targets", "catalog"]);
  assert.deepEqual([items.get("ADS_LATEST_DAILY|ALL")?.taskId, items.get("ADS_LATEST_DAILY|ALL")?.siteDate], [taskId, "2026-09-25"]);
  const runaway = spy.calls.filter((call) => call.event.taskType === "ads-runaway");
  assert.deepEqual(runaway.map((call) => call.event), [{ taskType: "ads-runaway", taskId: "ads-runaway|2026-09-25", scheduledAt: "2026-09-25T12:00:00.000Z" }]);
  assert.ok(runaway[0]!.delay > 50_000 && runaway[0]!.delay <= 60_000);
});

test("DAILY 完成才写 ADS_LATEST_DAILY 指针并排跑飞；较旧批次不回退指针、不排跑飞，EARLY 都不做", async () => {
  const profileId = "P_POINTER";
  const done = (endDate: string) => [{ key: "c", kind: "campaign", profileId, startDate: "2026-09-12", endDate, status: "DONE", attempts: 1, publishComplete: true }];
  const { state, items, tasks } = memoryState({
    "ads-daily|new": { state: { mode: "DAILY", jobs: done("2026-09-25") } },
    "ads-daily|old": { state: { mode: "DAILY", jobs: done("2026-09-24") } },
    "ads-early|x": { state: { mode: "EARLY", jobs: done("2026-09-26") } },
  });
  const spy = scheduleSpy();
  const call = (taskType: string, taskId: string, mode: "EARLY" | "DAILY") => runAdsReports({ taskType, taskId }, mode, configFor(profileId), state, emptyCatalog, {} as FeishuClient, spy.schedule);
  assert.equal((await call("ads-daily", "ads-daily|new", "DAILY")).status, "done");
  assert.deepEqual([items.get("ADS_LATEST_DAILY|ALL")?.taskId, items.get("ADS_LATEST_DAILY|ALL")?.siteDate], ["ads-daily|new", "2026-09-25"]);
  assert.equal(tasks.get("ads-daily|new")?.status, "done");
  assert.equal(tasks.get("ads-daily|new")?.nextAt, undefined);
  await call("ads-continue", "ads-daily|old", "DAILY");
  await call("ads-early", "ads-early|x", "EARLY");
  assert.equal(items.get("ADS_LATEST_DAILY|ALL")?.taskId, "ads-daily|new");
  assert.deepEqual(spy.calls.map((item) => item.event.taskId), ["ads-runaway|2026-09-25"]);
  assert.equal(items.has("ADS_SNAPSHOT|2026-09-26|P_POINTER|catalog|000"), false, "EARLY 不存目录");
});
