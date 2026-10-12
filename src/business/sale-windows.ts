import type { AppConfig, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { StateStore } from "../state.js";
import { log } from "../log.js";
import { addDaysYmd, errorText, nowIso, timeMs, ymdInZone } from "../util.js";

// 竞品大促加密（规则见 docs/模块说明.md「竞品大促加密」）：大促窗口按洛杉矶日期、含首尾，四个来源取并集：
// ①规则推算（黑五网一＋圣诞季、复活节）②本店已报名的大促活动（Promotions schedule.eventId）③人工配置 ④竞品集中开限时折扣触发。
export const SALE_PK = "COMPETITOR_SALE";
export const SALE_TRIGGER_HOURS = 48;
export const SALE_DEAL_TRIGGER_DEFAULT = 2;
const LA = "America/Los_Angeles";
type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
const text = (value: unknown): string => String(value ?? "").trim();
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface SaleWindow { name: string; start: string; end: string; source: "rule" | "promotion" | "config" }
export interface SaleMode { active: boolean; windows: SaleWindow[]; triggerUntil?: string }
export interface SaleSettings { enabled: boolean; dealTrigger: number; windows: SaleWindow[] }

const pad = (value: number): string => String(value).padStart(2, "0");

// 公历复活节（Anonymous Gregorian algorithm）。
export function easterYmd(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

// 感恩节＝11 月第 4 个周四。
export function thanksgivingYmd(year: number): string {
  const weekday = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  return `${year}-11-${pad(1 + ((4 - weekday + 7) % 7) + 21)}`;
}

// 规则窗口：黑五网一＋圣诞季＝感恩节前 7 天至 12/24；复活节＝前 14 天至当天。
export function ruleSaleWindows(year: number): SaleWindow[] {
  const easter = easterYmd(year);
  return [
    { name: "复活节", start: addDaysYmd(easter, -14), end: easter, source: "rule" },
    { name: "黑五网一·圣诞季", start: addDaysYmd(thanksgivingYmd(year), -7), end: `${year}-12-24`, source: "rule" },
  ];
}

// COMPETITOR_SALE_WINDOWS：`名称:YYYY-MM-DD~YYYY-MM-DD`，分号或换行分隔；格式不对明确报错，不静默忽略。
export function parseSaleWindows(raw: string): SaleWindow[] {
  return raw.split(/[;；\n]+/).map((item) => item.trim()).filter(Boolean).map((item) => {
    const match = /^(.+?)[:：]\s*(\d{4}-\d{2}-\d{2})\s*[~～]\s*(\d{4}-\d{2}-\d{2})$/.exec(item);
    if (!match || match[2]! > match[3]!) throw new Error(`COMPETITOR_SALE_WINDOWS 格式应为“名称:YYYY-MM-DD~YYYY-MM-DD”（分号分隔、开始不晚于结束）：${item.slice(0, 60)}`);
    return { name: match[1]!.trim(), start: match[2]!, end: match[3]!, source: "config" as const };
  });
}

export function saleSettings(config: AppConfig): SaleSettings {
  const enabled = typeof config.bool === "function" ? config.bool("COMPETITOR_SALE_MODE_ENABLED", true) : true;
  const rawTrigger = typeof config.optional === "function" ? config.optional("COMPETITOR_SALE_DEAL_TRIGGER", String(SALE_DEAL_TRIGGER_DEFAULT)) : String(SALE_DEAL_TRIGGER_DEFAULT);
  const dealTrigger = Number(rawTrigger);
  if (!Number.isInteger(dealTrigger) || dealTrigger < 0) throw new Error("COMPETITOR_SALE_DEAL_TRIGGER 必须是非负整数（0＝关闭数据触发）。");
  const windows = parseSaleWindows(typeof config.optional === "function" ? config.optional("COMPETITOR_SALE_WINDOWS", "") : "");
  return { enabled, dealTrigger, windows };
}

// 当前是否处于大促窗口：规则窗口（今年与去年跨年部分）、已存的本店大促活动、人工配置与未到期的数据触发。
export async function currentSaleMode(state: StateStore, settings: SaleSettings, now = new Date()): Promise<SaleMode> {
  if (!settings.enabled) return { active: false, windows: [] };
  const today = ymdInZone(now, LA);
  const year = Number(today.slice(0, 4));
  const [events, trigger] = await Promise.all([state.get(SALE_PK, "events"), state.get(SALE_PK, "trigger")]);
  const stored = rows(events?.windows).map((item): SaleWindow => ({ name: text(item.name), start: text(item.start), end: text(item.end), source: "promotion" })).filter((item) => YMD.test(item.start) && YMD.test(item.end));
  const windows = [...ruleSaleWindows(year), ...stored, ...settings.windows].filter((item) => item.start <= today && today <= item.end);
  const until = timeMs(trigger?.until);
  const triggered = until > now.getTime();
  return { active: windows.length > 0 || triggered, windows, ...(triggered ? { triggerUntil: new Date(until).toISOString() } : {}) };
}

// 本店大促活动的识别：官方 schedule.eventId 非空，或活动名称含大促字样。实测本店活动的 eventId 全空，
// 大促活动靠命名识别（如“2026PrimeDay”“黑五网一”），平时折扣（如“清货”“会员折扣”）不会命中。
export const SALE_TITLE = /prime\s*day|big\s*deal|spring\s*sale|black\s*friday|cyber\s*monday|bfcm|黑五|网一|黑色星期五|会员日|大促|春促|秋促/i;

export function promotionEventName(promotion: Row): string {
  const eventId = text(((promotion.schedule ?? {}) as Row).eventId);
  const title = text(promotion.promotionTitle);
  if (eventId && eventId !== "EVENT") return eventId;
  if (SALE_TITLE.test(title)) return title.slice(0, 30);
  return eventId ? "亚马逊大促活动" : "";
}

// 本店已报名的大促活动（Promotions 2025-12-01，只读）：UPCOMING/RUNNING 且识别为大促的，窗口＝开始前 1 天至结束（洛杉矶日期）。
// 只在每天 14:00 那轮刷新；读取失败保留上次结果、不让比价失败。
export async function refreshPromotionEvents(amazon: AmazonClient, state: StateStore, skus: string[], now = new Date()): Promise<JsonObject> {
  try {
    const found = new Map<string, SaleWindow>();
    for (let offset = 0; offset < skus.length; offset += 10) {
      let paginationToken = "";
      do {
        const page = await amazon.sp<JsonObject>("/promotions/2025-12-01/promotions", { query: { marketplaceIds: "ATVPDKIKX0DER", statuses: "UPCOMING,RUNNING", skus: skus.slice(offset, offset + 10).join(","), revision: "PUBLISHED", limit: 100, ...(paginationToken ? { paginationToken } : {}) } });
        if (!Array.isArray(page.promotions)) throw new Error("Promotions 响应缺少 promotions。");
        for (const promotion of rows(page.promotions)) {
          const schedule = (promotion.schedule ?? {}) as Row;
          const name = promotionEventName(promotion);
          const start = new Date(text(schedule.startDate));
          const end = new Date(text(schedule.endDate));
          if (!name || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) continue;
          const window: SaleWindow = { name, start: addDaysYmd(ymdInZone(start, LA), -1), end: ymdInZone(end, LA), source: "promotion" };
          found.set(`${window.name}|${window.start}|${window.end}`, window);
        }
        paginationToken = text((page.pagination as Row | undefined)?.nextToken);
      } while (paginationToken);
    }
    const today = ymdInZone(now, LA);
    const windows = [...found.values()].filter((item) => item.end >= today).sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
    // 只在清单有变化时写（平时没有大促活动，不必每天写一条空记录）。
    const signature = (list: unknown): string => rows(list).map((item) => `${text(item.name)}|${text(item.start)}|${text(item.end)}`).join(";");
    const stored = await state.get(SALE_PK, "events");
    if (signature(stored?.windows) !== signature(windows)) await state.put({ pk: SALE_PK, sk: "events", windows, refreshedAt: nowIso(), updatedAt: nowIso() });
    return { promotionEvents: windows.length };
  } catch (error) {
    log("WARN", "sale_promotion_events_failed", { error: errorText(error).slice(0, 200) });
    return { promotionEvents: "failed" };
  }
}

// 数据触发：本轮新开限时折扣（DEAL）的已跟踪竞品数达到阈值即加密 48 小时；已在触发期内再次达到则顺延。
export async function applyDealTrigger(state: StateStore, settings: SaleSettings, newDeals: string[], now = new Date()): Promise<string | undefined> {
  if (!settings.enabled || settings.dealTrigger <= 0 || newDeals.length < settings.dealTrigger) return undefined;
  const until = new Date(now.getTime() + SALE_TRIGGER_HOURS * 3_600_000).toISOString();
  await state.put({ pk: SALE_PK, sk: "trigger", until, startedAt: now.toISOString(), deals: newDeals.slice(0, 20), updatedAt: nowIso() });
  return until;
}

export function hasDeal(types: unknown, signature: unknown): boolean {
  if (Array.isArray(types)) return types.map((item) => String(item).toUpperCase()).includes("DEAL");
  return /(^|；)DEAL/.test(String(signature ?? ""));
}
