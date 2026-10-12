import type { AppConfig, FeishuRecord, JobEvent, JsonObject } from "../types.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { log } from "../log.js";
import { addDaysYmd, feishuFieldText, ymdInZone } from "../util.js";
import { loadSkuRegistry, marginResolution, profiles, type SkuInfo } from "./ads.js";
import {
  type AdsSnapshot, type Metrics, PLACEMENT_LABELS, adGroupSkus, deliveringSkus, emptyMetrics, latestSnapshotDate, loadSnapshot, metricsLine, ratios, salesWindow, sumSeries, windowStart,
} from "./ads-snapshot.js";
import { INVENTORY_HEALTH_PK, type SkuInventoryHealth } from "./inventory-health.js";
import { buildSqpPack, normalizeQuery, recentSqpWeeks, sqpSettings, type AdTermTotals, type SqpWeek } from "./sqp.js";

// 调价数据包（ads-review，只读）与写调价记忆（ads-memory，用户确认后由 Claude 手动调用；默认预览，cursor.apply=true 才写）。
// 规则见 docs/模块说明.md「广告」。只读写「广告调整记录」「SKU广告档案」，不碰亚马逊。
type Row = Record<string, unknown>;
const text = (value: unknown): string => String(value ?? "").trim();
const md = (ymd: string): string => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}`;
const adsDateMs = (date: string): number => Date.parse(`${date}T12:00:00Z`);
const isYmd = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);
const WINDOWS = [3, 7, 14, 30] as const;
const TERM_LIMIT = 80;

export const OBJECT_TYPES = ["关键词", "商品投放", "自动投放", "否定词", "广告位", "竞价策略", "预算", "广告活动", "广告组"] as const;
export const ACTIONS = ["提高竞价", "降低竞价", "提高位置加价", "降低位置加价", "暂停", "开启", "添加否定", "新增投放", "调整预算", "更改竞价策略"] as const;
export const REASONS = ["跑飞止损", "ACOS高于目标", "零单消耗", "表现好放量", "曝光不足", "广告位效率", "库存保护", "大促节奏", "清货", "测试", "其他"] as const;
export const SOURCES = ["Claude建议", "自行调整", "跑飞预警"] as const;
export const EXECUTIONS = ["已执行", "部分执行", "未采纳"] as const;
export const CONCLUSIONS = ["有效", "无效", "待观察", "数据不足"] as const;
export const STAGES = ["新品期", "成长期", "成熟期", "清货", "断货保护", "暂停推广"] as const;
const STRATEGY_LABELS: Record<string, string> = { LEGACY_FOR_SALES: "动态竞价-只降低", AUTO_FOR_SALES: "动态竞价-提高和降低", MANUAL: "固定竞价", RULE_BASED: "基于规则的竞价" };

function dateOf(value: unknown): string {
  const raw = feishuFieldText(value);
  const epoch = Number(raw);
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : "";
}

function compact(metrics: Metrics): JsonObject {
  const derived = ratios(metrics);
  return { impr: metrics.impressions, clicks: metrics.clicks, spend: metrics.spend, sales: metrics.sales, orders: metrics.orders, acos: derived.acos, cpc: derived.cpc, cvr: derived.cvr };
}

// 调整对象 → 按天序列：投放按对象ID；广告位按「活动ID|TOP/REST/PRODUCT」；否定词、竞价策略、预算、广告活动按活动汇总；广告组按广告组汇总。
export function objectMetrics(snapshot: AdsSnapshot, objectType: string, objectId: string, campaignId: string, from: string, to: string): Metrics | null {
  if (["关键词", "商品投放", "自动投放"].includes(objectType)) return snapshot.targets.days[objectId] || snapshot.catalog.targets.some((item) => item.id === objectId) ? sumSeries(snapshot.targets.days[objectId], from, to) : null;
  if (objectType === "广告位") return snapshot.placements.meta.some((item) => item.key === objectId) || snapshot.catalog.campaigns.some((item) => objectId.startsWith(`${item.campaignId}|`)) ? sumSeries(snapshot.placements.days[objectId], from, to) : null;
  const group = objectType === "广告组" ? objectId : campaignId;
  const members = snapshot.targets.meta.filter((item) => (objectType === "广告组" ? item.adGroupId : item.campaignId) === group);
  if (!group || (!members.length && !snapshot.catalog.campaigns.some((item) => item.campaignId === campaignId))) return null;
  const total = emptyMetrics();
  for (const item of members) sumSeries(snapshot.targets.days[item.id], from, to, total);
  return total;
}

export function basisText(snapshot: AdsSnapshot, objectType: string, objectId: string, campaignId: string): string {
  const end = snapshot.siteDate;
  const parts = [7, 14, 30].map((days) => objectMetrics(snapshot, objectType, objectId, campaignId, windowStart(end, days), end));
  if (parts.some((item) => item === null)) return "";
  return [`截至 LA ${md(end)}`, ...parts.map((item, index) => metricsLine(`${[7, 14, 30][index]}日`, item!))].join("｜");
}

// ---------- 数据包 ----------

async function searchSince(feishu: FeishuClient, app: string, table: string, field: string, since: string): Promise<FeishuRecord[]> {
  return feishu.searchRecords(app, table, {}, { conditions: [{ field_name: field, operator: "isGreater", value: ["ExactDate", String(adsDateMs(addDaysYmd(since, -1)))] }] });
}

function fieldsOf(record: FeishuRecord | undefined, names: string[]): JsonObject {
  const output: JsonObject = {};
  for (const name of names) {
    const value = record?.fields[name];
    if (value === undefined || value === null || value === "") continue;
    output[name] = /日期|时间/.test(name) && typeof value === "number" ? dateOf(value) : feishuFieldText(value);
  }
  return output;
}

const PROFILE_FIELDS = ["阶段", "广告目标", "核心词", "禁区与约束", "经验结论", "当前观察", "最近调价日期", "下次复盘日期", "更新时间"];
const SQP_PACK_WEEKS = 4;
// 清库存口径的适用条件（docs/模块说明.md「店铺健康、库龄与 SQP」）：亚马逊标为冗余（Excess），
// 或已有超 180 天的件且按近 30 天速度卖完可售库存要 6 个月以上。不用亚马逊的 days-of-supply：它含为大促备的在途货，
// 会把库存健康的主力款也算成超 180 天。
const CLEARANCE_MONTHS = 6;

export interface ReviewExtras { sqpWeeks?: Array<{ week: string; data: SqpWeek }>; sqpLimit?: number; inventory?: Map<string, SkuInventoryHealth>; inventoryDate?: string }

export function inventoryPack(item: SkuInventoryHealth | undefined, snapshotDate = ""): JsonObject | null {
  if (!item) return null;
  return {
    snapshotDate, status: item.status, available: item.available, inbound: item.inbound, daysOfSupply: item.daysOfSupply, excess: item.excess,
    aged181: item.aged181, newAged90: item.newAged90, storageNextMonth: item.storageNextMonth, aisNextMonth: item.aisNextMonth, holdingPerUnit: item.holdingPerUnit,
    monthsToClear: item.monthsToClear, price: item.price, cashPerUnit: item.cashPerUnit, cashAcos: item.cashAcos,
    clearanceLens: item.status === "Excess" || (item.aged181 > 0 && item.monthsToClear !== null && item.monthsToClear > CLEARANCE_MONTHS),
  };
}

// 本 SKU 广告组的全部搜索词近 30 天合计（小写、连续空白合成一个后的全文为键，与 SQP 搜索词同一口径），供 SQP 对照。
export function adTermTotals(snapshot: AdsSnapshot, belongs: (adGroupId: string, campaignId: string) => boolean, from: string, to: string): Map<string, AdTermTotals> {
  const output = new Map<string, AdTermTotals>();
  for (const term of snapshot.searchTerms.meta) {
    if (!belongs(term.adGroupId, term.campaignId)) continue;
    const key = normalizeQuery(term.searchTerm);
    if (!key) continue;
    const metrics = sumSeries(snapshot.searchTerms.days[term.key], from, to);
    const current = output.get(key) ?? { clicks: 0, orders: 0, spend: 0 };
    output.set(key, { clicks: current.clicks + metrics.clicks, orders: current.orders + metrics.orders, spend: Math.round((current.spend + metrics.spend) * 100) / 100 });
  }
  return output;
}

export function buildReviewPack(snapshot: AdsSnapshot, registry: SkuInfo[], skus: string[], memory: { profiles: FeishuRecord[]; changes: FeishuRecord[]; alerts: FeishuRecord[]; inventory: FeishuRecord[] }, extras: ReviewExtras = {}): JsonObject[] {
  const end = snapshot.siteDate;
  const window = (days: number): [string, string] => [windowStart(end, days), end];
  // SKU 归属按广告组（一个广告组只属于一个 SKU）；多 SKU 活动（如 sp_asin）只算本 SKU 广告组的投放，广告位数据是活动级、标出与哪些 SKU 共用。
  const belongs = (sku: string, adGroupId: string, campaignId: string): boolean => adGroupSkus(snapshot.catalog, adGroupId, campaignId).includes(sku);
  const campaignSkus = (campaignId: string): string[] => [...new Set(snapshot.catalog.adGroups.filter((item) => item.campaignId === campaignId).flatMap((item) => adGroupSkus(snapshot.catalog, item.adGroupId, campaignId)))];
  const adGroups = new Map(snapshot.catalog.adGroups.map((item) => [item.adGroupId, item]));
  const catalogTargets = new Map(snapshot.catalog.targets.map((item) => [item.id, item]));
  const targetMeta = new Map(snapshot.targets.meta.map((item) => [item.id, item]));
  const bySku = <T extends FeishuRecord>(records: T[], field: string, sku: string): T[] => records.filter((record) => feishuFieldText(record.fields[field]) === sku);
  return skus.map((sku) => {
    const info = registry.find((item) => item.sku === sku);
    const rule = marginResolution(info, "SKU信息表里没有该 SKU");
    const ownMeta = snapshot.targets.meta.filter((meta) => belongs(sku, meta.adGroupId, meta.campaignId));
    const campaignIds = new Set([...snapshot.catalog.adGroups.filter((group) => belongs(sku, group.adGroupId, group.campaignId)).map((group) => group.campaignId), ...ownMeta.map((meta) => meta.campaignId)]);
    const campaigns = snapshot.catalog.campaigns.filter((item) => campaignIds.has(item.campaignId));
    const sumOwn = (days: number, campaignId?: string): Metrics => { const total = emptyMetrics(); for (const meta of ownMeta) if (!campaignId || meta.campaignId === campaignId) sumSeries(snapshot.targets.days[meta.id], ...window(days), total); return total; };
    const ad = Object.fromEntries([7, 14, 30].map((days) => {
      const total = sumOwn(days);
      const sales = salesWindow(snapshot.skuSales[sku], ...window(days));
      return [String(days), { ...compact(total), totalSales: sales.sales, totalOrders: sales.orders, totalUnits: sales.units, tacos: sales.sales ? Number((total.spend / sales.sales).toFixed(4)) : null, adOrderShare: sales.orders ? Number((total.orders / sales.orders).toFixed(4)) : null }];
    }));
    const targets = snapshot.catalog.targets.filter((item) => belongs(sku, item.adGroupId, item.campaignId)).map((target) => {
      const meta = targetMeta.get(target.id);
      const w = Object.fromEntries(WINDOWS.map((days) => [String(days), compact(sumSeries(snapshot.targets.days[target.id], ...window(days)))]));
      return { id: target.id, campaign: campaigns.find((item) => item.campaignId === target.campaignId)?.name ?? "", adGroup: adGroups.get(target.adGroupId)?.name ?? "", kind: target.kind, text: target.kind === "keyword" ? target.text : meta?.targeting || target.text, matchType: target.matchType, expressionType: target.expressionType, state: target.state, bid: target.bid, w };
    }).filter((item) => item.state === "ENABLED" || Number((item.w["30"] as JsonObject).clicks) > 0 || Number((item.w["30"] as JsonObject).impr) > 0);
    const terms = snapshot.searchTerms.meta.filter((item) => belongs(sku, item.adGroupId, item.campaignId)).map((term) => {
      const w = Object.fromEntries([7, 14, 30].map((days) => [String(days), compact(sumSeries(snapshot.searchTerms.days[term.key], ...window(days)))]));
      const target = catalogTargets.get(term.keywordId);
      return { term: term.searchTerm, campaign: campaigns.find((item) => item.campaignId === term.campaignId)?.name ?? "", target: target?.kind === "keyword" ? `${target.text}（${term.matchType}）` : term.targeting || term.keyword, targetId: term.keywordId, w };
    }).filter((item) => Number((item.w["30"] as JsonObject).clicks) >= 3 || Number((item.w["30"] as JsonObject).orders) >= 1)
      .sort((a, b) => Number((b.w["30"] as JsonObject).spend) - Number((a.w["30"] as JsonObject).spend)).slice(0, TERM_LIMIT);
    const changes = bySku(memory.changes, "SKU编号", sku).map((record) => {
      const fields = fieldsOf(record, ["记录唯一键", "调整日期", "调整对象", "对象名称", "匹配类型", "调整动作", "原值", "新值", "原因分类", "调整原因", "调整前数据", "来源", "执行情况", "复盘日期", "复盘结论", "复盘数据", "活动ID", "对象ID"]);
      const date = text(fields["调整日期"]);
      const days = date && date < end ? Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000) : 0;
      const after = days > 0 ? objectMetrics(snapshot, text(fields["调整对象"]), text(fields["对象ID"]), text(fields["活动ID"]), addDaysYmd(date, 1), end) : null;
      const beforeFrom = addDaysYmd(date || end, -days);
      const before = days > 0 && beforeFrom >= windowStart(end, 30) ? objectMetrics(snapshot, text(fields["调整对象"]), text(fields["对象ID"]), text(fields["活动ID"]), beforeFrom, addDaysYmd(date, -1)) : null;
      return { ...fields, ...(after ? { afterDays: days, after: compact(after) } : {}), ...(before ? { sameLengthBefore: compact(before) } : {}) } as JsonObject;
    }).sort((a, b) => text(b["调整日期"]).localeCompare(text(a["调整日期"])));
    const inventory = bySku(memory.inventory, "SKU", sku)[0];
    // ASIN 没有映射时取只挂本 SKU 的活动的广告 ASIN；多 SKU 活动（如 sp_asin）的 ASIN 可能是别的 SKU 的，不取。
    const adAsin = campaigns.find((item) => item.skus.length === 1 && item.skus[0] === sku && item.asins.length === 1)?.asins[0];
    const asin = info?.asin || adAsin || "";
    const sqp = extras.sqpWeeks?.length ? buildSqpPack(extras.sqpWeeks, asin.toUpperCase(), adTermTotals(snapshot, (adGroupId, campaignId) => belongs(sku, adGroupId, campaignId), ...window(30)), extras.sqpLimit ?? 25) : null;
    return {
      sku, asin, name: info?.name ?? "",
      margin: rule.marginRate, targetAcos: rule.targetAcos, breakEvenAcos: rule.breakEvenAcos, clearance: rule.clearance, ruleNote: rule.dataAnomaly,
      profile: fieldsOf(bySku(memory.profiles, "SKU编号", sku)[0], PROFILE_FIELDS),
      inventory: fieldsOf(inventory, ["FBA可售", "FBA可售覆盖天数", "全链路覆盖天数", "30日销量", "预警等级", "预警原因", "数据状态"]),
      inventoryHealth: inventoryPack(extras.inventory?.get(sku), extras.inventoryDate),
      sqp,
      totals: ad,
      campaigns: campaigns.map((campaign) => ({
        id: campaign.campaignId, name: campaign.name, state: campaign.state, targetingType: campaign.targetingType, budget: campaign.budget,
        strategy: STRATEGY_LABELS[campaign.strategy] ?? campaign.strategy, placementAdjust: campaign.placements,
        sharedWithSkus: campaignSkus(campaign.campaignId).filter((item) => item !== sku),
        adGroups: snapshot.catalog.adGroups.filter((group) => group.campaignId === campaign.campaignId && belongs(sku, group.adGroupId, group.campaignId)).map((group) => ({ id: group.adGroupId, name: group.name, state: group.state, defaultBid: group.defaultBid })),
        w: Object.fromEntries([7, 14, 30].map((days) => [String(days), compact(sumOwn(days, campaign.campaignId))])),
        placements: snapshot.placements.meta.filter((item) => item.campaignId === campaign.campaignId).map((item) => ({
          code: item.placement, label: PLACEMENT_LABELS[item.placement] ?? item.placement, adjust: campaign.placements[item.placement] ?? null,
          w: Object.fromEntries([7, 14, 30].map((days) => [String(days), compact(sumSeries(snapshot.placements.days[item.key], ...window(days)))])),
        })),
      })),
      targets, searchTerms: terms, changes,
      alerts: bySku(memory.alerts, "SKU编号", sku).map((record) => fieldsOf(record, ["检查日期", "统计区间", "类别", "对象名称", "匹配类型", "3日点击", "3日花费", "当前bid", "主要搜索词", "状态"])),
    } as unknown as JsonObject;
  });
}

export async function runAdsReview(event: JobEvent, config: AppConfig, state: StateStore, feishu: FeishuClient): Promise<JsonObject> {
  const end = await latestSnapshotDate(state);
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const registry = await loadSkuRegistry(config, feishu);
  const wanted = Array.isArray(event.cursor?.skus) ? (event.cursor!.skus as unknown[]).map(text).filter(Boolean) : [];
  const [profileRows, changeRows, alertRows, inventoryRows] = await Promise.all([
    feishu.listRecords(app, config.get("FEISHU_BITABLE_TABLE_ID_ADS_PROFILES")),
    searchSince(feishu, app, config.get("FEISHU_BITABLE_TABLE_ID_ADS_CHANGES"), "调整日期", addDaysYmd(end, -90)),
    searchSince(feishu, app, config.get("FEISHU_BITABLE_TABLE_ID_ADS_ALERTS"), "检查日期", addDaysYmd(end, -30)),
    feishu.listRecords(app, config.get("FEISHU_BITABLE_TABLE_ID_INVENTORY_ALERTS")),
  ]);
  // 库存健康与 SQP 取不到时数据包照出，只在结果里注明（不让调价因附加数据失败）。
  const notes: string[] = [];
  const extras: ReviewExtras = {};
  try {
    const latest = await state.get(INVENTORY_HEALTH_PK, "latest");
    const items = (Array.isArray(latest?.skus) ? latest!.skus : []) as unknown as SkuInventoryHealth[];
    extras.inventory = new Map(items.map((item) => [item.sku, item]));
    extras.inventoryDate = text(latest?.snapshotDate);
    if (!items.length) notes.push("还没有库存健康数据（inventory-health 未运行过）");
  } catch (error) { notes.push(`库存健康数据读取失败：${String((error as Error).message ?? error).slice(0, 120)}`); }
  try {
    extras.sqpWeeks = await recentSqpWeeks(state, SQP_PACK_WEEKS);
    extras.sqpLimit = sqpSettings(config).packQueries;
    if (!extras.sqpWeeks.length) notes.push("还没有 SQP 数据（sqp 未运行过）");
  } catch (error) { notes.push(`SQP 数据读取失败：${String((error as Error).message ?? error).slice(0, 120)}`); }
  const packs: JsonObject[] = [];
  for (const profile of profiles(config)) {
    const snapshot = await loadSnapshot(state, end, profile.profileId);
    const skus = wanted.length ? wanted : deliveringSkus(snapshot.catalog);
    packs.push({ profileId: profile.profileId, skus: buildReviewPack(snapshot, registry, skus, { profiles: profileRows, changes: changeRows, alerts: alertRows, inventory: inventoryRows }, extras) as unknown as JsonObject[] });
  }
  log("INFO", "ads_review_done", { siteDate: end, skus: packs.reduce((sum, pack) => sum + (pack.skus as unknown[]).length, 0), notes: notes.length });
  return {
    status: "done", siteDate: end, generatedAt: new Date().toISOString(),
    windows: Object.fromEntries(WINDOWS.map((days) => [String(days), `${windowStart(end, days)}~${end}`])),
    rules: {
      targetAcos: "毛利率 − 10 个百分点（不低于 0）", breakEvenAcos: "毛利率", clearance: "毛利率 < 10%", attribution: "订单为 7 天归因；最近 1–2 天的订单可能还没归因完",
      clearanceLens: "inventoryHealth.clearanceLens 为真（亚马逊标为冗余，或已有超 180 天的件且按近 30 天速度卖完要 6 个月以上）时并列给常规目标与清库存线：现金盈亏线 ACOS＝每件回款 ÷ 现价（每件回款＝现价×(1−佣金率)−FBA 配送费，采购与头程不计）；改不改由用户定",
      sqp: "sqp 是该 ASIN 自然加广告的合计（周数据，晚 3–5 天出），份额为百分数；ad30 是同一搜索词近 30 天的广告点击、订单、花费（7 天归因），两者只作对照、不相减",
    },
    ...(notes.length ? { notes } : {}),
    profiles: packs,
  };
}

// ---------- 写调价记忆 ----------

interface ChangeInput { sku: string; objectType: string; objectId: string; objectName: string; matchType: string; campaignId: string; action: string; before: string; after: string; reasonCategory: string; reason: string; source: string; execution: string; adjustedOn: string; reviewOn: string; basis: string }
interface ReviewInput { key: string; conclusion: string; data: string; reviewOn: string }
interface ProfileInput { sku: string; fields: Row }

function oneOf(value: string, allowed: readonly string[], label: string, problems: string[], fallback = ""): string {
  const chosen = value || fallback;
  if (!allowed.includes(chosen)) problems.push(`${label}「${chosen || "（空）"}」不在可选值里：${allowed.join("/")}`);
  return chosen;
}

function adjustedDate(raw: Row, now: Date): string {
  const on = text(raw.adjustedOn);
  if (on) return on;
  const at = text(raw.adjustedAt);
  const time = at ? new Date(at) : now;
  return Number.isFinite(time.getTime()) ? ymdInZone(time, "America/Los_Angeles") : "";
}

export function parseMemoryInput(cursor: JsonObject | undefined, now = new Date()): { changes: ChangeInput[]; reviews: ReviewInput[]; profiles: ProfileInput[]; problems: string[] } {
  const problems: string[] = [];
  const list = (name: string): Row[] => Array.isArray(cursor?.[name]) ? cursor![name] as unknown as Row[] : [];
  const changes = list("changes").map((raw, index): ChangeInput => {
    const label = `changes[${index}]`;
    const item: ChangeInput = {
      sku: text(raw.sku), objectType: oneOf(text(raw.objectType), OBJECT_TYPES, `${label}.objectType`, problems), objectId: text(raw.objectId), objectName: text(raw.objectName),
      matchType: text(raw.matchType), campaignId: text(raw.campaignId), action: oneOf(text(raw.action), ACTIONS, `${label}.action`, problems), before: text(raw.before), after: text(raw.after),
      reasonCategory: oneOf(text(raw.reasonCategory), REASONS, `${label}.reasonCategory`, problems), reason: text(raw.reason),
      source: oneOf(text(raw.source), SOURCES, `${label}.source`, problems, "Claude建议"), execution: oneOf(text(raw.execution), EXECUTIONS, `${label}.execution`, problems, "已执行"),
      adjustedOn: adjustedDate(raw, now), reviewOn: text(raw.reviewOn), basis: text(raw.basis),
    };
    if (!item.sku) problems.push(`${label}.sku 不能为空`);
    if (!item.objectName && !item.objectId) problems.push(`${label} 需要 objectName 或 objectId`);
    if (!item.reason) problems.push(`${label}.reason 不能为空`);
    if (!isYmd(item.adjustedOn)) problems.push(`${label} 调整日期无效（adjustedOn 用 YYYY-MM-DD 洛杉矶日期，或 adjustedAt 用带时区的 ISO 时间）`);
    if (item.reviewOn && !isYmd(item.reviewOn)) problems.push(`${label}.reviewOn 必须是 YYYY-MM-DD`);
    return item;
  });
  const reviews = list("reviews").map((raw, index): ReviewInput => {
    const item = { key: text(raw.key), conclusion: oneOf(text(raw.conclusion), CONCLUSIONS, `reviews[${index}].conclusion`, problems), data: text(raw.data), reviewOn: text(raw.reviewOn) };
    if (!item.key) problems.push(`reviews[${index}].key 不能为空`);
    if (item.reviewOn && !isYmd(item.reviewOn)) problems.push(`reviews[${index}].reviewOn 必须是 YYYY-MM-DD`);
    return item;
  });
  const names: Record<string, string> = { stage: "阶段", goal: "广告目标", coreKeywords: "核心词", constraints: "禁区与约束", lessons: "经验结论", watching: "当前观察", lastAdjustedOn: "最近调价日期", nextReviewOn: "下次复盘日期" };
  const profileInputs = list("profiles").map((raw, index): ProfileInput => {
    const sku = text(raw.sku);
    if (!sku) problems.push(`profiles[${index}].sku 不能为空`);
    const fields: Row = {};
    for (const [key, name] of Object.entries(names)) {
      if (raw[key] === undefined) continue;
      const value = text(raw[key]);
      if (key === "stage" && value) oneOf(value, STAGES, `profiles[${index}].stage`, problems);
      if ((key === "lastAdjustedOn" || key === "nextReviewOn") && value) { if (!isYmd(value)) problems.push(`profiles[${index}].${key} 必须是 YYYY-MM-DD`); fields[name] = adsDateMs(value); continue; }
      fields[name] = value;
    }
    return { sku, fields };
  });
  const keys = changes.map((item) => changeKey(item));
  const duplicated = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (duplicated.length) problems.push(`同一批里记录唯一键重复：${[...new Set(duplicated)].join("；")}`);
  return { changes, reviews, profiles: profileInputs, problems };
}

export const changeKey = (item: ChangeInput): string => `${item.adjustedOn}|${item.sku}|${item.objectType}|${item.objectId || item.objectName}|${item.action}`;

export function changeFields(item: ChangeInput, snapshot: AdsSnapshot | undefined): Row {
  const target = snapshot?.catalog.targets.find((entry) => entry.id === item.objectId);
  const adGroupId = target?.adGroupId || (item.objectType === "广告组" ? item.objectId : "");
  const adGroup = snapshot?.catalog.adGroups.find((entry) => entry.adGroupId === adGroupId);
  const campaignId = item.campaignId || target?.campaignId || adGroup?.campaignId || (item.objectType === "广告位" ? item.objectId.split("|")[0]! : ["广告活动", "竞价策略", "预算"].includes(item.objectType) ? item.objectId : "");
  const campaign = snapshot?.catalog.campaigns.find((entry) => entry.campaignId === campaignId);
  const objectName = item.objectName || target?.text || (item.objectType === "广告位" ? PLACEMENT_LABELS[item.objectId.split("|")[1] ?? ""] ?? "" : "") || campaign?.name || item.objectId;
  const basis = snapshot && (item.objectId || campaignId) ? basisText(snapshot, item.objectType, item.objectId, campaignId) : "";
  const changed = item.before || item.after ? `｜${item.before || "—"}→${item.after || "—"}` : "";
  return {
    "调整内容": `${item.action}｜${objectName}${item.matchType ? `（${item.matchType}）` : ""}${changed}`,
    "调整日期": adsDateMs(item.adjustedOn), "SKU编号": item.sku, "活动名称": campaign?.name ?? "", "广告组名称": adGroup?.name ?? "",
    "调整对象": item.objectType, "对象名称": objectName, "匹配类型": item.matchType, "调整动作": item.action, "原值": item.before, "新值": item.after,
    "原因分类": item.reasonCategory, "调整原因": item.reason, "调整前数据": basis || item.basis || "快照中没有该对象的数据",
    "来源": item.source, "执行情况": item.execution, "复盘日期": adsDateMs(item.reviewOn || addDaysYmd(item.adjustedOn, 7)),
    "活动ID": campaignId, "对象ID": item.objectId, "记录唯一键": changeKey(item),
  };
}

const CREATE_ONLY = new Set(["调整前数据", "复盘日期"]);
const withoutEmpty = (fields: Row): Row => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== "" && value !== null && value !== undefined));

export async function runAdsMemory(event: JobEvent, config: AppConfig, state: StateStore, feishu: FeishuClient): Promise<JsonObject> {
  const apply = event.cursor?.apply === true;
  const parsed = parseMemoryInput(event.cursor);
  if (parsed.problems.length) throw new Error(`调价记忆载荷有误：${parsed.problems.join("；")}`);
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const changesTable = config.get("FEISHU_BITABLE_TABLE_ID_ADS_CHANGES"), profilesTable = config.get("FEISHU_BITABLE_TABLE_ID_ADS_PROFILES");
  let snapshot: AdsSnapshot | undefined;
  try { snapshot = await loadSnapshot(state, await latestSnapshotDate(state), profiles(config)[0]!.profileId); }
  catch (error) { log("WARN", "ads_memory_snapshot_missing", { error: String((error as Error).message).slice(0, 200) }); }
  const [changeRows, profileRows, registry] = await Promise.all([feishu.listRecords(app, changesTable), feishu.listRecords(app, profilesTable), loadSkuRegistry(config, feishu)]);
  const changesByKey = new Map<string, FeishuRecord[]>();
  for (const record of changeRows) { const key = feishuFieldText(record.fields["记录唯一键"]); if (key) changesByKey.set(key, [...(changesByKey.get(key) ?? []), record]); }
  const profilesBySku = new Map<string, FeishuRecord[]>();
  for (const record of profileRows) { const sku = feishuFieldText(record.fields["SKU编号"]); if (sku) profilesBySku.set(sku, [...(profilesBySku.get(sku) ?? []), record]); }
  const duplicates = [...changesByKey].filter(([, list]) => list.length > 1).map(([key]) => key).concat([...profilesBySku].filter(([, list]) => list.length > 1).map(([sku]) => `档案 ${sku}`));
  if (duplicates.length) throw new Error(`飞书里已有重复行，先人工处理：${duplicates.slice(0, 5).join("；")}`);

  const changeCreates: Row[] = [], changeUpdates: Array<{ recordId: string; fields: Row }> = [];
  for (const item of parsed.changes) {
    const fields = changeFields(item, snapshot);
    const existing = changesByKey.get(changeKey(item))?.[0];
    if (existing) changeUpdates.push({ recordId: existing.record_id, fields: withoutEmpty(Object.fromEntries(Object.entries(fields).filter(([name]) => !CREATE_ONLY.has(name)))) });
    else changeCreates.push(withoutEmpty(fields));
  }
  const missingReviews = parsed.reviews.filter((item) => !changesByKey.has(item.key)).map((item) => item.key);
  if (missingReviews.length) throw new Error(`复盘找不到对应调整记录：${missingReviews.join("；")}`);
  for (const item of parsed.reviews) changeUpdates.push({ recordId: changesByKey.get(item.key)![0]!.record_id, fields: withoutEmpty({ "复盘结论": item.conclusion, "复盘数据": item.data, ...(item.reviewOn ? { "复盘日期": adsDateMs(item.reviewOn) } : {}) }) });

  // 档案：只改给出的字段；本批有已执行/部分执行的调整而没给「最近调价日期」时，自动取本批该 SKU 最新的调整日期。
  const latestAdjust = new Map<string, string>();
  for (const item of parsed.changes) if (item.execution !== "未采纳" && item.adjustedOn > (latestAdjust.get(item.sku) ?? "")) latestAdjust.set(item.sku, item.adjustedOn);
  const profileInputs = new Map(parsed.profiles.map((item) => [item.sku, { ...item.fields }]));
  for (const [sku, date] of latestAdjust) { const fields = profileInputs.get(sku) ?? {}; if (fields["最近调价日期"] === undefined) fields["最近调价日期"] = adsDateMs(date); profileInputs.set(sku, fields); }
  const profileCreates: Row[] = [], profileUpdates: Array<{ recordId: string; fields: Row }> = [];
  for (const [sku, fields] of profileInputs) {
    // 明确给了空字符串＝清空该字段（飞书用 null 清空）。
    const stamped: Row = { ...Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, value === "" ? null : value])), "更新时间": Date.now() };
    // 品名由系统填：取 SKU信息表「SKU名称」，建行时写；已有行品名为空时顺带补上，不覆盖已有品名。
    const name = registry.find((entry) => entry.sku === sku)?.name ?? "";
    const existing = profilesBySku.get(sku)?.[0];
    if (existing) profileUpdates.push({ recordId: existing.record_id, fields: { ...(name && !feishuFieldText(existing.fields["品名"]) ? { "品名": name } : {}), ...stamped } });
    else profileCreates.push(withoutEmpty({ "SKU编号": sku, "品名": name, ...stamped }));
  }
  const plan = { changes: { create: changeCreates.length, update: changeUpdates.length }, profiles: { create: profileCreates.length, update: profileUpdates.length } };
  if (!apply) return { status: "done", apply: false, ...plan, preview: { changeCreates, changeUpdates, profileCreates, profileUpdates } as unknown as JsonObject };

  // 同一 recordId 的多次更新（如同批既改调整又回填复盘）合并成一次。
  const merge = (rows: Array<{ recordId: string; fields: Row }>): Array<{ recordId: string; fields: Row }> => [...rows.reduce((map, row) => map.set(row.recordId, { recordId: row.recordId, fields: { ...map.get(row.recordId)?.fields, ...row.fields } }), new Map<string, { recordId: string; fields: Row }>()).values()];
  if (changeCreates.length) await feishu.batchCreate(app, changesTable, changeCreates);
  if (changeUpdates.length) await feishu.batchUpdate(app, changesTable, merge(changeUpdates));
  if (profileCreates.length) await feishu.batchCreate(app, profilesTable, profileCreates);
  if (profileUpdates.length) await feishu.batchUpdate(app, profilesTable, merge(profileUpdates));
  // 读回核对：本批每个记录唯一键、每个档案 SKU 都恰好一行。
  const [afterChanges, afterProfiles] = await Promise.all([feishu.listRecords(app, changesTable), feishu.listRecords(app, profilesTable)]);
  const count = (records: FeishuRecord[], field: string, value: string): number => records.filter((record) => feishuFieldText(record.fields[field]) === value).length;
  const wrong = [
    ...parsed.changes.map(changeKey).filter((key) => count(afterChanges, "记录唯一键", key) !== 1),
    ...[...profileInputs.keys()].filter((sku) => count(afterProfiles, "SKU编号", sku) !== 1).map((sku) => `档案 ${sku}`),
  ];
  if (wrong.length) throw new Error(`写入后读回不符：${wrong.slice(0, 5).join("；")}`);
  log("INFO", "ads_memory_written", { changes: parsed.changes.length, reviews: parsed.reviews.length, profiles: profileInputs.size });
  return { status: "done", apply: true, ...plan, verified: true };
}
