import { randomUUID } from "node:crypto";
import type { AppConfig, FeishuRecord } from "../types.js";
import { refreshSecrets } from "../config.js";
import { HttpError, delay } from "../http.js";

interface Token { value: string; expiresAt: number }
let tenantToken: Token | undefined;

interface FeishuEnvelope<T> { code: number; msg?: string; data?: T }
interface TokenEnvelope { code?: number; msg?: string; tenant_access_token?: string; expire?: number }

export interface FeishuClientOptions { sleep?: (milliseconds: number) => Promise<void> }
export interface FeishuBatchOptions { onChunk?: (completedCount: number) => Promise<void> | void }
// 日期字段的比较值写 ["ExactDate", "<毫秒>"]。
export interface FeishuCondition { field_name: string; operator: "is" | "isNot" | "isEmpty" | "isNotEmpty" | "isGreater" | "isLess"; value: string[] }

export const FEISHU_MAX_RETRIES = 3;
export const FEISHU_BATCH_SIZE = 500;
// 租户本月 API 调用额度用尽（HTTP 429，每月 1 日重置）：重试无意义，立即报错。
export const FEISHU_QUOTA_CODE = 99991403;
const retryCapMs = 10_000;
// 1254002 Fail 为飞书内部错误：2026-09-30 至 10-01 生产出现 3 次，整轮任务重跑均成功，按暂态处理。
// 1255001 InternalError 同为飞书内部错误：2026-10-06 只读脚本读订单表时遇到 1 次，重跑即成功，按暂态处理。
const retryableCodes = new Set([1254002, 1254290, 1254291, 1254607, 1255001, 1255040, 99991400]);
const rateLimitCodes = new Set([1254290, 99991400]);
const credentialCodes = new Set([10003, 10014, 10015, 99991543]);

// 本实例自上次落库以来成功的飞书调用次数（失败调用不占租户额度、认证接口不计额度，均不计）与额度用尽次数；各 handler 结束时落到状态表 FEISHU_USAGE。
export interface FeishuUsage { calls: number; rejected: number; rejectedAt?: string }
const usage: FeishuUsage = { calls: 0, rejected: 0 };

export function takeFeishuUsage(): FeishuUsage {
  const taken = { ...usage };
  usage.calls = 0;
  usage.rejected = 0;
  delete usage.rejectedAt;
  return taken;
}

// 落库失败时放回计数，下次调用一并落库。
export function restoreFeishuUsage(taken: FeishuUsage): void {
  usage.calls += taken.calls;
  usage.rejected += taken.rejected;
  if (taken.rejectedAt && !(usage.rejectedAt && usage.rejectedAt > taken.rejectedAt)) usage.rejectedAt = taken.rejectedAt;
}

export function isFeishuQuotaError(error: unknown): boolean {
  return error instanceof HttpError && error.code === String(FEISHU_QUOTA_CODE);
}

function retryDelay(attempt: number, response?: Response, rateLimited = false): number {
  const header = (rateLimited ? response?.headers.get("x-ogw-ratelimit-reset") : null) || response?.headers.get("retry-after");
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(retryCapMs, seconds * 1000);
  return Math.min(retryCapMs, 1000 * 2 ** attempt + Math.floor(Math.random() * 250));
}

function parseBody<T>(text: string): T | undefined {
  try { return JSON.parse(text) as T; } catch { return undefined; }
}

function replayable(method: string, url: URL): boolean {
  if (method !== "POST") return true;
  if (/\/records\/(search|batch_update|batch_delete)$/.test(url.pathname)) return true;
  return url.searchParams.has("client_token") || url.searchParams.has("uuid");
}

function receipt<T>(records: T[] | undefined): T[] {
  return Array.isArray(records) ? records : [];
}

function uniqueIds(ids: string[], action: string): void {
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error(`飞书批量${action}的 record_id 为空或重复。`);
}

export class FeishuClient {
  private readonly base = "https://open.feishu.cn";
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly config: AppConfig, options: FeishuClientOptions = {}) {
    this.sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
  }

  private async token(force = false): Promise<string> {
    if (!force && tenantToken && tenantToken.expiresAt > Date.now()) return tenantToken.value;
    let refreshed = false;
    for (let retries = 0; ;) {
      const payload = JSON.stringify({ app_id: this.config.get("FEISHU_APP_ID"), app_secret: this.config.get("FEISHU_APP_SECRET") });
      let response: Response;
      let text: string;
      try {
        response = await fetch(`${this.base}/open-apis/auth/v3/tenant_access_token/internal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(15_000),
        });
        text = await response.text();
      } catch (error) {
        if (retries >= FEISHU_MAX_RETRIES) throw error;
        await this.sleep(retryDelay(retries++));
        continue;
      }
      const body = parseBody<TokenEnvelope>(text);
      if (response.ok && body?.code === 0 && body.tenant_access_token) {
        tenantToken = { value: body.tenant_access_token, expiresAt: Date.now() + Math.max(60, (body.expire ?? 7200) - 300) * 1000 };
        return tenantToken.value;
      }
      const code = Number(body?.code);
      if (!refreshed && credentialCodes.has(code)) {
        refreshed = true;
        await refreshSecrets();
        continue;
      }
      const rateLimited = response.status === 429 || rateLimitCodes.has(code);
      const retryable = rateLimited || response.status >= 500;
      if (retryable && retries < FEISHU_MAX_RETRIES) {
        await this.sleep(retryDelay(retries++, response, rateLimited));
        continue;
      }
      throw new HttpError(response.status, String(body?.code ?? "invalid_json"), "", "飞书 Tenant Token 获取失败。", retryable);
    }
  }

  async request<T>(method: string, path: string, body?: unknown, query: Record<string, string | number | undefined> = {}, tokenRetry = true): Promise<T> {
    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    const verb = method.toUpperCase();
    const canRetry = replayable(verb, url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let tokenRefreshed = !tokenRetry;
    for (let retries = 0; ;) {
      const token = await this.token();
      let response: Response;
      let text: string;
      try {
        response = await fetch(url, {
          method: verb,
          headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
          ...(payload === undefined ? {} : { body: payload }),
          signal: AbortSignal.timeout(25_000),
        });
        text = await response.text();
      } catch (error) {
        if (!canRetry || retries >= FEISHU_MAX_RETRIES) throw error;
        await this.sleep(retryDelay(retries++));
        continue;
      }
      const envelope = parseBody<FeishuEnvelope<T>>(text);
      if (envelope?.code === 99991663 && !tokenRefreshed) {
        tokenRefreshed = true;
        tenantToken = undefined;
        await this.token(true);
        continue;
      }
      if (response.ok && envelope?.code === 0 && envelope.data !== undefined) {
        usage.calls += 1;
        return envelope.data;
      }
      const code = Number(envelope?.code);
      const requestId = response.headers.get("x-tt-logid") ?? response.headers.get("x-request-id") ?? "";
      if (code === FEISHU_QUOTA_CODE) {
        usage.rejected += 1;
        usage.rejectedAt = new Date().toISOString();
        throw new HttpError(response.status, String(code), requestId, "飞书 API 本月调用额度已用尽（99991403），每月 1 日重置，期间飞书读写与消息都会失败。", false);
      }
      const rateLimited = response.status === 429 || rateLimitCodes.has(code);
      const retryable = rateLimited || response.status >= 500 || retryableCodes.has(code);
      if (retryable && canRetry && retries < FEISHU_MAX_RETRIES) {
        await this.sleep(retryDelay(retries++, response, rateLimited));
        continue;
      }
      if (!envelope) throw new HttpError(response.status, "invalid_json", requestId, "飞书返回非 JSON。", response.status >= 500);
      throw new HttpError(response.status, String(envelope.code), requestId, `飞书 API 失败: ${envelope.msg ?? ""}`.trim(), retryable);
    }
  }

  private recordsPath(appToken: string, tableId: string): string {
    return `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;
  }

  // fields 为“等于”条件；options.conditions 追加其它条件（如 isEmpty、isNot），全部按 and 组合。
  async searchRecords(appToken: string, tableId: string, fields: Record<string, string>, options: { fieldNames?: string[]; conditions?: FeishuCondition[] } = {}): Promise<FeishuRecord[]> {
    const output: FeishuRecord[] = [];
    let pageToken = "";
    const conditions = [...Object.entries(fields).map(([fieldName, value]) => ({ field_name: fieldName, operator: "is", value: [value] })), ...(options.conditions ?? [])];
    do {
      const data = await this.request<{ items?: FeishuRecord[]; has_more?: boolean; page_token?: string }>(
        "POST",
        `${this.recordsPath(appToken, tableId)}/search`,
        { ...(options.fieldNames ? { field_names: options.fieldNames } : {}), filter: { conjunction: "and", conditions } },
        { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) },
      );
      output.push(...(data.items ?? []));
      pageToken = data.has_more ? String(data.page_token ?? "") : "";
      if (data.has_more && !pageToken) throw new Error("飞书分页缺少 page_token。 ");
    } while (pageToken);
    return output;
  }

  async listRecords(appToken: string, tableId: string): Promise<FeishuRecord[]> {
    const output: FeishuRecord[] = [];
    let pageToken = "";
    do {
      const data = await this.request<{ items?: FeishuRecord[]; has_more?: boolean; page_token?: string }>(
        "GET",
        this.recordsPath(appToken, tableId),
        undefined,
        { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) },
      );
      output.push(...(data.items ?? []));
      pageToken = data.has_more ? String(data.page_token ?? "") : "";
      if (data.has_more && !pageToken) throw new Error("飞书分页缺少 page_token。 ");
    } while (pageToken);
    return output;
  }

  // 只取表的记录总数：查询接口 page_size=1、不带视图与条件，读响应的 total。
  async countRecords(appToken: string, tableId: string): Promise<number> {
    const data = await this.request<{ total?: number }>("POST", `${this.recordsPath(appToken, tableId)}/search`, { automatic_fields: false }, { page_size: 1 });
    const total = Number(data.total);
    if (!Number.isInteger(total) || total < 0) throw new Error("飞书查询记录未返回有效的 total。");
    return total;
  }

  async listTables(appToken: string): Promise<Record<string, unknown>[]> {
    const output: Record<string, unknown>[] = [];
    let pageToken = "";
    do {
      const data = await this.request<{ items?: Record<string, unknown>[]; has_more?: boolean; page_token?: string }>(
        "GET", `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, undefined,
        { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
      );
      output.push(...(data.items ?? []));
      pageToken = data.has_more ? String(data.page_token ?? "") : "";
      if (data.has_more && !pageToken) throw new Error("飞书表分页缺少 page_token。 ");
    } while (pageToken);
    return output;
  }

  async listFields(appToken: string, tableId: string): Promise<Record<string, unknown>[]> {
    const output: Record<string, unknown>[] = [];
    let pageToken = "";
    do {
      const data = await this.request<{ items?: Record<string, unknown>[]; has_more?: boolean; page_token?: string }>(
        "GET", `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`, undefined,
        { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
      );
      output.push(...(data.items ?? []));
      pageToken = data.has_more ? String(data.page_token ?? "") : "";
      if (data.has_more && !pageToken) throw new Error("飞书字段分页缺少 page_token。 ");
    } while (pageToken);
    return output;
  }

  async upsert(appToken: string, tableId: string, key: Record<string, string>, fields: Record<string, unknown>, createOnlyFields: Record<string, unknown> = {}, options: { existing?: FeishuRecord[] } = {}): Promise<string> {
    const existing = options.existing ?? await this.searchRecords(appToken, tableId, key);
    if (existing.length > 1) throw new Error(`飞书稳定业务键不唯一: ${Object.values(key).join("|")}`);
    if (existing[0]) {
      await this.update(appToken, tableId, existing[0].record_id, fields);
      return existing[0].record_id;
    }
    const created = await this.request<{ record: FeishuRecord }>("POST", this.recordsPath(appToken, tableId), { fields: { ...fields, ...createOnlyFields } }, { client_token: randomUUID() });
    if (!created.record?.record_id) throw new Error("飞书创建记录后未返回 record_id。 ");
    return created.record.record_id;
  }

  async update(appToken: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
    await this.request("PUT", `${this.recordsPath(appToken, tableId)}/${encodeURIComponent(recordId)}`, { fields });
  }

  async delete(appToken: string, tableId: string, recordId: string): Promise<void> {
    await this.request("DELETE", `${this.recordsPath(appToken, tableId)}/${encodeURIComponent(recordId)}`);
  }

  async batchCreate(appToken: string, tableId: string, rows: Array<Record<string, unknown>>, options: FeishuBatchOptions = {}): Promise<string[]> {
    const ids: string[] = [];
    for (let offset = 0; offset < rows.length; offset += FEISHU_BATCH_SIZE) {
      const chunk = rows.slice(offset, offset + FEISHU_BATCH_SIZE);
      const data = await this.request<{ records?: FeishuRecord[] }>("POST", `${this.recordsPath(appToken, tableId)}/batch_create`, { records: chunk.map((fields) => ({ fields })) }, { client_token: randomUUID() });
      const created = receipt(data.records).map((record) => String(record?.record_id ?? ""));
      if (created.length !== chunk.length || created.some((id) => !id) || new Set(created).size !== created.length) throw new Error("飞书批量创建回执与请求记录不一致。");
      ids.push(...created);
      await options.onChunk?.(offset + chunk.length);
    }
    return ids;
  }

  async batchUpdate(appToken: string, tableId: string, rows: Array<{ recordId: string; fields: Record<string, unknown> }>, options: FeishuBatchOptions = {}): Promise<void> {
    uniqueIds(rows.map((row) => row.recordId), "更新");
    for (let offset = 0; offset < rows.length; offset += FEISHU_BATCH_SIZE) {
      const chunk = rows.slice(offset, offset + FEISHU_BATCH_SIZE);
      const data = await this.request<{ records?: FeishuRecord[] }>("POST", `${this.recordsPath(appToken, tableId)}/batch_update`, { records: chunk.map((row) => ({ record_id: row.recordId, fields: row.fields })) }, { client_token: randomUUID() });
      const records = receipt(data.records);
      const returned = new Set(records.map((record) => String(record?.record_id ?? "")));
      if (records.length !== chunk.length || chunk.some((row) => !returned.has(row.recordId))) throw new Error("飞书批量更新回执与请求记录不一致。");
      await options.onChunk?.(offset + chunk.length);
    }
  }

  async batchDelete(appToken: string, tableId: string, recordIds: string[], options: FeishuBatchOptions = {}): Promise<void> {
    uniqueIds(recordIds, "删除");
    for (let offset = 0; offset < recordIds.length; offset += FEISHU_BATCH_SIZE) {
      const chunk = recordIds.slice(offset, offset + FEISHU_BATCH_SIZE);
      const data = await this.request<{ records?: Array<{ record_id?: string; deleted?: boolean }> }>("POST", `${this.recordsPath(appToken, tableId)}/batch_delete`, { records: chunk });
      const records = receipt(data.records);
      const deleted = new Set(records.filter((record) => record?.deleted === true).map((record) => String(record.record_id ?? "")));
      if (records.length !== chunk.length || chunk.some((id) => !deleted.has(id))) throw new Error("飞书批量删除回执未逐条确认。");
      await options.onChunk?.(offset + chunk.length);
    }
  }

  async sendText(userId: string, lines: string[], uuid: string): Promise<void> {
    await this.request("POST", "/open-apis/im/v1/messages", {
      receive_id: userId,
      msg_type: "text",
      content: JSON.stringify({ text: lines.join("\n") }),
    }, { receive_id_type: "user_id", uuid });
  }

  // 富文本消息（post）：标题、逐行文字，末行可带链接（店铺报告的“查看日报 ›”）。同样按 uuid 去重。
  async sendPost(userId: string, post: { title: string; lines: string[]; link?: { text: string; url: string } }, uuid: string): Promise<void> {
    const content = [...post.lines.map((line) => [{ tag: "text", text: line }]), ...(post.link ? [[{ tag: "a", text: post.link.text, href: post.link.url }]] : [])];
    await this.request("POST", "/open-apis/im/v1/messages", {
      receive_id: userId,
      msg_type: "post",
      content: JSON.stringify({ zh_cn: { title: post.title, content } }),
    }, { receive_id_type: "user_id", uuid });
  }
}
