import type { AppConfig, Json, RetryOptions } from "../types.js";
import { refreshSecrets } from "../config.js";
import { HttpError, delay, fetchJson, httpError } from "../http.js";

interface Token { value: string; expiresAt: number }
export interface Pace { key: string; minIntervalMs: number }
export interface AmazonClientOptions { sleep?: (milliseconds: number) => Promise<void> }
type Query = Record<string, string | number | boolean | undefined>;
// sp-notifications：通知 API 的目的地与按 ID 删除订阅属于免授权（grantless）操作，用应用凭证换 client_credentials 令牌。
type TokenKind = "sp" | "ads" | "sp-notifications";

const tokens = new Map<string, Token>();
const tokenLoads = new Map<string, Promise<string>>();
const paces = new Map<string, { last: number; queue: Promise<void> }>();

async function paced(pace: Pace | undefined): Promise<void> {
  if (!pace) return;
  const slot = paces.get(pace.key) ?? { last: 0, queue: Promise.resolve() };
  paces.set(pace.key, slot);
  const turn = slot.queue.then(async () => {
    for (let wait = slot.last + pace.minIntervalMs - Date.now(); wait > 0; wait = slot.last + pace.minIntervalMs - Date.now()) await delay(wait);
    slot.last = Date.now();
  });
  slot.queue = turn;
  await turn;
}

function tokenRejected(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 401 || error.status === 403) && /unauthori[sz]ed|token|^401$/i.test(error.code);
}

function credentialRejected(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 400 || error.status === 401) && ["invalid_client", "invalid_grant"].includes(error.code);
}

function endpoint(base: string, path: string, query: Query = {}): URL {
  const url = new URL(path, new URL(base));
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  return url;
}

function parseBody(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

export class AmazonClient {
  private readonly retry: Pick<RetryOptions, "sleep">;

  constructor(private readonly config: AppConfig, options: AmazonClientOptions = {}) {
    this.retry = options.sleep ? { sleep: options.sleep } : {};
  }

  private async accessToken(kind: TokenKind, rejected?: string): Promise<string> {
    const cached = tokens.get(kind);
    if (cached && cached.expiresAt > Date.now() && cached.value !== rejected) return cached.value;
    const pending = tokenLoads.get(kind);
    if (pending) return pending;
    const loading = this.fetchToken(kind).finally(() => tokenLoads.delete(kind));
    tokenLoads.set(kind, loading);
    return loading;
  }

  private async fetchToken(kind: TokenKind): Promise<string> {
    const prefix = kind === "ads" ? "ADS_" : "";
    const grant = (): Record<string, string> => kind === "sp-notifications"
      ? { grant_type: "client_credentials", scope: "sellingpartnerapi::notifications", client_id: this.config.get("CLIENT_ID"), client_secret: this.config.get("CLIENT_SECRET") }
      : { grant_type: "refresh_token", refresh_token: this.config.get(`${prefix}REFRESH_TOKEN`), client_id: this.config.get(`${prefix}CLIENT_ID`), client_secret: this.config.get(`${prefix}CLIENT_SECRET`) };
    const request = (): Promise<{ access_token?: string; expires_in?: number }> => fetchJson("https://api.amazon.com/auth/o2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(grant()),
    }, { attempts: 2, timeoutMs: 15_000, ...this.retry });
    let response: { access_token?: string; expires_in?: number };
    try {
      response = await request();
    } catch (error) {
      if (!credentialRejected(error)) throw error;
      await refreshSecrets();
      response = await request();
    }
    if (!response.access_token) throw new Error(`Amazon ${kind} token 响应缺少 access_token。`);
    tokens.set(kind, { value: response.access_token, expiresAt: Date.now() + Math.max(60, (response.expires_in ?? 3600) - 300) * 1000 });
    return response.access_token;
  }

  private async authorized<T>(kind: TokenKind, pace: Pace | undefined, send: (token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken(kind);
    await paced(pace);
    try {
      return await send(token);
    } catch (error) {
      if (!tokenRejected(error)) throw error;
      const fresh = await this.accessToken(kind, token);
      await paced(pace);
      return send(fresh);
    }
  }

  private spHeaders(token: string, json: boolean): Record<string, string> {
    return { "x-amz-access-token": token, "user-agent": this.config.optional("SP_API_USER_AGENT", "AMZShop/1.0 (Language=TypeScript; Platform=AWS Lambda)"), ...(json ? { "content-type": "application/json" } : {}) };
  }

  async sp<T extends Json>(path: string, init: { method?: string; query?: Query; body?: Json; pace?: Pace } = {}): Promise<T> {
    const url = endpoint(this.config.optional("SP_API_BASE_URL", "https://sellingpartnerapi-na.amazon.com"), path, init.query);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    return this.authorized("sp", init.pace, (token) => fetchJson<T>(url, { method, headers: this.spHeaders(token, !!body), ...(body ? { body } : {}) }, { attempts: 3, timeoutMs: 25_000, baseDelayMs: 1_000, ...this.retry }));
  }

  async spStatus(path: string, init: { method?: string; query?: Query; body?: Json; pace?: Pace } = {}): Promise<number> {
    const url = endpoint(this.config.optional("SP_API_BASE_URL", "https://sellingpartnerapi-na.amazon.com"), path, init.query);
    const method = (init.method ?? "POST").toUpperCase();
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    return this.authorized("sp", init.pace, async (token) => {
      const response = await fetch(url, { method, headers: this.spHeaders(token, !!body), ...(body ? { body } : {}), signal: AbortSignal.timeout(25_000) });
      if (response.ok) return response.status;
      const transient = response.status === 408 || response.status === 429 || response.status >= 500;
      throw httpError(response, parseBody(await response.text().catch(() => "")), transient ? `SP-API 可重试失败 HTTP ${response.status}。` : `SP-API 失败 HTTP ${response.status}。`);
    });
  }

  // 免授权通知接口（目的地查询/创建、按 ID 删除订阅）：只用于人工触发的运维任务，不自动重试；成功但无正文时返回 {}。
  async spGrantless<T extends Json>(path: string, init: { method?: string; body?: Json } = {}): Promise<T> {
    const url = endpoint(this.config.optional("SP_API_BASE_URL", "https://sellingpartnerapi-na.amazon.com"), path);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    return this.authorized("sp-notifications", undefined, async (token) => {
      const response = await fetch(url, { method, headers: this.spHeaders(token, !!body), ...(body ? { body } : {}), signal: AbortSignal.timeout(25_000) });
      const text = await response.text().catch(() => "");
      const parsed = text ? parseBody(text) : {};
      if (response.ok) return (parsed ?? {}) as T;
      throw httpError(response, parsed, `SP-API 通知接口失败 HTTP ${response.status}。`);
    });
  }

  async ads<T extends Json>(path: string, init: { method?: string; query?: Record<string, string | number | undefined>; body?: Json; profileId?: string; mediaType?: string; pace?: Pace } = {}): Promise<T> {
    const url = endpoint(this.config.optional("ADS_API_BASE", "https://advertising-api.amazon.com"), path, init.query);
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    return this.authorized("ads", init.pace, (token) => fetchJson<T>(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Amazon-Advertising-API-ClientId": this.config.get("ADS_CLIENT_ID"),
        ...(init.profileId ? { "Amazon-Advertising-API-Scope": init.profileId } : {}),
        ...(body ? { "content-type": init.mediaType ?? "application/json" } : {}),
        ...(init.mediaType ? { Accept: init.mediaType } : {}),
      },
      ...(body ? { body } : {}),
    }, { attempts: 3, timeoutMs: 30_000, ...this.retry }));
  }

  async adsDownload(url: string): Promise<Uint8Array> {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Ads 报表下载失败 HTTP ${response.status}。`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async download(url: string): Promise<Uint8Array> {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Amazon 文档下载失败 HTTP ${response.status}。`);
    return new Uint8Array(await response.arrayBuffer());
  }
}
