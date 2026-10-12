import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import type { AppConfig, FeishuRecord, JsonObject } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import type { StateStore } from "../../src/state.js";
import {
  type AdsSnapshot, type DaySeries, catalogSnapshot, deliveringSkus, loadSnapshot, loadSnapshotParts, placementCode, saveSnapshotPart, sumSeries, targetSeries,
} from "../../src/business/ads-snapshot.js";
import { findRunaways, runAdsRunaway, runawayPeriod } from "../../src/business/ads-runaway.js";
import { buildReviewPack, inventoryPack, parseMemoryInput, runAdsMemory, runAdsReview } from "../../src/business/ads-review.js";
import type { SkuInventoryHealth } from "../../src/business/inventory-health.js";
import { compactSqp, saveSqpWeek, type SqpWeek } from "../../src/business/sqp.js";
import { loadSkuRegistry } from "../../src/business/ads.js";
import { runJob } from "../../src/business/jobs.js";
import { HEALTH_RULES } from "../../src/business/maintenance.js";
import { healthTaskType, storedResult } from "../../src/handlers/jobs.js";

type Row = Record<string, unknown>;
const siteMs = (date: string): number => Date.parse(`${date}T12:00:00Z`);

// ---------- 内存版状态表（含通知意图） ----------
class MemoryState {
  readonly items = new Map<string, Row>();
  readonly order: string[] = [];
  get = async (pk: string, sk: string): Promise<Row | undefined> => this.items.get(`${pk}|${sk}`);
  put = async (item: Row): Promise<void> => { this.order.push(`put:${String(item.pk)}`); this.items.set(`${String(item.pk)}|${String(item.sk)}`, structuredClone(item)); };
  queryPartition = async (pk: string, options: { beginsWith?: string } = {}): Promise<Row[]> => [...this.items.values()].filter((item) => item.pk === pk && String(item.sk).startsWith(options.beginsWith ?? "")).sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
  saveNotification = async (eventKey: string, lines: string[], recipients: string[]): Promise<void> => {
    const existing = this.items.get(`NOTIFICATION|${eventKey}`);
    if (existing?.status === "done") return;
    this.order.push(`notification:${eventKey}`);
    this.items.set(`NOTIFICATION|${eventKey}`, { pk: "NOTIFICATION", sk: eventKey, status: "pending", lines, recipients, delivered: {}, createdAt: new Date().toISOString() });
  };
  notification = async (eventKey: string): Promise<Row | undefined> => this.items.get(`NOTIFICATION|${eventKey}`);
  markRecipient = async (eventKey: string, recipient: string): Promise<void> => { ((this.items.get(`NOTIFICATION|${eventKey}`)!.delivered) as Row)[recipient] = true; };
  completeNotification = async (eventKey: string): Promise<void> => { this.items.get(`NOTIFICATION|${eventKey}`)!.status = "done"; };
  store(): StateStore { return this as unknown as StateStore; }
}

// ---------- 内存版飞书：支持 searchRecords 的 is / isGreater（日期 ExactDate）、批量写、发消息 ----------
class MemoryFeishu {
  readonly tables = new Map<string, Map<string, Row>>();
  readonly sent: string[][] = [];
  readonly writes: string[] = [];
  private serial = 0;
  constructor(private readonly onWrite: (table: string) => void = () => {}) {}
  seed(table: string, rows: Row[]): string[] { return rows.map((fields) => this.insert(table, fields)); }
  rows(table: string): Array<{ id: string; fields: Row }> { return [...(this.tables.get(table) ?? new Map<string, Row>()).entries()].map(([id, fields]) => ({ id, fields })); }
  private insert(table: string, fields: Row): string {
    const id = `rec${++this.serial}`;
    const rows = this.tables.get(table) ?? new Map<string, Row>();
    rows.set(id, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined && value !== "")));
    this.tables.set(table, rows);
    return id;
  }
  client(): FeishuClient {
    const present = (fields: Row): Row => Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, typeof value === "string" ? [{ type: "text", text: value }] : value]));
    const matches = (fields: Row, condition: { field_name: string; operator: string; value: string[] }): boolean => {
      const value = fields[condition.field_name];
      const wanted = condition.value[0] === "ExactDate" ? Number(condition.value[1]) : condition.value[0];
      if (condition.operator === "is") return typeof wanted === "number" ? value === wanted : String(value ?? "") === wanted;
      if (condition.operator === "isGreater") return Number(value) > Number(wanted);
      throw new Error(`未支持的条件 ${condition.operator}`);
    };
    return {
      listRecords: async (_app: string, table: string): Promise<FeishuRecord[]> => this.rows(table).map((row) => ({ record_id: row.id, fields: present(row.fields) })),
      searchRecords: async (_app: string, table: string, equals: Record<string, string>, options: { conditions?: Array<{ field_name: string; operator: string; value: string[] }> } = {}): Promise<FeishuRecord[]> => {
        const conditions = [...Object.entries(equals).map(([field_name, value]) => ({ field_name, operator: "is", value: [value] })), ...(options.conditions ?? [])];
        return this.rows(table).filter((row) => conditions.every((condition) => matches(row.fields, condition))).map((row) => ({ record_id: row.id, fields: present(row.fields) }));
      },
      batchCreate: async (_app: string, table: string, rows: Row[]): Promise<string[]> => { this.onWrite(table); this.writes.push(`create:${table}:${rows.length}`); return rows.map((fields) => this.insert(table, fields)); },
      batchUpdate: async (_app: string, table: string, rows: Array<{ recordId: string; fields: Row }>): Promise<void> => {
        this.onWrite(table);
        this.writes.push(`update:${table}:${rows.length}`);
        for (const row of rows) {
          const stored = this.tables.get(table)?.get(row.recordId);
          if (!stored) throw new Error(`RecordIdNotFound ${row.recordId}`);
          for (const [name, value] of Object.entries(row.fields)) { if (value === null || value === "") delete stored[name]; else if (value !== undefined) stored[name] = value; }
        }
      },
      sendText: async (_user: string, lines: string[]): Promise<void> => { this.sent.push(lines); },
    } as unknown as FeishuClient;
  }
}

const TABLES: Record<string, string> = {
  FEISHU_BITABLE_APP_TOKEN_ORDERS: "app", FEISHU_BITABLE_TABLE_ID_ADS_ALERTS: "alerts", FEISHU_BITABLE_TABLE_ID_ADS_CHANGES: "changes", FEISHU_BITABLE_TABLE_ID_ADS_PROFILES: "profiles",
  FEISHU_BITABLE_TABLE_ID_SKUS: "skus", FEISHU_BITABLE_TABLE_ID_PROFIT_ESTIMATE: "profits", FEISHU_BITABLE_TABLE_ID_INVENTORY_ALERTS: "inventory",
};
// asins：SSM asin/ 的 SKU/ASIN 映射。
function configWith(options: Record<string, string> = {}, asins: Array<{ sku: string; asin: string }> = []): AppConfig {
  const values: Record<string, string> = { ADS_PROFILES_JSON: JSON.stringify([{ profileId: "P1", marketplaceId: "ATVPDKIKX0DER", countryCode: "US", currencyCode: "USD" }]), FEISHU_NOTIFY_USER_IDS: "u1", ...options };
  return {
    get: (key: string) => { const value = TABLES[key] ?? values[key]; if (!value) throw new Error(`缺少配置 ${key}`); return value; },
    optional: (key: string, fallback = "") => TABLES[key] ?? values[key] ?? fallback,
    bool: (key: string, fallback = false) => values[key] === undefined ? fallback : values[key] === "true",
    asins: () => asins.map((item) => ({ ...item, competitors: [], adMarker: "" })),
  } as unknown as AppConfig;
}

// ---------- 快照样例：窗口 10/07–10/09（洛杉矶），截止 10/09 ----------
const days = (entries: Array<[string, number, number, number?, number?]>): DaySeries => Object.fromEntries(entries.map(([date, clicks, spend, orders = 0, sales = 0]) => [date, [clicks * 10, clicks, spend, sales, orders, orders]]));
function sampleSnapshot(): AdsSnapshot {
  return {
    siteDate: "2026-10-09", profileId: "P1",
    catalog: {
      campaigns: [
        { campaignId: "C1", name: "SP-rocket-manual", state: "ENABLED", targetingType: "MANUAL", budget: 20, budgetType: "DAILY", strategy: "LEGACY_FOR_SALES", placements: { TOP: 30, REST: 0, PRODUCT: 10 }, startDate: "2026-08-01", skus: ["SKU-1"], asins: ["B0ROCKET01"] },
        { campaignId: "C2", name: "SP-rocket-auto", state: "ENABLED", targetingType: "AUTO", budget: 10, budgetType: "DAILY", strategy: "MANUAL", placements: {}, startDate: "2026-08-01", skus: ["SKU-1"], asins: ["B0ROCKET01"] },
        { campaignId: "C3", name: "SP-old", state: "PAUSED", targetingType: "MANUAL", budget: 5, budgetType: "DAILY", strategy: "MANUAL", placements: {}, startDate: "2026-07-01", skus: ["SKU-1"], asins: ["B0ROCKET01"] },
      ],
      adGroups: [
        { adGroupId: "G1", campaignId: "C1", name: "rocket-kw", state: "ENABLED", defaultBid: 0.5 },
        { adGroupId: "G2", campaignId: "C2", name: "rocket-auto", state: "ENABLED", defaultBid: 0.6 },
        { adGroupId: "G3", campaignId: "C3", name: "old", state: "ENABLED", defaultBid: 0.4 },
      ],
      targets: [
        { id: "K1", campaignId: "C1", adGroupId: "G1", state: "ENABLED", bid: 0.9, kind: "keyword", text: "rocket toy", matchType: "EXACT", expressionType: "" },
        { id: "K2", campaignId: "C1", adGroupId: "G1", state: "ENABLED", bid: 0.7, kind: "keyword", text: "toy", matchType: "BROAD", expressionType: "" },
        { id: "K3", campaignId: "C1", adGroupId: "G1", state: "PAUSED", bid: 0.8, kind: "keyword", text: "space toy", matchType: "PHRASE", expressionType: "" },
        { id: "K4", campaignId: "C3", adGroupId: "G3", state: "ENABLED", bid: 0.4, kind: "keyword", text: "old toy", matchType: "EXACT", expressionType: "" },
        { id: "K5", campaignId: "C1", adGroupId: "G1", state: "ENABLED", bid: 0.6, kind: "keyword", text: "kids rocket", matchType: "PHRASE", expressionType: "" },
        { id: "T1", campaignId: "C2", adGroupId: "G2", state: "ENABLED", bid: 0.6, kind: "target", text: "紧密匹配", matchType: "", expressionType: "AUTO" },
      ],
    },
    targets: {
      meta: [
        { id: "K1", campaignId: "C1", adGroupId: "G1", keyword: "rocket toy", targeting: "", keywordType: "EXACT", matchType: "EXACT", bid: 0.9 },
        { id: "K2", campaignId: "C1", adGroupId: "G1", keyword: "toy", targeting: "", keywordType: "BROAD", matchType: "BROAD", bid: 0.7 },
        { id: "K3", campaignId: "C1", adGroupId: "G1", keyword: "space toy", targeting: "", keywordType: "PHRASE", matchType: "PHRASE", bid: 0.8 },
        { id: "K4", campaignId: "C3", adGroupId: "G3", keyword: "old toy", targeting: "", keywordType: "EXACT", matchType: "EXACT", bid: 0.4 },
        { id: "K5", campaignId: "C1", adGroupId: "G1", keyword: "kids rocket", targeting: "", keywordType: "PHRASE", matchType: "PHRASE", bid: 0.6 },
        { id: "T1", campaignId: "C2", adGroupId: "G2", keyword: "", targeting: "close-match", keywordType: "TARGETING_EXPRESSION_PREDEFINED", matchType: "", bid: 0.6 },
      ],
      days: {
        K1: days([["2026-10-06", 30, 20, 3, 60], ["2026-10-07", 9, 7], ["2026-10-08", 8, 6.5], ["2026-10-09", 8, 6.3]]),
        K2: days([["2026-10-07", 15, 6, 1, 20], ["2026-10-08", 15, 6]]),
        K3: days([["2026-10-08", 40, 30]]),
        K4: days([["2026-10-08", 40, 30]]),
        K5: days([["2026-10-08", 19, 9]]),
        T1: days([["2026-10-08", 12, 5], ["2026-10-09", 10, 4]]),
      },
    },
    searchTerms: {
      meta: [
        { key: "s1", campaignId: "C1", adGroupId: "G1", keywordId: "K2", keyword: "toy", targeting: "", matchType: "BROAD", searchTerm: "toy for adults" },
        { key: "s2", campaignId: "C1", adGroupId: "G1", keywordId: "K1", keyword: "rocket toy", targeting: "", matchType: "EXACT", searchTerm: "Rocket  Toy" },
        { key: "s3", campaignId: "C2", adGroupId: "G2", keywordId: "T1", keyword: "", targeting: "close-match", matchType: "", searchTerm: "b0xyz12345" },
        { key: "s4", campaignId: "C2", adGroupId: "G2", keywordId: "T1", keyword: "", targeting: "close-match", matchType: "", searchTerm: "space rocket" },
        { key: "s5", campaignId: "C1", adGroupId: "G1", keywordId: "K1", keyword: "rocket toy", targeting: "", matchType: "EXACT", searchTerm: "rocket toys" },
      ],
      days: {
        s1: days([["2026-10-07", 10, 4], ["2026-10-08", 11, 4.4]]),
        s2: days([["2026-10-07", 25, 19.8]]),
        s3: days([["2026-10-08", 12, 5]]),
        s4: days([["2026-10-09", 10, 4]]),
        s5: days([["2026-10-08", 30, 12, 0, 0]]),
      },
    },
    placements: {
      meta: [{ key: "C1|TOP", campaignId: "C1", placement: "TOP" }, { key: "C1|REST", campaignId: "C1", placement: "REST" }],
      days: { "C1|TOP": days([["2026-10-08", 20, 15, 2, 50]]), "C1|REST": days([["2026-10-08", 30, 12]]) },
    },
    skuSales: { "SKU-1": { "2026-10-08": [100, 4, 5], "2026-10-09": [50, 2, 2] } },
  };
}

async function seedSnapshot(state: MemoryState, snapshot = sampleSnapshot()): Promise<void> {
  await saveSnapshotPart(state.store(), snapshot.siteDate, "P1", "targets", snapshot.targets);
  await saveSnapshotPart(state.store(), snapshot.siteDate, "P1", "searchTerms", snapshot.searchTerms);
  await saveSnapshotPart(state.store(), snapshot.siteDate, "P1", "placements", snapshot.placements);
  await saveSnapshotPart(state.store(), snapshot.siteDate, "P1", "catalog", snapshot.catalog);
  await saveSnapshotPart(state.store(), snapshot.siteDate, "P1", "skuSales:SKU-1", snapshot.skuSales["SKU-1"]);
  await state.put({ pk: "ADS_LATEST_DAILY", sk: "ALL", taskId: "ads-daily|x", siteDate: snapshot.siteDate });
}

test("快照：gzip 分片存取往返一致；000 号最后写、只认同版本分片，缺片明确失败", async () => {
  const state = new MemoryState();
  const big = { blob: randomBytes(400_000).toString("hex") };
  const chunks = await saveSnapshotPart(state.store(), "2026-10-09", "P1", "targets", big, 1_000);
  assert.ok(chunks >= 2);
  assert.deepEqual(state.order.slice(-1), ["put:ADS_SNAPSHOT"]);
  assert.equal(String([...state.items.keys()].filter((key) => key.startsWith("ADS_SNAPSHOT")).at(-1)).endsWith("|000"), true, "000 号最后写，作提交标记");
  assert.deepEqual((await loadSnapshotParts(state.store(), "2026-10-09", "P1", 2_000)).get("targets"), big);
  // 再存一份更小的新版本：旧版本多出来的分片被忽略
  await saveSnapshotPart(state.store(), "2026-10-09", "P1", "targets", { small: true }, 3_000);
  assert.deepEqual((await loadSnapshotParts(state.store(), "2026-10-09", "P1", 4_000)).get("targets"), { small: true });
  // 缺片：删掉新大版本的一个分片
  await saveSnapshotPart(state.store(), "2026-10-09", "P1", "catalog", big, 5_000);
  state.items.delete("ADS_SNAPSHOT|2026-10-09|P1|catalog|001");
  await assert.rejects(loadSnapshotParts(state.store(), "2026-10-09", "P1", 6_000), /分片 1 不完整/);
  await assert.rejects(loadSnapshot(new MemoryState().store(), "2026-10-09", "P1"), /缺少 targets/);
  // 广告位可缺（发布前开跑的旧计划批次没有广告位报表）
  const partial = new MemoryState();
  for (const part of ["targets", "searchTerms"]) await saveSnapshotPart(partial.store(), "2026-10-09", "P1", part, { meta: [], days: {} });
  await saveSnapshotPart(partial.store(), "2026-10-09", "P1", "catalog", { campaigns: [], adGroups: [], targets: [] });
  assert.deepEqual((await loadSnapshot(partial.store(), "2026-10-09", "P1")).placements, { meta: [], days: {} });
});

test("快照构建：投放取最新日 bid、同日累加、零日不存；广告位代码与目录（位置加价、预算、竞价策略、SKU、已归档排除、出价回落默认）", () => {
  const series = targetSeries([
    { date: "2026-10-08", keywordId: "K1", keywordBid: 0.8, clicks: 2, cost: 1.1, impressions: 20 },
    { date: "2026-10-09", keywordId: "K1", keywordBid: 0.9, clicks: 1, cost: 0.55, impressions: 5 },
    { date: "2026-10-09", keywordId: "K1", keywordBid: 0.9, clicks: 1, cost: 0.55, impressions: 5 },
    { date: "2026-10-07", keywordId: "K1", keywordBid: 0.7, clicks: 0, cost: 0, impressions: 0 },
  ]);
  assert.equal(series.meta[0]!.bid, 0.9);
  assert.deepEqual(series.days.K1, { "2026-10-08": [20, 2, 1.1, 0, 0, 0], "2026-10-09": [10, 2, 1.1, 0, 0, 0] });
  assert.deepEqual(["Top of Search on-Amazon", "Other on-Amazon", "Detail Page on-Amazon", "Off Amazon", "PLACEMENT_REST_OF_SEARCH"].map(placementCode), ["TOP", "REST", "PRODUCT", "OFF", "REST"]);
  const catalog = catalogSnapshot({
    campaigns: [{ campaignId: "C1", name: "A", state: "ENABLED", targetingType: "manual", budget: { budget: 15, budgetType: "DAILY" }, dynamicBidding: { strategy: "AUTO_FOR_SALES", placementBidding: [{ placement: "PLACEMENT_TOP", percentage: 50 }, { placement: "PLACEMENT_PRODUCT_PAGE", percentage: 10 }] } }, { campaignId: "C9", state: "ARCHIVED" }],
    adGroups: [{ adGroupId: "G1", campaignId: "C1", name: "g", state: "ENABLED", defaultBid: 0.45 }],
    keywords: [{ keywordId: "K1", campaignId: "C1", adGroupId: "G1", state: "ENABLED", keywordText: "rocket", matchType: "exact" }, { keywordId: "K9", campaignId: "C9", adGroupId: "G9", state: "ENABLED" }],
    targets: [{ targetId: "T1", campaignId: "C1", adGroupId: "G1", state: "PAUSED", bid: 0.3, expressionType: "MANUAL", expression: [{ type: "ASIN_SAME_AS", value: "B0TEST" }] }],
    productAds: [{ adId: "A1", campaignId: "C1", adGroupId: "G1", sku: "SKU-1", asin: "B0ROCKET01", state: "ENABLED" }],
  });
  assert.deepEqual(catalog.campaigns.map((item) => [item.campaignId, item.budget, item.strategy, item.placements, item.skus, item.targetingType]), [["C1", 15, "AUTO_FOR_SALES", { TOP: 50, PRODUCT: 10 }, ["SKU-1"], "MANUAL"]]);
  assert.deepEqual(catalog.targets.map((item) => [item.id, item.bid, item.matchType, item.text, item.state]), [["K1", 0.45, "EXACT", "rocket", "ENABLED"], ["T1", 0.3, "", "ASIN B0TEST", "PAUSED"]]);
  assert.deepEqual(catalog.adGroups.map((item) => [item.adGroupId, item.skus, item.allSkus]), [["G1", ["SKU-1"], ["SKU-1"]]]);
});

test("跑飞判定：启用中、窗口内点击≥阈值且 0 单；暂停的、暂停活动里的、未到阈值的、窗口外的不报；搜索词单列且不与精准原词重复", () => {
  const items = findRunaways(sampleSnapshot(), "2026-10-07", "2026-10-09", 20);
  assert.deepEqual(items.map((item) => [item.kind, item.objectId, item.category, item.clicks, item.spend]), [
    ["target", "K1", "关键词", 25, 19.8], ["target", "T1", "自动投放", 22, 9], ["term", "s1", "搜索词", 21, 8.4],
  ], "按花费从高到低");
  const k1 = items.find((item) => item.objectId === "K1")!;
  assert.deepEqual([k1.sku, k1.campaignName, k1.adGroupName, k1.matchType, k1.bid, k1.spend, k1.key], ["SKU-1", "SP-rocket-manual", "rocket-kw", "精准", 0.9, 19.8, "P1|2026-10-09|target|K1"]);
  assert.deepEqual(k1.topTerms, [{ term: "rocket toys", clicks: 30 }, { term: "Rocket  Toy", clicks: 25 }], "跑飞投放附上点击最多的搜索词");
  assert.equal(items.some((item) => item.objectName === "rocket toys"), false, "所属投放已跑飞的搜索词不单列");
  const t1 = items.find((item) => item.objectId === "T1")!;
  assert.deepEqual([t1.objectName, t1.matchType, t1.topTerms.map((term) => term.term)], ["紧密匹配", "", ["b0xyz12345", "space rocket"]]);
  const higher = findRunaways(sampleSnapshot(), "2026-10-07", "2026-10-09", 26);
  assert.deepEqual(higher.map((item) => [item.kind, item.objectName, item.clicks]), [["term", "rocket toys", 30]], "所属投放未达阈值时，达阈值的搜索词单列");
  assert.equal(findRunaways(sampleSnapshot(), "2026-10-07", "2026-10-09", 31).length, 0);
  assert.deepEqual([runawayPeriod("2026-10-06", "2026-10-08"), runawayPeriod("2026-10-06", "2026-10-09"), runawayPeriod("2026-10-06", "2026-10-15")], [0, 1, 3]);
});

test("跑飞排查：以最新已执行调整为锚点每 3 天一期；未到期不写不发；到期先持久化通知再写预警表；同一期不重复；用户改过的状态不覆盖；下一期标注上一期也跑飞", async () => {
  const state = new MemoryState();
  await seedSnapshot(state);
  const feishu = new MemoryFeishu((table) => { if (table === "alerts") assert.ok(state.items.get("NOTIFICATION|ads-runaway|2026-10-09"), "写预警表前已持久化通知意图"); });
  const config = configWith();
  feishu.seed("changes", [{ "调整日期": siteMs("2026-10-08"), "执行情况": "未采纳" }, { "调整日期": siteMs("2026-10-07"), "执行情况": "已执行" }]);
  const run = (cursor: JsonObject = {}, dryRun = false) => runAdsRunaway({ taskType: "ads-runaway", cursor, ...(dryRun ? { dryRun } : {}) }, config, state.store(), feishu.client());

  const early = await run();
  assert.deepEqual([early.result, early.anchor, early.period], ["not_due", "2026-10-07", 0], "未采纳不移动锚点；10/07 锚点到 10/09 只过 2 天");
  assert.equal(feishu.writes.length, 0);

  const preview = await run({ force: true }, true);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.flagged, 3);
  assert.equal(feishu.writes.length, 0);
  assert.equal(state.items.has("ADS_RUNAWAY|state"), false);

  feishu.tables.get("changes")!.clear();
  feishu.seed("changes", [{ "调整日期": siteMs("2026-10-06"), "执行情况": "部分执行" }]);
  const due = await run();
  assert.deepEqual([due.due, due.period, due.flagged, due.created, due.notification], [true, 1, 3, 3, "sent"]);
  assert.equal(feishu.sent.length, 1);
  assert.match(feishu.sent[0]![0]!, /^🚨 关键词跑飞 10\/07–10\/09（洛杉矶，3 天点击≥20、0 单）$/);
  assert.match(feishu.sent[0]![1]!, /^• SKU-1｜SP-rocket-manual｜rocket toy（精准）｜点击 25｜\$19\.80｜bid \$0\.90｜搜索词：rocket toys 30、Rocket {2}Toy 25$/);
  assert.ok(feishu.sent[0]!.some((line) => line.includes("搜索词 toy for adults")));
  const alerts = feishu.rows("alerts");
  assert.deepEqual(alerts.map((row) => row.fields["状态"]), ["待处理", "待处理", "待处理"]);
  const k1Row = alerts.find((row) => row.fields["对象ID"] === "K1")!.fields;
  assert.deepEqual([k1Row["检查日期"], k1Row["统计区间"], k1Row["3日点击"], k1Row["3日花费"], k1Row["当前bid"], k1Row["类别"], k1Row["匹配类型"]], [siteMs("2026-10-09"), "10/07–10/09", 25, 19.8, 0.9, "关键词", "精准"]);
  assert.equal(state.items.get("ADS_RUNAWAY|state")?.period, 1);

  const again = await run();
  assert.equal(again.result, "not_due", "同一期不重复");
  feishu.tables.get("alerts")!.get(alerts[0]!.id)!["状态"] = "已处理";
  const forced = await run({ force: true });
  assert.deepEqual([forced.due, forced.created, forced.updated], [false, 0, 3]);
  assert.equal(feishu.tables.get("alerts")!.get(alerts[0]!.id)!["状态"], "已处理", "重跑不覆盖用户改过的状态");
  assert.ok(state.items.has("NOTIFICATION|ads-runaway|2026-10-09|manual"), "强制重查用单独的通知键");
  assert.equal(state.items.get("ADS_RUNAWAY|state")?.period, 1);

  // 下一期（截止 10/12）同一关键词仍跑飞：消息标注上一期
  const next = sampleSnapshot();
  next.siteDate = "2026-10-12";
  next.targets.days.K1 = days([["2026-10-11", 21, 15]]);
  next.targets.days.K2 = {}; next.targets.days.T1 = {}; next.searchTerms.days = {};
  await seedSnapshot(state, next);
  const second = await run();
  assert.deepEqual([second.period, second.flagged], [2, 1]);
  assert.match(feishu.sent.at(-1)![1]!, /（上一期 10\/09 也跑飞）$/);
});

test("跑飞排查：没有调整记录时用配置锚点；关闭开关时不写不发", async () => {
  const state = new MemoryState();
  await seedSnapshot(state);
  const feishu = new MemoryFeishu();
  const result = await runAdsRunaway({ taskType: "ads-runaway" }, configWith({ ADS_RUNAWAY_ANCHOR: "2026-10-06" }), state.store(), feishu.client());
  assert.deepEqual([result.anchor, result.anchorSource, result.due], ["2026-10-06", "config", true]);
  const off = new MemoryState();
  await seedSnapshot(off);
  const disabled = await runAdsRunaway({ taskType: "ads-runaway" }, configWith({ ADS_RUNAWAY_ANCHOR: "2026-10-06", ADS_RUNAWAY_ENABLED: "false" }), off.store(), new MemoryFeishu().client());
  assert.equal(disabled.result, "disabled");
  assert.equal(off.items.has("ADS_RUNAWAY|state"), false);
});

test("调价数据包：按 SKU 汇总活动、广告位、投放、搜索词、总销量与 TACOS；上次调整附“调整后到截止日”与等长调整前数据", () => {
  const snapshot = sampleSnapshot();
  const registry = [{ sku: "SKU-1", asin: "B0ROCKET01", name: "Rocket Toy", marginRate: 0.35, profitMatchCount: 1 }];
  const changes: FeishuRecord[] = [{ record_id: "r1", fields: { "SKU编号": [{ type: "text", text: "SKU-1" }], "记录唯一键": "k1", "调整日期": siteMs("2026-10-06"), "调整对象": "关键词", "对象ID": "K1", "活动ID": "C1", "调整动作": "降低竞价", "原值": "$1.10", "新值": "$0.90", "执行情况": "已执行" } }];
  const [pack] = buildReviewPack(snapshot, registry, ["SKU-1"], { profiles: [{ record_id: "p1", fields: { "SKU编号": "SKU-1", "阶段": "成熟期", "最近调价日期": siteMs("2026-10-06") } }], changes, alerts: [], inventory: [{ record_id: "i1", fields: { SKU: "SKU-1", "FBA可售": 120, "FBA可售覆盖天数": 40 } }] }) as unknown as Row[];
  assert.deepEqual([pack!.targetAcos, pack!.breakEvenAcos, pack!.clearance], [0.25, 0.35, false]);
  assert.deepEqual(pack!.profile, { "阶段": "成熟期", "最近调价日期": "2026-10-06" });
  assert.deepEqual(pack!.inventory, { "FBA可售": "120", "FBA可售覆盖天数": "40" });
  const totals7 = (pack!.totals as Row)["7"] as Row;
  assert.deepEqual([totals7.totalSales, totals7.totalOrders, totals7.clicks, totals7.tacos], [150, 6, 206, Number((totals7.spend as number / 150).toFixed(4))], "暂停的投放与活动的历史点击仍计入 SKU 广告合计");
  const campaigns = pack!.campaigns as Row[];
  assert.deepEqual(campaigns.map((item) => [item.name, item.strategy]), [["SP-rocket-manual", "动态竞价-只降低"], ["SP-rocket-auto", "固定竞价"], ["SP-old", "固定竞价"]]);
  assert.deepEqual((campaigns[0]!.placements as Row[]).map((item) => [item.label, item.adjust]), [["搜索结果顶部（首页）", 30], ["搜索结果其余位置", 0]]);
  const targets = (pack!.targets as Row[]).map((item) => item.id);
  assert.deepEqual(targets, ["K1", "K2", "K3", "K4", "K5", "T1"], "启用的都列，暂停的有花费也列");
  assert.ok((pack!.searchTerms as Row[]).every((item) => Number(((item.w as Row)["30"] as Row).clicks) >= 3));
  const [change] = pack!.changes as Row[];
  assert.deepEqual([change!.afterDays, (change!.after as Row).clicks, (change!.sameLengthBefore as Row | undefined)?.clicks], [3, 25, 0]);
});

test("SKU 按广告组归属：多 SKU 活动（如 sp_asin）只算本 SKU 的广告组；在投 SKU 要活动、广告组、商品广告都启用", () => {
  const snapshot = sampleSnapshot();
  for (const group of snapshot.catalog.adGroups) Object.assign(group, group.campaignId === "C3" ? { skus: [], allSkus: ["SKU-1"] } : { skus: ["SKU-1"], allSkus: ["SKU-1"] });
  snapshot.catalog.campaigns.push({ campaignId: "C9", name: "sp_asin", state: "ENABLED", targetingType: "MANUAL", budget: 10, budgetType: "DAILY", strategy: "MANUAL", placements: { TOP: 20 }, startDate: "", skus: ["SKU-1", "SKU-2"], asins: [] });
  snapshot.catalog.adGroups.push(
    { adGroupId: "G9a", campaignId: "C9", name: "rocket-asin", state: "ENABLED", defaultBid: 0.5, skus: ["SKU-1"], allSkus: ["SKU-1"] },
    { adGroupId: "G9b", campaignId: "C9", name: "bucket-asin", state: "PAUSED", defaultBid: 0.5, skus: ["SKU-2"], allSkus: ["SKU-2"] },
  );
  snapshot.catalog.targets.push(
    { id: "X1", campaignId: "C9", adGroupId: "G9a", state: "ENABLED", bid: 0.5, kind: "target", text: "ASIN B0RIVAL001", matchType: "", expressionType: "MANUAL" },
    { id: "X2", campaignId: "C9", adGroupId: "G9b", state: "ENABLED", bid: 0.5, kind: "target", text: "ASIN B0RIVAL002", matchType: "", expressionType: "MANUAL" },
  );
  snapshot.targets.meta.push(
    { id: "X1", campaignId: "C9", adGroupId: "G9a", keyword: "", targeting: 'asin="B0RIVAL001"', keywordType: "TARGETING_EXPRESSION", matchType: "", bid: 0.5 },
    { id: "X2", campaignId: "C9", adGroupId: "G9b", keyword: "", targeting: 'asin="B0RIVAL002"', keywordType: "TARGETING_EXPRESSION", matchType: "", bid: 0.5 },
  );
  snapshot.targets.days.X1 = days([["2026-10-08", 24, 12]]);
  snapshot.targets.days.X2 = days([["2026-09-20", 5, 2, 1, 15]]);
  assert.deepEqual(deliveringSkus(snapshot.catalog), ["SKU-1"], "SKU-2 的广告组已暂停，不算在投");
  const x1 = findRunaways(snapshot, "2026-10-07", "2026-10-09", 20).find((item) => item.objectId === "X1");
  assert.deepEqual([x1?.sku, x1?.category, x1?.objectName], ["SKU-1", "商品投放", 'asin="B0RIVAL001"'], "SKU 取所在广告组的，不是整个活动的 SKU-1/SKU-2");
  const registry = [{ sku: "SKU-1", asin: "B0ROCKET01", name: "Rocket", marginRate: 0.35, profitMatchCount: 1 }, { sku: "SKU-2", asin: "B0BUCKET01", name: "Bucket", marginRate: 0.3, profitMatchCount: 1 }];
  const [sku1, sku2] = buildReviewPack(snapshot, registry, ["SKU-1", "SKU-2"], { profiles: [], changes: [], alerts: [], inventory: [] }) as unknown as Row[];
  const asin1 = (sku1!.campaigns as Row[]).find((item) => item.name === "sp_asin")!;
  assert.deepEqual([asin1.sharedWithSkus, (asin1.adGroups as Row[]).map((item) => item.name), ((asin1.w as Row)["7"] as Row).clicks], [["SKU-2"], ["rocket-asin"], 24]);
  assert.deepEqual((sku2!.campaigns as Row[]).map((item) => item.name), ["sp_asin"]);
  assert.deepEqual((sku2!.targets as Row[]).map((item) => item.id), ["X2"]);
  assert.equal(((sku2!.totals as Row)["30"] as Row).orders, 1);
});

test("SKU 登记按 SKU信息表真实字段：品名取「SKU名称」（表里没有 ASIN、商品名称、品名列），ASIN 取 SSM asin/ 映射，没有映射留空", async () => {
  const feishu = new MemoryFeishu();
  // 与 2026-10-09 实测的 SKU信息表一致：16 列里和这里相关的只有 SKU编号、SKU名称。
  feishu.seed("skus", [{ "SKU编号": "SKU-1", "SKU名称": "火箭玩具", "状态": "在售" }, { "SKU编号": "SKU-2", "SKU名称": "跳舞机器人", "状态": "待上架" }]);
  feishu.seed("profits", [{ "SKU编号": "SKU-1", "毛利率": 0.35 }]);
  const registry = await loadSkuRegistry(configWith({}, [{ sku: "SKU-1", asin: "B0ROCKET01" }]), feishu.client());
  assert.deepEqual(registry.map((item) => [item.sku, item.asin, item.name, item.marginRate, item.profitMatchCount]), [["SKU-1", "B0ROCKET01", "火箭玩具", 0.35, 1], ["SKU-2", "", "跳舞机器人", 0, 0]]);
});

test("数据包 ASIN：有映射用映射；没有映射取只挂本 SKU 的活动的广告 ASIN，不取多 SKU 活动（如 sp_asin）的", () => {
  const snapshot = sampleSnapshot();
  // sp_asin 排在最前、ASIN 顺序与 SKU 无关：旧写法 campaigns[0].asins[0] 会给 SKU-1 安上水桶的 ASIN。
  snapshot.catalog.campaigns.unshift({ campaignId: "C9", name: "sp_asin", state: "ENABLED", targetingType: "MANUAL", budget: 10, budgetType: "DAILY", strategy: "MANUAL", placements: {}, startDate: "", skus: ["SKU-1", "SKU-2"], asins: ["B0BUCKET01", "B0ROCKET01"] });
  snapshot.catalog.adGroups.push(
    { adGroupId: "G9a", campaignId: "C9", name: "rocket-asin", state: "PAUSED", defaultBid: 0.5, skus: ["SKU-1"], allSkus: ["SKU-1"] },
    { adGroupId: "G9b", campaignId: "C9", name: "bucket-asin", state: "PAUSED", defaultBid: 0.5, skus: ["SKU-2"], allSkus: ["SKU-2"] },
  );
  const entry = (sku: string, asin: string, name: string) => ({ sku, asin, name, marginRate: 0.3, profitMatchCount: 1 });
  const pack = (registry: Array<ReturnType<typeof entry>>): Row[] => buildReviewPack(snapshot, registry, ["SKU-1", "SKU-2"], { profiles: [], changes: [], alerts: [], inventory: [] }) as unknown as Row[];
  const [rocket, bucket] = pack([entry("SKU-1", "", "火箭玩具"), entry("SKU-2", "", "小水桶")]);
  assert.deepEqual([rocket!.asin, rocket!.name], ["B0ROCKET01", "火箭玩具"], "取只挂 SKU-1 的活动 C1 的 ASIN");
  assert.deepEqual([bucket!.asin, bucket!.name], ["", "小水桶"], "SKU-2 只在 sp_asin 里，那里的 ASIN 认不出是谁的，留空");
  assert.equal(pack([entry("SKU-1", "B0MAPPED01", "火箭玩具"), entry("SKU-2", "", "小水桶")])[0]!.asin, "B0MAPPED01", "有映射时以映射为准");
});

test("写记忆载荷校验：枚举、必填与日期；adjustedAt 按洛杉矶站点日换算", () => {
  const bad = parseMemoryInput({ changes: [{ sku: "", objectType: "关键字", action: "降价", reasonCategory: "高ACOS", reason: "", adjustedOn: "10/09" }] } as unknown as JsonObject);
  assert.equal(bad.problems.length, 7, bad.problems.join("\n"));
  const ok = parseMemoryInput({ changes: [
    { sku: "S", objectType: "关键词", objectName: "a", action: "降低竞价", reasonCategory: "ACOS高于目标", reason: "r", adjustedAt: "2026-10-09T10:00:00+08:00" },
    { sku: "S", objectType: "关键词", objectName: "b", action: "降低竞价", reasonCategory: "ACOS高于目标", reason: "r", adjustedAt: "2026-10-09T16:30:00+08:00" },
  ] } as unknown as JsonObject);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.changes.map((item) => [item.adjustedOn, item.source, item.execution]), [["2026-10-08", "Claude建议", "已执行"], ["2026-10-09", "Claude建议", "已执行"]]);
});

test("写记忆：默认只预览不写；apply 写入并读回；同一载荷再发只更新不新建、不改调整前数据；复盘回填；档案只改给出字段、空串清空", async () => {
  const state = new MemoryState();
  await seedSnapshot(state);
  const feishu = new MemoryFeishu();
  feishu.seed("skus", [{ "SKU编号": "SKU-1", "SKU名称": "火箭玩具" }]);
  feishu.seed("profits", [{ "SKU编号": "SKU-1", "毛利率": 0.35 }]);
  feishu.seed("profiles", [{ "SKU编号": "SKU-2", "阶段": "成熟期", "当前观察": "旧观察" }]);
  const cursor = {
    changes: [
      { sku: "SKU-1", objectType: "关键词", objectId: "K1", action: "降低竞价", before: "$0.90", after: "$0.70", reasonCategory: "跑飞止损", reason: "3 天 25 次点击 0 单", source: "跑飞预警", adjustedOn: "2026-10-09" },
      { sku: "SKU-1", objectType: "广告位", objectId: "C1|TOP", action: "提高位置加价", before: "30%", after: "50%", reasonCategory: "广告位效率", reason: "首页转化高", adjustedOn: "2026-10-09" },
    ],
    profiles: [{ sku: "SKU-1", stage: "成熟期", watching: "看 K1 降价后点击" }, { sku: "SKU-2", watching: "" }],
  } as unknown as JsonObject;
  const config = configWith();
  const preview = await runAdsMemory({ taskType: "ads-memory", cursor }, config, state.store(), feishu.client());
  assert.deepEqual([preview.apply, (preview.changes as Row).create, (preview.profiles as Row).create, (preview.profiles as Row).update], [false, 2, 1, 1]);
  assert.equal(feishu.writes.length, 0);
  const created = ((preview.preview as Row).changeCreates as Row[])[0]!;
  assert.equal(created["调整内容"], "降低竞价｜rocket toy｜$0.90→$0.70");
  assert.equal(created["活动名称"], "SP-rocket-manual");
  assert.equal(created["复盘日期"], siteMs("2026-10-16"));
  assert.equal(created["调整前数据"], "截至 LA 10/09｜7日 曝光550 点击55 花费$39.80 订单3 销售$60.00 ACOS 66.3%｜14日 曝光550 点击55 花费$39.80 订单3 销售$60.00 ACOS 66.3%｜30日 曝光550 点击55 花费$39.80 订单3 销售$60.00 ACOS 66.3%");
  assert.equal(((preview.preview as Row).changeCreates as Row[])[1]!["对象名称"], "搜索结果顶部（首页）");

  const applied = await runAdsMemory({ taskType: "ads-memory", cursor: { ...cursor, apply: true } }, config, state.store(), feishu.client());
  assert.equal(applied.verified, true);
  assert.equal(feishu.rows("changes").length, 2);
  const profile1 = feishu.rows("profiles").find((row) => row.fields["SKU编号"] === "SKU-1")!.fields;
  assert.deepEqual([profile1["品名"], profile1["阶段"], profile1["最近调价日期"]], ["火箭玩具", "成熟期", siteMs("2026-10-09")], "有已执行调整时自动记最近调价日期");
  const profile2 = feishu.rows("profiles").find((row) => row.fields["SKU编号"] === "SKU-2")!.fields;
  assert.deepEqual([profile2["阶段"], Object.hasOwn(profile2, "当前观察")], ["成熟期", false], "空串清空该字段，其它字段不动");

  const k1 = feishu.rows("changes").find((row) => row.fields["对象ID"] === "K1")!;
  k1.fields["调整前数据"] = "人工保留";
  const key = String(k1.fields["记录唯一键"]);
  const again = await runAdsMemory({ taskType: "ads-memory", cursor: { ...cursor, apply: true, reviews: [{ key, conclusion: "有效", data: "调整后 3 天点击 6、订单 1" }] } }, config, state.store(), feishu.client());
  assert.deepEqual([(again.changes as Row).create, feishu.rows("changes").length], [0, 2]);
  const updated = feishu.rows("changes").find((row) => row.fields["对象ID"] === "K1")!.fields;
  assert.deepEqual([updated["调整前数据"], updated["复盘结论"], updated["复盘数据"]], ["人工保留", "有效", "调整后 3 天点击 6、订单 1"]);
  await assert.rejects(runAdsMemory({ taskType: "ads-memory", cursor: { reviews: [{ key: "nope", conclusion: "有效" }] } as unknown as JsonObject }, config, state.store(), feishu.client()), /复盘找不到对应调整记录/);
});

test("写记忆：档案品名取 SKU信息表「SKU名称」；已有行品名为空时顺带补上（只给 sku 即只补品名），已有品名不覆盖", async () => {
  const state = new MemoryState();
  await seedSnapshot(state);
  const feishu = new MemoryFeishu();
  feishu.seed("skus", [{ "SKU编号": "SKU-1", "SKU名称": "火箭玩具" }, { "SKU编号": "SKU-2", "SKU名称": "跳舞机器人" }, { "SKU编号": "SKU-3", "SKU名称": "表里的名称" }]);
  feishu.seed("profiles", [{ "SKU编号": "SKU-2", "阶段": "成熟期" }, { "SKU编号": "SKU-3", "品名": "人工改过的品名" }]);
  const cursor = { profiles: [{ sku: "SKU-1", stage: "新品期" }, { sku: "SKU-2" }, { sku: "SKU-3" }] } as unknown as JsonObject;
  const preview = await runAdsMemory({ taskType: "ads-memory", cursor }, configWith(), state.store(), feishu.client());
  const planned = (preview.preview as Row).profileUpdates as Array<{ fields: Row }>;
  assert.deepEqual(planned.map((item) => item.fields["品名"]), ["跳舞机器人", undefined], "预览里看得到要补的品名");
  assert.equal(feishu.writes.length, 0);
  await runAdsMemory({ taskType: "ads-memory", cursor: { ...cursor, apply: true } }, configWith(), state.store(), feishu.client());
  const profile = (sku: string): Row => feishu.rows("profiles").find((row) => row.fields["SKU编号"] === sku)!.fields;
  assert.deepEqual([profile("SKU-1")["品名"], profile("SKU-2")["品名"], profile("SKU-3")["品名"]], ["火箭玩具", "跳舞机器人", "人工改过的品名"]);
  assert.equal(profile("SKU-2")["阶段"], "成熟期", "其它字段不动");
});

test("停用与健康：ads-decision 变空操作且不记健康；健康规则改为 ads-runaway 50 小时；超过 64 KB 的结果事件里只存摘要", async () => {
  const retired = await runJob({ taskType: "ads-decision" }, { config: configWith(), state: new MemoryState().store(), amazon: {} as AmazonClient, feishu: new MemoryFeishu().client() });
  assert.deepEqual(retired, { status: "done", retired: true, skipped: true });
  assert.equal(healthTaskType({ taskType: "ads-decision" }, "ads-decision|x", retired), undefined);
  assert.equal(HEALTH_RULES["ads-decision"], undefined);
  assert.equal(HEALTH_RULES["ads-runaway"], 50 * 3_600_000);
  const small = { status: "done", siteDate: "2026-10-09" };
  assert.equal(storedResult("t", small), small);
  const big = storedResult("ads-review|x", { status: "done", siteDate: "2026-10-09", profiles: [{ blob: "x".repeat(70_000) }] } as unknown as JsonObject);
  assert.deepEqual([big.status, big.truncated, big.siteDate, big.taskId, Object.hasOwn(big, "profiles")], ["done", true, "2026-10-09", "ads-review|x", false]);
});

test("窗口求和只算区间内", () => {
  assert.deepEqual(sumSeries(days([["2026-10-01", 5, 2], ["2026-10-05", 3, 1.5]]), "2026-10-02", "2026-10-09"), { impressions: 30, clicks: 3, spend: 1.5, sales: 0, orders: 0, units: 0 });
});

// ---------- 2026-10-11：数据包附库存健康（清库存口径）与 SQP ----------

const EXCESS_HEALTH: SkuInventoryHealth = {
  sku: "SKU-1", asin: "B0ROCKET01", status: "Excess", action: "Advertise listing", available: 180, inbound: 0, ages: [0, 4, 190, 0, 0, 0], aged181: 190, aged91to180: 4, newAged90: 134, willAge90: 4,
  shipped30: 30, shipped90: 60, daysOfSupply: 300, excess: 120, storageNextMonth: 230.4, aisNextMonth: 90.4, aisUnits: 188, holdingPerUnit: 1.28, monthsToClear: 6,
  price: 15.99, commissionRate: 0.15, fbaFee: 8.1, cashPerUnit: 5.49, cashAcos: 0.3433, lowInventoryFee: false, seasonal: "Holiday Season",
};
const sqpWeek = (): SqpWeek => compactSqp({ dataByAsin: [["rocket toy", 1, 300, 20, 8], ["rocket toys", 2, 120, 9, 2], ["space rocket", 5, 80, 4, 0]].map(([query, score, volume, clicks, buys]) => ({
  asin: "B0ROCKET01", searchQueryData: { searchQuery: query, searchQueryScore: score, searchQueryVolume: volume },
  impressionData: { totalQueryImpressionCount: Number(volume) * 10, asinImpressionCount: Number(clicks) * 5 }, clickData: { totalClickCount: Number(volume), asinClickCount: clicks },
  cartAddData: { totalCartAddCount: 30, asinCartAddCount: buys }, purchaseData: { totalPurchaseCount: 20, asinPurchaseCount: buys },
})) });

test("调价数据包附库存健康与 SQP：清库存口径的数字原样带上；SQP 取重要度前 N 个词并补花费 ≥$5 的广告搜索词，广告词按小写、合并空白对照", () => {
  const registry = [{ sku: "SKU-1", asin: "B0ROCKET01", name: "Rocket Toy", marginRate: 0.05, profitMatchCount: 1 }];
  const [pack] = buildReviewPack(sampleSnapshot(), registry, ["SKU-1"], { profiles: [], changes: [], alerts: [], inventory: [] }, {
    inventory: new Map([["SKU-1", EXCESS_HEALTH]]), inventoryDate: "2026-10-10", sqpWeeks: [{ week: "2026-09-27", data: sqpWeek() }], sqpLimit: 1,
  }) as unknown as Row[];
  assert.deepEqual(pack!.inventoryHealth, {
    snapshotDate: "2026-10-10", status: "Excess", available: 180, inbound: 0, daysOfSupply: 300, excess: 120, aged181: 190, newAged90: 134, storageNextMonth: 230.4, aisNextMonth: 90.4,
    holdingPerUnit: 1.28, monthsToClear: 6, price: 15.99, cashPerUnit: 5.49, cashAcos: 0.3433, clearanceLens: true,
  });
  const queries = ((pack!.sqp as Row).queries as Row[]);
  assert.deepEqual(queries.map((item) => item.query), ["rocket toy", "rocket toys"], "space rocket 广告花费 $4 不到 $5，toy for adults 不在 SQP 里");
  assert.deepEqual(queries.map((item) => item.ad30), [{ clicks: 25, orders: 0, spend: 19.8 }, { clicks: 30, orders: 0, spend: 12 }], "“Rocket  Toy”合并空白后对上");
  assert.deepEqual([queries[0]!.clickShare, queries[0]!.buyShare], [6.67, 40]);
  const [plain] = buildReviewPack(sampleSnapshot(), registry, ["SKU-1"], { profiles: [], changes: [], alerts: [], inventory: [] }) as unknown as Row[];
  assert.deepEqual([plain!.inventoryHealth, plain!.sqp], [null, null], "没有附加数据时为空，原有内容不变");
  // 清库存口径不看亚马逊的 days-of-supply（含为大促备的在途货）：健康、没有超龄的主力款即使 days-of-supply 256 也不适用。
  const lens = (patch: Partial<SkuInventoryHealth>): unknown => inventoryPack({ ...EXCESS_HEALTH, ...patch })?.clearanceLens;
  assert.equal(lens({ status: "Healthy", daysOfSupply: 256, aged181: 0, monthsToClear: 4 }), false);
  assert.equal(lens({ status: "Healthy", aged181: 87, monthsToClear: 3.8 }), false, "有超龄但几个月就能卖完");
  assert.equal(lens({ status: "Healthy", aged181: 40, monthsToClear: 8 }), true, "有超龄且卖完要 6 个月以上");
  assert.equal(lens({ status: "Excess", aged181: 0, monthsToClear: 34 }), true, "亚马逊标为冗余");
});

test("调价数据包任务：库存健康与 SQP 没数据时照出并注明；有数据时每个 SKU 带上，规则里写明清库存口径与 SQP 的读法", async () => {
  const state = new MemoryState();
  await seedSnapshot(state);
  const feishu = new MemoryFeishu();
  const empty = await runAdsReview({ taskType: "ads-review" }, configWith(), state.store(), feishu.client());
  assert.deepEqual(empty.notes, ["还没有库存健康数据（inventory-health 未运行过）", "还没有 SQP 数据（sqp 未运行过）"]);
  assert.match(String((empty.rules as Row).clearanceLens), /现金盈亏线 ACOS＝每件回款 ÷ 现价/);
  assert.match(String((empty.rules as Row).sqp), /自然加广告的合计/);
  await state.put({ pk: "INVENTORY_HEALTH", sk: "latest", snapshotDate: "2026-10-10", skus: [EXCESS_HEALTH] });
  await saveSqpWeek(state.store(), "2026-09-27", sqpWeek());
  await state.put({ pk: "SQP_META", sk: "state", weeks: ["2026-09-27"] });
  const full = await runAdsReview({ taskType: "ads-review" }, configWith(), state.store(), feishu.client());
  assert.equal(full.notes, undefined);
  const sku = ((full.profiles as Row[])[0]!.skus as Row[])[0]!;
  assert.equal(sku.sku, "SKU-1");
  assert.equal((sku.inventoryHealth as Row).clearanceLens, true);
  assert.deepEqual(((sku.sqp as Row).queries as Row[]).map((item) => item.query), ["rocket toy", "rocket toys", "space rocket"], "默认取前 25 个");
});
