import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { AppConfig } from "../types.js";
import { getConfig } from "../config.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { flushFeishuUsage } from "../feishu-quota.js";
import { log, logError } from "../log.js";
import {
  DEFAULT_SESSION_DAYS, PortalAuthError, SESSION_COOKIE, STATE_COOKIE, beginLogin, clearCookie, exchangeCode, fetchUser, finishLogin, idList, isAllowed, newSession,
  parseCookies, readSession, sessionCookie, signingKey, type Fetcher, type Session,
} from "../portal/auth.js";
import { CACHE_PK, readCache, refreshSections, staleSections, type SourceContext } from "../portal/sources.js";
import { DEFAULT_TITLE, buildView, type ViewOptions } from "../portal/view.js";
import { portalLinks } from "../portal/links.js";
import { contentSecurityPolicy, renderMessagePage, renderPortalPage, type MessagePage } from "../portal/page.js";
import { renderReportPage } from "../portal/report-page.js";
import { SITE_ZONE } from "../portal/clock.js";
import { loadReportInput, parseStored } from "../report/load.js";
import { addDays, parsePeriod, type Period } from "../report/periods.js";
import { REPORT_META_PK, type ReportMeta } from "../report/types.js";
import { buildReportView, type CatalogEntry, type ReportView } from "../report/view.js";
import { ymdInZone } from "../util.js";

// 店铺中台入口（Lambda 函数网址）：只读页面 + 飞书登录。除 /healthz 外一律要求白名单内的登录态。
export interface PortalDeps {
  config: (force?: boolean) => Promise<AppConfig>;
  state: StateStore;
  amazon: (config: AppConfig) => AmazonClient;
  feishu: (config: AppConfig) => FeishuClient;
  fetcher: Fetcher;
  now: () => number;
  nonce: () => string;
}

type Result = Exclude<LambdaFunctionURLResult, string>;
// 应用凭证刚写入时实例里还是旧缓存：缺凭证时最多每分钟强制重读一次配置。
const SETUP_RELOAD_MS = 60_000;
let setupReloadAt = 0;

function securityHeaders(nonce: string, contentType: string): Record<string, string> {
  return {
    "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000", "permissions-policy": "camera=(), microphone=(), geolocation=()", "content-security-policy": contentSecurityPolicy(nonce),
  };
}

function respond(event: LambdaFunctionURLEvent, status: number, body: string, headers: Record<string, string>, cookies?: string[]): Result {
  const gzip = /\bgzip\b/i.test(event.headers?.["accept-encoding"] ?? "") && Buffer.byteLength(body) > 1024;
  return {
    statusCode: status,
    headers: gzip ? { ...headers, "content-encoding": "gzip", vary: "accept-encoding" } : headers,
    body: gzip ? gzipSync(body).toString("base64") : body,
    ...(gzip ? { isBase64Encoded: true } : {}),
    ...(cookies?.length ? { cookies } : {}),
  };
}

const html = (event: LambdaFunctionURLEvent, status: number, body: string, nonce: string, cookies?: string[]): Result => respond(event, status, body, securityHeaders(nonce, "text/html; charset=utf-8"), cookies);
const json = (event: LambdaFunctionURLEvent, status: number, value: unknown, nonce: string): Result => respond(event, status, JSON.stringify(value), securityHeaders(nonce, "application/json; charset=utf-8"));
const redirect = (location: string, cookies: string[]): Result => ({ statusCode: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" }, body: "", cookies });

// 页面名称：飞书应用名改了也能跟着改（导航标签取页面标题），默认 AMZ中台。
export function portalTitle(config: AppConfig): string {
  return config.optional("PORTAL_TITLE", DEFAULT_TITLE).trim().slice(0, 30) || DEFAULT_TITLE;
}

function viewOptions(config: AppConfig, session: Session, nowMs: number): ViewOptions {
  return {
    nowMs, title: portalTitle(config), user: { name: session.n, avatar: session.a },
    asinBySku: Object.fromEntries(config.asins().filter((item) => item.asin).map((item) => [item.sku, item.asin])),
    links: portalLinks(config),
  };
}

function routeName(path: string): string {
  if (/^\/report(\/|$)/.test(path)) return "/report";
  return ["/", "/healthz", "/auth/callback", "/api/refresh", "/api/snapshot", "/api/report"].includes(path) ? path : "other";
}

// 报告页：/report/{day|week|month|year}/{期}；/report 跳到最新一期日报。
const REPORT_PATH = /^\/report\/(day|week|month|year)\/([0-9A-Za-z-]{4,10})\/?$/;

// 商品主图与标题取中台已缓存的商品资料（PORTAL_CACHE/catalog，只读），报告本身不存。
async function readCatalog(state: StateStore): Promise<Record<string, CatalogEntry>> {
  const item = await state.get(CACHE_PK, "catalog");
  const data = parseStored<{ items?: Array<{ sku: string; title: string; image: string; asin: string }> }>(item);
  return Object.fromEntries((data?.items ?? []).map((entry) => [entry.sku, { title: entry.title, image: entry.image, asin: entry.asin }]));
}

async function reportView(state: StateStore, period: Period, nowMs: number): Promise<ReportView> {
  const today = ymdInZone(new Date(nowMs), SITE_ZONE);
  const [catalog] = await Promise.all([readCatalog(state)]);
  return buildReportView(await loadReportInput(state, period, today, nowMs, { events: true, catalog }));
}

export function createPortalHandler(deps: PortalDeps): (event: LambdaFunctionURLEvent) => Promise<Result> {
  async function route(event: LambdaFunctionURLEvent, nonce: string): Promise<Result> {
    const method = event.requestContext?.http?.method ?? "GET";
    const path = event.rawPath || "/";
    const api = path.startsWith("/api/");
    if (path === "/healthz") return { statusCode: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: "ok" };
    let config = await deps.config();
    const title = portalTitle(config);
    const say = (status: number, page: MessagePage, cookies?: string[]): Result => html(event, status, renderMessagePage(page, nonce, title), nonce, cookies);
    if (!config.bool("PORTAL_ENABLED", true)) {
      return api ? json(event, 503, { error: "disabled" }, nonce) : say(503, { title: `${title}已关闭`, message: "管理员关闭了中台（PORTAL_ENABLED=false）。现有通知与数据同步不受影响。" });
    }
    if ((!config.optional("PORTAL_FEISHU_APP_ID", "") || !config.optional("PORTAL_FEISHU_APP_SECRET", "")) && deps.now() - setupReloadAt >= SETUP_RELOAD_MS) {
      setupReloadAt = deps.now();
      config = await deps.config(true);
    }
    const appId = config.optional("PORTAL_FEISHU_APP_ID", "").trim();
    const appSecret = config.optional("PORTAL_FEISHU_APP_SECRET", "").trim();
    const host = event.requestContext?.domainName ?? "";
    if (!appId || !appSecret) {
      return api ? json(event, 503, { error: "setup_required" }, nonce) : say(200, {
        title: `${title}已部署，等待飞书登录配置`,
        message: `还差最后一步：在飞书开发者后台创建网页应用“${title}”，并写入 App ID 与 App Secret。`,
        lines: ["网页应用主页地址填本页地址；重定向 URL 填下面这一行。"], code: `https://${host}/auth/callback`,
      });
    }
    const sessionKey = signingKey(appSecret, "session");
    const stateKey = signingKey(appSecret, "state");
    const cookies = parseCookies(event.cookies, event.headers?.cookie);
    const redirectUri = `https://${host}/auth/callback`;
    const now = deps.now();
    const allowedUsers = idList(config.optional("PORTAL_ALLOWED_USER_IDS", ""));
    const allowedOpenIds = idList(config.optional("PORTAL_ALLOWED_OPEN_IDS", ""));

    if (path === "/auth/callback" && method === "GET") {
      const query = event.queryStringParameters ?? {};
      if (query.error) return say(403, { title: "没有完成授权", message: `你在飞书里取消了授权。重新打开${title}即可再次登录。` }, [clearCookie(STATE_COOKIE)]);
      const verified = finishLogin(query.state, cookies, stateKey, now);
      if (!verified || !query.code) return say(400, { title: "登录链接已过期", message: `请从飞书左侧导航重新打开${title}。` }, [clearCookie(STATE_COOKIE)]);
      try {
        const user = await fetchUser(await exchangeCode(appId, appSecret, query.code, redirectUri, deps.fetcher), deps.fetcher);
        if (!isAllowed(user, allowedUsers, allowedOpenIds)) {
          log("WARN", "portal_login_denied", { hasUserId: !!user.userId, allowlist: allowedUsers.length + allowedOpenIds.length });
          return say(403, {
            title: "这个账号没有权限",
            message: `${title}只对白名单里的飞书账号开放。`,
            lines: user.userId ? ["如需开通，把下面的 user_id 加到配置 PORTAL_ALLOWED_USER_IDS。"] : ["飞书没有返回 user_id：请确认应用已开通“获取用户 user ID”权限并发布版本；或把下面的 open_id 加到 PORTAL_ALLOWED_OPEN_IDS。"],
            code: user.userId ? `user_id: ${user.userId}` : `open_id: ${user.openId}`,
          }, [clearCookie(STATE_COOKIE)]);
        }
        const days = Number(config.optional("PORTAL_SESSION_DAYS", String(DEFAULT_SESSION_DAYS)));
        const session = newSession(user, now, Number.isFinite(days) ? Math.min(30, Math.max(1, days)) : DEFAULT_SESSION_DAYS);
        log("INFO", "portal_login", {});
        return redirect(verified.next, [sessionCookie(session, sessionKey, now), clearCookie(STATE_COOKIE)]);
      } catch (error) {
        log("WARN", "portal_login_failed", { code: error instanceof PortalAuthError ? error.code : "network" });
        return say(502, { title: "飞书登录暂时失败", message: `可能是网络波动。请稍后重新打开${title}。` }, [clearCookie(STATE_COOKIE)]);
      }
    }

    const session = readSession(cookies, sessionKey, now);
    const signedIn = !!session && isAllowed({ userId: session.u, openId: session.o }, allowedUsers, allowedOpenIds);
    if ((path === "/" || path === "/index.html") && method === "GET") {
      if (!signedIn) {
        const login = beginLogin(appId, redirectUri, "/", stateKey, now);
        return redirect(login.location, [login.cookie, ...(session ? [clearCookie(SESSION_COOKIE)] : [])]);
      }
      const view = buildView(await readCache(deps.state), viewOptions(config, session!, now));
      return html(event, 200, renderPortalPage(view, nonce), nonce);
    }
    const reportMatch = REPORT_PATH.exec(path);
    if ((path === "/report" || path === "/report/" || reportMatch) && method === "GET") {
      // 未登录：走飞书登录，登录后回到原来的报告链接（消息里点开的就是这一期）。
      if (!signedIn) {
        const login = beginLogin(appId, redirectUri, path, stateKey, now);
        return redirect(login.location, [login.cookie, ...(session ? [clearCookie(SESSION_COOKIE)] : [])]);
      }
      if (!reportMatch) {
        const meta = parseStored<ReportMeta>(await deps.state.get(REPORT_META_PK, "state"));
        return redirect(`/report/day/${meta?.latest || addDays(ymdInZone(new Date(now), SITE_ZONE), -1)}`, []);
      }
      const period = parsePeriod(reportMatch[1]!, reportMatch[2]!);
      if (!period) return say(404, { title: "这一期不存在", message: "日期或周期写错了。请从报告页重新选择。" });
      const view = await reportView(deps.state, period, now);
      return html(event, 200, renderReportPage(view, nonce, title, { name: session!.n, avatar: session!.a }), nonce);
    }
    if (api && !signedIn) return json(event, 401, { error: "login_required" }, nonce);
    if (path === "/api/report" && method === "GET") {
      const query = event.queryStringParameters ?? {};
      const period = parsePeriod(String(query.type ?? ""), String(query.period ?? ""));
      if (!period) return json(event, 400, { error: "bad_period" }, nonce);
      return json(event, 200, await reportView(deps.state, period, now), nonce);
    }
    if (path === "/api/snapshot" && method === "GET") return json(event, 200, buildView(await readCache(deps.state), viewOptions(config, session!, now)), nonce);
    if (path === "/api/refresh" && method === "POST") {
      // 自定义请求头不能被跨站表单带上（无 CORS 放行），配合 SameSite=Lax 防跨站触发刷新。
      if (event.headers?.["x-portal-refresh"] !== "1") return json(event, 403, { error: "bad_request" }, nonce);
      let force = false;
      try { force = (JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "{}") as { force?: unknown }).force === true; } catch { force = false; }
      const context: SourceContext = { config, state: deps.state, amazon: deps.amazon(config), feishu: deps.feishu(config), now: deps.now };
      const cache = await readCache(deps.state);
      const outcome = await refreshSections(context, cache, staleSections(cache, now, force), randomUUID());
      if (outcome.refreshed.length || outcome.failed.length) log("INFO", "portal_refreshed", { refreshed: outcome.refreshed.join(","), failed: outcome.failed.join(","), busy: outcome.busy });
      return json(event, 200, buildView(outcome.cache, viewOptions(config, session!, deps.now())), nonce);
    }
    return api ? json(event, 404, { error: "not_found" }, nonce) : say(404, { title: "页面不存在", message: `请从飞书左侧导航打开${title}。` });
  }

  return async (event: LambdaFunctionURLEvent): Promise<Result> => {
    const started = deps.now();
    const nonce = deps.nonce();
    const path = event.rawPath || "/";
    let result: Result;
    try {
      result = await route(event, nonce);
    } catch (error) {
      logError("portal_failed", error, { route: routeName(path) });
      result = path.startsWith("/api/") ? json(event, 500, { error: "internal" }, nonce)
        : html(event, 500, renderMessagePage({ title: "中台出错了", message: "请稍后刷新页面；若持续出错，告诉 Claude 查看日志。" }, nonce), nonce);
    } finally {
      try { await flushFeishuUsage(deps.state, "portal"); } catch { /* 计数失败不影响页面 */ }
    }
    log("INFO", "portal_request", { method: event.requestContext?.http?.method ?? "", route: routeName(path), status: result.statusCode, ms: deps.now() - started });
    return result;
  };
}

export const handler = createPortalHandler({
  config: (force) => getConfig(force ? { force: true } : {}),
  state: new StateStore(),
  amazon: (config) => new AmazonClient(config),
  feishu: (config) => new FeishuClient(config),
  fetcher: (input, init) => fetch(input, init),
  now: () => Date.now(),
  nonce: () => randomBytes(16).toString("base64"),
});
