import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export const nowIso = (): string => new Date().toISOString();
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
export const ownerId = (): string => randomUUID();

export function canonicalJson(value: unknown): string {
  if (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") return canonicalJson((value as { toJSON: () => unknown }).toJSON());
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).filter((key) => !["undefined", "function", "symbol"].includes(typeof object[key])).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const canonicalHash = (value: unknown): string => sha256(canonicalJson(value));

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseJson<T>(value: string, label = "JSON"): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} 格式无效。`);
  }
}

export function deepFind(value: unknown, names: readonly string[], depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFind(item, names, depth + 1);
      if (found !== undefined && found !== "") return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, item] of Object.entries(object)) {
    if (wanted.has(key.toLowerCase()) && item !== null && item !== undefined && String(item).trim()) return item;
  }
  for (const item of Object.values(object)) {
    const found = deepFind(item, names, depth + 1);
    if (found !== undefined && found !== "") return found;
  }
  return undefined;
}

export function unwrapNotification(input: unknown): unknown {
  let current = input;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current === "string") {
      current = parseJson<unknown>(current, "消息体");
      continue;
    }
    if (current && typeof current === "object") {
      const object = current as Record<string, unknown>;
      if (typeof object.Message === "string") {
        current = object.Message;
        continue;
      }
      if (typeof object.message === "string") {
        current = object.message;
        continue;
      }
    }
    break;
  }
  return current;
}

export function stableKey(...parts: unknown[]): string {
  return parts.map((part) => String(part ?? "").trim()).join("|");
}

export function auditEncode(value: unknown): string {
  return `gz1:${gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64")}`;
}

export function auditDecode<T>(value: string): T {
  if (!value.startsWith("gz1:")) return parseJson<T>(value, "审计字段");
  return JSON.parse(gunzipSync(Buffer.from(value.slice(4), "base64")).toString("utf8")) as T;
}

export function mustString(value: unknown, label: string): string {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} 不能为空。`);
  return result;
}

export function booleanFact(value: unknown): { known: boolean; value: boolean } {
  if (typeof value === "boolean") return { known: true, value };
  if (typeof value !== "string") return { known: false, value: false };
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "false"
    ? { known: true, value: normalized === "true" }
    : { known: false, value: false };
}

export function timeMs(value: unknown): number {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function feishuFieldText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value).trim();
  if (Array.isArray(value)) return value.map(feishuFieldText).filter(Boolean).join(",");
  const row = value as Record<string, unknown>;
  return feishuFieldText(row.text ?? row.name ?? row.value);
}

export function feishuRelationRecordIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (item: unknown): void => {
    if (!item) return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (typeof item !== "object") return;
    const row = item as Record<string, unknown>;
    const id = String(row.record_id ?? row.recordId ?? "").trim();
    if (id) ids.add(id);
    for (const [key, child] of Object.entries(row)) if (key !== "record_id" && key !== "recordId" && typeof child === "object") visit(child);
  };
  visit(value);
  return [...ids];
}

// 飞书文本时间比较先后用：先取富文本的纯文本；不带时区的 “YYYY-MM-DD HH:mm:ss”（或 T 分隔）按洛杉矶本地时间换算，带 Z 或偏移的 ISO 照常解析；无效返回 0。
// 秋季回拨那一小时的本地时间对应两个时刻，换算可能差 1 小时（全年只有这一小时）。
export function losAngelesTimeMs(value: unknown): number {
  const text = feishuFieldText(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) return timeMs(text);
  const wanted = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let guess = wanted;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])) as Record<string, number>;
    guess += wanted - Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour === 24 ? 0 : parts.hour!, parts.minute!, parts.second!);
  }
  return Number.isFinite(guess) ? guess : 0;
}

export function amazonLocalTime(value: unknown): string {
  const date = new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date) : "";
}

export function ymdInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addDaysYmd(ymd: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) throw new Error(`无效日期: ${ymd}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days)).toISOString().slice(0, 10);
}

export function zonedMidnight(ymd: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) throw new Error(`无效日期: ${ymd}`);
  const wanted = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let guess = wanted;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])) as Record<string, number>;
    const { year, month, day, hour, minute, second } = parts;
    if ([year, month, day, hour, minute, second].some((part) => part === undefined)) throw new Error(`无法计算 ${timeZone} 时区日期。`);
    const represented = Date.UTC(year!, month! - 1, day!, hour === 24 ? 0 : hour!, minute!, second!);
    guess += wanted - represented;
  }
  return new Date(guess).toISOString();
}
