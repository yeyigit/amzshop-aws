// 店铺中台的时间口径：“今日”按洛杉矶站点日（与亚马逊后台一致），页面同时显示北京时间。
export const SITE_ZONE = "America/Los_Angeles";
export const HOME_ZONE = "Asia/Shanghai";
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number; ymd: string }

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
    .formatToParts(new Date(ms)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
  const hour = Number(parts.hour) % 24, minute = Number(parts.minute);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday));
  return { year, month, day, hour, minute, weekday, ymd: `${parts.year}-${parts.month}-${parts.day}` };
}

// 站点日内已过去的小时数（含分钟小数），用于“截至同一时刻”对比。
export function siteHourOfDay(ms: number): number {
  const parts = zonedParts(ms, SITE_ZONE);
  return parts.hour + parts.minute / 60;
}

export function clockLabel(ms: number, timeZone: string): string {
  const parts = zonedParts(ms, timeZone);
  return `${parts.month}/${parts.day} ${WEEKDAYS[parts.weekday] ?? ""} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function dayLabel(ymd: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return ymd;
  const weekday = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
  return `${Number(match[2])}/${Number(match[3])} ${WEEKDAYS[weekday] ?? ""}`;
}

// 按北京时间问候：用户在国内看页面。
export function greeting(ms: number): string {
  const hour = zonedParts(ms, HOME_ZONE).hour;
  if (hour < 5) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 13) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}
