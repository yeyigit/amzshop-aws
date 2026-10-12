import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// 店铺中台登录：飞书 OAuth 授权码流程（专用自建应用“店铺中台”，可用范围仅用户本人）+ 白名单 + HMAC 签名的 __Host- Cookie。
// 签名密钥由应用密钥派生，不另存密钥；应用密钥轮换后旧登录态自然失效，重新免登即可。
export const SESSION_COOKIE = "__Host-portal_session";
export const STATE_COOKIE = "__Host-portal_state";
export const STATE_TTL_MS = 10 * 60_000;
export const DEFAULT_SESSION_DAYS = 7;
// 只申请“获取用户 user ID”：白名单按飞书 user_id 比对（与消息接收人配置同一种 ID）。
export const USER_SCOPE = "contact:user.employee_id:readonly";
export const AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
export const TOKEN_URL = "https://accounts.feishu.cn/oauth/v3/token";
export const USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";

export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface PortalUser { userId: string; openId: string; name: string; avatar: string }
export interface Session { u: string; o: string; n: string; a: string; iat: number; exp: number }
interface StatePayload { nonce: string; next: string; exp: number }

export class PortalAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PortalAuthError";
  }
}

export function signingKey(appSecret: string, purpose: "session" | "state"): Buffer {
  return createHmac("sha256", appSecret).update(`amzshop-portal|${purpose}|v1`).digest();
}

export function seal(payload: object, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

export function unseal<T>(token: string | undefined, key: Buffer): T | undefined {
  const [body, mac, extra] = String(token ?? "").split(".");
  if (!body || !mac || extra !== undefined) return undefined;
  const expected = createHmac("sha256", key).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T; } catch { return undefined; }
}

// Function URL 把 Cookie 放在 event.cookies；兼容直接带 cookie 头的调用。同名取第一个。
export function parseCookies(cookies: string[] | undefined, header?: string): Map<string, string> {
  const output = new Map<string, string>();
  const pairs = [...(cookies ?? []), ...String(header ?? "").split(";")];
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    if (name && !output.has(name)) output.set(name, pair.slice(index + 1).trim());
  }
  return output;
}

const cookie = (name: string, value: string, maxAgeSeconds: number): string => `${name}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; Secure; SameSite=Lax`;
export const clearCookie = (name: string): string => cookie(name, "", 0);

export function newSession(user: PortalUser, nowMs: number, days = DEFAULT_SESSION_DAYS): Session {
  return { u: user.userId, o: user.openId, n: user.name.slice(0, 64), a: user.avatar.slice(0, 512), iat: nowMs, exp: nowMs + days * 86_400_000 };
}

export function sessionCookie(session: Session, key: Buffer, nowMs: number): string {
  return cookie(SESSION_COOKIE, seal(session, key), (session.exp - nowMs) / 1000);
}

export function readSession(cookies: Map<string, string>, key: Buffer, nowMs: number): Session | undefined {
  const session = unseal<Session>(cookies.get(SESSION_COOKIE), key);
  if (!session || typeof session.exp !== "number" || session.exp <= nowMs || typeof session.iat !== "number" || session.iat > nowMs + 60_000) return undefined;
  return session;
}

// 登录后跳回的页面只允许本站相对路径，防开放重定向。
export function safeNext(value: string | undefined): string {
  const next = String(value ?? "");
  return /^\/(?![/\\])[\w\-./?=&%]*$/.test(next) ? next : "/";
}

export function authorizeUrl(appId: string, redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", USER_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

// state 签名并绑定一次性 Cookie（nonce），回调时两者一致且未过期才换取令牌，防 CSRF 与重放。
export function beginLogin(appId: string, redirectUri: string, next: string, key: Buffer, nowMs: number, nonce = randomBytes(16).toString("base64url")): { location: string; cookie: string } {
  const state = seal({ nonce, next: safeNext(next), exp: nowMs + STATE_TTL_MS } satisfies StatePayload, key);
  return { location: authorizeUrl(appId, redirectUri, state), cookie: cookie(STATE_COOKIE, nonce, STATE_TTL_MS / 1000) };
}

export function finishLogin(state: string | undefined, cookies: Map<string, string>, key: Buffer, nowMs: number): { next: string } | undefined {
  const payload = unseal<StatePayload>(state, key);
  const nonce = cookies.get(STATE_COOKIE);
  if (!payload || !nonce || payload.nonce !== nonce || !(payload.exp > nowMs)) return undefined;
  return { next: safeNext(payload.next) };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

export async function exchangeCode(appId: string, appSecret: string, code: string, redirectUri: string, fetcher: Fetcher = fetch): Promise<string> {
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: appId, client_secret: appSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await readJson(response);
  const token = typeof body.access_token === "string" ? body.access_token : "";
  if (!response.ok || Number(body.code ?? 0) !== 0 || !token) throw new PortalAuthError(`token_${String(body.code ?? response.status)}`, "飞书登录换取令牌失败。");
  return token;
}

export async function fetchUser(accessToken: string, fetcher: Fetcher = fetch): Promise<PortalUser> {
  const response = await fetcher(USER_INFO_URL, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
  const body = await readJson(response);
  const data = (body.data ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
  if (!response.ok || Number(body.code ?? -1) !== 0 || !text(data.open_id)) throw new PortalAuthError(`user_info_${String(body.code ?? response.status)}`, "飞书登录读取用户信息失败。");
  return { userId: text(data.user_id), openId: text(data.open_id), name: text(data.name) || text(data.en_name), avatar: text(data.avatar_thumb) || text(data.avatar_url) };
}

export function idList(value: string): string[] {
  return value.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean);
}

export function isAllowed(user: Pick<PortalUser, "userId" | "openId">, allowedUserIds: string[], allowedOpenIds: string[]): boolean {
  return (!!user.userId && allowedUserIds.includes(user.userId)) || (!!user.openId && allowedOpenIds.includes(user.openId));
}
