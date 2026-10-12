// 店铺报告的周期（见 docs/模块说明.md「店铺报告」）：日、周（周一至周日的 ISO 周）、月、年，一律按洛杉矶站点日。
// 纯函数，中台页面与 Jobs 共用；日期都是 YYYY-MM-DD 文本，按 UTC 日历做加减，不受夏令时影响。
export type ReportType = "day" | "week" | "month" | "year";
export const REPORT_TYPES: ReportType[] = ["day", "week", "month", "year"];
export const TYPE_NAMES: Record<ReportType, string> = { day: "日报", week: "周报", month: "月报", year: "年报" };
export interface Period { type: ReportType; key: string; from: string; to: string }

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const DAY_MS = 86_400_000;
const pad = (value: number, size = 2): string => String(value).padStart(size, "0");
const utc = (ymd: string): number => Date.parse(`${ymd}T00:00:00Z`);
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) && ymd(ms) === value;
}

export function addDays(date: string, days: number): string { return ymd(utc(date) + days * DAY_MS); }
export function daysBetween(from: string, to: string): number { return Math.round((utc(to) - utc(from)) / DAY_MS); }
// 0＝周日 … 6＝周六。
export function weekdayIndex(date: string): number { return new Date(utc(date)).getUTCDay(); }
export function weekdayName(date: string): string { return WEEKDAYS[weekdayIndex(date)] ?? ""; }
export function monthEnd(month: string): string { const [year, number] = month.split("-").map(Number); return ymd(Date.UTC(year!, number!, 0)); }
export function shiftMonth(month: string, months: number): string { const [year, number] = month.split("-").map(Number); const date = new Date(Date.UTC(year!, number! - 1 + months, 1)); return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`; }

// ISO 周：周一开始，含 1 月 4 日的那周为第 1 周；周所属年份可能与日历年不同（如 2026-12-28 属 2026-W53，2027-01-01 也属 2026-W53）。
export function isoWeek(date: string): { year: number; week: number } {
  const ms = utc(date);
  const day = (new Date(ms).getUTCDay() + 6) % 7;
  const thursday = ms + (3 - day) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const firstThursday = Date.UTC(year, 0, 4) + (3 - ((new Date(Date.UTC(year, 0, 4)).getUTCDay() + 6) % 7)) * DAY_MS;
  return { year, week: 1 + Math.round((thursday - firstThursday) / (7 * DAY_MS)) };
}
export function isoWeekMonday(year: number, week: number): string {
  const jan4 = Date.UTC(year, 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  return ymd(monday + (week - 1) * 7 * DAY_MS);
}
export function weeksInYear(year: number): number { return isoWeek(`${year}-12-28`).week; }
export const weekKey = (date: string): string => { const { year, week } = isoWeek(date); return `${year}-W${pad(week)}`; };

// 期的键：日 2026-10-07、周 2026-W41、月 2026-10、年 2026；写错返回 null。
export function parsePeriod(type: string, key: string): Period | null {
  const value = String(key ?? "").trim();
  if (type === "day") return validDate(value) ? { type, key: value, from: value, to: value } : null;
  if (type === "week") {
    const match = /^(\d{4})-W(\d{2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]), week = Number(match[2]);
    if (year < 2000 || year > 2100 || week < 1 || week > weeksInYear(year)) return null;
    const from = isoWeekMonday(year, week);
    return { type, key: value, from, to: addDays(from, 6) };
  }
  if (type === "month") {
    const match = /^(\d{4})-(\d{2})$/.exec(value);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[1]) < 2000 || Number(match[1]) > 2100) return null;
    return { type, key: value, from: `${value}-01`, to: monthEnd(value) };
  }
  if (type === "year") {
    if (!/^\d{4}$/.test(value) || Number(value) < 2000 || Number(value) > 2100) return null;
    return { type, key: value, from: `${value}-01-01`, to: `${value}-12-31` };
  }
  return null;
}

// 包含某天的那一期。
export function periodOf(type: ReportType, date: string): Period {
  const key = type === "day" ? date : type === "week" ? weekKey(date) : type === "month" ? date.slice(0, 7) : date.slice(0, 4);
  return parsePeriod(type, key)!;
}

// 前后翻期：n＝−1 上一期、+1 下一期。
export function shiftPeriod(period: Period, n: number): Period {
  if (period.type === "day") return periodOf("day", addDays(period.from, n));
  if (period.type === "week") return periodOf("week", addDays(period.from, 7 * n));
  if (period.type === "month") return periodOf("month", `${shiftMonth(period.key, n)}-01`);
  return periodOf("year", `${Number(period.key) + n}-01-01`);
}

export function periodDays(period: Period, through = period.to): string[] {
  const last = through < period.to ? through : period.to;
  const output: string[] = [];
  for (let date = period.from; date <= last; date = addDays(date, 1)) output.push(date);
  return output;
}

const md = (date: string): string => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

export function periodLabel(period: Period): string {
  if (period.type === "day") return `${period.key} ${weekdayName(period.key)}`;
  if (period.type === "week") {
    const { year, week } = isoWeek(period.from);
    const prefix = Number(period.from.slice(0, 4)) !== year || Number(period.to.slice(0, 4)) !== year ? `${year}年` : "";
    return `${prefix}第${week}周（${md(period.from)}–${md(period.to)}）`;
  }
  if (period.type === "month") return `${period.key.slice(0, 4)}年${Number(period.key.slice(5, 7))}月`;
  return `${period.key}年`;
}

// 消息标题里的短写法：10/07 周三、第41周 10/05–10/11、2026年10月、2026年。
export function periodShortLabel(period: Period): string {
  if (period.type === "day") return `${period.key.slice(5, 7)}/${period.key.slice(8, 10)} ${weekdayName(period.key)}`;
  if (period.type === "week") return `第${isoWeek(period.from).week}周 ${md(period.from)}–${md(period.to)}`;
  return periodLabel(period);
}

// 对比期：日＝前一天与上周同一天；周、月、年＝上一期。进行中的期（截至 through）与上一期的同样天数比。
export interface Comparison { key: "previous" | "lastWeek" | "lastYear"; label: string; period: Period; from: string; to: string }
export function comparisons(period: Period, through = period.to): Comparison[] {
  const last = through < period.to ? through : period.to;
  const elapsed = daysBetween(period.from, last);
  const within = (target: Period): { from: string; to: string } => {
    const to = addDays(target.from, elapsed);
    return { from: target.from, to: to < target.to ? to : target.to };
  };
  if (period.type === "day") {
    const previous = shiftPeriod(period, -1), lastWeek = shiftPeriod(period, -7);
    return [{ key: "previous", label: "较前一天", period: previous, from: previous.from, to: previous.to }, { key: "lastWeek", label: "较上周同日", period: lastWeek, from: lastWeek.from, to: lastWeek.to }];
  }
  const previous = shiftPeriod(period, -1);
  const label = period.type === "week" ? "较上周" : period.type === "month" ? "较上月" : "较去年";
  const output: Comparison[] = [{ key: "previous", label, period: previous, ...within(previous) }];
  if (period.type === "month") {
    const lastYear = periodOf("month", `${Number(period.key.slice(0, 4)) - 1}${period.key.slice(4)}-01`);
    output.push({ key: "lastYear", label: "较去年同月", period: lastYear, ...within(lastYear) });
  }
  return output;
}
