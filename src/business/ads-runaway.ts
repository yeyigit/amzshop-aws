import type { AppConfig, FeishuRecord, JobEvent, JsonObject } from "../types.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { flushNotification, prepareNotification } from "../notifications.js";
import { log } from "../log.js";
import { addDaysYmd, feishuFieldText } from "../util.js";
import { profiles } from "./ads.js";
import { type AdsSnapshot, type CatalogTarget, adGroupSkus, latestSnapshotDate, loadSnapshot, sumSeries, windowStart } from "./ads-snapshot.js";

// 关键词跑飞排查（规则见 docs/模块说明.md「广告」）：以最近一次调价为锚点，每 3 个完整站点日查一期；
// 只报启用中、3 天点击 ≥ 阈值且 0 单的投放（附点击最多的 3 个搜索词）与单个搜索词。只写「广告预警」与 ADS_RUNAWAY/state，有跑飞才发一条合并消息。
type Row = Record<string, unknown>;
export const RUNAWAY_DEFAULT_ANCHOR = "2026-10-05";
export const RUNAWAY_DEFAULT_MIN_CLICKS = 20;
export const RUNAWAY_PERIOD_DAYS = 3;
const MESSAGE_LIMIT = 30;
const EXECUTED = new Set(["已执行", "部分执行"]);
const MATCH_LABELS: Record<string, string> = { EXACT: "精准", PHRASE: "词组", BROAD: "广泛" };
const TARGETING_LABELS: Record<string, string> = { "close-match": "紧密匹配", "loose-match": "宽泛匹配", substitutes: "同类商品", complements: "关联商品" };

export interface RunawayItem {
  key: string; kind: "target" | "term"; sku: string; campaignId: string; campaignName: string; adGroupName: string;
  category: "关键词" | "商品投放" | "自动投放" | "搜索词"; objectId: string; objectName: string; matchType: string;
  clicks: number; spend: number; bid: number | null; topTerms: Array<{ term: string; clicks: number }>; repeatOf?: string;
}

const text = (value: unknown): string => String(value ?? "").trim();
const md = (ymd: string): string => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}`;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();
const adsDateMs = (date: string): number => Date.parse(`${date}T12:00:00Z`);

// 第几期：锚点后每满 3 个站点日为一期（锚点当天不算）。
export function runawayPeriod(anchor: string, end: string): number {
  return Math.floor(daysBetween(anchor, end) / RUNAWAY_PERIOD_DAYS);
}

function dateOf(value: unknown): string {
  const raw = feishuFieldText(value);
  const epoch = Number(raw);
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : "";
}

// 锚点：「广告调整记录」里已执行/部分执行的最新调整日期；还没有记录（或表未配置）时用 ADS_RUNAWAY_ANCHOR。
export async function runawayAnchor(config: AppConfig, feishu: FeishuClient): Promise<{ anchor: string; source: string }> {
  const fallback = config.optional("ADS_RUNAWAY_ANCHOR", RUNAWAY_DEFAULT_ANCHOR) || RUNAWAY_DEFAULT_ANCHOR;
  const table = config.optional("FEISHU_BITABLE_TABLE_ID_ADS_CHANGES");
  if (!table) return { anchor: fallback, source: "config" };
  const records = await feishu.searchRecords(config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS"), table, {}, { fieldNames: ["调整日期", "执行情况"] });
  const dates = records.filter((record) => EXECUTED.has(feishuFieldText(record.fields["执行情况"]))).map((record) => dateOf(record.fields["调整日期"])).filter(Boolean).sort();
  return dates.length ? { anchor: dates.at(-1)!, source: "changes" } : { anchor: fallback, source: "config" };
}

function targetLabel(target: CatalogTarget | undefined, meta: { keyword: string; targeting: string }): string {
  if (target?.kind === "keyword") return target.text || meta.keyword;
  const raw = meta.targeting || target?.text || meta.keyword;
  return TARGETING_LABELS[raw.toLowerCase()] ?? raw;
}

export function findRunaways(snapshot: AdsSnapshot, from: string, to: string, minClicks: number, profileId = snapshot.profileId): RunawayItem[] {
  const campaigns = new Map(snapshot.catalog.campaigns.map((item) => [item.campaignId, item]));
  const adGroups = new Map(snapshot.catalog.adGroups.map((item) => [item.adGroupId, item]));
  const targets = new Map(snapshot.catalog.targets.map((item) => [item.id, item]));
  const enabled = (target: CatalogTarget | undefined): boolean => !!target && target.state === "ENABLED" && adGroups.get(target.adGroupId)?.state === "ENABLED" && campaigns.get(target.campaignId)?.state === "ENABLED";
  const skuOf = (target: CatalogTarget): string => adGroupSkus(snapshot.catalog, target.adGroupId, target.campaignId).join("/");
  const items: RunawayItem[] = [];
  const flagged = new Set<string>();
  const termsByTarget = new Map<string, Array<{ term: string; clicks: number }>>();
  for (const term of snapshot.searchTerms.meta) {
    const clicks = sumSeries(snapshot.searchTerms.days[term.key], from, to).clicks;
    if (clicks > 0 && term.keywordId) termsByTarget.set(term.keywordId, [...(termsByTarget.get(term.keywordId) ?? []), { term: term.searchTerm, clicks }]);
  }
  for (const meta of snapshot.targets.meta) {
    const target = targets.get(meta.id);
    if (!enabled(target)) continue;
    const metrics = sumSeries(snapshot.targets.days[meta.id], from, to);
    if (metrics.clicks < minClicks || metrics.orders > 0) continue;
    const campaign = campaigns.get(target!.campaignId);
    const category = target!.kind === "keyword" ? "关键词" : target!.expressionType === "AUTO" || campaign?.targetingType === "AUTO" ? "自动投放" : "商品投放";
    flagged.add(meta.id);
    items.push({
      key: `${profileId}|${to}|target|${meta.id}`, kind: "target", sku: skuOf(target!), campaignId: target!.campaignId, campaignName: campaign?.name ?? "",
      adGroupName: adGroups.get(target!.adGroupId)?.name ?? "", category, objectId: meta.id, objectName: targetLabel(target, meta),
      matchType: MATCH_LABELS[target!.matchType] ?? "", clicks: metrics.clicks, spend: metrics.spend, bid: target!.bid ?? meta.bid,
      topTerms: (termsByTarget.get(meta.id) ?? []).sort((a, b) => b.clicks - a.clicks || a.term.localeCompare(b.term)).slice(0, 3),
    });
  }
  for (const term of snapshot.searchTerms.meta) {
    const parent = targets.get(term.keywordId);
    if (!enabled(parent) || flagged.has(term.keywordId)) continue;
    if (parent!.kind === "keyword" && normalize(parent!.text) === normalize(term.searchTerm)) continue;
    const metrics = sumSeries(snapshot.searchTerms.days[term.key], from, to);
    if (metrics.clicks < minClicks || metrics.orders > 0) continue;
    items.push({
      key: `${profileId}|${to}|term|${term.key}`, kind: "term", sku: skuOf(parent!), campaignId: parent!.campaignId, campaignName: campaigns.get(parent!.campaignId)?.name ?? "",
      adGroupName: adGroups.get(parent!.adGroupId)?.name ?? "", category: "搜索词", objectId: term.key, objectName: term.searchTerm,
      matchType: MATCH_LABELS[parent!.matchType] ?? "", clicks: metrics.clicks, spend: metrics.spend, bid: parent!.bid, topTerms: [],
    });
  }
  return items.sort((a, b) => b.spend - a.spend || b.clicks - a.clicks || a.key.localeCompare(b.key));
}

export function runawayLines(items: RunawayItem[], from: string, to: string, minClicks: number): string[] {
  const lines = [`🚨 关键词跑飞 ${md(from)}–${md(to)}（洛杉矶，3 天点击≥${minClicks}、0 单）`];
  for (const item of items.slice(0, MESSAGE_LIMIT)) {
    const label = item.kind === "term" ? `搜索词 ${item.objectName}` : `${item.objectName}（${item.matchType || item.category}）`;
    const parts = [item.sku || "未知SKU", item.campaignName, label, `点击 ${item.clicks}`, `$${item.spend.toFixed(2)}`];
    if (item.bid !== null) parts.push(`bid $${item.bid.toFixed(2)}`);
    if (item.topTerms.length) parts.push(`搜索词：${item.topTerms.map((term) => `${term.term} ${term.clicks}`).join("、")}`);
    lines.push(`• ${parts.join("｜")}${item.repeatOf ? `（上一期 ${md(item.repeatOf)} 也跑飞）` : ""}`);
  }
  lines.push(items.length > MESSAGE_LIMIT ? `共 ${items.length} 个，另 ${items.length - MESSAGE_LIMIT} 个见「广告预警」；处理后可把状态改成已处理。` : `共 ${items.length} 个；处理后可在「广告预警」把状态改成已处理。`);
  return lines;
}

export function runawayFields(item: RunawayItem, from: string, to: string): Row {
  return {
    "预警唯一键": item.key, "检查日期": adsDateMs(to), "统计区间": `${md(from)}–${md(to)}`, "SKU编号": item.sku,
    "活动名称": item.campaignName, "广告组名称": item.adGroupName, "类别": item.category, "对象名称": item.objectName, "匹配类型": item.matchType,
    "3日点击": item.clicks, "3日花费": item.spend, "当前bid": item.bid, "主要搜索词": item.topTerms.map((term) => `${term.term} ${term.clicks}`).join("、"), "对象ID": item.objectId,
  };
}

// 同一期重跑：已有行只更新数据列，不动「状态」（用户可能已改成已处理）；新行状态为待处理。
async function writeAlerts(config: AppConfig, feishu: FeishuClient, items: RunawayItem[], from: string, to: string): Promise<{ created: number; updated: number }> {
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS"), table = config.get("FEISHU_BITABLE_TABLE_ID_ADS_ALERTS");
  const existing = await feishu.searchRecords(app, table, {}, { fieldNames: ["预警唯一键"], conditions: [{ field_name: "检查日期", operator: "is", value: ["ExactDate", String(adsDateMs(to))] }] });
  const byKey = new Map<string, FeishuRecord>();
  for (const record of existing) byKey.set(feishuFieldText(record.fields["预警唯一键"]), record);
  const creates = items.filter((item) => !byKey.has(item.key)).map((item) => ({ ...runawayFields(item, from, to), "状态": "待处理" }));
  const updates = items.filter((item) => byKey.has(item.key)).map((item) => ({ recordId: byKey.get(item.key)!.record_id, fields: runawayFields(item, from, to) }));
  if (creates.length) await feishu.batchCreate(app, table, creates);
  if (updates.length) await feishu.batchUpdate(app, table, updates);
  return { created: creates.length, updated: updates.length };
}

export async function runAdsRunaway(event: JobEvent, config: AppConfig, state: StateStore, feishu: FeishuClient): Promise<JsonObject> {
  const end = await latestSnapshotDate(state);
  const force = event.cursor?.force === true;
  const minClicks = Math.max(1, Math.floor(Number(config.optional("ADS_RUNAWAY_MIN_CLICKS", String(RUNAWAY_DEFAULT_MIN_CLICKS))) || RUNAWAY_DEFAULT_MIN_CLICKS));
  const { anchor, source } = await runawayAnchor(config, feishu);
  const period = runawayPeriod(anchor, end);
  const saved = await state.get("ADS_RUNAWAY", "state");
  const checked = text(saved?.anchor) === anchor && Number(saved?.period ?? 0) >= period;
  const due = period >= 1 && !checked;
  const base = { anchor, anchorSource: source, siteDate: end, period, due };
  if (!due && !force) return { status: "done", ...base, result: "not_due" };
  if (!config.bool("ADS_RUNAWAY_ENABLED", true) && event.dryRun !== true) return { status: "done", ...base, result: "disabled" };

  const from = windowStart(end, RUNAWAY_PERIOD_DAYS);
  const previous = (saved?.flagged ?? {}) as Record<string, { siteDate?: string }>;
  const items: RunawayItem[] = [];
  for (const profile of profiles(config)) {
    for (const item of findRunaways(await loadSnapshot(state, end, profile.profileId), from, end, minClicks, profile.profileId)) {
      const objectKey = `${item.kind}|${item.objectId}`;
      const earlier = text(previous[objectKey]?.siteDate);
      items.push(earlier && earlier < end ? { ...item, repeatOf: earlier } : item);
    }
  }
  const summary = { ...base, window: `${from}~${end}`, minClicks, flagged: items.length, targets: items.filter((item) => item.kind === "target").length, terms: items.filter((item) => item.kind === "term").length };
  if (event.dryRun === true) return { status: "done", dryRun: true, ...summary, items: items as unknown as JsonObject[], lines: items.length ? runawayLines(items, from, end, minClicks) : [] };

  // 手动强制且未到期的一次用单独的通知键，不占用到期那一期的键；也不推进期数，只把本次跑飞对象并入“上一期”记录。
  const notificationKey = due ? `ads-runaway|${end}` : `ads-runaway|${end}|manual`;
  const prepared = items.length ? await prepareNotification(config, state, notificationKey, runawayLines(items, from, end, minClicks)) : undefined;
  const written = items.length ? await writeAlerts(config, feishu, items, from, end) : { created: 0, updated: 0 };
  const notification = await flushNotification(state, feishu, notificationKey, prepared);
  const flagged = Object.fromEntries(items.map((item) => [`${item.kind}|${item.objectId}`, { siteDate: end, bid: item.bid }]));
  const keptPeriod = text(saved?.anchor) === anchor ? Number(saved?.period ?? 0) : 0;
  await state.put({
    pk: "ADS_RUNAWAY", sk: "state", anchor, anchorSource: source, period: due ? period : keptPeriod,
    siteDate: end, checkedAt: new Date().toISOString(), flagged: due ? flagged : { ...previous, ...flagged }, updatedAt: new Date().toISOString(),
  });
  log("INFO", "ads_runaway_done", { siteDate: end, period, flagged: items.length, created: written.created, updated: written.updated });
  return { status: "done", ...summary, ...written, notification, nextCheckAfter: addDaysYmd(anchor, (Math.max(period, 0) + 1) * RUNAWAY_PERIOD_DAYS) };
}
