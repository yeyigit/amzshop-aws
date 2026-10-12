import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import type { AppConfig } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { HttpError } from "../../src/http.js";
import { MemoryState } from "./memory-state.js";
import {
  AUTHORIZE_URL, SESSION_COOKIE, STATE_COOKIE, TOKEN_URL, USER_INFO_URL, USER_SCOPE, beginLogin, finishLogin, isAllowed, newSession, parseCookies, readSession, safeNext, seal,
  sessionCookie, signingKey, unseal,
} from "../../src/portal/auth.js";
import {
  METRIC, UNPAID_ALERT_DAYS, adsBillingView, adsSummary, aggregateOrders, catalogItems, competitorDrops, dailySeries, feedItems, last30, monthCloseAfter, offerFacts, orderAmount, paceFor, paceSeries, parseAdsInvoices, parseFunds, parseSalesBuckets,
  shipmentSummary, skuPace, stockFacts, trafficFacts,
  type CampaignDayRow, type OverviewRow,
} from "../../src/portal/metrics.js";
import { CACHE_PK, CACHE_SCHEMA, ORDER_DAYS, SECTION_KEYS, readCache, refreshSections, staleSections, usAdsProfileId, type SectionCache, type SourceContext } from "../../src/portal/sources.js";
import { buildView } from "../../src/portal/view.js";
import { LINK_KEYS, portalLinks } from "../../src/portal/links.js";
import { clientMain } from "../../src/portal/client.js";
import { embedJson, renderPortalPage } from "../../src/portal/page.js";
import { createPortalHandler } from "../../src/handlers/portal.js";
import { mergeBundle } from "../../scripts/set-secret.mts";

type Row = Record<string, unknown>;
const root = path.resolve(import.meta.dirname, "..");
// 2026-10-07 03:15Z = 洛杉矶 10/06 20:15（PDT）= 北京 10/07 11:15。
const NOW = Date.parse("2026-10-07T03:15:00Z");
const TODAY = "2026-10-06";
const addDays = (ymd: string, days: number): string => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const text = (value: string): Array<{ type: string; text: string }> => [{ type: "text", text: value }];

// 近 7 天每天 8–21 点每小时 1 件、$10；今天 8–19 点只卖了 7 件。
function salesPayload(todayUnits: Record<number, number> = { 8: 1, 9: 1, 10: 1, 12: 1, 14: 1, 17: 1, 19: 1 }): Row[] {
  const rows: Row[] = [];
  for (let offset = 7; offset >= 0; offset -= 1) {
    const day = addDays(TODAY, -offset);
    for (let hour = 0; hour < 24; hour += 1) {
      const units = offset === 0 ? todayUnits[hour] ?? 0 : hour >= 8 && hour <= 21 ? 1 : 0;
      const start = `${day}T${String(hour).padStart(2, "0")}:00-07:00`;
      rows.push({ interval: `${start}--${day}T${String(hour + 1).padStart(2, "0")}:00-07:00`, unitCount: units, orderItemCount: units, orderCount: units, averageUnitPrice: { amount: 10, currencyCode: "USD" }, totalSales: { amount: units * 10, currencyCode: "USD" } });
    }
  }
  return rows;
}

const configValues: Record<string, string> = {
  FEISHU_BITABLE_APP_TOKEN_ORDERS: "app-orders", FEISHU_BITABLE_TABLE_ID_ORDERS: "tbl-orders", FEISHU_BITABLE_TABLE_ID_ADS: "tbl-budget",
  FEISHU_BITABLE_TABLE_ID_ADS_DAILY_OVERVIEW: "tbl-overview", FEISHU_BITABLE_TABLE_ID_ADS_CAMPAIGN_DAILY: "tbl-campaign", FEISHU_BITABLE_TABLE_ID_INVENTORY_ALERTS: "tbl-inventory",
  FEISHU_BITABLE_TABLE_ID_SHIPMENTS: "tbl-shipments",
  PORTAL_FEISHU_APP_ID: "cli_portal", PORTAL_FEISHU_APP_SECRET: "portal-secret-for-tests", PORTAL_ALLOWED_USER_IDS: "u-owner", COMPETITOR_AUTO_ENABLED: "false",
  SP_API_SELLER_ID: "SELLER1", COMPETITOR_SALE_MODE_ENABLED: "false", ADS_PROFILE_ID: "ADS-US",
};
function configOf(overrides: Record<string, string | undefined> = {}): AppConfig {
  const values: Record<string, string> = { ...configValues };
  for (const [key, value] of Object.entries(overrides)) { if (value === undefined) delete values[key]; else values[key] = value; }
  return {
    get: (key: string) => { const value = values[key]; if (!value) throw new Error(`缺少 Parameter Store 配置 ${key}。`); return value; },
    optional: (key: string, fallback = "") => values[key] ?? fallback,
    bool: (key: string, fallback = false) => { const raw = values[key]; return raw === undefined ? fallback : ["1", "true", "yes", "on"].includes(raw.toLowerCase()); },
    json: <T>(key: string): T => JSON.parse(values[key] ?? "null") as T,
    asins: () => [{ sku: "SKU-A", asin: "B000000AAA", competitors: ["B0000RIVAL"], adMarker: "" }, { sku: "SKU-B", asin: "B000000BBB", competitors: [], adMarker: "" }],
    version: "test",
  };
}

// 近 7 天 SKU-A 每天 4 件（公式「金额」$10/件）、SKU-B 每天 1 件（只有付款金额 $20）；30 天前那天的单不进“最近 30 天”。
function orderRecords(): Array<{ fields: Row }> {
  const records: Array<{ fields: Row }> = [];
  for (let offset = 7; offset >= 1; offset -= 1) {
    for (let index = 0; index < 4; index += 1) records.push({ fields: { "订单编号": text(`A-${offset}-${index}`), SKU: text("SKU-A"), "数量": 1, "订单状态": text("已发货"), "下单时间": text(`${addDays(TODAY, -offset)} 1${index}:00:00`), "金额": { type: 2, value: [10] } } });
    records.push({ fields: { "订单编号": text(`B-${offset}`), SKU: text("SKU-B"), "数量": 1, "订单状态": text("已发货"), "下单时间": text(`${addDays(TODAY, -offset)} 09:00:00`), "付款金额": 20 } });
  }
  records.push({ fields: { "订单编号": text("B-OLD"), SKU: text("SKU-B"), "数量": 5, "订单状态": text("已发货"), "下单时间": text(`${addDays(TODAY, -30)} 09:00:00`), "付款金额": 100 } });
  records.push({ fields: { "订单编号": text("B-TODAY"), SKU: text("SKU-B"), "数量": 2, "订单状态": text("待处理"), "下单时间": text(`${TODAY} 18:40:00`), "金额": { type: 2, value: [40] } } });
  records.push({ fields: { "订单编号": text("A-CANCEL"), SKU: text("SKU-A"), "数量": 1, "订单状态": text("已取消"), "下单时间": text(`${TODAY} 19:00:00`), "金额": { type: 2, value: [10] } } });
  return records;
}
const listingItems = (): Row[] => [
  { sku: "SKU-A", summaries: [{ marketplaceId: "ATVPDKIKX0DER", asin: "B000000AAA", status: ["BUYABLE", "DISCOVERABLE"], itemName: "Rocket Toy Truck", mainImage: { link: "https://m.media-amazon.com/images/I/truck.jpg" } }], offers: [{ marketplaceId: "ATVPDKIKX0DER", offerType: "B2C", price: { amount: "19.99", currencyCode: "USD" } }, { marketplaceId: "ATVPDKIKX0DER", offerType: "B2B", price: { amount: "18.99" } }] },
  { sku: "SKU-B", summaries: [{ marketplaceId: "ATVPDKIKX0DER", asin: "B000000BBB", status: ["BUYABLE"], itemName: "Play Mat", mainImage: { link: "https://evil.example.com/x.jpg" } }], offers: [{ offerType: "B2C", price: { amount: "25.99" } }] },
  { sku: "SKU-PARENT", summaries: [{ marketplaceId: "ATVPDKIKX0DER", asin: "B00000PARE", status: ["DISCOVERABLE"], itemName: "Parent" }], offers: [] },
];
const inventorySummaries = (): Row[] => [
  { sellerSku: "SKU-A", asin: "B000000AAA", inventoryDetails: { fulfillableQuantity: 320, inboundWorkingQuantity: 0, inboundShippedQuantity: 40, inboundReceivingQuantity: 10, reservedQuantity: { totalReservedQuantity: 5 } } },
  { sellerSku: "SKU-B", asin: "B000000BBB", inventoryDetails: { fulfillableQuantity: 9 } },
];

const siteMs = (ymd: string): number => Date.parse(`${ymd}T12:00:00Z`);
function overviewRecords(): Array<{ fields: Row }> {
  return Array.from({ length: 14 }, (_, index) => {
    const date = addDays(TODAY, -1 - index);
    const recent = index < 7;
    return { fields: { "站点日期": siteMs(date), "花费": recent ? 50 : 40, "广告销售额": recent ? 150 : 160, "广告订单": recent ? 10 : 11, "曝光": recent ? 10_000 : 12_000, "点击": recent ? 100 : 120, "总销售额": 400 } };
  });
}
function campaignRecords(): Array<{ fields: Row }> {
  const rows: Array<{ fields: Row }> = [];
  for (let index = 0; index < 14; index += 1) {
    const date = siteMs(addDays(TODAY, -1 - index));
    const recent = index < 7;
    rows.push({ fields: { "站点日期": date, "活动ID": "C-A", "活动名称": text("Truck auto"), "活动状态": "ENABLED", "花费": recent ? 3 : 1, "广告订单": 0, "广告销售额": 0, "曝光": 500, "点击": 5 } });
    rows.push({ fields: { "站点日期": date, "活动ID": "C-B", "活动名称": text("Mat exact"), "活动状态": "ENABLED", "花费": 5, "广告订单": 1, "广告销售额": 20, "曝光": recent ? 100 : 300, "点击": 3 } });
    rows.push({ fields: { "站点日期": date, "活动ID": "C-C", "活动名称": text("Paused one"), "活动状态": "PAUSED", "花费": 0, "广告订单": 0, "广告销售额": 0, "曝光": recent ? 10 : 900, "点击": 0 } });
  }
  return rows;
}
// 货件表「当前状态」是单选，查询接口直接返回选项名。
const shipmentRecords = (): Array<{ fields: Row }> => [
  ...Array.from({ length: 7 }, () => ({ fields: { "当前状态": "运输中" } })), ...Array.from({ length: 4 }, () => ({ fields: { "当前状态": "接收中" } })),
  { fields: { "当前状态": "已登记入仓" } }, { fields: { "当前状态": "已完成" } }, { fields: { "当前状态": "已取消" } }, { fields: {} },
];
const inventoryRecords = (): Array<{ record_id: string; fields: Row }> => [
  { record_id: "r1", fields: { SKU: "SKU-A", ASIN: "B000000AAA", "品名": text("Toy Truck"), "30日销量": 120, "FBA可售": 300, "FBA可售覆盖天数": 40, "预警等级": "正常", "数据时间": "Sales 截止 2026-10-05", "数据状态": "最新" } },
  { record_id: "r2", fields: { SKU: "SKU-B", ASIN: "B000000BBB", "品名": text("Play Mat"), "30日销量": 30, "FBA可售": 10, "FBA可售覆盖天数": 6, "预警等级": "FBA断货风险", "预警原因": "FBA可售仅覆盖 6.0 天", "数据时间": "Sales 截止 2026-10-05", "数据状态": "最新" } },
  { record_id: "r3", fields: { SKU: "SKU-OLD", ASIN: "B000000OLD", "品名": text("Old"), "30日销量": 0, "预警等级": "已停用" } },
];
const balances = { payload: { balances: [{ partnerMetadata: { accountType: "STANDARD_ORDERS" }, balanceType: "TOTAL", amount: { currencyAmount: 100, currencyCode: "USD" }, balances: [
  { balanceType: "AVAILABLE", amount: { currencyAmount: 60, currencyCode: "USD" } }, { balanceType: "RESERVED", amount: { currencyAmount: 40, currencyCode: "USD" } },
] }] }, statusCode: 200 };
const expected = { expectedPayouts: [
  { status: "NO_PAYOUT_EXPECTED", amount: {}, scheduledDate: null },
  { status: "SCHEDULED", amount: { unit: "USD", value: 1234.56 }, scheduledDate: "2026-10-15T00:00:00.000Z" },
  { status: "SCHEDULED", amount: { unit: "USD", value: 0 }, scheduledDate: "2026-10-08T00:00:00.000Z" },
] };
// 广告发票（形状同真实接口返回）：累积中的那张没有发票号、结束日和开票日；按门槛开的略超门槛，每月 2 日是月结。
const PAID_INVOICES: Array<[string, string, number]> = [
  ["20260921", "20261002", 478.6], ["20260906", "20260921", 500.40], ["20260902", "20260906", 236.18],
  ["20260815", "20260902", 500.20], ["20260802", "20260815", 500.60], ["20260720", "20260802", 318.75],
];
function invoicePayload(options: { accrued?: number; since?: string; extra?: Row[] } = {}): Row {
  const usd = (amount: number): Row => ({ amount, currencyCode: "USD" });
  return { status: "success", payload: { nextCursor: "next", invoiceSummaries: [
    { status: "ACCUMULATING", fromDate: options.since ?? "20261002", amountDue: usd(options.accrued ?? 410.85), remainingAmountDue: usd(options.accrued ?? 410.85), downloadableDocuments: [], adProductGroup: "SPONSORED_ADS", countryCode: "US" },
    ...(options.extra ?? []),
    ...PAID_INVOICES.map(([from, to, amount]) => ({ id: `INV${to}`, status: "PAID_IN_FULL", fromDate: from, toDate: to, invoiceDate: to, amountDue: usd(amount), remainingAmountDue: usd(0), fees: [], downloadableDocuments: ["INVOICE"], adProductGroup: "SPONSORED_ADS", countryCode: "US" })),
  ] } };
}

function stateWithBusiness(): MemoryState {
  const recent = new Date(NOW - 86_400_000).toISOString();
  return new MemoryState([
    { pk: "OFFER", sk: "ATVPDKIKX0DER|B000000AAA", marketplaceId: "ATVPDKIKX0DER", asin: "B000000AAA", buyBox: { status: "lost", incident: 1, holder: "SELLERX" }, own: { landed: 19.99, currency: "USD", fba: true }, sellers: { SELLERX: { episode: 1, firstSeenAt: recent }, OLD: { episode: 1, firstSeenAt: recent, leftAt: recent } } },
    { pk: "OFFER", sk: "A1AM78C64UM0Y8|B000000AAA", marketplaceId: "A1AM78C64UM0Y8", asin: "B000000AAA", buyBox: { status: "won" }, own: null, sellers: {} },
    { pk: "TRAFFIC", sk: "B000000AAA|sessions", status: "alert", current: 300, baseline: 500, drop: 0.4, evalDay: "2026-10-04" },
    { pk: "COMPETITOR_PRICE", sk: "B0000RIVAL", sku: "SKU-A", price: 12.79, promoSignature: "减 10%", updatedAt: recent },
    { pk: "HEALTH", sk: "competitor-prices", lastSuccessAt: recent },
    { pk: "NOTIFICATION", sk: "competitor|B0000RIVAL|16.59->12.79|2026-10-06", lines: ["竞品价格变化", "16.59 → 12.79", "SKU：SKU-A"], createdAt: recent, status: "done" },
    { pk: "NOTIFICATION", sk: "offer-seller|ATVPDKIKX0DER|B000000AAA|SELLERX|1", lines: ["⚠️ 发现跟卖", "美国站 B000000AAA"], createdAt: recent, status: "done" },
    { pk: "NOTIFICATION", sk: "buybox|B000000AAA|lost|initial", lines: ["旧巡检"], createdAt: recent, status: "done" },
    { pk: "NOTIFICATION", sk: "competitor-set|3|x", lines: ["清单变化"], createdAt: recent, status: "done" },
    { pk: "NOTIFICATION", sk: "traffic|B000000AAA|sessions|alert|initial", lines: ["📉 流量下降预警"], createdAt: new Date(NOW - 9 * 86_400_000).toISOString(), status: "done" },
  ]);
}

function fakes(options: { salesError?: unknown; todayUnits?: Record<number, number> } = {}) {
  const amazonCalls: Array<{ path: string; init: Row }> = [];
  const amazon = { sp: async (requestPath: string, init: Row = {}) => {
    amazonCalls.push({ path: requestPath, init });
    if (init.method !== undefined) throw new Error("中台只允许 GET");
    if (requestPath === "/sales/v1/orderMetrics") { if (options.salesError) throw options.salesError; return { payload: salesPayload(options.todayUnits) }; }
    if (requestPath.endsWith("/balances")) return balances;
    if (requestPath.endsWith("/payouts/expected")) return expected;
    if (requestPath === "/listings/2021-08-01/items/SELLER1") {
      const query = init.query as Row;
      assert.equal(query.includedData, "summaries,offers");
      return query.pageToken ? { items: [listingItems()[2]], pagination: {} } : { items: listingItems().slice(0, 2), pagination: { nextToken: "p2" } };
    }
    if (requestPath === "/fba/inventory/v1/summaries") return { payload: { inventorySummaries: inventorySummaries() }, pagination: {} };
    throw new Error(`unexpected ${requestPath}`);
  }, ads: async (requestPath: string, init: Row = {}) => {
    amazonCalls.push({ path: requestPath, init });
    // 广告 API 只允许读美国站发票：不带 method（GET）、不带版本 Accept（v1/v1.1 实测 406）。
    if (init.method !== undefined || init.body !== undefined || init.mediaType !== undefined) throw new Error("中台只允许 GET 发票");
    assert.equal(requestPath, "/invoices");
    assert.equal(init.profileId, "ADS-US");
    return invoicePayload();
  } } as unknown as AmazonClient;
  const feishuCalls: string[] = [];
  const feishu = {
    request: async (method: string, requestPath: string, body: Row) => {
      feishuCalls.push(`${method} ${requestPath}`);
      assert.equal(method, "POST");
      assert.match(requestPath, /\/records\/search$/);
      const table = requestPath.split("/tables/")[1]!.split("/")[0];
      const filter = body.filter as { conjunction: string; conditions: Array<{ field_name: string; operator: string; value: string[] }> };
      if (table === "tbl-orders") { assert.equal(filter.conjunction, "or"); assert.equal(filter.conditions.length, ORDER_DAYS); return { items: orderRecords(), has_more: false }; }
      if (table === "tbl-budget") return { items: [{ fields: { "已花费预算": 20.5, "预算更新时间": text(`${TODAY} 19:30:00`) } }, { fields: { "已花费预算": 4.5, "预算更新时间": text(`${TODAY} 18:00:00`) } }], has_more: false };
      if (table === "tbl-overview") return { items: overviewRecords(), has_more: false };
      if (table === "tbl-campaign") return { items: campaignRecords(), has_more: false };
      if (table === "tbl-shipments") {
        assert.deepEqual(body.field_names, ["当前状态"], "货件表只取状态一列");
        assert.deepEqual(filter.conditions, [{ field_name: "当前状态", operator: "isNotEmpty", value: [] }]);
        return { items: shipmentRecords(), has_more: false };
      }
      throw new Error(`unexpected table ${table}`);
    },
    listRecords: async (_app: string, table: string) => { feishuCalls.push(`GET ${table}`); assert.equal(table, "tbl-inventory"); return inventoryRecords(); },
  } as unknown as FeishuClient;
  return { amazon, feishu, amazonCalls, feishuCalls };
}

// ---------- 登录 ----------

test("中台登录：签名 Cookie 防篡改、会话过期失效；state 绑定一次性 nonce；跳转只允许本站路径", () => {
  const key = signingKey("secret", "session");
  const token = seal({ a: 1 }, key);
  assert.deepEqual(unseal(token, key), { a: 1 });
  assert.equal(unseal(`${token.slice(0, -2)}xx`, key), undefined, "签名被改");
  assert.equal(unseal(token, signingKey("other", "session")), undefined, "换了应用密钥");
  const session = newSession({ userId: "u-owner", openId: "ou_1", name: "Owner", avatar: "" }, NOW, 7);
  const cookie = sessionCookie(session, key, NOW);
  assert.match(cookie, /^__Host-portal_session=[^;]+; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$/);
  const jar = parseCookies([cookie.split(";")[0]!]);
  assert.equal(readSession(jar, key, NOW + 60_000)?.u, "u-owner");
  assert.equal(readSession(jar, key, NOW + 8 * 86_400_000), undefined, "过期");
  const stateKey = signingKey("secret", "state");
  const login = beginLogin("cli_portal", "https://h/auth/callback", "/", stateKey, NOW, "nonce-1");
  const url = new URL(login.location);
  assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE_URL);
  assert.equal(url.searchParams.get("client_id"), "cli_portal");
  assert.equal(url.searchParams.get("redirect_uri"), "https://h/auth/callback");
  assert.equal(url.searchParams.get("scope"), USER_SCOPE);
  const state = url.searchParams.get("state") ?? "";
  assert.deepEqual(finishLogin(state, new Map([[STATE_COOKIE, "nonce-1"]]), stateKey, NOW + 1000), { next: "/" });
  assert.equal(finishLogin(state, new Map([[STATE_COOKIE, "other"]]), stateKey, NOW), undefined, "nonce 不符");
  assert.equal(finishLogin(state, new Map([[STATE_COOKIE, "nonce-1"]]), stateKey, NOW + 11 * 60_000), undefined, "state 过期");
  for (const bad of ["//evil.com", "https://evil.com", "/\\evil", "javascript:alert(1)"]) assert.equal(safeNext(bad), "/", bad);
  assert.equal(safeNext("/api/snapshot"), "/api/snapshot");
  assert.equal(isAllowed({ userId: "u-owner", openId: "x" }, ["u-owner"], []), true);
  assert.equal(isAllowed({ userId: "", openId: "ou_1" }, ["u-owner"], ["ou_1"]), true);
  assert.equal(isAllowed({ userId: "u-other", openId: "ou_2" }, ["u-owner"], ["ou_1"]), false);
});

// ---------- 销售快慢 ----------

test("今日快慢按截至同一时刻对比近 7 日均值；时间尚早不判；全天预估与昨日；秋季回拨同钟点两个桶相加", () => {
  const data = parseSalesBuckets(salesPayload());
  const nowHour = 20.25;
  const units = paceFor(data, TODAY, nowHour, METRIC.units);
  assert.equal(units.value, 7);
  assert.equal(units.avgDay, 14);
  assert.equal(units.avgSameTime, 12.25);
  assert.equal(units.status, "very-slow");
  assert.ok(Math.abs((units.pace ?? 0) - (7 - 12.25) / 12.25) < 1e-9);
  assert.ok(Math.abs((units.projection ?? 0) - 8) < 1e-9);
  assert.equal(units.yesterday, 14);
  assert.equal(paceFor(data, TODAY, 9.5, METRIC.units).status, "early", "平时此刻不到 15%");
  const busy = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [8 + index, 2]));
  assert.equal(paceFor(parseSalesBuckets(salesPayload(busy)), TODAY, 20.25, METRIC.sales).status, "fast", "24 件对平时同时段 12.25 件");
  assert.equal(paceFor(parseSalesBuckets(salesPayload({ 8: 2, 9: 2, 10: 2, 11: 2, 12: 2, 13: 2, 14: 2 })), TODAY, 20.25, METRIC.sales).status, "normal", "+14% 仍算正常");
  assert.equal(paceFor({ currency: "USD", days: {} }, TODAY, 20, METRIC.sales).status, "unknown");
  const series = paceSeries(data, TODAY, nowHour);
  assert.equal(series.avg?.length, 25);
  assert.equal(series.avg?.[24], 140);
  assert.deepEqual(series.today.at(-1), [20.25, 70]);
  // 小图含今天在内 7 天（与后台一致）：首日是 6 天前，比较用的 7 个完整日仍取足（avg 由 8 天数据算出）。
  const daily = dailySeries(data, TODAY);
  assert.equal(daily.length, 7);
  assert.equal(daily[0]?.date, addDays(TODAY, -6));
  assert.equal(daily.at(-1)?.partial, true);
  assert.equal(daily.at(-1)?.label, "今天");
  const fallBack = parseSalesBuckets([
    { interval: "2026-11-01T01:00-07:00--2026-11-01T01:00-08:00", unitCount: 1, orderCount: 1, totalSales: { amount: 5, currencyCode: "USD" } },
    { interval: "2026-11-01T01:00-08:00--2026-11-01T02:00-08:00", unitCount: 2, orderCount: 2, totalSales: { amount: 9, currencyCode: "USD" } },
  ]);
  assert.deepEqual(fallBack.days["2026-11-01"]?.[1], [3, 3, 14]);
});

// ---------- 主力款 ----------

test("商品：已取消不计；金额优先公式「金额」、没有再用付款金额；最近 30 天不含今天；待处理按订单去重；该出未出与偏慢", () => {
  const days = Array.from({ length: ORDER_DAYS }, (_, index) => addDays(TODAY, index - ORDER_DAYS + 1));
  const orders = aggregateOrders(orderRecords(), days);
  assert.deepEqual(orders.skus["SKU-A"]?.u.slice(-8), [4, 4, 4, 4, 4, 4, 4, 0], "今天唯一一单已取消");
  assert.equal(orders.skus["SKU-B"]?.u.at(-1), 2);
  assert.equal(orders.skus["SKU-B"]?.last, `${TODAY} 18:40:00`);
  assert.equal(orders.pendingOrders, 1);
  assert.deepEqual(last30(orders.skus["SKU-A"]), { units: 28, sales: 280 });
  assert.deepEqual(last30(orders.skus["SKU-B"]), { units: 12, sales: 240 }, "30 天前那天 5 件计入、今天的 2 件不计");
  assert.equal(orderAmount({ "金额": { type: 2, value: [12.5] }, "付款金额": 99 }), 12.5);
  assert.equal(orderAmount({ "付款金额": 7 }), 7);
  assert.equal(orderAmount({}), 0);
  assert.deepEqual(skuPace(orders.skus["SKU-A"], 0.875), { todayUnits: 0, todayOrders: 0, avgDailyUnits: 4, expectedSoFar: 3.5, flag: "due" });
  assert.equal(skuPace({ u: [8, 8, 8, 8, 8, 8, 8, 1], s: [], o: [], last: "" }, 0.875).flag, "slow");
  assert.equal(skuPace({ u: [1, 1, 1, 1, 1, 1, 1, 0], s: [], o: [], last: "" }, 0.875).flag, "ok", "应出不足 2 件不报");
  assert.equal(skuPace(undefined, 0.875).flag, "quiet");
});

test("商品资料：在售看 BUYABLE、价格取 B2C、主图只收亚马逊图片域名；实时库存取可售与三项在途", () => {
  const items = catalogItems(listingItems());
  assert.deepEqual(items[0], { sku: "SKU-A", asin: "B000000AAA", title: "Rocket Toy Truck", image: "https://m.media-amazon.com/images/I/truck.jpg", buyable: true, price: 19.99 });
  assert.equal(items[1]?.image, "", "非亚马逊图片域名不用");
  assert.equal(items[2]?.buyable, false);
  assert.equal(items[2]?.price, null);
  assert.deepEqual(stockFacts(inventorySummaries()), { "SKU-A": { fulfillable: 320, inbound: 50, reserved: 5 }, "SKU-B": { fulfillable: 9, inbound: 0, reserved: 0 } });
});

// ---------- 广告 ----------

test("广告近 7 个完整日对比前 7 天：ACOS/TACOS 按合计算；只花钱不出单与曝光下降只看启用活动", () => {
  const overview: OverviewRow[] = overviewRecords().map(({ fields }) => ({ date: new Date(Number(fields["站点日期"])).toISOString().slice(0, 10), spend: Number(fields["花费"]), adSales: Number(fields["广告销售额"]), adOrders: Number(fields["广告订单"]), impressions: Number(fields["曝光"]), clicks: Number(fields["点击"]), totalSales: Number(fields["总销售额"]) }));
  const campaigns: CampaignDayRow[] = campaignRecords().map(({ fields }) => ({ date: new Date(Number(fields["站点日期"])).toISOString().slice(0, 10), id: String(fields["活动ID"]), name: String((fields["活动名称"] as Array<{ text: string }>)[0]?.text), status: String(fields["活动状态"]), spend: Number(fields["花费"]), orders: Number(fields["广告订单"]), sales: Number(fields["广告销售额"]), impressions: Number(fields["曝光"]), clicks: Number(fields["点击"]) }));
  const view = adsSummary(overview, campaigns, TODAY, 10)!;
  assert.equal(view.latest, "2026-10-05");
  assert.equal(view.from, "2026-09-29");
  assert.equal(view.prevFrom, "2026-09-22");
  const metric = (key: string) => view.metrics.find((item) => item.key === key)!;
  assert.equal(metric("spend").value, 350);
  assert.equal(metric("spend").prev, 280);
  assert.equal(metric("spend").delta, 0.25);
  assert.equal(metric("acos").value, Math.round((350 / 1050) * 10_000) / 10_000);
  assert.equal(metric("tacos").value, Math.round((350 / 2800) * 10_000) / 10_000);
  assert.equal(metric("acos").better, "down");
  assert.deepEqual(view.noOrder.map((item) => [item.id, item.spend]), [["C-A", 21]]);
  assert.deepEqual(view.drops.map((item) => [item.id, item.drop]), [["C-B", 0.6667]], "暂停的 C-C 降得更多也不报");
  const small = campaigns.map((row) => row.id === "C-B" && row.date < view.from ? { ...row, impressions: 120 } : row);
  assert.deepEqual(adsSummary(overview, small, TODAY, 10)!.drops, [], "前 7 天曝光不足 1000 不报");
  assert.equal(view.avgDailySpend, 50);
  assert.deepEqual(view.day, { date: "2026-10-05", spend: 50, sales: 150, orders: 10, impressions: 10_000, clicks: 100, acos: 0.3333 }, "快照用最近一个完整日");
  assert.equal(adsSummary([], [], TODAY, 10), null);
});

// ---------- 状态表、动态、资金 ----------

test("购物车与跟卖只看美国站在售跟卖；流量按 ASIN；动态只收约定前缀的近 7 天消息；竞品降价次数；余额与最近一笔非零预计放款", () => {
  const state = stateWithBusiness();
  const offers = offerFacts(state.partition("OFFER"));
  assert.deepEqual(offers.get("B000000AAA"), { buyBox: "lost", holder: "SELLERX", ownPrice: 19.99, selling: true, hijackers: 1, lostAt: "" });
  assert.equal(offers.size, 1, "墨西哥站不进美国视图");
  assert.equal(trafficFacts(state.partition("TRAFFIC")).get("B000000AAA")?.sessions?.drop, 0.4);
  const notifications = state.partition("NOTIFICATION");
  const feed = feedItems(notifications, NOW);
  assert.deepEqual(feed.map((item) => item.kind).sort(), ["competitor-price", "hijacker-in"], "旧 buybox 巡检、竞品清单汇总与 7 天前的不收");
  assert.equal(feed.find((item) => item.kind === "competitor-price")?.title, "竞品价格变化");
  assert.deepEqual(Object.fromEntries(competitorDrops([...notifications, { sk: "competitor|B0000RIVAL|12.79->15.00|2026-10-06", createdAt: new Date(NOW - 3_600_000).toISOString() }], NOW)), { B0000RIVAL: 1 });
  // 大促期间竞品变化合并成一条：动态收这条、去掉固定的说明行；降价次数从逐行内容统计（涨价与只报促销的行不算）。
  const saleItem = { sk: "competitor-sale|2026-10-06T08:00:00Z", createdAt: new Date(NOW - 2 * 3_600_000).toISOString(), lines: [
    "🛒 大促竞品动态（Prime Big Deal Days）", "【SKU-A】B0000RIVAL Acme：14.99 → 12.49｜促销：DEAL", "【SKU-A】B0000OTHER：9.99 → 10.99", "【SKU-B】B0000THIRD：到手价 8.00｜开始促销：COUPON", "大促期间每 2 小时比价一次，只列与上一轮相比的变化。",
  ] };
  const saleFeed = feedItems([saleItem], NOW);
  assert.equal(saleFeed[0]?.kind, "competitor-sale");
  assert.equal(saleFeed[0]?.details.length, 3);
  assert.deepEqual(Object.fromEntries(competitorDrops([...notifications, saleItem], NOW)), { B0000RIVAL: 2 });
  const funds = parseFunds(balances, expected, NOW);
  assert.deepEqual(funds.balances, [{ accountType: "STANDARD_ORDERS", currency: "USD", total: 100, available: 60 }]);
  assert.deepEqual(funds.next, { amount: 1234.56, currency: "USD", date: "2026-10-15T00:00:00.000Z", status: "SCHEDULED" });
});

test("广告账单：累积费用照原值；门槛按最近 6 张发票推断；预计扣款取满门槛与月结较早者；已开票没扣完的列出、超 3 天标红", () => {
  // 2026-10-10 01:00Z = 洛杉矶 10/9 18:00（PDT），示例时刻。
  const at = Date.parse("2026-10-10T01:00:00Z");
  const data = parseAdsInvoices(invoicePayload());
  assert.deepEqual(data.accumulating, { amount: 410.85, currency: "USD", since: "2026-10-02" }, "累积中的那张只有起始日与金额");
  assert.equal(data.invoices.length, PAID_INVOICES.length);
  assert.deepEqual(data.invoices[0], { status: "PAID_IN_FULL", from: "2026-09-21", date: "2026-10-02", amount: 478.6, remaining: 0, currency: "USD" }, "开票日新的在前");
  const view = adsBillingView(data, at, 56.4);
  // 最近 6 张取整到 10 美元，最大是 500 → 门槛 500；还差 89.15，按日均 56.4 约 1.58 天 → 洛杉矶 10/11。
  assert.deepEqual([view.threshold, view.rate, view.monthClose], [500, 56.4, "2026-11-02"]);
  assert.deepEqual(view.next, { date: "2026-10-11", kind: "threshold" });
  assert.deepEqual(view.last, { amount: 478.6, date: "2026-10-02" });
  assert.equal(view.pending, null);
  // 广告区块取不到日均：用本期累积 ÷ 已过天数（10/2 洛杉矶零点起 7.75 天 → 53.01/天）。
  const fallback = adsBillingView(data, at, null);
  assert.deepEqual([fallback.rate, fallback.next], [53.01, { date: "2026-10-11", kind: "threshold" }]);
  // 本期刚开始（不满 1 天）又没有日均：不硬算，只给月结日。
  assert.deepEqual(adsBillingView(parseAdsInvoices(invoicePayload({ accrued: 12, since: "20261009" })), at, null).next, { date: "2026-11-02", kind: "month" });
  // 已满门槛但还没开票：随时扣；超过推断门槛 20 美元以上说明门槛改了，只给月结日。
  assert.deepEqual(adsBillingView(parseAdsInvoices(invoicePayload({ accrued: 503.5 })), at, 56.4).next, { date: "2026-10-09", kind: "due" });
  const raised = adsBillingView(parseAdsInvoices(invoicePayload({ accrued: 530 })), at, 56.4);
  assert.deepEqual([raised.threshold, raised.next], [null, { date: "2026-11-02", kind: "month" }]);
  // 月底前满不了门槛：月结更早。
  assert.deepEqual(adsBillingView(parseAdsInvoices(invoicePayload({ accrued: 100, since: "20261025" })), Date.parse("2026-10-28T19:00:00Z"), 10).next, { date: "2026-11-02", kind: "month" });
  // 已到月结日还没开票（起始日在上月）：月结开票中、随时扣；同一天满门槛的优先说“已满”。
  assert.deepEqual(adsBillingView(parseAdsInvoices(invoicePayload({ accrued: 300, since: "20260921" })), Date.parse("2026-10-02T15:00:00Z"), 50).next, { date: "2026-10-02", kind: "closing" });
  assert.deepEqual(adsBillingView(parseAdsInvoices(invoicePayload({ accrued: 505, since: "20260921" })), Date.parse("2026-10-02T15:00:00Z"), 50).next, { date: "2026-10-02", kind: "due" });
  // 已开票没扣完：列出金额与开票日；超过 UNPAID_ALERT_DAYS 天标红。作废的不算。
  const issued = (date: string, remaining: number, status = "ISSUED"): Row => ({ id: `I${date}`, status, fromDate: "20261001", toDate: date, invoiceDate: date, amountDue: { amount: 500.25, currencyCode: "USD" }, remainingAmountDue: { amount: remaining, currencyCode: "USD" } });
  const fresh = adsBillingView(parseAdsInvoices(invoicePayload({ extra: [issued("20261008", 500.25), issued("20261007", 80, "WRITTEN_OFF")] })), at, 56.4);
  assert.deepEqual(fresh.pending, { amount: 500.25, date: "2026-10-08", days: 1, count: 1, overdue: false });
  assert.deepEqual(fresh.last, { amount: 478.6, date: "2026-10-02" }, "上次扣款只取已付清的");
  const stale = adsBillingView(parseAdsInvoices(invoicePayload({ extra: [issued("20261005", 200.5, "PAID_IN_PART")] })), at, 56.4);
  assert.deepEqual(stale.pending, { amount: 200.5, date: "2026-10-05", days: 4, count: 1, overdue: true });
  assert.equal(UNPAID_ALERT_DAYS, 3);
  // 没有累积中的发票：不编 0，也不估扣款日。
  const none = adsBillingView(parseAdsInvoices({ payload: { invoiceSummaries: [] } }), at, 56.4);
  assert.deepEqual([none.accrued, none.next, none.threshold, none.last], [null, null, null, null]);
  // 月结日：起始日之后的下一个 2 日（跨年也对）。
  assert.deepEqual(["2026-10-02", "2026-12-15", "2026-08-01", "2026-09-30", ""].map(monthCloseAfter), ["2026-11-02", "2027-01-02", "2026-08-02", "2026-10-02", ""]);
});

test("广告账单只看美国站 Profile：ADS_PROFILES_JSON 里的美国站（没写站点按美国站），没配就用 ADS_PROFILE_ID", () => {
  assert.equal(usAdsProfileId(configOf()), "ADS-US");
  const listed = (value: unknown): AppConfig => configOf({ ADS_PROFILES_JSON: JSON.stringify(value), ADS_PROFILE_ID: undefined });
  assert.equal(usAdsProfileId(listed([{ profileId: "P-CA", marketplaceId: "A2EUQ1WTGCTBG2", countryCode: "CA" }, { profileId: "P-US", marketplaceId: "ATVPDKIKX0DER" }])), "P-US");
  assert.equal(usAdsProfileId(listed([{ profileId: 123 }])), "123");
  assert.throws(() => usAdsProfileId(listed([{ profileId: "P-CA", marketplaceId: "A2EUQ1WTGCTBG2" }])), /没有美国站/);
  assert.throws(() => usAdsProfileId(configOf({ ADS_PROFILE_ID: undefined })), /ADS_PROFILE_ID/);
});

// ---------- 跳飞书、货件 ----------

test("跳飞书：只在多维表格网址合法时生成；默认打开来源表，PORTAL_FEISHU_LINKS 可改指向视图或仪表盘；写错的项与非飞书网址一律不用", () => {
  const BASE = "https://acme123.feishu.cn/base/AppTokenAbc123";
  const tables = { FEISHU_BITABLE_TABLE_ID_ORDERS: "tblOrders123", FEISHU_BITABLE_TABLE_ID_SHIPMENTS: "tblShip12345", FEISHU_BITABLE_TABLE_ID_ADS_DAILY_OVERVIEW: "tblOverview1", FEISHU_BITABLE_TABLE_ID_INVENTORY_ALERTS: "tblInv123456" };
  assert.deepEqual(portalLinks(configOf(tables)), {}, "没配网址：数字不可点");
  for (const bad of ["http://acme123.feishu.cn/base/AppTokenAbc123", "https://evil.example.com/base/AppTokenAbc123", "javascript:alert(1)//acme.feishu.cn/base/x", "https://acme123.feishu.cn/base/App?x=1"]) {
    assert.deepEqual(portalLinks(configOf({ ...tables, PORTAL_FEISHU_BASE_URL: bad })), {}, bad);
  }
  const links = portalLinks(configOf({ ...tables, PORTAL_FEISHU_BASE_URL: `${BASE}/` }));
  assert.deepEqual(links.orders, { url: `${BASE}?table=tblOrders123`, label: "订单表" }, "末尾斜杠去掉");
  assert.deepEqual(links.pending, links.orders);
  assert.deepEqual(links.shipments, { url: `${BASE}?table=tblShip12345`, label: "货件表" });
  assert.equal(links.ads?.label, "广告每日总览");
  assert.equal(links.funds, undefined, "该表没配 ID：这个数字不可点");
  const custom = portalLinks(configOf({ ...tables, PORTAL_FEISHU_BASE_URL: BASE, PORTAL_FEISHU_LINKS: JSON.stringify({
    sales: { to: "blkDashboard01", label: "店铺仪表盘" }, pending: { to: "tblOrders123/vewPending1" }, shipments: { to: "tbl\"><script>" }, orders: "tblWrongShape",
  }) }));
  assert.deepEqual(custom.sales, { url: `${BASE}?table=blkDashboard01`, label: "店铺仪表盘" }, "仪表盘也走 table 参数");
  assert.deepEqual(custom.pending, { url: `${BASE}?table=tblOrders123&view=vewPending1`, label: "飞书多维表格" }, "改了指向又没给名称时不冒用原表名");
  assert.deepEqual(custom.shipments, { url: `${BASE}?table=tblShip12345`, label: "货件表" }, "写错的目标忽略，用默认表");
  assert.deepEqual(custom.orders, links.orders, "非对象写法忽略");
  assert.deepEqual(portalLinks(configOf({ ...tables, PORTAL_FEISHU_BASE_URL: BASE, PORTAL_FEISHU_LINKS: "{bad json" })).orders, links.orders, "JSON 写错不影响默认链接");
  assert.ok(LINK_KEYS.every((key) => /^[a-zA-Z]+$/.test(key)));
});

test("货件概况：只计未完成入库的状态，按货件流程排序，未知状态排最后；没有货件时为 0", () => {
  const summary = shipmentSummary([
    { fields: { "当前状态": "接收中" } }, { fields: { "当前状态": "处理中" } }, { fields: { "当前状态": "混合状态" } }, { fields: { "当前状态": "运输中" } },
    { fields: { "当前状态": "已删除" } }, { fields: { "当前状态": "已作废" } }, { fields: { "当前状态": "已放弃" } }, { fields: { "当前状态": " " } },
  ]);
  assert.deepEqual(summary, { active: 4, statuses: [{ status: "处理中", count: 1 }, { status: "运输中", count: 1 }, { status: "接收中", count: 1 }, { status: "混合状态", count: 1 }] });
  assert.deepEqual(shipmentSummary([]), { active: 0, statuses: [] });
});

// ---------- 取数与缓存 ----------

test("过期判断：缺失即取；快区块手动刷新超 30 秒重取；失败后 60 秒内不重试；洛杉矶换日后按日区块立即过期；旧格式缓存立即重取", () => {
  assert.deepEqual(staleSections({}, NOW), SECTION_KEYS);
  const fresh = new Date(NOW - 60_000).toISOString();
  const cache: SectionCache = Object.fromEntries(SECTION_KEYS.map((key) => [key, { data: { today: TODAY }, fetchedAt: fresh, schema: CACHE_SCHEMA }]));
  assert.deepEqual(staleSections(cache, NOW), []);
  assert.deepEqual(staleSections(cache, NOW, true), ["sales", "orders", "adsToday", "live"]);
  assert.deepEqual(staleSections({ ...cache, funds: { error: "x", errorAt: new Date(NOW - 10_000).toISOString() } }, NOW), [], "失败退避");
  assert.deepEqual(staleSections({ ...cache, sales: { data: { today: addDays(TODAY, -1) }, fetchedAt: fresh, schema: CACHE_SCHEMA } }, NOW), ["sales"]);
  // 10/07 改版前写入的区块没有格式版本：即使没过缓存时长也立即重取，免得新页面拿旧结构显示成“—”。
  assert.deepEqual(staleSections({ ...cache, ads: { data: { today: TODAY }, fetchedAt: fresh } }, NOW), ["ads"]);
});

test("刷新：各区块只读取数并只写 PORTAL_CACHE；页面数据算出全局快照、商品绩效行与广告；某区块失败保留旧值并写明原因", async () => {
  const state = stateWithBusiness();
  const { amazon, feishu, amazonCalls, feishuCalls } = fakes();
  const context: SourceContext = { config: configOf(), state: state.asStore(), amazon, feishu, now: () => NOW };
  const first = await refreshSections(context, {}, SECTION_KEYS, "owner-1");
  assert.deepEqual(first.failed, []);
  assert.deepEqual(state.writes.map((item) => item.pk).filter((pk) => pk !== CACHE_PK), [], "只写自己的缓存分区");
  assert.deepEqual(amazonCalls.map((item) => item.path).sort(), [
    "/fba/inventory/v1/summaries", "/finances/2024-06-19/balances", "/finances/transfers/2024-06-01/payouts/expected", "/invoices",
    "/listings/2021-08-01/items/SELLER1", "/listings/2021-08-01/items/SELLER1", "/sales/v1/orderMetrics",
  ]);
  assert.ok(feishuCalls.every((call) => /records\/search$|^GET tbl-inventory$/.test(call)), feishuCalls.join("\n"));
  const cached = await readCache(state.asStore());
  assert.deepEqual(Object.keys(cached).sort(), [...SECTION_KEYS].sort());
  assert.ok(SECTION_KEYS.every((key) => cached[key]?.schema === CACHE_SCHEMA), "写入时带格式版本并能读回");
  const view = buildView(cached, { nowMs: NOW, title: "AMZ中台", user: { name: "Owner", avatar: "" }, asinBySku: { "SKU-A": "B000000AAA", "SKU-B": "B000000BBB" } });
  assert.equal(view.title, "AMZ中台");
  assert.equal(view.today, TODAY);
  assert.equal(view.laClock, "10/6 周二 20:15");
  assert.equal(view.bjClock, "10/7 周三 11:15");
  assert.equal(view.kpis.sales?.value, 70);
  assert.equal(view.kpis.sales?.status, "very-slow");
  assert.equal(view.pendingOrders, 1);
  assert.deepEqual(view.featured, { selling: 1, won: 0, lost: [{ asin: "B000000AAA", sku: "SKU-A", holder: "SELLERX" }], hijacked: 1 });
  assert.deepEqual(view.stockAlerts, { risk: 1, soon: 0, items: [{ sku: "SKU-B", level: "FBA断货风险", reason: "FBA可售仅覆盖 6.0 天" }] });
  // 广告账单：洛杉矶 10/6 20:15 累积 410.85，门槛推断 $500，按广告区块 7 日日均 $50 约 1.6 天后（10/8）满门槛；最迟 11/2 月结。
  assert.deepEqual(view.adsBilling, {
    accrued: 410.85, currency: "USD", since: "2026-10-02", threshold: 500, rate: 50, monthClose: "2026-11-02",
    next: { date: "2026-10-08", kind: "threshold" }, pending: null, last: { amount: 478.6, date: "2026-10-02" },
  });
  assert.equal(view.sale?.active, false, "非大促时商品表标题旁不显示“大促加密中”");
  assert.equal(view.adDay?.date, "2026-10-05");
  assert.deepEqual(view.products.map((row) => [row.sku, row.flag, row.buyable]), [["SKU-A", "due", true], ["SKU-B", "ok", true], ["SKU-PARENT", "quiet", false]]);
  const truck = view.products[0]!;
  assert.equal(truck.title, "Rocket Toy Truck");
  assert.equal(truck.image, "https://m.media-amazon.com/images/I/truck.jpg");
  assert.equal(truck.price, 19.99);
  assert.deepEqual([truck.units30, truck.sales30, truck.fulfillable, truck.inbound, truck.fbaDays], [28, 280, 320, 50, 40]);
  assert.equal(truck.buyBox, "lost");
  assert.equal(truck.hijackers, 1);
  assert.equal(truck.links.reviews, "https://www.amazon.com/product-reviews/B000000AAA?sortBy=recent");
  assert.deepEqual(truck.competitor, { count: 1, priced: 1, minPrice: 12.79, promos: 1, drops: 1 });
  assert.equal(truck.sessions?.drop, 0.4);
  assert.equal(view.products[1]?.stockLevel, "FBA断货风险");
  assert.equal(view.products[1]?.fulfillable, 9, "库存用实时 FBA，不用库存预警表的 09:00 快照");
  assert.equal(view.adSpend?.today, 25);
  assert.equal(view.adSpend?.avgDaily, 50);
  assert.equal(view.funds?.total, 100);
  assert.equal(view.ads?.noOrder[0]?.name, "Truck auto");
  assert.equal(view.feed.length, 2);
  assert.deepEqual(view.shipments, { active: 12, statuses: [{ status: "运输中", count: 7 }, { status: "已登记入仓", count: 1 }, { status: "接收中", count: 4 }] }, "货件按流程排序，已完成、已取消、空状态不计");
  assert.deepEqual(view.links, {}, "没传链接时为空，页面数字不可点");
  assert.deepEqual(view.stale, []);

  const failing = fakes({ salesError: new HttpError(429, "QuotaExceeded", "", "throttled", true) });
  const later = NOW + 6 * 60_000;
  const second = await refreshSections({ ...context, amazon: failing.amazon, feishu: failing.feishu, now: () => later }, cached, staleSections(cached, later), "owner-2");
  assert.deepEqual(second.failed, ["sales"]);
  assert.equal(second.cache.sales?.error, "接口限流，稍后自动重试");
  assert.equal(second.cache.sales?.fetchedAt, cached.sales?.fetchedAt, "保留上次成功时间");
  assert.deepEqual(second.cache.sales?.data, cached.sales?.data, "保留旧值，不写 0");
  assert.equal(second.cache.sales?.schema, CACHE_SCHEMA, "失败时保留旧值原来的格式版本");
  const stored = await readCache(state.asStore());
  assert.equal(stored.sales?.error, "接口限流，稍后自动重试");
});

test("刷新租约被占用时不取数，直接返回当前缓存", async () => {
  class BusyState extends MemoryState { override async acquireLease(): Promise<boolean> { return false; } }
  const state = new BusyState();
  const { amazon, feishu, amazonCalls } = fakes();
  const outcome = await refreshSections({ config: configOf(), state: state.asStore(), amazon, feishu, now: () => NOW }, {}, SECTION_KEYS, "owner");
  assert.equal(outcome.busy, true);
  assert.equal(amazonCalls.length, 0);
});

// ---------- 入口 ----------

function event(method: string, rawPath: string, options: { cookies?: string[]; query?: Record<string, string>; headers?: Record<string, string>; body?: string } = {}): LambdaFunctionURLEvent {
  return {
    version: "2.0", routeKey: "$default", rawPath, rawQueryString: new URLSearchParams(options.query ?? {}).toString(), headers: options.headers ?? {},
    ...(options.cookies ? { cookies: options.cookies } : {}), ...(options.query ? { queryStringParameters: options.query } : {}), ...(options.body ? { body: options.body } : {}), isBase64Encoded: false,
    requestContext: { accountId: "anonymous", apiId: "x", domainName: "portal.example.on.aws", domainPrefix: "portal", http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "1.1.1.1", userAgent: "test" }, requestId: "r", routeKey: "$default", stage: "$default", time: "", timeEpoch: NOW },
  } as unknown as LambdaFunctionURLEvent;
}

function portal(configOverrides: Record<string, string | undefined> = {}, user: Row = { user_id: "u-owner", open_id: "ou_owner", name: "Owner", avatar_thumb: "https://s1-imfile.feishucdn.com/a.png" }) {
  const state = stateWithBusiness();
  const { amazon, feishu } = fakes();
  const fetched: Array<{ url: string; body: string }> = [];
  const fetcher = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    fetched.push({ url, body: init?.body ? String(init.body) : "" });
    if (url === TOKEN_URL) return new Response(JSON.stringify({ code: 0, access_token: "user-token", expires_in: 7200, token_type: "Bearer" }), { status: 200 });
    if (url === USER_INFO_URL) return new Response(JSON.stringify({ code: 0, data: user }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const handler = createPortalHandler({ config: async () => configOf(configOverrides), state: state.asStore(), amazon: () => amazon, feishu: () => feishu, fetcher, now: () => NOW, nonce: () => "testnonce" });
  return { handler, state, fetched };
}
const cookiePair = (cookies: string[] | undefined, name: string): string => (cookies ?? []).find((item) => item.startsWith(`${name}=`))!.split(";")[0]!;

test("入口：未登录跳飞书授权；回调校验 state 后换令牌、白名单通过发登录态；登录后页面带 CSP nonce 与数据；刷新要求自定义头", async () => {
  const { handler, fetched } = portal();
  const health = await handler(event("GET", "/healthz"));
  assert.equal(health.statusCode, 200);
  assert.equal(health.body, "ok");
  const start = await handler(event("GET", "/"));
  assert.equal(start.statusCode, 302);
  const location = new URL(String(start.headers?.location));
  assert.equal(location.searchParams.get("redirect_uri"), "https://portal.example.on.aws/auth/callback");
  const stateCookie = cookiePair(start.cookies, STATE_COOKIE);
  assert.equal((await handler(event("GET", "/auth/callback", { query: { code: "c1", state: "forged" }, cookies: [stateCookie] }))).statusCode, 400);
  const callback = await handler(event("GET", "/auth/callback", { query: { code: "c1", state: location.searchParams.get("state")! }, cookies: [stateCookie] }));
  assert.equal(callback.statusCode, 302);
  assert.equal(callback.headers?.location, "/");
  const tokenRequest = new URLSearchParams(fetched.find((item) => item.url === TOKEN_URL)!.body);
  assert.deepEqual([tokenRequest.get("grant_type"), tokenRequest.get("client_id"), tokenRequest.get("code"), tokenRequest.get("redirect_uri")], ["authorization_code", "cli_portal", "c1", "https://portal.example.on.aws/auth/callback"]);
  const session = cookiePair(callback.cookies, SESSION_COOKIE);
  const page = await handler(event("GET", "/", { cookies: [session] }));
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers?.["content-security-policy"]), /script-src 'nonce-testnonce'/);
  assert.match(String(page.body), /<script nonce="testnonce">/);
  assert.match(String(page.body), /id="portal-data"/);
  assert.equal((await handler(event("POST", "/api/refresh", { cookies: [session] }))).statusCode, 403, "缺自定义头");
  assert.equal((await handler(event("POST", "/api/refresh", { headers: { "x-portal-refresh": "1" } }))).statusCode, 401, "未登录");
  const refreshed = await handler(event("POST", "/api/refresh", { cookies: [session], headers: { "x-portal-refresh": "1", "accept-encoding": "gzip" }, body: JSON.stringify({ force: true }) }));
  assert.equal(refreshed.statusCode, 200);
  assert.equal(refreshed.headers?.["content-encoding"], "gzip");
  const view = JSON.parse(gunzipSync(Buffer.from(String(refreshed.body), "base64")).toString("utf8"));
  assert.equal(view.kpis.sales.value, 70);
  assert.equal(view.user.name, "Owner");
  assert.equal(view.title, "AMZ中台", "默认名称（10/08 用户改名）");
  const renamed = portal({ PORTAL_TITLE: "我的店" });
  const renamedStart = await renamed.handler(event("GET", "/"));
  const renamedLocation = new URL(String(renamedStart.headers?.location));
  const renamedCallback = await renamed.handler(event("GET", "/auth/callback", { query: { code: "c2", state: renamedLocation.searchParams.get("state")! }, cookies: [cookiePair(renamedStart.cookies, STATE_COOKIE)] }));
  const renamedPage = await renamed.handler(event("GET", "/", { cookies: [cookiePair(renamedCallback.cookies, SESSION_COOKIE)] }));
  assert.match(String(renamedPage.body), /<title>我的店<\/title>/, "PORTAL_TITLE 改名不用重新发布");
  const linked = portal({ PORTAL_FEISHU_BASE_URL: "https://acme123.feishu.cn/base/AppTokenAbc123", PORTAL_FEISHU_LINKS: JSON.stringify({ orders: { to: "tblOrders123", label: "订单表" } }) });
  const linkedStart = await linked.handler(event("GET", "/"));
  const linkedLocation = new URL(String(linkedStart.headers?.location));
  const linkedCallback = await linked.handler(event("GET", "/auth/callback", { query: { code: "c3", state: linkedLocation.searchParams.get("state")! }, cookies: [cookiePair(linkedStart.cookies, STATE_COOKIE)] }));
  const snapshot = await linked.handler(event("GET", "/api/snapshot", { cookies: [cookiePair(linkedCallback.cookies, SESSION_COOKIE)] }));
  assert.deepEqual(JSON.parse(String(snapshot.body)).links.orders, { url: "https://acme123.feishu.cn/base/AppTokenAbc123?table=tblOrders123", label: "订单表" }, "页面数据带上跳飞书的地址");
});

test("入口：白名单外账号 403 并显示其 user_id；关闭开关返回已关闭页；缺应用凭证显示配置指引", async () => {
  const outsider = portal({}, { user_id: "u-stranger", open_id: "ou_s", name: "X" });
  const start = await outsider.handler(event("GET", "/"));
  const location = new URL(String(start.headers?.location));
  const denied = await outsider.handler(event("GET", "/auth/callback", { query: { code: "c", state: location.searchParams.get("state")! }, cookies: [cookiePair(start.cookies, STATE_COOKIE)] }));
  assert.equal(denied.statusCode, 403);
  assert.match(String(denied.body), /user_id: u-stranger/);
  assert.equal(denied.cookies?.some((item) => item.startsWith(`${SESSION_COOKIE}=`)), false);
  assert.equal((await portal({ PORTAL_ENABLED: "false" }).handler(event("GET", "/"))).statusCode, 503);
  const setup = await portal({ PORTAL_FEISHU_APP_SECRET: undefined }).handler(event("GET", "/"));
  assert.equal(setup.statusCode, 200);
  assert.match(String(setup.body), /https:\/\/portal\.example\.on\.aws\/auth\/callback/);
});

test("写密钥脚本：新增键保留其余键并排序；已有键须显式轮换；拒绝坏键名、空值、换行与超 4 KB", () => {
  const current = { FEISHU_APP_SECRET: "a", CLIENT_SECRET: "b" };
  const added = mergeBundle(current, "PORTAL_FEISHU_APP_SECRET", "s3cret");
  assert.deepEqual(Object.keys(added.next), ["CLIENT_SECRET", "FEISHU_APP_SECRET", "PORTAL_FEISHU_APP_SECRET"]);
  assert.equal(added.next.FEISHU_APP_SECRET, "a");
  assert.equal(added.replaced, false);
  assert.throws(() => mergeBundle(current, "CLIENT_SECRET", "x"), /--replace/);
  assert.equal(mergeBundle(current, "CLIENT_SECRET", "x", true).next.CLIENT_SECRET, "x");
  for (const [key, value] of [["bad-key", "x"], ["OK", ""], ["OK", "a\nb"], ["OK", " padded"]]) assert.throws(() => mergeBundle(current, key!, value!), key);
  assert.throws(() => mergeBundle({ A: 1 }, "OK", "x"), /非字符串/);
  assert.throws(() => mergeBundle(current, "BIG", "x".repeat(5000)), /4 KB/);
});

// ---------- 页面与只读边界 ----------

test("页面脚本可解析、不用 innerHTML；内嵌 JSON 转义 < 与行分隔符", () => {
  const source = clientMain.toString();
  assert.doesNotThrow(() => new Function(`(${source})`));
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.equal(embedJson({ a: "</script><b>\u2028" }), '{"a":"\\u003c/script>\\u003cb>\\u2028"}');
  const view = buildView({}, { nowMs: NOW, title: "AMZ<店铺>中台", user: { name: "</script>", avatar: "" }, asinBySku: {} });
  const html = renderPortalPage(view, "n1");
  assert.equal(html.match(/<\/script>/g)?.length, 2, "只有两个真正的 script 结束标签");
  assert.match(html, /<title>AMZ&lt;店铺&gt;中台<\/title>/, "页面标题取配置名称并转义（飞书导航标签用它）");
});

test("中台源码只读：不出现飞书写入、消息发送、亚马逊非 GET；广告 API 只有一处读发票；飞书请求只走 records/search；状态表只写缓存分区", async () => {
  const directory = path.join(root, "src", "portal");
  const files = [...(await readdir(directory)).map((name) => path.join(directory, name)), path.join(root, "src", "handlers", "portal.ts")];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const name = path.basename(file);
    assert.doesNotMatch(source, /\.(upsert|batchCreate|batchUpdate|batchDelete|sendText)\(|deliverNotification|prepareNotification|flushNotification|\.spStatus\(|\.spGrantless\(|\.adsDownload\(/, name);
    // 广告 API（10/10 广告账单格）：只允许 sources.ts 里一处 GET /invoices，下面的“亚马逊调用不带 method”同样约束它。
    const adsCalls = [...source.matchAll(/\.ads\s*(?:<[^<>()]*>)?\(\s*([^,)]*)/g)].map((match) => match[1]);
    assert.deepEqual(adsCalls, name === "sources.ts" ? ['"/invoices"'] : [], name);
    assert.doesNotMatch(source, /saveTask|saveNotification|recordHealth|claimEvent|putVersioned|markRecipient/, name);
    // 飞书请求只有 sources.ts 的一处查询封装，且固定为 POST records/search；亚马逊调用不带 method（即 GET）。
    const feishuRequests = (source.match(/\.request\s*[<(]/g) ?? []).length;
    if (name === "sources.ts") {
      assert.equal(feishuRequests, 1);
      assert.match(source, /"POST", `[^`]*\/records\/search`/);
      assert.doesNotMatch(source, /method\s*:/, "亚马逊只允许 GET");
    } else assert.equal(feishuRequests, 0, name);
    if (name !== "sources.ts") assert.doesNotMatch(source, /state\.put\(|\.put\(\{/, `${name} 不直接写状态表`);
  }
  const sources = await readFile(path.join(directory, "sources.ts"), "utf8");
  assert.deepEqual([...sources.matchAll(/state\.put\(\{\s*pk:\s*(\w+)/g)].map((match) => match[1]), ["CACHE_PK"]);
});

test("模板：中台函数只在控制区、唯一函数网址、两条公开调用策略、状态表写入受 LeadingKeys 限制、无队列/调度/SNS 权限；部署策略只对中台放行网址与并发", async () => {
  const template = await readFile(path.join(root, "infra", "template.yaml"), "utf8");
  const blocks = new Map<string, string>();
  for (const part of template.split(/^(?= {2}[A-Za-z][A-Za-z0-9]*:)/m)) { const id = /^ {2}([A-Za-z][A-Za-z0-9]*):/.exec(part)?.[1]; if (id) blocks.set(id, part); }
  assert.deepEqual([...blocks].filter(([, block]) => /Type: AWS::Lambda::Url\b/.test(block)).map(([id]) => id), ["PortalFunctionUrl"]);
  for (const id of ["PortalRole", "PortalLogGroup", "PortalFunction", "PortalFunctionUrl", "PortalUrlPublicInvoke", "PortalUrlFunctionInvoke"]) assert.match(blocks.get(id) ?? "", /Condition: IsControl/, id);
  assert.match(blocks.get("PortalFunctionUrl") ?? "", /AuthType: NONE/);
  assert.match(blocks.get("PortalUrlPublicInvoke") ?? "", /Action: lambda:InvokeFunctionUrl[\s\S]*FunctionUrlAuthType: NONE/);
  assert.match(blocks.get("PortalUrlFunctionInvoke") ?? "", /Action: lambda:InvokeFunction\s[\s\S]*InvokedViaFunctionUrl: true/);
  assert.match(blocks.get("PortalFunction") ?? "", /ReservedConcurrentExecutions: 2/);
  const role = blocks.get("PortalRole") ?? "";
  assert.match(role, /Action: \[dynamodb:GetItem, dynamodb:Query\]/);
  assert.match(role, /Action: \[dynamodb:PutItem, dynamodb:UpdateItem, dynamodb:DeleteItem\][\s\S]*dynamodb:LeadingKeys: \[PORTAL_CACHE, "LEASE#portal", FEISHU_USAGE\]/);
  assert.doesNotMatch(role, /sqs:|scheduler:|sns:|iam:PassRole/);
  const policy = JSON.parse(await readFile(path.join(root, "infra", "deployer-policy.json"), "utf8")) as { Statement: Array<{ Sid?: string; Action: string | string[]; Resource: string | string[] }> };
  const urlActions = policy.Statement.filter((item) => [item.Action].flat().some((action) => /FunctionUrlConfig|AddPermission|FunctionConcurrency/.test(action)));
  assert.deepEqual(urlActions.map((item) => item.Resource), ["arn:aws:lambda:us-east-1:123456789012:function:amzshop-prod-portal"]);
});
