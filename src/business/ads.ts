import { gunzipSync } from "node:zlib";
import type { AppConfig, FeishuRecord, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FEISHU_BATCH_SIZE, FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { ensureOneTimeSchedule } from "../scheduling.js";
import { addDaysYmd, feishuFieldText as fieldText, feishuRelationRecordIds, sha256, ymdInZone, zonedMidnight } from "../util.js";
import { catalogSnapshot, placementSeries, saveSnapshotPart, targetSeries, termSeries, type SalesDay } from "./ads-snapshot.js";

type Row = Record<string, unknown>;
interface Metrics { impressions: number; clicks: number; spend: number; sales: number; orders: number; units: number }
export interface Profile { profileId: string; marketplaceId: string; countryCode: string; currencyCode: string }
type ReportKind = keyof typeof definitions;
// salesSku30 是 2026-10-09 前的逐 SKU 客单价任务（写投放词监控），旧断点里遇到直接记完成。
type JobKind = ReportKind | "sales" | "skuSales" | "salesSku30" | "placement";
interface ReportJob { key: string; kind: JobKind; profileId: string; startDate: string; endDate: string; sku?: string; asin?: string; reportId?: string; status: string; attempts: number; failures?: number; publishComplete?: boolean; publishCursor?: number; publishAfter?: string; publishPhase?: "write" | "cleanup" }
export interface SkuInfo { sku: string; asin: string; name: string; marginRate: number; profitMatchCount: number }
export interface SkuResolution { ok: boolean; sku: string; asin: string; marginRate: number | null; targetAcos: number | null; breakEvenAcos: number | null; clearance: boolean; dataAnomaly: string; allowBidAdvice: boolean }
interface Catalog { campaigns: Row[]; adGroups: Row[]; keywords: Row[]; targets: Row[]; productAds: Row[] }
interface KeyedRow { key: string; fields: Row }
interface RecordChange { record: FeishuRecord; fields: Row }

export const ADS_RUN_BUDGET_MS = 600_000;
export const ADS_REPORT_MAX_FAILURES = 3;
// 清货：毛利率低于 10%（2026-10-09 用户修正，原 20%）。目标 ACOS＝毛利率 − 10 个百分点（不低于 0），盈亏平衡 ACOS＝毛利率。
export const ADS_CLEARANCE_MARGIN = 0.1;
export const ADS_TARGET_ACOS_OFFSET = 0.1;
const chunkSize = FEISHU_BATCH_SIZE;
const salesPace = { key: "sp-sales-order-metrics", minIntervalMs: 2_100 };
const LA = "America/Los_Angeles";
const tableConfig = { campaign: "FEISHU_BITABLE_TABLE_ID_ADS_CAMPAIGN_DAILY", overview: "FEISHU_BITABLE_TABLE_ID_ADS_DAILY_OVERVIEW" } as const;

const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
const text = (value: unknown): string => String(value ?? "").trim();
const number = (value: unknown): number => { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; };
const adsDateMs = (date: string): number => Date.parse(`${date}T12:00:00Z`);
const metric = (row: Row): Metrics => ({ impressions: number(row.impressions), clicks: number(row.clicks), spend: number(row.cost), sales: number(row.sales7d), orders: number(row.purchases7d), units: number(row.unitsSoldClicks7d) });
const sumMetric = (target: Metrics, row: Row): Metrics => { const value = metric(row); for (const key of Object.keys(target) as Array<keyof Metrics>) target[key] += value[key]; return target; };
const cellText = (value: unknown): string => value === null || value === undefined ? "" : Array.isArray(value) ? value.map(cellText).join("") : typeof value === "object" ? cellText((value as Row).text ?? (value as Row).name ?? (value as Row).value) : String(value);

function sameCell(current: unknown, next: unknown): boolean {
  const stored = cellText(current);
  if (next === null || next === "") return stored === "";
  return typeof next === "number" ? stored !== "" && Number(stored) === next : stored === String(next);
}

const unchanged = (current: Row, fields: Row): boolean => Object.entries(fields).every(([name, value]) => value === undefined || sameCell(current[name], value));

function applyCells(target: Row, fields: Row): void {
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null || value === "") delete target[name];
    else target[name] = value;
  }
}

const funnel = ["impressions", "clicks", "cost", "sales7d", "purchases7d", "unitsSoldClicks7d"];
const definitions = {
  campaign: { reportTypeId: "spCampaigns", groupBy: ["campaign"], columns: ["date", "campaignId", "campaignName", "campaignStatus", "campaignBudgetAmount", "campaignBudgetType", "campaignBudgetCurrencyCode", "campaignBiddingStrategy", ...funnel] },
  advertisedProduct: { reportTypeId: "spAdvertisedProduct", groupBy: ["advertiser"], columns: ["date", "campaignId", "campaignName", "campaignStatus", "adGroupId", "adGroupName", "adId", "advertisedAsin", "advertisedSku", "campaignBudgetAmount", "campaignBudgetCurrencyCode", ...funnel] },
  targeting: { reportTypeId: "spTargeting", groupBy: ["targeting"], columns: ["date", "campaignId", "campaignName", "campaignStatus", "adGroupId", "adGroupName", "keywordId", "keyword", "keywordType", "matchType", "targeting", "keywordBid", "adKeywordStatus", ...funnel], filters: [{ field: "keywordType", values: ["BROAD", "PHRASE", "EXACT", "TARGETING_EXPRESSION", "TARGETING_EXPRESSION_PREDEFINED"] }] },
  searchTerm: { reportTypeId: "spSearchTerm", groupBy: ["searchTerm"], columns: ["date", "campaignId", "campaignName", "campaignStatus", "adGroupId", "adGroupName", "keywordId", "keyword", "keywordType", "matchType", "targeting", "searchTerm", "keywordBid", "adKeywordStatus", ...funnel], filters: [{ field: "keywordType", values: ["BROAD", "PHRASE", "EXACT", "TARGETING_EXPRESSION", "TARGETING_EXPRESSION_PREDEFINED"] }] },
  // 广告位表现（2026-10-09 重启，换任务名 campaignPlacement）：只进每日分析快照，供调价时判断三个位置加价，不写飞书。
  campaignPlacement: { reportTypeId: "spCampaigns", groupBy: ["campaign", "campaignPlacement"], columns: ["date", "campaignId", "campaignName", "placementClassification", ...funnel] },
} as const;
// 旧断点里遇到直接记完成：placement（2026-10-06 停，写「Placement明细」JSON）、salesSku30（2026-10-09 停，写投放词监控「30日平均客单价」）。
const RETIRED_REPORT_KINDS = new Set(["placement", "salesSku30"]);
const SNAPSHOT_KINDS = { targeting: "targets", searchTerm: "searchTerms", campaignPlacement: "placements" } as const;

export function profiles(config: AppConfig): Profile[] {
  const configured = config.optional("ADS_PROFILES_JSON");
  if (configured) {
    const value = JSON.parse(configured) as Partial<Profile>[];
    if (!Array.isArray(value) || !value.length) throw new Error("ADS_PROFILES_JSON 必须是非空数组。 ");
    return value.map((item) => ({ profileId: text(item.profileId), marketplaceId: text(item.marketplaceId) || "ATVPDKIKX0DER", countryCode: text(item.countryCode) || "US", currencyCode: text(item.currencyCode) || "USD" }));
  }
  return [{ profileId: config.get("ADS_PROFILE_ID"), marketplaceId: "ATVPDKIKX0DER", countryCode: "US", currencyCode: "USD" }];
}

function profileFor(config: AppConfig, profileId: string): Profile {
  const profile = profiles(config).find((item) => item.profileId === profileId);
  if (!profile) throw new Error(`Ads Profile 配置缺失: ${profileId}`);
  return profile;
}

// SKU信息表没有 ASIN 列，品名列叫「SKU名称」（2026-10-09 核对字段；此前按不存在的 ASIN、商品名称/品名 读，GAS 时期起一直为空）。
// ASIN 取系统唯一的 SKU/ASIN 映射 SSM asin/，没有映射的 SKU 留空。
export async function loadSkuRegistry(config: AppConfig, feishu: FeishuClient): Promise<SkuInfo[]> {
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const [skus, profits] = await Promise.all([
    feishu.listRecords(app, config.get("FEISHU_BITABLE_TABLE_ID_SKUS")),
    feishu.listRecords(app, config.get("FEISHU_BITABLE_TABLE_ID_PROFIT_ESTIMATE")),
  ]);
  const skuByRecordId = new Map<string, string>();
  for (const record of skus) { const sku = fieldText(record.fields["SKU编号"]); if (sku) skuByRecordId.set(record.record_id, sku); }
  const bySku = new Map<string, number[]>();
  for (const record of profits) {
    const rawSku = record.fields["SKU编号"];
    const related = [...new Set(feishuRelationRecordIds(rawSku).map((id) => skuByRecordId.get(id) ?? "").filter(Boolean))];
    const sku = related.length === 1 ? related[0]! : related.length ? "" : fieldText(rawSku);
    let margin = Number(fieldText(record.fields["毛利率"]));
    if (margin > 1) margin /= 100;
    if (!sku || !Number.isFinite(margin)) continue;
    bySku.set(sku, [...(bySku.get(sku) ?? []), margin]);
  }
  const asinBySku = new Map(config.asins().map((item) => [item.sku, item.asin]));
  return skus.map((record) => {
    const sku = fieldText(record.fields["SKU编号"]);
    const margins = bySku.get(sku) ?? [];
    return { sku, asin: asinBySku.get(sku) ?? "", name: fieldText(record.fields["SKU名称"]), marginRate: margins[0] ?? 0, profitMatchCount: margins.length };
  }).filter((item) => item.sku);
}

export function marginResolution(item: SkuInfo | undefined, anomaly: string): SkuResolution {
  if (!item) return { ok: false, sku: "", asin: "", marginRate: null, targetAcos: null, breakEvenAcos: null, clearance: false, dataAnomaly: anomaly, allowBidAdvice: false };
  if (item.profitMatchCount !== 1) return { ok: false, sku: item.sku, asin: item.asin, marginRate: null, targetAcos: null, breakEvenAcos: null, clearance: false, dataAnomaly: item.profitMatchCount ? "毛利率存在多条记录" : "毛利率缺失", allowBidAdvice: false };
  return { ok: true, sku: item.sku, asin: item.asin, marginRate: item.marginRate, breakEvenAcos: item.marginRate, targetAcos: Math.max(0, Number((item.marginRate - ADS_TARGET_ACOS_OFFSET).toFixed(4))), clearance: item.marginRate < ADS_CLEARANCE_MARGIN, dataAnomaly: "", allowBidAdvice: true };
}

function resolveSku(row: Row, registry: SkuInfo[], productAds: Row[]): SkuResolution {
  const unique = (candidates: SkuInfo[], anomaly = "SKU关联不到唯一记录") => {
    const identities = new Map(candidates.map((item) => [`${item.sku}|${item.asin}`, item]));
    return identities.size === 1 ? marginResolution([...identities.values()][0], anomaly) : marginResolution(undefined, identities.size ? "SKU关联到多个候选" : anomaly);
  };
  const sku = text(row.advertisedSku ?? row.sku);
  if (sku) { const matches = registry.filter((item) => item.sku === sku); if (matches.length) return unique(matches); }
  const asin = text(row.advertisedAsin ?? row.asin);
  if (asin) { const matches = registry.filter((item) => item.asin === asin); if (matches.length) return unique(matches); }
  const ads = productAds.filter((item) => text(item.campaignId) === text(row.campaignId) && (!row.adGroupId || text(item.adGroupId) === text(row.adGroupId)));
  const productMatches = ads.flatMap((item) => registry.filter((entry) => entry.sku === text(item.sku ?? item.advertisedSku) || entry.asin === text(item.asin ?? item.advertisedAsin)));
  if (productMatches.length) return unique(productMatches);
  const names = [row.campaignName, row.adGroupName, row.productName].map((value) => text(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "")).filter(Boolean);
  return unique(registry.filter((item) => {
    const name = item.name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
    return name && names.some((value) => value.includes(name) || name.includes(value));
  }));
}

const entitySpecs = {
  campaigns: { path: "/sp/campaigns/list", media: "application/vnd.spCampaign.v3+json", key: "campaigns" },
  adGroups: { path: "/sp/adGroups/list", media: "application/vnd.spAdGroup.v3+json", key: "adGroups" },
  keywords: { path: "/sp/keywords/list", media: "application/vnd.spKeyword.v3+json", key: "keywords" },
  targets: { path: "/sp/targets/list", media: "application/vnd.spTargetingClause.v3+json", key: "targetingClauses" },
  productAds: { path: "/sp/productAds/list", media: "application/vnd.spProductAd.v3+json", key: "productAds" },
} as const;
const reportMediaType = "application/vnd.createasyncreportrequest.v3+json";

async function listEntities(amazon: AmazonClient, profileId: string, name: keyof typeof entitySpecs): Promise<Row[]> {
  const spec = entitySpecs[name];
  const output: Row[] = [];
  let nextToken = "";
  const seen = new Set<string>();
  do {
    const response = await amazon.ads<JsonObject>(spec.path, { method: "POST", profileId, mediaType: spec.media, body: { stateFilter: { include: ["ENABLED", "PAUSED", "ARCHIVED"] }, maxResults: 1000, ...(nextToken ? { nextToken } : {}) } });
    const result = (response.results ?? response) as Row;
    output.push(...rows(result[spec.key]));
    nextToken = text(result.nextToken);
    if (nextToken && seen.has(nextToken)) throw new Error(`Ads ${name} 分页游标重复。`);
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return output;
}

// 单次调用内的飞书表缓存：按表首次需要时 listRecords 一次，写入回执核对后同步内存；新建行的 record_id 不依赖批量回执顺序，需要时整表回读确认。
class AdsTable {
  private byKey = new Map<string, FeishuRecord[]>();
  private readonly created = new Set<string>();
  private dirty = false;

  constructor(private readonly feishu: FeishuClient, private readonly app: string, private readonly id: string, private readonly keyField: string, private list: FeishuRecord[]) {
    this.index();
  }

  get records(): FeishuRecord[] { return this.list; }

  private index(): void {
    this.byKey = new Map();
    for (const record of this.list) {
      const key = cellText(record.fields[this.keyField]).trim();
      if (!key) continue;
      const same = this.byKey.get(key);
      if (same) same.push(record); else this.byKey.set(key, [record]);
    }
  }

  async settle(): Promise<void> {
    if (!this.dirty && !this.created.size) return;
    this.list = await this.feishu.listRecords(this.app, this.id);
    this.index();
    const wrong = [...this.created].filter((key) => (this.byKey.get(key)?.length ?? 0) !== 1);
    this.created.clear();
    this.dirty = false;
    if (wrong.length) throw new Error(`飞书新建记录回读数量不符 ${wrong.length} 条: ${wrong[0]}`);
  }

  async find(key: string): Promise<FeishuRecord | undefined> {
    if (this.dirty || this.created.has(key)) await this.settle();
    const found = this.byKey.get(key) ?? [];
    if (found.length > 1) throw new Error(`飞书稳定业务键不唯一: ${key}`);
    return found[0];
  }

  async update(changes: RecordChange[]): Promise<number> {
    const merged = new Map<string, RecordChange>();
    for (const { record, fields } of changes) merged.set(record.record_id, { record, fields: { ...merged.get(record.record_id)?.fields, ...fields } });
    const pending = [...merged.values()].filter(({ record, fields }) => !unchanged(record.fields, fields));
    if (!pending.length) return 0;
    let applied = 0;
    await this.feishu.batchUpdate(this.app, this.id, pending.map(({ record, fields }) => ({ recordId: record.record_id, fields })), {
      onChunk: (count) => { for (const { record, fields } of pending.slice(applied, count)) applyCells(record.fields, fields); applied = count; },
    });
    return pending.length;
  }

  async write(input: KeyedRow[]): Promise<number> {
    const merged = new Map<string, Row>();
    for (const row of input) merged.set(row.key, { ...merged.get(row.key), ...row.fields });
    const updates: RecordChange[] = [], creates: KeyedRow[] = [];
    for (const [key, fields] of merged) {
      const record = await this.find(key);
      if (record) updates.push({ record, fields }); else creates.push({ key, fields });
    }
    const updated = await this.update(updates);
    if (!creates.length) return updated;
    let done = 0;
    try {
      await this.feishu.batchCreate(this.app, this.id, creates.map((row) => row.fields), { onChunk: (count) => { for (const row of creates.slice(done, count)) this.created.add(row.key); done = count; } });
    } catch (error) {
      this.dirty = true;
      throw error;
    }
    return updated + creates.length;
  }

  async remove(ids: string[]): Promise<void> {
    if (!ids.length) return;
    let done = 0;
    try {
      await this.feishu.batchDelete(this.app, this.id, ids, { onChunk: (count) => { const gone = new Set(ids.slice(done, count)); this.list = this.list.filter((record) => !gone.has(record.record_id)); done = count; } });
    } finally {
      this.index();
    }
  }
}

export class AdsRun {
  private readonly tables = new Map<string, AdsTable>();
  private readonly catalogs = new Map<string, Promise<Catalog>>();
  private registry: Promise<SkuInfo[]> | undefined;

  constructor(readonly config: AppConfig, readonly amazon: AmazonClient, readonly feishu: FeishuClient, readonly deadline = Date.now() + ADS_RUN_BUDGET_MS, readonly checkpoint: () => Promise<void> = async () => {}, readonly state?: StateStore) {}

  timeLeft(): boolean { return Date.now() < this.deadline; }

  skuRegistry(): Promise<SkuInfo[]> { return this.registry ??= loadSkuRegistry(this.config, this.feishu); }

  catalog(profileId: string): Promise<Catalog> {
    const cached = this.catalogs.get(profileId);
    if (cached) return cached;
    const loaded = Promise.all((Object.keys(entitySpecs) as Array<keyof typeof entitySpecs>).map(async (name) => [name, await listEntities(this.amazon, profileId, name)] as const)).then((items) => Object.fromEntries(items) as unknown as Catalog);
    this.catalogs.set(profileId, loaded);
    return loaded;
  }

  async table(name: keyof typeof tableConfig): Promise<AdsTable> {
    const id = this.config.get(tableConfig[name]);
    const cached = this.tables.get(id);
    if (cached) return cached;
    const app = this.config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
    const table = new AdsTable(this.feishu, app, id, "记录唯一键", await this.feishu.listRecords(app, id));
    this.tables.set(id, table);
    return table;
  }
}

async function initialJobs(run: AdsRun, mode: "EARLY" | "DAILY", taskId: string): Promise<ReportJob[]> {
  const end = addDaysYmd(ymdInZone(new Date(), "America/Los_Angeles"), -1);
  const registry = mode === "DAILY" ? await run.skuRegistry() : [];
  return adsJobPlan(profiles(run.config), mode, taskId, end, registry);
}

// DAILY：活动与商品报表 14 天（写活动日报、总览）；投放、搜索词、广告位报表与逐 SKU 每日销售 30 天（进每日分析快照）。
export function adsJobPlan(configuredProfiles: Profile[], mode: "EARLY" | "DAILY", taskId: string, end: string, registry: SkuInfo[]): ReportJob[] {
  const start = addDaysYmd(end, mode === "EARLY" ? -2 : -13);
  const snapshotStart = addDaysYmd(end, -29);
  const skus = [...new Map(registry.filter((entry) => entry.sku).map((entry) => [entry.sku, entry])).values()];
  return configuredProfiles.flatMap((profile) => {
    const reports: ReportJob[] = (["campaign", "advertisedProduct"] as const).map((kind) => ({ key: `${taskId}|${profile.profileId}|${kind}|${start}|${end}`, kind, profileId: profile.profileId, startDate: start, endDate: end, status: "NEW", attempts: 0 }));
    if (mode === "DAILY") for (const kind of ["targeting", "searchTerm", "campaignPlacement"] as const) reports.push({ key: `${taskId}|${profile.profileId}|${kind}|${snapshotStart}|${end}`, kind, profileId: profile.profileId, startDate: snapshotStart, endDate: end, status: "NEW", attempts: 0 });
    for (let date = start; date <= end; date = addDaysYmd(date, 1)) reports.push({ key: `${taskId}|${profile.profileId}|sales|${date}`, kind: "sales", profileId: profile.profileId, startDate: date, endDate: date, status: "NEW", attempts: 0 });
    if (mode === "DAILY") for (const item of skus) reports.push({ key: `${taskId}|${profile.profileId}|skuSales|${end}|${item.sku}`, kind: "skuSales", profileId: profile.profileId, startDate: snapshotStart, endDate: end, sku: item.sku, asin: item.asin, status: "NEW", attempts: 0 });
    return reports;
  });
}

function request(job: ReportJob): JsonObject {
  if (!(job.kind in definitions)) throw new Error(`${job.kind} 任务不创建 Ads 报表。 `);
  const definition = definitions[job.kind as ReportKind];
  return {
    name: `AMZShop ${job.kind} ${job.startDate}~${job.endDate}`,
    startDate: job.startDate,
    endDate: job.endDate,
    configuration: {
      adProduct: "SPONSORED_PRODUCTS",
      groupBy: [...definition.groupBy],
      columns: [...definition.columns],
      reportTypeId: definition.reportTypeId,
      timeUnit: "DAILY",
      format: "GZIP_JSON",
      ...("filters" in definition ? { filters: definition.filters.map((filter) => ({ field: filter.field, values: [...filter.values] })) } : {}),
    },
  } as JsonObject;
}

function campaignRows(profileId: string, report: Row[], currentCatalog: Catalog, startDate: string, endDate: string): KeyedRow[] {
  const byKey = new Map<string, Row>();
  for (const source of report) {
    const key = `${profileId}|${text(source.date)}|${text(source.campaignId)}`;
    const row = byKey.get(key) ?? { ...source, impressions: 0, clicks: 0, cost: 0, sales7d: 0, purchases7d: 0, unitsSoldClicks7d: 0 };
    const total = metric(row);
    sumMetric(total, source);
    Object.assign(row, { impressions: total.impressions, clicks: total.clicks, cost: total.spend, sales7d: total.sales, purchases7d: total.orders, unitsSoldClicks7d: total.units });
    byKey.set(key, row);
  }
  for (const campaign of currentCatalog.campaigns.filter((item) => text(item.state ?? "ENABLED").toUpperCase() === "ENABLED")) {
    const campaignId = text(campaign.campaignId);
    const launched = text(campaign.startDate);
    for (let date = startDate; campaignId && date <= endDate; date = addDaysYmd(date, 1)) {
      if (launched && date < launched) continue;
      const key = `${profileId}|${date}|${campaignId}`;
      if (!byKey.has(key)) byKey.set(key, { date, campaignId, campaignName: campaign.name ?? campaign.campaignName, campaignStatus: "ENABLED", campaignBudgetAmount: (campaign.budget as Row | undefined)?.budget ?? campaign.budget, impressions: 0, clicks: 0, cost: 0, sales7d: 0, purchases7d: 0, unitsSoldClicks7d: 0 });
    }
  }
  return [...byKey].map(([key, row]) => {
    const m = metric(row);
    const campaign = currentCatalog.campaigns.find((item) => text(item.campaignId) === text(row.campaignId));
    return { key, fields: {
      "记录唯一键": key, "站点日期": adsDateMs(text(row.date)), "Profile ID": profileId,
      "活动ID": text(row.campaignId), "活动名称": text(row.campaignName), "活动状态": text(row.campaignStatus),
      ...(text(campaign?.startDate) ? { "活动上线日期": adsDateMs(text(campaign?.startDate)) } : {}),
      "预算": number(row.campaignBudgetAmount), "花费": m.spend, "广告销售额": m.sales,
      "广告订单": m.orders, "广告销量": m.units, "曝光": m.impressions, "点击": m.clicks,
      "ACOS": m.sales ? m.spend / m.sales : 0, "ROAS": m.spend ? m.sales / m.spend : 0,
      "CTR": m.impressions ? m.clicks / m.impressions : 0, "CPC": m.clicks ? m.spend / m.clicks : 0,
      "CVR": m.clicks ? m.orders / m.clicks : 0, "CPO": m.orders ? m.spend / m.orders : 0,
    } };
  });
}

async function overviewAdRows(table: AdsTable, profile: Profile, report: Row[]): Promise<KeyedRow[]> {
  const byDate = new Map<string, ReturnType<typeof metric>>();
  for (const row of report) {
    const date = text(row.date);
    const current = byDate.get(date) ?? { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 };
    const value = metric(row);
    for (const key of Object.keys(current) as Array<keyof typeof current>) current[key] += value[key];
    byDate.set(date, current);
  }
  const output: KeyedRow[] = [];
  for (const [date, ad] of byDate) {
    const key = `${profile.profileId}|${date}`;
    const prior = (await table.find(key))?.fields ?? {};
    const totalSales = number(prior["总销售额"]);
    const totalOrders = number(prior["总订单"]);
    const totalUnits = number(prior["总销量"]);
    const salesComplete = prior["总销售额"] !== undefined && prior["总订单"] !== undefined;
    output.push({ key, fields: {
      "记录唯一键": key, "站点日期": adsDateMs(date), "Profile ID": profile.profileId, "站点": profile.countryCode,
      "曝光": ad.impressions, "点击": ad.clicks, "花费": ad.spend, "广告销售额": ad.sales,
      "广告订单": ad.orders, "广告销量": ad.units, "ACOS": ad.sales ? ad.spend / ad.sales : 0, "ROAS": ad.spend ? ad.sales / ad.spend : 0,
      "CTR": ad.impressions ? ad.clicks / ad.impressions : 0,
      "CPC": ad.clicks ? ad.spend / ad.clicks : 0, "CVR": ad.clicks ? ad.orders / ad.clicks : 0, "CPO": ad.orders ? ad.spend / ad.orders : 0,
      ...(salesComplete ? { "总销售额": totalSales, "总订单": totalOrders, "总销量": totalUnits, "自然订单（估算）": Math.max(0, totalOrders - ad.orders), "TACOS（ACoAS）": totalSales ? ad.spend / totalSales : 0, "广告订单占比": totalOrders ? ad.orders / totalOrders : null } : {}),
      "数据新鲜度": salesComplete ? "完整" : "广告报表已完成，等待总销售",
    } });
  }
  return output;
}

async function salesRows(run: AdsRun, profile: Profile, jobs: ReportJob[]): Promise<ReportJob[]> {
  const table = await run.table("overview");
  const output: KeyedRow[] = [], done: ReportJob[] = [];
  for (const job of jobs) {
    if (done.length && !run.timeLeft()) break;
    const date = job.startDate;
    const response = await run.amazon.sp<JsonObject>("/sales/v1/orderMetrics", { query: { marketplaceIds: profile.marketplaceId, interval: `${zonedMidnight(date, "America/Los_Angeles")}--${zonedMidnight(addDaysYmd(date, 1), "America/Los_Angeles")}`, granularity: "Day", granularityTimeZone: "America/Los_Angeles" }, pace: salesPace });
    const sales = rows(response.payload)[0] ?? {};
    const key = `${profile.profileId}|${date}`;
    const prior = (await table.find(key))?.fields ?? {};
    const hasAds = prior["花费"] !== undefined && prior["花费"] !== null;
    const spend = number(prior["花费"]), adSales = number(prior["广告销售额"]), adOrders = number(prior["广告订单"]), impressions = number(prior["曝光"]), clicks = number(prior["点击"]);
    const totalSales = number((sales.totalSales as Row | undefined)?.amount), totalOrders = number(sales.orderCount), totalUnits = number(sales.unitCount);
    output.push({ key, fields: {
      "记录唯一键": key, "站点日期": adsDateMs(date), "Profile ID": profile.profileId, "站点": profile.countryCode,
      "总销售额": totalSales, "总订单": totalOrders, "总销量": totalUnits,
      ...(hasAds ? { "曝光": impressions, "点击": clicks, "花费": spend, "广告销售额": adSales, "广告订单": adOrders,
        "自然订单（估算）": Math.max(0, totalOrders - adOrders), "ACOS": adSales ? spend / adSales : null,
        "ROAS": spend ? adSales / spend : null, "TACOS（ACoAS）": totalSales ? spend / totalSales : null,
        "CTR": impressions ? clicks / impressions : null, "CPC": clicks ? spend / clicks : null,
        "CVR": clicks ? adOrders / clicks : null, "CPO": adOrders ? spend / adOrders : null,
        "广告订单占比": totalOrders ? adOrders / totalOrders : null } : {}),
      "数据新鲜度": hasAds ? "完整" : "总销售已完成，等待广告报表", "采集完成时间": Date.now(),
    } });
    done.push(job);
  }
  await table.write(output);
  return done;
}

// 逐 SKU 近 30 天每日销售额/订单/件数（Sales 接口全部履约网络，每 SKU 一次调用）→ 快照 skuSales:<SKU>，供数据包算 TACOS 与自然单。
export async function skuSalesSnapshot(run: AdsRun, profile: Profile, jobs: ReportJob[]): Promise<ReportJob[]> {
  if (!run.state) throw new Error("逐 SKU 销售快照需要状态表。 ");
  const done: ReportJob[] = [];
  for (const job of jobs) {
    if (done.length && !run.timeLeft()) break;
    const response = await run.amazon.sp<JsonObject>("/sales/v1/orderMetrics", { query: { marketplaceIds: profile.marketplaceId, interval: `${zonedMidnight(job.startDate, LA)}--${zonedMidnight(addDaysYmd(job.endDate, 1), LA)}`, granularity: "Day", granularityTimeZone: LA, ...(job.sku ? { sku: job.sku } : { asin: job.asin }) }, pace: salesPace });
    const days: Record<string, SalesDay> = {};
    for (const bucket of rows(response.payload)) {
      const date = text(bucket.interval).slice(0, 10);
      const value: SalesDay = [Math.round(number((bucket.totalSales as Row | undefined)?.amount) * 100) / 100, number(bucket.orderCount), number(bucket.unitCount)];
      if (date && value.some((item) => item !== 0)) days[date] = value;
    }
    await saveSnapshotPart(run.state, job.endDate, profile.profileId, `skuSales:${job.sku ?? job.asin}`, days);
    done.push(job);
  }
  return done;
}

function advertisedRows(profileId: string, report: Row[], registry: SkuInfo[], currentCatalog: Catalog): { campaign: KeyedRow[]; overview: KeyedRow[] } {
  const groups = new Map<string, { skus: Map<string, SkuResolution>; profit: number; unmatched: number; matched: number; anomalies: string[] }>();
  for (const row of report) {
    const key = `${profileId}|${text(row.date)}|${text(row.campaignId)}`;
    const group = groups.get(key) ?? { skus: new Map<string, SkuResolution>(), profit: 0, unmatched: 0, matched: 0, anomalies: [] as string[] };
    const resolution = resolveSku(row, registry, currentCatalog.productAds);
    const values = metric(row);
    if (!resolution.ok) { group.unmatched += values.spend; group.anomalies.push(`${resolution.dataAnomaly}: ${text(row.advertisedSku ?? row.advertisedAsin ?? row.adId)}`); }
    else { group.skus.set(resolution.sku, resolution); group.matched += 1; group.profit += values.sales * (resolution.marginRate ?? 0) - values.spend; }
    groups.set(key, group);
  }
  const campaign: KeyedRow[] = [];
  const byOverview = new Map<string, { profit: number; unmatched: number; incomplete: boolean; anomalies: number }>();
  for (const [key, group] of groups) {
    const only = group.skus.size === 1 ? [...group.skus.values()][0]! : undefined;
    if (group.skus.size > 1) group.anomalies.push("同一活动关联多个 SKU，活动级 bid 建议已禁止");
    const anomaly = [...new Set(group.anomalies)].join("；");
    campaign.push({ key, fields: {
      "记录唯一键": key, "SKU编号": only?.sku ?? "", "目标ACOS": only?.targetAcos ?? null,
      "盈亏平衡ACOS": only?.breakEvenAcos ?? null, "清货": only?.clearance ? "是" : "否",
      "估算广告贡献利润": group.unmatched ? null : Number(group.profit.toFixed(2)), "已匹配广告贡献利润": Number(group.profit.toFixed(2)),
      "未匹配花费": Number(group.unmatched.toFixed(2)), "利润口径": group.unmatched ? (group.matched ? "仅已匹配部分" : "未知") : "完整", "数据异常": anomaly,
    } });
    const [, date] = key.split("|");
    const overviewKey = `${profileId}|${date}`;
    const overview = byOverview.get(overviewKey) ?? { profit: 0, unmatched: 0, incomplete: false, anomalies: 0 };
    overview.profit += group.profit; overview.unmatched += group.unmatched; overview.incomplete ||= group.unmatched > 0; overview.anomalies += anomaly ? 1 : 0;
    byOverview.set(overviewKey, overview);
  }
  return { campaign, overview: [...byOverview].map(([key, item]) => ({ key, fields: { "记录唯一键": key, "估算广告贡献利润": item.incomplete ? null : Number(item.profit.toFixed(2)), "已匹配广告贡献利润": Number(item.profit.toFixed(2)), "未匹配花费": Number(item.unmatched.toFixed(2)), "利润口径": item.incomplete ? (item.profit ? "仅已匹配部分" : "未知") : "完整", "SKU数据异常数": item.anomalies } })) };
}

async function dateRows(job: ReportJob, date: string, batch: Row[], run: AdsRun, profile: Profile, currentCatalog: Catalog): Promise<{ campaign: KeyedRow[]; overview: KeyedRow[] }> {
  if (job.kind === "campaign") return { campaign: campaignRows(job.profileId, batch, currentCatalog, date, date), overview: await overviewAdRows(await run.table("overview"), profile, batch) };
  if (job.kind === "advertisedProduct") return advertisedRows(job.profileId, batch, await run.skuRegistry(), currentCatalog);
  throw new Error(`Ads 报表 ${job.kind} 不按日期写入。`);
}

// 投放、搜索词、广告位报表整份存进每日分析快照（不写飞书）。活动与商品报表每块（≤500 行）写入并核对回执后才推进断点；
// 中断后重跑只写缺失或变化的行。每次调用至少完成一块，之后受时间预算约束。
export async function processReport(job: ReportJob, data: Row[], run: AdsRun): Promise<boolean> {
  if (job.kind === "targeting" || job.kind === "searchTerm" || job.kind === "campaignPlacement") {
    if (!run.state) throw new Error("广告快照需要状态表。 ");
    const value = job.kind === "targeting" ? targetSeries(data) : job.kind === "searchTerm" ? termSeries(data) : placementSeries(data);
    await saveSnapshotPart(run.state, job.endDate, job.profileId, SNAPSHOT_KINDS[job.kind], value);
    return true;
  }
  const profile = profileFor(run.config, job.profileId);
  const currentCatalog = await run.catalog(job.profileId);
  let progressed = false;
  const more = (): boolean => !progressed || run.timeLeft();
  const step = async (): Promise<void> => { progressed = true; await run.checkpoint(); };
  const byDate = new Map<string, Row[]>();
  for (const row of data) {
    const date = text(row.date);
    const same = byDate.get(date);
    if (same) same.push(row); else byDate.set(date, [row]);
  }
  const dates: string[] = [];
  for (let date = job.startDate; date <= job.endDate; date = addDaysYmd(date, 1)) dates.push(date);
  while ((job.publishCursor ?? 0) < dates.length) {
    if (!more()) return false;
    const offset = job.publishCursor ?? 0;
    const campaign: KeyedRow[] = [], overview: KeyedRow[] = [];
    let count = 0;
    for (const date of dates.slice(offset)) {
      const next = await dateRows(job, date, byDate.get(date) ?? [], run, profile, currentCatalog);
      if (count && campaign.length + next.campaign.length > chunkSize) break;
      campaign.push(...next.campaign);
      overview.push(...next.overview);
      count += 1;
    }
    if (campaign.length) await (await run.table("campaign")).write(campaign);
    if (overview.length) await (await run.table("overview")).write(overview);
    job.publishCursor = offset + count;
    await step();
  }
  return true;
}

const siteDateOf = (jobs: ReportJob[]): string => jobs.map((job) => job.endDate).sort().at(-1) ?? "";

export function adsContinueDelayMs(jobs: ReportJob[]): number {
  const actionable = jobs.some((job) => job.status !== "DONE" && (job.kind === "sales" || job.kind === "skuSales" || RETIRED_REPORT_KINDS.has(job.kind) || !job.reportId || ["PUBLISHING", "COMPLETED"].includes(job.status)));
  return actionable ? 60_000 : 5 * 60_000;
}

// 较旧的批次晚完成时不回退指针；指针所指即“最新完整快照”（各部分与目录都已写完）。
async function markLatestDaily(state: StateStore, taskId: string, siteDate: string): Promise<boolean> {
  const current = await state.get("ADS_LATEST_DAILY", "ALL");
  if (text(current?.siteDate) > siteDate) return false;
  await state.put({ pk: "ADS_LATEST_DAILY", sk: "ALL", taskId, siteDate, updatedAt: new Date().toISOString() });
  return true;
}

// DAILY 批次收尾（在任务记 done 之前，失败时任务保持未完成、由重试或看门狗接续）：存广告目录 → 更新最新快照指针 → 约 1 分钟后排关键词跑飞排查。
// 跑飞事件的 scheduledAt 固定为截止日，重复收尾排出的同一事件被认领去重。
async function finishDaily(run: AdsRun, state: StateStore, taskId: string, siteDate: string, schedule: typeof ensureOneTimeSchedule): Promise<void> {
  for (const profile of profiles(run.config)) await saveSnapshotPart(state, siteDate, profile.profileId, "catalog", catalogSnapshot(await run.catalog(profile.profileId)));
  if (!await markLatestDaily(state, taskId, siteDate)) return;
  await schedule({ taskType: "ads-runaway", taskId: `ads-runaway|${siteDate}`, scheduledAt: `${siteDate}T12:00:00.000Z` }, new Date(Date.now() + 60_000));
}

export async function runAdsReports(event: JobEvent, mode: "EARLY" | "DAILY", config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient, schedule = ensureOneTimeSchedule): Promise<JsonObject> {
  const taskId = event.taskId ?? `ads-${mode.toLowerCase()}|${ymdInZone(new Date(), "America/Los_Angeles")}`;
  const existing = await state.task("ads-reports", taskId);
  const savedState = (existing?.state ?? {}) as JsonObject;
  let jobs: ReportJob[] = [];
  const save = (status: string, nextAt?: string) => state.saveTask("ads-reports", taskId, { mode, jobs: jobs as unknown as JsonObject[], completed: jobs.filter((job) => job.status === "DONE").length, total: jobs.length }, status, nextAt);
  const checkpoint = () => save("waiting_report", new Date().toISOString());
  const run = new AdsRun(config, amazon, feishu, Date.now() + ADS_RUN_BUDGET_MS, checkpoint, state);
  jobs = Array.isArray(savedState.jobs) ? savedState.jobs as unknown as ReportJob[] : await initialJobs(run, mode, taskId);
  for (const job of jobs) {
    if (job.status === "DONE") continue;
    if (RETIRED_REPORT_KINDS.has(job.kind)) { job.status = "DONE"; job.publishComplete = true; continue; } // 发布前存下的断点
    if (!run.timeLeft()) break;
    if (job.kind === "sales" || job.kind === "skuSales") {
      const profile = profileFor(config, job.profileId);
      const pending = jobs.filter((item) => item.kind === job.kind && item.profileId === job.profileId && item.status !== "DONE");
      const finished = job.kind === "sales" ? await salesRows(run, profile, pending) : await skuSalesSnapshot(run, profile, pending);
      for (const item of finished) { item.status = "DONE"; item.publishComplete = true; item.attempts += 1; }
      await checkpoint();
      continue;
    }
    profileFor(config, job.profileId);
    if (job.reportId) {
      const status = await amazon.ads<JsonObject>(`/reporting/reports/${encodeURIComponent(job.reportId)}`, { profileId: job.profileId, mediaType: reportMediaType });
      const value = text(status.status).toUpperCase();
      job.status = value;
      job.attempts += 1;
      if (["PENDING", "PROCESSING", "IN_PROGRESS"].includes(value)) continue;
      if (["FAILURE", "FAILED", "CANCELLED"].includes(value)) {
        job.failures = (job.failures ?? 0) + 1;
        if (job.failures >= ADS_REPORT_MAX_FAILURES) {
          await checkpoint();
          throw new Error(`Ads 报表失败 ${job.kind}/${job.reportId}/${value}，已累计 ${job.failures} 次。`);
        }
        delete job.reportId; delete job.publishCursor; delete job.publishPhase; delete job.publishAfter; delete job.publishComplete;
        job.status = "NEW";
        await checkpoint();
      } else {
        if (!["COMPLETED", "DONE", "SUCCESS"].includes(value)) throw new Error(`Ads 报表未知状态 ${value}。`);
        let url = text(status.url);
        if (!url) {
          const refreshed = await amazon.ads<JsonObject>(`/reporting/reports/${encodeURIComponent(job.reportId)}`, { profileId: job.profileId, mediaType: reportMediaType });
          url = text(refreshed.url);
        }
        if (!url) throw new Error("Ads 完成报表缺少下载 URL。 ");
        const parsed = JSON.parse(gunzipSync(await amazon.adsDownload(url)).toString("utf8")) as unknown;
        if (!Array.isArray(parsed)) throw new Error("Ads 报表内容不是数组。 ");
        job.status = "PUBLISHING";
        const published = await processReport(job, parsed as Row[], run);
        job.status = published ? "DONE" : "PUBLISHING";
        job.publishComplete = published;
        await checkpoint();
        if (!published) break;
        continue;
      }
    }
    const created = await amazon.ads<JsonObject>("/reporting/reports", { method: "POST", profileId: job.profileId, mediaType: reportMediaType, body: request(job) });
    job.reportId = text(created.reportId);
    if (!job.reportId) throw new Error("Ads 创建报表未返回 reportId。 ");
    job.status = "PENDING";
    job.attempts += 1;
    await checkpoint();
  }
  const done = jobs.every((job) => job.status === "DONE");
  const nextAt = done ? undefined : new Date(Date.now() + adsContinueDelayMs(jobs));
  if (done && mode === "DAILY") await finishDaily(run, state, taskId, siteDateOf(jobs), schedule);
  await save(done ? "done" : "waiting_report", nextAt?.toISOString());
  if (nextAt) await schedule({ taskType: "ads-continue", taskId, scheduledAt: event.scheduledAt ?? new Date().toISOString(), cursor: { mode } }, nextAt);
  return { status: done ? "done" : "waiting_report", taskId, completed: jobs.filter((job) => job.status === "DONE").length, total: jobs.length };
}

const retentionMetrics = ["花费", "广告销售额", "广告订单", "广告销量", "曝光", "点击"] as const;

function retentionMonthClosed(month: string, cutoff: number): boolean {
  const [year, number] = month.split("-").map(Number);
  return Date.UTC(year!, number!, 1) <= cutoff;
}

export async function runAdsRetention(event: JobEvent, config: AppConfig, state: StateStore, _amazon: AmazonClient, feishu: FeishuClient): Promise<JsonObject> {
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const dailyTable = config.get("FEISHU_BITABLE_TABLE_ID_ADS_CAMPAIGN_DAILY");
  const monthlyTable = config.get("FEISHU_BITABLE_TABLE_ID_ADS_CAMPAIGN_MONTHLY");
  const daily = await feishu.listRecords(app, dailyTable);
  const cutoff = Date.now() - Number(config.optional("ADS_DAILY_RETENTION_DAYS", "60")) * 86_400_000;
  const groups = new Map<string, typeof daily>();
  for (const record of daily) {
    const at = Number(record.fields["站点日期"] ?? 0);
    if (!at || at >= cutoff) continue;
    const month = new Date(at).toISOString().slice(0, 7);
    const key = `${month}|${fieldText(record.fields["Profile ID"])}|${fieldText(record.fields["活动ID"])}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const manifests = new Map((await state.list("ADS_RETENTION")).map((item) => [String(item.sk), item]));
  for (const item of manifests.values()) if (item.status === "prepared" && !groups.has(String(item.sk))) groups.set(String(item.sk), []);
  const candidates: Array<{ key: string; group: typeof daily; manifest: Record<string, unknown> | undefined }> = [];
  for (const [key, group] of groups) {
    const manifest = manifests.get(key);
    if (retentionMonthClosed(key.slice(0, 7), cutoff) || manifest?.status === "prepared") candidates.push({ key, group, manifest });
  }
  if (!candidates.length) return { status: "done", archivedGroups: 0, deletedDailyRows: 0, deferredGroups: groups.size };
  const { key, group } = candidates[0]!;
  let manifest = candidates[0]!.manifest;
  const existing = await feishu.searchRecords(app, monthlyTable, { "记录唯一键": key });
  if (existing.length > 1) throw new Error(`广告月报稳定键不唯一: ${key}`);
  if (!manifest) {
    if (existing.length) throw new Error(`广告月报 ${key} 有旧基线但缺少可重入归档清单。`);
    const totals = Object.fromEntries(retentionMetrics.map((name) => [name, group.reduce((sum, row) => sum + number(row.fields[name]), 0)])) as Record<(typeof retentionMetrics)[number], number>;
    const fingerprint = sha256(group.map((item) => `${item.record_id}|${JSON.stringify(item.fields)}`).sort().join("\n"));
    const first = group[0]!;
    const fields = {
      "记录唯一键": key, "月份": key.slice(0, 7), "Profile ID": fieldText(first.fields["Profile ID"]), "活动ID": fieldText(first.fields["活动ID"]), "活动名称": fieldText(first.fields["活动名称"]),
      ...totals, "ACOS": totals.广告销售额 ? totals.花费 / totals.广告销售额 : 0, "ROAS": totals.花费 ? totals.广告销售额 / totals.花费 : 0,
      "CTR": totals.曝光 ? totals.点击 / totals.曝光 : 0, "CPC": totals.点击 ? totals.花费 / totals.点击 : 0, "CVR": totals.点击 ? totals.广告订单 / totals.点击 : 0,
      "CPO": totals.广告订单 ? totals.花费 / totals.广告订单 : 0, "来源日数": new Set(group.map((item) => Number(item.fields["站点日期"]))).size,
      "核对指纹": fingerprint, "核对时间": Date.now(),
    };
    manifest = { pk: "ADS_RETENTION", sk: key, status: "prepared", throughDate: new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).toISOString().slice(0, 10), targetFingerprint: fingerprint, pendingIds: group.map((item) => item.record_id), targetFields: fields, updatedAt: new Date().toISOString() };
    await state.put(manifest, "attribute_not_exists(pk)");
  } else if (manifest.status === "done") {
    if (existing.length !== 1 || fieldText(existing[0]!.fields["核对指纹"]) !== manifest.targetFingerprint) throw new Error(`广告月报 ${key} 已归档基线与清单不一致。`);
    const throughDate = String(manifest.throughDate ?? "");
    if (group.some((item) => new Date(Number(item.fields["站点日期"])).toISOString().slice(0, 10) <= throughDate)) throw new Error(`广告月报 ${key} 已归档日期又出现日报，拒绝双算。`);
    const prior = existing[0]!.fields;
    const priorDays = Number(prior["来源日数"]);
    if (!Number.isFinite(priorDays) || priorDays < 0) throw new Error(`广告月报 ${key} 来源日数无效。`);
    const totals = Object.fromEntries(retentionMetrics.map((name) => [name, Number(prior[name]) + group.reduce((sum, row) => sum + number(row.fields[name]), 0)])) as Record<(typeof retentionMetrics)[number], number>;
    if (retentionMetrics.some((name) => !Number.isFinite(Number(prior[name])) || !Number.isFinite(totals[name]))) throw new Error(`广告月报 ${key} 已有金额或数量无效。`);
    const fingerprint = sha256(`${manifest.targetFingerprint}\n${sha256(group.map((item) => `${item.record_id}|${JSON.stringify(item.fields)}`).sort().join("\n"))}`);
    const first = group[0]!;
    const fields = {
      "记录唯一键": key, "月份": key.slice(0, 7), "Profile ID": fieldText(first.fields["Profile ID"]), "活动ID": fieldText(first.fields["活动ID"]), "活动名称": fieldText(first.fields["活动名称"]),
      ...totals, "ACOS": totals.广告销售额 ? totals.花费 / totals.广告销售额 : 0, "ROAS": totals.花费 ? totals.广告销售额 / totals.花费 : 0,
      "CTR": totals.曝光 ? totals.点击 / totals.曝光 : 0, "CPC": totals.点击 ? totals.花费 / totals.点击 : 0, "CVR": totals.点击 ? totals.广告订单 / totals.点击 : 0,
      "CPO": totals.广告订单 ? totals.花费 / totals.广告订单 : 0, "来源日数": priorDays + new Set(group.map((item) => Number(item.fields["站点日期"]))).size,
      "核对指纹": fingerprint, "核对时间": Date.now(),
    };
    manifest = { ...manifest, pk: "ADS_RETENTION", sk: key, status: "prepared", throughDate: new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).toISOString().slice(0, 10), sourceWindowEnd: new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).toISOString().slice(0, 10), sourceDayCount: fields["来源日数"], targetFingerprint: fingerprint, pendingIds: group.map((item) => item.record_id), targetFields: fields, updatedAt: new Date().toISOString() };
    await state.put(manifest);
  }
  const pendingIds = Array.isArray(manifest.pendingIds) ? manifest.pendingIds.map(String) : [];
  const fingerprint = String(manifest.targetFingerprint ?? "");
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error(`广告月报 ${key} 归档清单缺少指纹。`);
  let deleted = 0;
  if (manifest.status === "prepared") {
    if (manifest.targetFields) await feishu.upsert(app, monthlyTable, { "记录唯一键": key }, manifest.targetFields as Record<string, unknown>);
    const verify = await feishu.searchRecords(app, monthlyTable, { "记录唯一键": key });
    if (verify.length !== 1 || fieldText(verify[0]!.fields["核对指纹"]) !== fingerprint) throw new Error(`广告月报核对失败，未删除日报: ${key}`);
    const present = new Set(group.map((item) => item.record_id));
    for (const id of pendingIds) if (present.has(id)) { await feishu.delete(app, dailyTable, id); deleted += 1; }
    const { targetFields: _targetFields, ...rest } = manifest;
    manifest = { ...rest, status: "done", pendingIds: [], targetFingerprint: fingerprint, updatedAt: new Date().toISOString() };
    await state.put(manifest);
  } else if (manifest.status !== "done") throw new Error(`广告月报 ${key} 归档清单状态未知。`);
  const remainingHere = group.some((item) => !pendingIds.includes(item.record_id));
  const remainingGroups = candidates.length - 1 + Number(remainingHere);
  if (remainingGroups) {
    const nextAt = new Date(Date.now() + 90_000);
    await ensureOneTimeSchedule({ taskType: "ads-retention", taskId: event.taskId ?? `ads-retention|${event.scheduledAt ?? ""}`, scheduledAt: nextAt.toISOString() }, nextAt);
    return { status: "waiting", archivedGroups: 1, deletedDailyRows: deleted, remainingGroups, nextAt: nextAt.toISOString() };
  }
  return { status: "done", archivedGroups: 1, deletedDailyRows: deleted, deferredGroups: groups.size - candidates.length };
}
