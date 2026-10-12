import { gunzipSync, gzipSync } from "node:zlib";
import type { StateStore } from "../state.js";
import { addDaysYmd, sha256 } from "../util.js";

// 每日分析快照（见 docs/模块说明.md「广告」）：每日广告任务把近 30 天投放、搜索词、广告位报表按天、
// 广告目录与逐 SKU 每日销售存进状态表，供关键词跑飞排查、调价数据包与写记忆读取；不再写飞书「投放词监控」。
type Row = Record<string, unknown>;
export type DayMetrics = [impressions: number, clicks: number, spend: number, sales: number, orders: number, units: number];
export type DaySeries = Record<string, DayMetrics>;
export type SalesDay = [sales: number, orders: number, units: number];
export interface Metrics { impressions: number; clicks: number; spend: number; sales: number; orders: number; units: number }
export interface TargetMeta { id: string; campaignId: string; adGroupId: string; keyword: string; targeting: string; keywordType: string; matchType: string; bid: number | null }
export interface TermMeta { key: string; campaignId: string; adGroupId: string; keywordId: string; keyword: string; targeting: string; matchType: string; searchTerm: string }
export interface PlacementMeta { key: string; campaignId: string; placement: string }
export interface SeriesPart<M> { meta: M[]; days: Record<string, DaySeries> }
export interface CatalogCampaign { campaignId: string; name: string; state: string; targetingType: string; budget: number | null; budgetType: string; strategy: string; placements: Record<string, number>; startDate: string; skus: string[]; asins: string[] }
// skus：该广告组启用中的商品广告的 SKU；allSkus：未归档的全部商品广告的 SKU（2026-10-09 晚加入，更早的快照没有这两项）。
export interface CatalogAdGroup { adGroupId: string; campaignId: string; name: string; state: string; defaultBid: number | null; skus?: string[]; allSkus?: string[] }
export interface CatalogTarget { id: string; campaignId: string; adGroupId: string; state: string; bid: number | null; kind: "keyword" | "target"; text: string; matchType: string; expressionType: string }
export interface CatalogSnapshot { campaigns: CatalogCampaign[]; adGroups: CatalogAdGroup[]; targets: CatalogTarget[] }
export interface AdsSnapshot {
  siteDate: string; profileId: string;
  targets: SeriesPart<TargetMeta>; searchTerms: SeriesPart<TermMeta>; placements: SeriesPart<PlacementMeta>;
  catalog: CatalogSnapshot; skuSales: Record<string, Record<string, SalesDay>>;
}

export const SNAPSHOT_PK = "ADS_SNAPSHOT";
export const SNAPSHOT_TTL_DAYS = 21;
const CHUNK_CHARS = 300_000;
// 必需部分；广告位可缺（发布前开跑的旧计划批次没有广告位报表），缺时按空处理。
export const SNAPSHOT_PARTS = ["targets", "searchTerms", "catalog"] as const;

const text = (value: unknown): string => String(value ?? "").trim();
const num = (value: unknown): number => { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; };
const cents = (value: number): number => Math.round(value * 100) / 100;
const optionalNumber = (value: unknown): number | null => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

// ---------- 存取：gzip+base64 分片；先写其余分片、最后写 000 号（带版本与分片数，作提交标记），读取只认与 000 号同版本的分片 ----------

export async function saveSnapshotPart(state: StateStore, siteDate: string, profileId: string, part: string, value: unknown, now = Date.now()): Promise<number> {
  const encoded = gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64");
  const chunks = Math.max(1, Math.ceil(encoded.length / CHUNK_CHARS));
  const version = `${now}-${sha256(encoded).slice(0, 8)}`;
  const expiresAt = Math.floor(now / 1000) + SNAPSHOT_TTL_DAYS * 86_400;
  const item = (index: number) => ({ pk: SNAPSHOT_PK, sk: `${siteDate}|${profileId}|${part}|${String(index).padStart(3, "0")}`, part, version, chunks, data: encoded.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS), createdAt: new Date(now).toISOString(), expiresAt });
  for (let index = chunks - 1; index >= 0; index -= 1) await state.put(item(index));
  return chunks;
}

export async function loadSnapshotParts(state: StateStore, siteDate: string, profileId: string, now = Date.now()): Promise<Map<string, unknown>> {
  const items = await state.queryPartition(SNAPSHOT_PK, { beginsWith: `${siteDate}|${profileId}|`, limit: 5_000 });
  const live = items.filter((item) => !(item.expiresAt !== undefined && Number(item.expiresAt) <= Math.floor(now / 1000)));
  const byPart = new Map<string, Row[]>();
  for (const item of live) { const part = text(item.part); byPart.set(part, [...(byPart.get(part) ?? []), item]); }
  const output = new Map<string, unknown>();
  for (const [part, list] of byPart) {
    const head = list.find((item) => text(item.sk).endsWith("|000"));
    if (!head) throw new Error(`广告快照 ${siteDate}/${part} 缺少首个分片。`);
    const version = text(head.version), chunks = num(head.chunks);
    const pieces: string[] = [];
    for (let index = 0; index < chunks; index += 1) {
      const piece = list.find((item) => text(item.sk).endsWith(`|${String(index).padStart(3, "0")}`) && text(item.version) === version);
      if (!piece) throw new Error(`广告快照 ${siteDate}/${part} 分片 ${index} 不完整。`);
      pieces.push(text(piece.data));
    }
    output.set(part, JSON.parse(gunzipSync(Buffer.from(pieces.join(""), "base64")).toString("utf8")) as unknown);
  }
  return output;
}

export async function loadSnapshot(state: StateStore, siteDate: string, profileId: string): Promise<AdsSnapshot> {
  const parts = await loadSnapshotParts(state, siteDate, profileId);
  const missing = SNAPSHOT_PARTS.filter((part) => !parts.has(part));
  if (missing.length) throw new Error(`广告快照 ${siteDate} 缺少 ${missing.join("、")}。`);
  const skuSales: AdsSnapshot["skuSales"] = {};
  for (const [part, value] of parts) if (part.startsWith("skuSales:")) skuSales[part.slice("skuSales:".length)] = value as Record<string, SalesDay>;
  return {
    siteDate, profileId,
    targets: parts.get("targets") as SeriesPart<TargetMeta>, searchTerms: parts.get("searchTerms") as SeriesPart<TermMeta>,
    placements: (parts.get("placements") as SeriesPart<PlacementMeta> | undefined) ?? { meta: [], days: {} }, catalog: parts.get("catalog") as CatalogSnapshot, skuSales,
  };
}

// 最新完整快照：ADS_LATEST_DAILY 指针在 DAILY 批次全部写完（含目录）后才更新。
export async function latestSnapshotDate(state: StateStore): Promise<string> {
  const pointer = await state.get("ADS_LATEST_DAILY", "ALL");
  const siteDate = text(pointer?.siteDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(siteDate)) throw new Error("还没有完整的每日广告快照（ADS_LATEST_DAILY 缺失）。");
  return siteDate;
}

// ---------- 由报表行构建按天序列（只存非零日） ----------

const dayMetrics = (row: Row): DayMetrics => [num(row.impressions), num(row.clicks), num(row.cost), num(row.sales7d), num(row.purchases7d), num(row.unitsSoldClicks7d)];

function addDay(days: Record<string, DaySeries>, key: string, date: string, value: DayMetrics): void {
  if (!date || value.every((item) => item === 0)) return;
  const series = (days[key] ??= {});
  const current = series[date] ?? [0, 0, 0, 0, 0, 0];
  series[date] = current.map((item, index) => index === 2 || index === 3 ? cents(item + value[index]!) : item + value[index]!) as DayMetrics;
}

export function targetSeries(rows: Row[]): SeriesPart<TargetMeta> {
  const meta = new Map<string, TargetMeta & { bidDate: string }>();
  const days: Record<string, DaySeries> = {};
  for (const row of rows) {
    const id = text(row.keywordId ?? row.targetId) || sha256([row.campaignId, row.adGroupId, row.keyword, row.targeting].map(text).join("|")).slice(0, 24);
    const date = text(row.date);
    const known = meta.get(id);
    const bid = optionalNumber(row.keywordBid);
    if (!known) meta.set(id, { id, campaignId: text(row.campaignId), adGroupId: text(row.adGroupId), keyword: text(row.keyword), targeting: text(row.targeting), keywordType: text(row.keywordType), matchType: text(row.matchType), bid, bidDate: date });
    else if (bid !== null && date >= known.bidDate) Object.assign(known, { bid, bidDate: date });
    addDay(days, id, date, dayMetrics(row));
  }
  return { meta: [...meta.values()].map(({ bidDate: _bidDate, ...item }) => item), days };
}

export const termKey = (row: Row): string => sha256([row.campaignId, row.adGroupId, row.keywordId, row.targeting, row.searchTerm].map(text).join("|")).slice(0, 24);

export function termSeries(rows: Row[]): SeriesPart<TermMeta> {
  const meta = new Map<string, TermMeta>();
  const days: Record<string, DaySeries> = {};
  for (const row of rows) {
    const key = termKey(row);
    if (!meta.has(key)) meta.set(key, { key, campaignId: text(row.campaignId), adGroupId: text(row.adGroupId), keywordId: text(row.keywordId), keyword: text(row.keyword), targeting: text(row.targeting), matchType: text(row.matchType), searchTerm: text(row.searchTerm) });
    addDay(days, key, text(row.date), dayMetrics(row));
  }
  return { meta: [...meta.values()], days };
}

// 报表 placementClassification → 位置代码；与活动竞价设置 placementBidding 的位置一一对应（站外没有加价）。
export function placementCode(value: unknown): string {
  const raw = text(value);
  if (/top of search/i.test(raw) || raw === "PLACEMENT_TOP") return "TOP";
  if (/detail page|product page/i.test(raw) || raw === "PLACEMENT_PRODUCT_PAGE") return "PRODUCT";
  if (/rest of search|other on-amazon/i.test(raw) || raw === "PLACEMENT_REST_OF_SEARCH") return "REST";
  if (/off amazon/i.test(raw)) return "OFF";
  if (raw === "SITE_AMAZON_BUSINESS") return "BUSINESS";
  return raw.toUpperCase() || "OTHER";
}
export const PLACEMENT_LABELS: Record<string, string> = { TOP: "搜索结果顶部（首页）", REST: "搜索结果其余位置", PRODUCT: "商品页面", OFF: "站外", BUSINESS: "亚马逊企业购" };

export function placementSeries(rows: Row[]): SeriesPart<PlacementMeta> {
  const meta = new Map<string, PlacementMeta>();
  const days: Record<string, DaySeries> = {};
  for (const row of rows) {
    const placement = placementCode(row.placementClassification);
    const key = `${text(row.campaignId)}|${placement}`;
    if (!meta.has(key)) meta.set(key, { key, campaignId: text(row.campaignId), placement });
    addDay(days, key, text(row.date), dayMetrics(row));
  }
  return { meta: [...meta.values()], days };
}

// ---------- 广告目录：只留启用与暂停（已归档不要），出价缺省取广告组默认出价 ----------

const AUTO_LABELS: Record<string, string> = { QUERY_HIGH_REL_MATCHES: "紧密匹配", QUERY_BROAD_REL_MATCHES: "宽泛匹配", ASIN_SUBSTITUTE_RELATED: "同类商品", ASIN_ACCESSORY_RELATED: "关联商品" };
const MANUAL_LABELS: Record<string, string> = { ASIN_SAME_AS: "ASIN", ASIN_CATEGORY_SAME_AS: "类目", ASIN_BRAND_SAME_AS: "品牌", ASIN_EXPANDED_FROM: "扩展ASIN" };

function expressionText(target: Row): string {
  const expression = (Array.isArray(target.resolvedExpression) && target.resolvedExpression.length ? target.resolvedExpression : target.expression) as Row[] | undefined;
  if (!Array.isArray(expression) || !expression.length) return "";
  return expression.map((part) => {
    const type = text(part.type);
    const value = text(typeof part.value === "object" ? JSON.stringify(part.value) : part.value);
    return AUTO_LABELS[type] ?? `${MANUAL_LABELS[type] ?? type}${value ? ` ${value}` : ""}`;
  }).join("、");
}

const entityState = (row: Row): string => text(row.state ?? "ENABLED").toUpperCase();
const live = (row: Row): boolean => entityState(row) !== "ARCHIVED";

export function catalogSnapshot(catalog: { campaigns: Row[]; adGroups: Row[]; keywords: Row[]; targets: Row[]; productAds: Row[] }): CatalogSnapshot {
  const campaigns = catalog.campaigns.filter(live);
  const campaignIds = new Set(campaigns.map((item) => text(item.campaignId)));
  const adGroups = catalog.adGroups.filter((item) => live(item) && campaignIds.has(text(item.campaignId)));
  const defaultBid = new Map(adGroups.map((item) => [text(item.adGroupId), optionalNumber(item.defaultBid)]));
  const products = catalog.productAds.filter((item) => live(item) && campaignIds.has(text(item.campaignId)));
  const skusOf = (ads: Row[]): string[] => [...new Set(ads.map((item) => text(item.sku)).filter(Boolean))];
  const enabledFirst = (ads: Row[]): string[] => { const enabled = skusOf(ads.filter((item) => entityState(item) === "ENABLED")); return enabled.length ? enabled : skusOf(ads); };
  return {
    campaigns: campaigns.map((campaign) => {
      const id = text(campaign.campaignId);
      const bidding = (campaign.dynamicBidding ?? {}) as Row;
      const placements: Record<string, number> = {};
      for (const item of Array.isArray(bidding.placementBidding) ? bidding.placementBidding as Row[] : []) placements[placementCode(item.placement)] = num(item.percentage);
      const budget = campaign.budget as Row | number | undefined;
      const own = products.filter((item) => text(item.campaignId) === id);
      return {
        campaignId: id, name: text(campaign.name ?? campaign.campaignName), state: entityState(campaign), targetingType: text(campaign.targetingType).toUpperCase(),
        budget: optionalNumber(typeof budget === "object" ? budget?.budget : budget), budgetType: text(typeof budget === "object" ? budget?.budgetType : ""),
        strategy: text(bidding.strategy), placements, startDate: text(campaign.startDate),
        skus: enabledFirst(own), asins: [...new Set(own.map((item) => text(item.asin)).filter(Boolean))],
      };
    }),
    adGroups: adGroups.map((group) => {
      const own = products.filter((item) => text(item.adGroupId) === text(group.adGroupId));
      return { adGroupId: text(group.adGroupId), campaignId: text(group.campaignId), name: text(group.name), state: entityState(group), defaultBid: optionalNumber(group.defaultBid), skus: skusOf(own.filter((item) => entityState(item) === "ENABLED")), allSkus: skusOf(own) };
    }),
    targets: [
      ...catalog.keywords.filter((item) => live(item) && campaignIds.has(text(item.campaignId))).map((item): CatalogTarget => ({
        id: text(item.keywordId), campaignId: text(item.campaignId), adGroupId: text(item.adGroupId), state: entityState(item),
        bid: optionalNumber(item.bid) ?? defaultBid.get(text(item.adGroupId)) ?? null, kind: "keyword", text: text(item.keywordText), matchType: text(item.matchType).toUpperCase(), expressionType: "",
      })),
      ...catalog.targets.filter((item) => live(item) && campaignIds.has(text(item.campaignId))).map((item): CatalogTarget => ({
        id: text(item.targetId), campaignId: text(item.campaignId), adGroupId: text(item.adGroupId), state: entityState(item),
        bid: optionalNumber(item.bid) ?? defaultBid.get(text(item.adGroupId)) ?? null, kind: "target", text: expressionText(item), matchType: "", expressionType: text(item.expressionType).toUpperCase(),
      })),
    ],
  };
}

// ---------- SKU 归属：按广告组（用户 10/09：一个广告组只属于一个 SKU；活动可以挂多个广告组，如 sp_asin 每组一个 SKU） ----------

// 广告组的 SKU：启用中的商品广告 → 未归档的全部商品广告 → 活动的 SKU（2026-10-09 晚之前的快照没有广告组 SKU，按活动）。
export function adGroupSkus(catalog: CatalogSnapshot, adGroupId: string, campaignId: string): string[] {
  const group = catalog.adGroups.find((item) => item.adGroupId === adGroupId);
  if (group?.skus?.length) return group.skus;
  if (group?.allSkus?.length) return group.allSkus;
  return catalog.campaigns.find((item) => item.campaignId === campaignId)?.skus ?? [];
}

// 在投 SKU：活动、广告组、商品广告都启用。旧快照没有广告组 SKU 时退回“启用活动的 SKU”。
export function deliveringSkus(catalog: CatalogSnapshot): string[] {
  const enabled = new Set(catalog.campaigns.filter((item) => item.state === "ENABLED").map((item) => item.campaignId));
  const hasGroupSkus = catalog.adGroups.some((item) => item.skus !== undefined);
  const skus = hasGroupSkus
    ? catalog.adGroups.filter((item) => item.state === "ENABLED" && enabled.has(item.campaignId)).flatMap((item) => item.skus ?? [])
    : catalog.campaigns.filter((item) => item.state === "ENABLED").flatMap((item) => item.skus);
  return [...new Set(skus)].sort();
}

// ---------- 窗口计算 ----------

export const emptyMetrics = (): Metrics => ({ impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 });

export function sumSeries(series: DaySeries | undefined, from: string, to: string, into = emptyMetrics()): Metrics {
  for (const [date, value] of Object.entries(series ?? {})) {
    if (date < from || date > to) continue;
    into.impressions += value[0]; into.clicks += value[1]; into.spend = cents(into.spend + value[2]); into.sales = cents(into.sales + value[3]); into.orders += value[4]; into.units += value[5];
  }
  return into;
}

export const windowStart = (end: string, days: number): string => addDaysYmd(end, -(days - 1));

export function salesWindow(days: Record<string, SalesDay> | undefined, from: string, to: string): { sales: number; orders: number; units: number } {
  const total = { sales: 0, orders: 0, units: 0 };
  for (const [date, value] of Object.entries(days ?? {})) if (date >= from && date <= to) { total.sales = cents(total.sales + value[0]); total.orders += value[1]; total.units += value[2]; }
  return total;
}

export function ratios(metrics: Metrics): { acos: number | null; cpc: number | null; cvr: number | null; ctr: number | null } {
  return {
    acos: metrics.sales ? Number((metrics.spend / metrics.sales).toFixed(4)) : null,
    cpc: metrics.clicks ? cents(metrics.spend / metrics.clicks) : null,
    cvr: metrics.clicks ? Number((metrics.orders / metrics.clicks).toFixed(4)) : null,
    ctr: metrics.impressions ? Number((metrics.clicks / metrics.impressions).toFixed(4)) : null,
  };
}

const pct = (value: number | null): string => value === null ? "—" : `${(value * 100).toFixed(1)}%`;
export function metricsLine(label: string, metrics: Metrics): string {
  return `${label} 曝光${metrics.impressions} 点击${metrics.clicks} 花费$${metrics.spend.toFixed(2)} 订单${metrics.orders} 销售$${metrics.sales.toFixed(2)} ACOS ${pct(ratios(metrics).acos)}`;
}
