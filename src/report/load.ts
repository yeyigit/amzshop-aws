import type { StateStore } from "../state.js";
import { FEED_PREFIXES } from "../portal/metrics.js";
import { addDays, periodOf, shiftMonth, type Period } from "./periods.js";
import { REPORT_DAY_PK, REPORT_META_PK, REPORT_MONTH_PK, type DayFacts, type MonthFacts, type ReportMeta } from "./types.js";
import type { CatalogEntry, ReportEvent, ReportInput } from "./view.js";

// 报告视图取数（只读状态表）：中台页面与 Jobs 发消息共用，保证两边数字一致。
type Row = Record<string, unknown>;

export function parseStored<T>(item: Row | undefined): T | undefined {
  if (!item || typeof item.payload !== "string") return undefined;
  try { return JSON.parse(item.payload) as T; } catch { return undefined; }
}

// 各类报告要读的天与月：日报近 14 天（含前一天与上周同日）；周报近 8 周；月报本月与上月（逐天）；年报两年的月汇总 + 本年与去年进行中那个月的逐天。
export function readPlan(period: Period, yesterday: string): { dayRanges: Array<[string, string]>; monthRange: [string, string] } {
  const through = period.to < yesterday ? period.to : yesterday;
  if (period.type === "day") return { dayRanges: [[addDays(period.from, -13), period.to]], monthRange: [period.key.slice(0, 7), period.key.slice(0, 7)] };
  if (period.type === "week") return { dayRanges: [[addDays(period.from, -49), period.to]], monthRange: [period.from.slice(0, 7), period.to.slice(0, 7)] };
  if (period.type === "month") return { dayRanges: [[`${shiftMonth(period.key, -1)}-01`, period.to]], monthRange: [shiftMonth(period.key, -12), period.key] };
  const year = Number(period.key);
  const partial = periodOf("month", through >= period.from ? through : period.to);
  const lastYearPartial = periodOf("month", `${year - 1}${partial.from.slice(4)}`);
  return { dayRanges: [[partial.from, partial.to], [lastYearPartial.from, lastYearPartial.to]], monthRange: [`${year - 1}-01`, `${year}-12`] };
}

export async function loadReportInput(state: StateStore, period: Period, today: string, nowMs: number, options: { events?: boolean; catalog?: Record<string, CatalogEntry> } = {}): Promise<ReportInput> {
  const plan = readPlan(period, addDays(today, -1));
  const [dayGroups, monthItems, metaItem, events] = await Promise.all([
    Promise.all(plan.dayRanges.map(([from, to]) => state.queryRange(REPORT_DAY_PK, from, to))),
    state.queryRange(REPORT_MONTH_PK, plan.monthRange[0], plan.monthRange[1]),
    state.get(REPORT_META_PK, "state"),
    options.events ? loadEvents(state) : Promise.resolve(undefined),
  ]);
  const days = new Map<string, DayFacts>();
  for (const item of dayGroups.flat()) { const day = parseStored<DayFacts>(item); if (day?.date) days.set(day.date, day); }
  const months = new Map<string, MonthFacts>();
  for (const item of monthItems) { const month = parseStored<MonthFacts>(item); if (month?.month) months.set(month.month, month); }
  const meta = parseStored<ReportMeta>(metaItem) ?? null;
  return { period, today, nowMs, days, months, meta, ...(events ? { events } : {}), ...(options.catalog ? { catalog: options.catalog } : {}) };
}

// 本期动态：系统已发出的业务消息（状态表 NOTIFICATION，保留约 1 年），按中台“近 7 天动态”的同一组前缀归类。
export async function loadEvents(state: StateStore): Promise<ReportEvent[]> {
  const groups = await Promise.all(FEED_PREFIXES.map(([prefix]) => state.queryPartition("NOTIFICATION", { beginsWith: prefix, limit: 2000 })));
  const output: ReportEvent[] = [];
  for (const item of groups.flat()) {
    const sk = String(item.sk ?? "");
    const kind = FEED_PREFIXES.find(([prefix]) => sk.startsWith(prefix))?.[1];
    const at = String(item.createdAt ?? item.updatedAt ?? "");
    const lines = Array.isArray(item.lines) ? (item.lines as unknown[]).map((line) => String(line ?? "").trim()).filter(Boolean) : [];
    if (!kind || !Number.isFinite(Date.parse(at)) || !lines.length) continue;
    output.push({ kind, at: new Date(Date.parse(at)).toISOString(), title: lines[0]!.slice(0, 60), details: lines.slice(1, 3).map((line) => line.slice(0, 100)) });
  }
  return output;
}
