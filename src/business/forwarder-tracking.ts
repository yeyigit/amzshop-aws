import type { AppConfig, FeishuRecord, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore, completedStateExpiresAt } from "../state.js";
import { flushNotification, prepareNotification, type PreparedNotification } from "../notifications.js";
import {
  FORWARDER_IDS, FORWARDER_NAMES, FORWARDER_SHORT, MEISHE_DEFAULT_BASE_URL, MILESTONES, beijingWallTime, createForwarderAdapters, forwarderForCarrier, trackFacts,
  type ForwarderAdapter, type ForwarderEvent, type ForwarderId, type ForwarderTrack, type Milestone, type TrackFacts,
} from "../clients/forwarders.js";
import { log } from "../log.js";
import { errorText, feishuFieldText, ownerId, sha256 } from "../util.js";

// 物流商货件轨迹（规则见 docs/模块说明.md「物流商货件轨迹」）：物流商只管把货送进亚马逊仓，接收后的动态只能由亚马逊给出，
// 所以只写货件表这 7 列，承运商（人工，只读）与亚马逊来源的字段一律不碰。
export const FORWARDER_FIELDS = { node: "物流节点", latest: "物流最新动态", eta: "物流预计到港", signed: "物流签收时间", waybill: "物流商单号", trace: "物流轨迹", sync: "物流同步时间" } as const;
export const FORWARDER_FIELD_NAMES: readonly string[] = Object.values(FORWARDER_FIELDS);
export const FORWARDER_STATE_PK = "FORWARDER_TRACK";
export const forwarderHealthName = (id: ForwarderId): string => `forwarder-${id}`;
const LEASE_SCOPE = "forwarder-tracking";
const LEASE_MS = 15 * 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const SYNC_REFRESH_MS = 6 * HOUR;
export const SIGNED_GRACE_MS = 3 * DAY;
export const CLOSED_GRACE_MS = 7 * DAY;
export const MAX_AGE_MS = 180 * DAY;
export const FIRST_SEEN_NOTIFY_MS = 48 * HOUR;
export const DETECT_RETRY_MS = 6 * HOUR;
export const ETA_DELAY_DAYS = 2;
const TRACE_MAX_CHARS = 8_000;
const LATEST_MAX_CHARS = 300;
const MESSAGE_MAX_LINES = 40;
const STOP_NOW = new Set(["已取消", "已删除", "已作废", "已放弃"]);
const AMAZON_DONE = "已完成";
const NOTIFY_MILESTONES: readonly Milestone[] = ["已开船", "已到港", "已预约", "已签收"];
const REQUIRED_FIELDS = ["货件唯一键", "货件编号", "承运商", "当前状态", "目的仓", "货件创建时间", ...FORWARDER_FIELD_NAMES];

type Row = Record<string, unknown>;
type Mode = "hourly" | "backfill";
export interface ForwarderDeps { adapters?: Partial<Record<ForwarderId, ForwarderAdapter>>; now?: () => number }
interface Context { config: AppConfig; state: StateStore; feishu: FeishuClient; deps: ForwarderDeps }

interface Shipment { recordId: string; key: string; id: string; carrier: string; status: string; destination: string; createdAt?: number; fields: Row }
interface TrackState {
  pk: string; sk: string; shipmentId?: string; forwarder?: ForwarderId; detected?: boolean; waybillNo?: string; milestone?: string;
  eta?: string; etaBase?: string; signedAt?: number; notified?: string[]; firstSeenAt?: string; lastPolledAt?: string; lastFoundAt?: string; lastProbeAt?: string;
  notFoundSince?: string; signedSeenAt?: string; closedSeenAt?: string; stoppedAt?: string; stopReason?: string; recordId?: string; updatedAt?: string; expiresAt?: number;
}
interface Target { shipment: Shipment; saved?: TrackState; assigned?: ForwarderId; primary?: ForwarderId }
interface Change { key: string; line: string; exception: boolean; at?: number }
interface Outcome {
  shipment: Shipment; result: "found" | "not_found" | "unknown" | "ambiguous"; forwarder?: ForwarderId; facts?: TrackFacts;
  fields: Row; fresh: Change[]; next?: TrackState; stop?: string;
}

const text = (value: unknown): string => feishuFieldText(value);
const iso = (ms: number): string => new Date(ms).toISOString();
const time = (value: unknown): number => Date.parse(String(value ?? ""));
const truncate = (value: string, max: number): string => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const stripTag = (value: string): string => value.replace(/^(?:【[^】]{1,8}】\s*)+/, "").trim();
const rank = (milestone: string | undefined): number => MILESTONES.indexOf(milestone as Milestone);
const shortTime = (event: ForwarderEvent): string => event.time ? event.time.slice(5) : "";
const dayDiff = (from: string, to: string): number => Math.round(((beijingWallTime(to) ?? 0) - (beijingWallTime(from) ?? 0)) / DAY);

// 飞书文本单元格可能是字符串，也可能是富文本分段数组：拼回原文再比较（不能用逗号拼接）。
function cellText(value: unknown): string {
  if (Array.isArray(value)) return value.map((segment) => segment && typeof segment === "object" ? String((segment as Row).text ?? "") : String(segment ?? "")).join("").trim();
  return text(value);
}

function cellNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function shipmentOf(record: FeishuRecord): Shipment | undefined {
  const key = text(record.fields["货件唯一键"]);
  const id = text(record.fields["货件编号"]);
  if (!record.record_id || !key || !id) return undefined;
  const createdAt = cellNumber(record.fields["货件创建时间"]);
  return { recordId: record.record_id, key, id, carrier: text(record.fields["承运商"]), status: text(record.fields["当前状态"]), destination: text(record.fields["目的仓"]), ...(createdAt !== undefined ? { createdAt } : {}), fields: record.fields };
}

// 每小时只查：已在跟踪且未停止的，或尚未跟踪、亚马逊状态未结束、创建不超过 180 天的；回填不看停止条件（已取消等除外）。
// 承运商为其他物流商（含 AWD货件分销）不跟踪；为空时三家都查，未查到的 6 小时后再试。
function selectTargets(shipments: Shipment[], states: Map<string, TrackState>, mode: Mode, now: number): { targets: Target[]; stops: Array<{ shipment: Shipment; saved: TrackState; reason: string }> } {
  const targets: Target[] = [];
  const stops: Array<{ shipment: Shipment; saved: TrackState; reason: string }> = [];
  for (const shipment of shipments) {
    const assigned = forwarderForCarrier(shipment.carrier);
    if (!assigned && shipment.carrier) continue;
    const saved = states.get(shipment.key);
    if (mode === "hourly" && saved?.stoppedAt) continue;
    if (STOP_NOW.has(shipment.status)) {
      if (saved && !saved.stoppedAt) stops.push({ shipment, saved, reason: `亚马逊${shipment.status}` });
      continue;
    }
    if (mode === "hourly") {
      const tooOld = shipment.createdAt !== undefined && now - shipment.createdAt > MAX_AGE_MS;
      if (!saved && (shipment.status === AMAZON_DONE || tooOld)) continue;
      if (saved && tooOld) { stops.push({ shipment, saved, reason: "货件创建超过 180 天" }); continue; }
      if (!assigned && !saved?.forwarder && now - time(saved?.lastProbeAt) < DETECT_RETRY_MS) continue;
    }
    const primary = assigned ?? saved?.forwarder;
    targets.push({ shipment, ...(saved ? { saved } : {}), ...(assigned ? { assigned } : {}), ...(primary ? { primary } : {}) });
  }
  return { targets, stops };
}

// 第一轮：有指定物流商的只查该家，承运商为空的三家都查；第二轮：指定物流商明确查无（不是查询失败）的，再查另两家。
async function queryForwarders(targets: Target[], adapters: Record<ForwarderId, ForwarderAdapter>): Promise<{ tracks: Map<string, ForwarderTrack[]>; failed: Map<ForwarderId, string>; queried: Map<ForwarderId, number> }> {
  const tracks = new Map<string, ForwarderTrack[]>();
  const failed = new Map<ForwarderId, string>();
  const queried = new Map<ForwarderId, number>();
  const run = async (plan: Map<ForwarderId, Set<string>>): Promise<void> => {
    for (const forwarder of FORWARDER_IDS) {
      const ids = [...(plan.get(forwarder) ?? [])];
      if (!ids.length || failed.has(forwarder)) continue;
      try {
        const found = await adapters[forwarder].track(ids);
        queried.set(forwarder, (queried.get(forwarder) ?? 0) + ids.length);
        for (const id of ids) {
          const track = found.get(id);
          if (track) tracks.set(id, [...(tracks.get(id) ?? []), track]);
        }
      } catch (error) {
        failed.set(forwarder, errorText(error).slice(0, 200));
        log("WARN", "forwarder_query_failed", { forwarder, count: ids.length, error: errorText(error).slice(0, 200) });
      }
    }
  };
  const add = (plan: Map<ForwarderId, Set<string>>, forwarder: ForwarderId, id: string): void => { plan.set(forwarder, (plan.get(forwarder) ?? new Set()).add(id)); };
  const first = new Map<ForwarderId, Set<string>>();
  for (const target of targets) for (const forwarder of target.primary ? [target.primary] : FORWARDER_IDS) add(first, forwarder, target.shipment.id);
  await run(first);
  const second = new Map<ForwarderId, Set<string>>();
  for (const target of targets) {
    if (!target.primary || failed.has(target.primary)) continue;
    if ((tracks.get(target.shipment.id) ?? []).some((track) => track.found)) continue;
    for (const forwarder of FORWARDER_IDS) if (forwarder !== target.primary) add(second, forwarder, target.shipment.id);
  }
  await run(second);
  return { tracks, failed, queried };
}

function latestText(event: ForwarderEvent): string {
  return truncate([event.time, stripTag(event.text)].filter(Boolean).join(" "), LATEST_MAX_CHARS);
}

// 物流轨迹：首行物流商｜单号｜明细，之后全部动态（最新在上，与物流商网站一致）；过长时略去最早的动态。
export function traceText(track: ForwarderTrack, note = ""): string {
  const header = [FORWARDER_NAMES[track.forwarder], track.waybillNo, ...track.details].filter(Boolean).join("｜");
  const lines = [header, ...(note ? [note] : [])];
  let length = lines.join("\n").length;
  let shown = 0;
  for (const event of track.events) {
    const line = [event.time, event.text].filter(Boolean).join(" ");
    if (length + line.length + 1 > TRACE_MAX_CHARS - 20) break;
    lines.push(line);
    length += line.length + 1;
    shown += 1;
  }
  if (shown < track.events.length) lines.push(`……更早 ${track.events.length - shown} 条略`);
  return lines.join("\n");
}

function desiredFields(track: ForwarderTrack, facts: TrackFacts, note: string): Row {
  const fields: Row = {};
  if (facts.milestone) fields[FORWARDER_FIELDS.node] = facts.milestone;
  if (facts.latest) fields[FORWARDER_FIELDS.latest] = latestText(facts.latest);
  const eta = facts.eta ? beijingWallTime(facts.eta) : undefined;
  if (eta !== undefined) fields[FORWARDER_FIELDS.eta] = eta;
  if (facts.signed?.at !== undefined) fields[FORWARDER_FIELDS.signed] = facts.signed.at;
  if (track.waybillNo) fields[FORWARDER_FIELDS.waybill] = track.waybillNo;
  fields[FORWARDER_FIELDS.trace] = traceText(track, note);
  return fields;
}

// 只写与表里现值不同的列；内容有变化时一并写同步时间，没变化时同步时间最多每 6 小时刷新一次。
function changedFields(desired: Row, current: Row, now: number, refreshSync: boolean): Row {
  const changed: Row = {};
  for (const [name, value] of Object.entries(desired)) {
    const same = typeof value === "number" ? cellNumber(current[name]) === value : cellText(current[name]) === String(value);
    if (!same) changed[name] = value;
  }
  const lastSync = cellNumber(current[FORWARDER_FIELDS.sync]);
  if (refreshSync && (Object.keys(changed).length || lastSync === undefined || now - lastSync >= SYNC_REFRESH_MS)) changed[FORWARDER_FIELDS.sync] = now;
  return changed;
}

function milestoneLine(milestone: Milestone, event: ForwarderEvent, track: ForwarderTrack, facts: TrackFacts): string {
  const at = shortTime(event);
  if (milestone === "已开船") return `已开船${at ? ` ${at}` : ""}${track.vessel ? `：${track.vessel}` : ""}${facts.eta ? `，预计 ${facts.eta.slice(5)} 到港` : ""}`;
  if (milestone === "已预约") return `已预约送仓 ${event.appointment || at}`.trim();
  return `${milestone}${at ? ` ${at}` : ""}`;
}

// 本轮新出现、尚未提醒过的变化：关键节点、预计到港推迟 ≥2 天（到港前）、异常动态。
function changesFor(track: ForwarderTrack, facts: TrackFacts, saved: TrackState | undefined, now: number): { candidates: Change[]; etaBase?: string } {
  const known = new Set(saved?.notified ?? []);
  const candidates: Change[] = [];
  for (const milestone of NOTIFY_MILESTONES) {
    const event = track.events.find((item) => item.milestone === milestone);
    const key = `m:${milestone}`;
    if (!event || known.has(key)) continue;
    candidates.push({ key, line: milestoneLine(milestone, event, track, facts), exception: false, ...(event.at !== undefined ? { at: event.at } : {}) });
  }
  const base = saved?.forwarder === track.forwarder ? saved?.etaBase || saved?.eta : undefined;
  let etaBase = base ?? facts.eta;
  if (facts.eta && base && rank(facts.milestone) < rank("已到港")) {
    const delay = dayDiff(base, facts.eta);
    const key = `eta:${facts.eta}`;
    if (delay >= ETA_DELAY_DAYS && !known.has(key)) {
      candidates.push({ key, line: `预计到港推迟：${base.slice(5)} → ${facts.eta.slice(5)}（+${delay} 天）`, exception: false, at: now });
      etaBase = facts.eta;
    } else if (delay < 0) etaBase = facts.eta;
  }
  if (candidates.some((change) => change.key === "m:已开船") && facts.eta) etaBase = facts.eta;
  for (const event of track.events) {
    const key = `x:${event.key}`;
    if (!event.exception || known.has(key)) continue;
    candidates.push({ key, line: truncate(stripTag(event.text), 80), exception: true, ...(event.at !== undefined ? { at: event.at } : {}) });
  }
  return { candidates, ...(etaBase ? { etaBase } : {}) };
}

function stopReason(shipment: Shipment, next: TrackState, facts: TrackFacts | undefined, now: number): string | undefined {
  if (next.signedSeenAt && now - time(next.signedSeenAt) >= SIGNED_GRACE_MS) return "物流商已签收满 3 天";
  if (shipment.status === AMAZON_DONE && (facts?.signed || now - time(next.closedSeenAt) >= CLOSED_GRACE_MS)) return "亚马逊已完成";
  if (shipment.createdAt !== undefined && now - shipment.createdAt > MAX_AGE_MS) return "货件创建超过 180 天";
  return undefined;
}

function resolve(target: Target, tracks: ForwarderTrack[], failed: Map<ForwarderId, string>, mode: Mode, now: number): Outcome {
  const { shipment, saved } = target;
  const nowIso = iso(now);
  const found = tracks.filter((track) => track.found);
  const base: TrackState = { ...(saved ?? {}), pk: FORWARDER_STATE_PK, sk: shipment.key, shipmentId: shipment.id, recordId: shipment.recordId, lastPolledAt: nowIso, updatedAt: nowIso };
  // 停止标记与“亚马逊已完成”时间按本轮重新判定（回填会重查已停止的货件）。
  delete base.stoppedAt;
  delete base.stopReason;
  delete base.expiresAt;
  if (shipment.status === AMAZON_DONE) base.closedSeenAt = saved?.closedSeenAt || nowIso;
  else delete base.closedSeenAt;
  if (!found.length) {
    // 查询失败（任一应查的物流商出错）时结果未知：不写表、不动状态。
    const consulted = target.primary ? [target.primary, ...(failed.has(target.primary) ? [] : FORWARDER_IDS.filter((id) => id !== target.primary))] : [...FORWARDER_IDS];
    if (consulted.some((id) => failed.has(id))) return { shipment, result: "unknown", fields: {}, fresh: [] };
    const next: TrackState = { ...base, lastProbeAt: nowIso, notFoundSince: saved?.notFoundSince || nowIso };
    const stop = stopReason(shipment, next, undefined, now);
    // 只有指定了物流商、且从未查到过时才写“暂未查到”；查到过的数据一律不清空，承运商为空的不写。
    const fields: Row = target.assigned && !cellText(shipment.fields[FORWARDER_FIELDS.waybill])
      ? changedFields({ [FORWARDER_FIELDS.latest]: `${FORWARDER_NAMES[target.assigned]}暂未查到此单，可能尚未录入` }, shipment.fields, now, false)
      : {};
    return { shipment, result: "not_found", fields, fresh: [], next: stop ? { ...next, stoppedAt: nowIso, stopReason: stop, expiresAt: completedStateExpiresAt(now) } : next, ...(stop ? { stop } : {}) };
  }
  const track = found.find((item) => item.forwarder === target.primary) ?? (found.length === 1 ? found[0] : undefined);
  if (!track) {
    log("WARN", "forwarder_ambiguous", { shipmentId: shipment.id, forwarders: found.map((item) => item.forwarder).join(",") });
    return { shipment, result: "ambiguous", fields: {}, fresh: [] };
  }
  const facts = trackFacts(track);
  const note = target.assigned && track.forwarder !== target.assigned ? `注意：承运商选的是${FORWARDER_NAMES[target.assigned]}，但在${FORWARDER_NAMES[track.forwarder]}查到此单` : "";
  const fields = changedFields(desiredFields(track, facts, note), shipment.fields, now, true);
  const { candidates, etaBase } = changesFor(track, facts, saved, now);
  // 回填全程静默；首次跟踪（或换了物流商）只提醒 48 小时内发生的，更早的记为已知不再提醒。
  const firstSeen = !saved?.forwarder || saved.forwarder !== track.forwarder;
  const fresh = mode === "backfill" ? [] : candidates.filter((change) => !firstSeen || (change.at !== undefined && change.at >= now - FIRST_SEEN_NOTIFY_MS && change.at <= now + HOUR));
  const notified = [...new Set([...(saved?.notified ?? []), ...candidates.map((change) => change.key)])].slice(-200);
  const signedAt = facts.signed?.at ?? saved?.signedAt;
  const signedSeenAt = saved?.signedSeenAt || (facts.signed ? nowIso : undefined);
  const milestone = facts.milestone ?? saved?.milestone;
  const eta = facts.eta ?? saved?.eta;
  const next: TrackState = {
    ...base, forwarder: track.forwarder, detected: !target.assigned, waybillNo: track.waybillNo || saved?.waybillNo || "",
    ...(milestone ? { milestone } : {}),
    ...(eta ? { eta } : {}),
    ...(etaBase ? { etaBase } : {}),
    ...(signedAt !== undefined ? { signedAt } : {}),
    ...(signedSeenAt ? { signedSeenAt } : {}),
    notified, firstSeenAt: saved?.firstSeenAt || nowIso, lastFoundAt: nowIso,
  };
  delete next.notFoundSince;
  const stop = stopReason(shipment, next, facts, now);
  return {
    shipment, result: "found", forwarder: track.forwarder, facts, fields, fresh,
    next: stop ? { ...next, stoppedAt: nowIso, stopReason: stop, expiresAt: completedStateExpiresAt(now) } : next,
    ...(stop ? { stop } : {}),
  };
}

export function messageLines(outcomes: Outcome[]): string[] {
  const notified = outcomes.filter((item) => item.fresh.length);
  const lines = [`🚢 物流动态（${notified.length} 个货件）`];
  for (const item of notified.filter((entry) => entry.fresh.some((change) => !change.exception))) {
    lines.push(`${item.shipment.id}${item.shipment.destination ? ` → ${item.shipment.destination}` : ""}（${FORWARDER_SHORT[item.forwarder!]}）`);
    for (const change of item.fresh.filter((entry) => !entry.exception)) lines.push(`  ${change.line}`);
  }
  const abnormal = notified.filter((entry) => entry.fresh.some((change) => change.exception));
  if (abnormal.length) {
    lines.push("⚠️ 异常");
    for (const item of abnormal) for (const change of item.fresh.filter((entry) => entry.exception)) lines.push(`${item.shipment.id}：${change.line}`);
  }
  return lines.length > MESSAGE_MAX_LINES ? [...lines.slice(0, MESSAGE_MAX_LINES - 1), `……另有 ${lines.length - MESSAGE_MAX_LINES + 1} 行未列出（完整轨迹见货件表「物流轨迹」）`] : lines;
}

function previewOf(outcome: Outcome): JsonObject {
  return {
    shipmentId: outcome.shipment.id, carrier: outcome.shipment.carrier, result: outcome.result, forwarder: outcome.forwarder ?? "",
    node: outcome.facts?.milestone ?? "", latest: outcome.facts?.latest ? truncate(latestText(outcome.facts.latest), 80) : "",
    eta: outcome.facts?.eta ?? "", writes: Object.keys(outcome.fields).join(","), notify: outcome.fresh.map((change) => change.line).join(" / "), stop: outcome.stop ?? "",
  };
}

async function recordForwarderHealth(state: StateStore, summary: (id: ForwarderId) => JsonObject | undefined): Promise<void> {
  for (const id of FORWARDER_IDS) {
    const details = summary(id);
    if (!details) continue;
    try { await state.recordHealth(forwarderHealthName(id), "done", details); }
    catch (error) { log("WARN", "health_record_failed", { taskType: forwarderHealthName(id), error: errorText(error).slice(0, 200) }); }
  }
}

async function track(context: Context, mode: Mode, apply: boolean): Promise<JsonObject> {
  const { config, state, feishu, deps } = context;
  const now = (deps.now ?? Date.now)();
  const label = apply ? mode : `${mode}-preview`;
  if (!config.bool("FORWARDER_TRACKING_ENABLED", true)) {
    if (apply) await recordForwarderHealth(state, () => ({ disabled: true }));
    return { status: "done", mode: label, retired: true };
  }
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const table = config.get("FEISHU_BITABLE_TABLE_ID_SHIPMENTS");
  const names = new Set((await feishu.listFields(app, table)).map((field) => String(field.field_name ?? field.fieldName ?? "").trim()));
  const missing = REQUIRED_FIELDS.filter((name) => !names.has(name));
  if (missing.length && apply) throw new Error(`货件表缺少字段：${missing.join("、")}（先按 docs/部署说明.md 建列）。`);
  const owner = ownerId();
  if (apply && !(await state.acquireLease(LEASE_SCOPE, "global", owner, LEASE_MS))) return { status: "busy", mode: label, note: "另一轮物流商轨迹正在运行，稍后再试" };
  try {
    const shipments = (await feishu.listRecords(app, table)).map(shipmentOf).filter((item): item is Shipment => !!item);
    const states = new Map(((await state.list(FORWARDER_STATE_PK)) as unknown as TrackState[]).map((item) => [String(item.sk), item]));
    const { targets, stops } = selectTargets(shipments, states, mode, now);
    const adapters = { ...createForwarderAdapters({ meisheBaseUrl: config.optional("FORWARDER_MEISHE_BASE_URL", MEISHE_DEFAULT_BASE_URL) }), ...(deps.adapters ?? {}) } as Record<ForwarderId, ForwarderAdapter>;
    const { tracks, failed, queried } = targets.length ? await queryForwarders(targets, adapters) : { tracks: new Map<string, ForwarderTrack[]>(), failed: new Map<ForwarderId, string>(), queried: new Map<ForwarderId, number>() };
    const outcomes = targets.map((target) => resolve(target, tracks.get(target.shipment.id) ?? [], failed, mode, now));
    const writes = outcomes.filter((item) => Object.keys(item.fields).length).map((item) => ({ recordId: item.shipment.recordId, fields: item.fields }));
    const fresh = outcomes.filter((item) => item.fresh.length);
    const lines = fresh.length ? messageLines(outcomes) : [];
    const counts = {
      shipments: shipments.length, targets: targets.length,
      found: outcomes.filter((item) => item.result === "found").length, notFound: outcomes.filter((item) => item.result === "not_found").length,
      unknown: outcomes.filter((item) => item.result === "unknown").length, ambiguous: outcomes.filter((item) => item.result === "ambiguous").length,
      updated: writes.length, notifiedShipments: fresh.length, stopped: outcomes.filter((item) => item.stop).length + stops.length,
      failed: [...failed.keys()].join(","), errors: [...failed].map(([id, error]) => `${id}: ${error.slice(0, 120)}`).join("；"),
    };
    if (!apply) return { status: "done", mode: label, ...counts, ...(missing.length ? { missingFields: missing.join("、") } : {}), message: lines.join("\n"), preview: outcomes.map(previewOf) };

    // 先持久化通知意图（键＝本轮全部变化键的哈希，中断重跑得到同一个键），再写表、写状态，最后发送；发送失败由维护任务补发。
    const eventKey = `forwarder-track|${sha256(fresh.flatMap((item) => item.fresh.map((change) => `${item.shipment.key}|${change.key}`)).sort().join("\n")).slice(0, 24)}`;
    let prepared: PreparedNotification | undefined;
    if (fresh.length) prepared = await prepareNotification(config, state, eventKey, lines);
    if (writes.length) await feishu.batchUpdate(app, table, writes);
    for (const item of outcomes) if (item.next) await state.put({ ...item.next } as unknown as Row);
    for (const { saved, reason } of stops) await state.put({ ...saved, stoppedAt: iso(now), stopReason: reason, updatedAt: iso(now), expiresAt: completedStateExpiresAt(now) } as unknown as Row);
    await recordForwarderHealth(state, (id) => failed.has(id) ? undefined : { queried: queried.get(id) ?? 0 });
    let notified = false;
    if (fresh.length) {
      try { notified = (await flushNotification(state, feishu, eventKey, prepared)) === "sent"; }
      catch (error) { log("WARN", "forwarder_notify_failed", { eventKey, error: errorText(error).slice(0, 200) }); }
    }
    log("INFO", "forwarder_tracking_done", { mode, ...counts, notified });
    return { status: "done", mode: label, ...counts, notified };
  } finally {
    if (apply) await state.releaseLease(LEASE_SCOPE, "global", owner);
  }
}

// 每小时第 50 分钟（北京时间）的定时任务；dryRun 只读预览（不写表、不写状态、不发消息）。
export async function runForwarderTracking(event: JobEvent, config: AppConfig, state: StateStore, _amazon: AmazonClient, feishu: FeishuClient, deps: ForwarderDeps = {}): Promise<JsonObject> {
  return track({ config, state, feishu, deps }, "hourly", event.dryRun !== true);
}

// 只手动调用：全部 SEND 货件（不受停止条件限制、已取消等除外）回填，全程不发消息；默认只读预览，cursor.apply=true 才写。
export async function runForwarderBackfill(event: JobEvent, config: AppConfig, state: StateStore, _amazon: AmazonClient, feishu: FeishuClient, deps: ForwarderDeps = {}): Promise<JsonObject> {
  return track({ config, state, feishu, deps }, "backfill", event.cursor?.apply === true && event.dryRun !== true);
}
