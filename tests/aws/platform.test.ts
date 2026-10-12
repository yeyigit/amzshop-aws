import assert from "node:assert/strict";
import test from "node:test";
import type { Parameter } from "@aws-sdk/client-ssm";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AmazonClient } from "../../src/clients/amazon.js";
import { FeishuClient } from "../../src/clients/feishu.js";
import { CONFIG_CACHE_TTL_MS, SECRET_CACHE_TTL_MS, SECRET_REFRESH_MIN_INTERVAL_MS, getConfig, refreshSecrets, setParameterReader, type ParameterReader } from "../../src/config.js";
import { HttpError } from "../../src/http.js";
import { COMPLETED_STATE_RETENTION_SECONDS, COMPLETED_TASK_RETENTION_SECONDS, StateStore } from "../../src/state.js";
import { canonicalHash, canonicalJson, sha256 } from "../../src/util.js";
import type { AppConfig, JsonObject } from "../../src/types.js";

interface Call { url: URL; method: string; headers: Headers; body: string }
type Handler = (call: Call) => Response | Promise<Response>;

process.env.PARAMETER_PREFIX = "/amzshop/prod/";
const guardReader: ParameterReader = async () => { throw new Error("测试不得访问 SSM。"); };
setParameterReader(guardReader);

async function withFetch<T>(handler: Handler, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => handler({
    url: new URL(input instanceof Request ? input.url : String(input)),
    method: String(init.method ?? "GET").toUpperCase(),
    headers: new Headers(init.headers),
    body: typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "",
  })) as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = previous; }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ok = (data: unknown): Response => json({ code: 0, msg: "success", data });
const bodyOf = (call: Call | undefined): Record<string, unknown> => JSON.parse(call?.body || "{}") as Record<string, unknown>;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const feishuConfig = { get: (key: string) => `${key}-value`, optional: (_key: string, fallback = "") => fallback } as unknown as AppConfig;
let tenantSerial = 0;
const isTenantToken = (call: Call): boolean => call.url.pathname === "/open-apis/auth/v3/tenant_access_token/internal";
const issueTenantToken = (): Response => json({ code: 0, tenant_access_token: `t-${++tenantSerial}`, expire: 7200 });

async function feishuScenario(steps: Array<() => Response>, run: (client: FeishuClient) => Promise<unknown>) {
  const delays: number[] = [];
  const calls: Call[] = [];
  const events: string[] = [];
  let error: unknown;
  let result: unknown;
  const client = new FeishuClient(feishuConfig, { sleep: async (milliseconds) => { delays.push(milliseconds); } });
  await withFetch((call) => {
    if (isTenantToken(call)) { events.push("token"); return issueTenantToken(); }
    calls.push(call);
    events.push("api");
    return steps[Math.min(calls.length, steps.length) - 1]!();
  }, async () => { try { result = await run(client); } catch (caught) { error = caught; } });
  return { delays, calls, events, error, result };
}

const feishuError = (code: number, status = 200, headers: Record<string, string> = {}, msg = "temporary") => (): Response => json({ code, msg }, status, headers);
const feishuOk = (data: unknown) => (): Response => ok(data);
const networkDown = (): Response => { throw new TypeError("fetch failed"); };
const between = (value: number | undefined, low: number, high: number): boolean => value !== undefined && value >= low && value < high;

test("规范化 JSON 与哈希对对象键顺序不敏感，数组保序且值类型敏感", () => {
  const fromApi = { transactionId: "T1", totalAmount: { currencyCode: "USD", currencyAmount: -12.5 }, relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "111-1" }, { relatedIdentifierName: "SHIPMENT_ID", relatedIdentifierValue: "S1" }], breakdowns: null };
  const fromDynamo = { breakdowns: null, relatedIdentifiers: [{ relatedIdentifierValue: "111-1", relatedIdentifierName: "ORDER_ID" }, { relatedIdentifierValue: "S1", relatedIdentifierName: "SHIPMENT_ID" }], totalAmount: { currencyAmount: -12.5, currencyCode: "USD" }, transactionId: "T1" };
  assert.notEqual(JSON.stringify(fromApi), JSON.stringify(fromDynamo));
  assert.equal(canonicalJson(fromApi), canonicalJson(fromDynamo));
  assert.equal(canonicalHash(fromApi), canonicalHash(fromDynamo));
  assert.equal(canonicalHash(fromApi), sha256(canonicalJson(fromApi)));
  assert.match(canonicalHash(fromApi), /^[0-9a-f]{64}$/);
  assert.equal(canonicalJson({ b: [2, { d: 1, c: "中文" }], a: true }), '{"a":true,"b":[2,{"c":"中文","d":1}]}');
  assert.equal(canonicalJson({ a: undefined, b: [undefined], c: 1 }), JSON.stringify({ b: [null], c: 1 }));
  assert.deepEqual(JSON.parse(canonicalJson({ "10": 1, "2": 2, z: [3] })), { "10": 1, "2": 2, z: [3] });
  assert.notEqual(canonicalHash({ list: [1, 2] }), canonicalHash({ list: [2, 1] }));
  assert.notEqual(canonicalHash({ amount: "1" }), canonicalHash({ amount: 1 }));
  assert.notEqual(canonicalHash({ amount: -12.5 }), canonicalHash({ amount: -12.51 }));
});

test("飞书可重试失败按 1s/2s/4s 退避重试，幂等与带幂等键请求才重放", async () => {
  const app = "app";
  const table = "tbl";
  const retried: Array<[string, Array<() => Response>, (client: FeishuClient) => Promise<unknown>]> = [
    ["GET HTTP 500", [feishuError(500, 500), feishuOk({ items: [] })], (client) => client.listRecords(app, table)],
    ["GET 非 JSON 502", [() => new Response("<html>bad gateway</html>", { status: 502 }), feishuOk({ items: [] })], (client) => client.listRecords(app, table)],
    ["GET HTTP 429", [feishuError(99991400, 429), feishuOk({ items: [] })], (client) => client.listRecords(app, table)],
    ["GET 旧式频控码 99991400", [feishuError(99991400, 400), feishuOk({ items: [] })], (client) => client.listRecords(app, table)],
    ["search 数据未就绪 1254607", [feishuError(1254607), feishuOk({ items: [] })], (client) => client.searchRecords(app, table, { "记录唯一键": "k" })],
    ["PUT 网络错误", [networkDown, feishuOk({ record: { record_id: "rec1", fields: {} } })], (client) => client.update(app, table, "rec1", { a: 1 })],
    ["DELETE 超时 1255040", [feishuError(1255040, 504), feishuOk({ deleted: true, record_id: "rec1" })], (client) => client.delete(app, table, "rec1")],
    ["batch_update 写冲突 1254291", [feishuError(1254291), feishuOk({ records: [{ record_id: "rec1" }] })], (client) => client.request("POST", `/open-apis/bitable/v1/apps/${app}/tables/${table}/records/batch_update`, { records: [{ record_id: "rec1", fields: {} }] })],
    ["batch_delete 频控 1254290", [feishuError(1254290), feishuOk({ records: [{ record_id: "rec1", deleted: true }] })], (client) => client.request("POST", `/open-apis/bitable/v1/apps/${app}/tables/${table}/records/batch_delete`, { records: ["rec1"] })],
    ["消息带 uuid", [feishuError(500, 500), feishuOk({ message_id: "om_1" })], (client) => client.sendText("user-1", ["hello"], "uuid-1")],
    ["创建带 client_token", [networkDown, feishuOk({ record: { record_id: "rec-new", fields: {} } })], (client) => client.upsert(app, table, { "记录唯一键": "k" }, { "记录唯一键": "k" }, {}, { existing: [] })],
  ];
  for (const [name, steps, run] of retried) {
    const outcome = await feishuScenario(steps, run);
    assert.equal(outcome.error, undefined, name);
    assert.equal(outcome.calls.length, 2, name);
    assert.equal(outcome.delays.length, 1, name);
    assert.ok(between(outcome.delays[0], 1000, 1250), `${name}: ${outcome.delays[0]}`);
    if (name === "创建带 client_token") {
      const token = outcome.calls[0]!.url.searchParams.get("client_token") ?? "";
      assert.match(token, uuidV4);
      assert.equal(outcome.calls[1]!.url.searchParams.get("client_token"), token);
      assert.equal(outcome.result, "rec-new");
    }
  }

  const notRetried: Array<[string, Array<() => Response>, (client: FeishuClient) => Promise<unknown>, RegExp]> = [
    ["创建无 client_token 遇 503", [feishuError(1255001, 503), feishuOk({ record: { record_id: "rec-x" } })], (client) => client.request("POST", `/open-apis/bitable/v1/apps/${app}/tables/${table}/records`, { fields: {} }), /飞书 API 失败/],
    ["创建无 client_token 遇网络错误", [networkDown, feishuOk({ records: [] })], (client) => client.request("POST", `/open-apis/bitable/v1/apps/${app}/tables/${table}/records/batch_create`, { records: [] }), /fetch failed/],
    ["创建无 client_token 遇数据未就绪", [feishuError(1254607), feishuOk({ record: { record_id: "rec-x" } })], (client) => client.request("POST", `/open-apis/bitable/v1/apps/${app}/tables/${table}/records`, { fields: {} }), /飞书 API 失败/],
    ["不可重试业务码", [feishuError(1254001, 200, {}, "WrongRequestBody"), feishuOk({ items: [] })], (client) => client.listRecords(app, table), /飞书 API 失败: WrongRequestBody/],
  ];
  for (const [name, steps, run, message] of notRetried) {
    const outcome = await feishuScenario(steps, run);
    assert.equal(outcome.calls.length, 1, name);
    assert.deepEqual(outcome.delays, [], name);
    assert.match(String((outcome.error as Error | undefined)?.message), message, name);
  }

  const reset = await feishuScenario([feishuError(1254290, 200, { "x-ogw-ratelimit-reset": "3" }), feishuOk({ items: [] })], (client) => client.listRecords(app, table));
  assert.deepEqual(reset.delays, [3000]);
  const capped = await feishuScenario([feishuError(99991400, 429, { "x-ogw-ratelimit-reset": "30" }), feishuOk({ items: [] })], (client) => client.listRecords(app, table));
  assert.deepEqual(capped.delays, [10_000]);
  const notRateLimit = await feishuScenario([feishuError(1254607, 200, { "x-ogw-ratelimit-reset": "0" }), feishuOk({ items: [] })], (client) => client.listRecords(app, table));
  assert.ok(between(notRateLimit.delays[0], 1000, 1250));

  const exhausted = await feishuScenario([feishuError(1254607, 200, {}, "Data not ready, please try again later")], (client) => client.listRecords(app, table));
  assert.equal(exhausted.calls.length, 4);
  assert.equal(exhausted.delays.length, 3);
  assert.ok(between(exhausted.delays[0], 1000, 1250) && between(exhausted.delays[1], 2000, 2250) && between(exhausted.delays[2], 4000, 4250), exhausted.delays.join(","));
  assert.ok(exhausted.error instanceof HttpError);
  assert.equal(exhausted.error.code, "1254607");
  assert.equal(exhausted.error.retryable, true);
  assert.match(exhausted.error.message, /^飞书 API 失败: Data not ready, please try again later$/);
});

test("飞书 99991663 只清 Tenant Token 并重试一次，创建类同样适用且不计入退避", async () => {
  const refreshed = await feishuScenario([feishuError(99991663, 400, {}, "Invalid access token"), feishuOk({ items: [] })], (client) => client.listRecords("app", "tbl"));
  assert.equal(refreshed.error, undefined);
  assert.deepEqual(refreshed.events.slice(-3), ["api", "token", "api"]);
  assert.notEqual(refreshed.calls[0]!.headers.get("authorization"), refreshed.calls[1]!.headers.get("authorization"));
  assert.equal(refreshed.calls[1]!.headers.get("authorization"), `Bearer t-${tenantSerial}`);
  assert.deepEqual(refreshed.delays, []);

  const twice = await feishuScenario([feishuError(99991663, 400, {}, "Invalid access token")], (client) => client.listRecords("app", "tbl"));
  assert.equal(twice.calls.length, 2);
  assert.equal(twice.events.filter((event) => event === "token").length - (twice.events[0] === "token" ? 1 : 0), 1);
  assert.ok(twice.error instanceof HttpError);
  assert.equal(twice.error.code, "99991663");

  const create = await feishuScenario([feishuError(99991663, 400), feishuOk({ record: { record_id: "rec-1", fields: {} } })], (client) => client.request("POST", "/open-apis/bitable/v1/apps/app/tables/tbl/records", { fields: {} }));
  assert.equal(create.error, undefined);
  assert.equal(create.calls.length, 2);
});

test("飞书 upsert 传入 existing 时不再搜索，创建带 uuidv4 client_token；search 可限定返回字段", async () => {
  const calls: Call[] = [];
  const client = new FeishuClient(feishuConfig, { sleep: async () => undefined });
  await withFetch((call) => {
    if (isTenantToken(call)) return issueTenantToken();
    calls.push(call);
    if (call.url.pathname.endsWith("/records/search")) return ok({ items: [], has_more: false });
    if (call.method === "PUT") return ok({ record: { record_id: "rec-old", fields: {} } });
    return ok({ record: { record_id: "rec-new", fields: {} } });
  }, async () => {
    assert.equal(await client.upsert("app", "tbl", { "记录唯一键": "k1" }, { "值": 1 }, { "创建时间": 1 }, { existing: [{ record_id: "rec-old", fields: {} }] }), "rec-old");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "PUT");
    assert.match(calls[0]!.url.pathname, /\/records\/rec-old$/);
    assert.deepEqual(bodyOf(calls[0]), { fields: { "值": 1 } });
    await assert.rejects(client.upsert("app", "tbl", { "记录唯一键": "k1" }, {}, {}, { existing: [{ record_id: "a", fields: {} }, { record_id: "b", fields: {} }] }), /稳定业务键不唯一/);
    assert.equal(calls.length, 1);
    assert.equal(await client.upsert("app", "tbl", { "记录唯一键": "k2" }, { "值": 2 }, { "创建时间": 3 }), "rec-new");
    assert.deepEqual(calls.slice(1).map((call) => call.url.pathname.split("/").at(-1)), ["search", "records"]);
    assert.match(calls[2]!.url.searchParams.get("client_token") ?? "", uuidV4);
    assert.deepEqual(bodyOf(calls[2]), { fields: { "值": 2, "创建时间": 3 } });
    await client.searchRecords("app", "tbl", { "SKU编号": "SKU-1" }, { fieldNames: ["SKU编号", "快照日期"] });
    assert.deepEqual(bodyOf(calls[3]), { field_names: ["SKU编号", "快照日期"], filter: { conjunction: "and", conditions: [{ field_name: "SKU编号", operator: "is", value: ["SKU-1"] }] } });
  });
});

test("飞书批量创建每块≤500、块内重试复用 client_token、按输入顺序返回并逐块回调", async () => {
  const calls: Call[] = [];
  const events: string[] = [];
  let serial = 0;
  let failOnce = true;
  const client = new FeishuClient(feishuConfig, { sleep: async () => undefined });
  const rows = Array.from({ length: 1001 }, (_, index) => ({ "记录唯一键": `k${index}` }));
  const ids = await withFetch((call) => {
    if (isTenantToken(call)) return issueTenantToken();
    calls.push(call);
    const records = bodyOf(call).records as Array<{ fields: Record<string, unknown> }>;
    events.push(`api:${records.length}`);
    if (calls.length === 2 && failOnce) { failOnce = false; return json({ code: 1255040, msg: "timeout" }, 504); }
    return ok({ records: records.map((record) => ({ record_id: `rec-${String(record.fields["记录唯一键"])}-${++serial}`, fields: record.fields })) });
  }, () => client.batchCreate("app", "tbl", rows, { onChunk: async (count) => { events.push(`chunk:${count}`); } }));
  assert.deepEqual(events, ["api:500", "chunk:500", "api:500", "api:500", "chunk:1000", "api:1", "chunk:1001"]);
  assert.ok(calls.every((call) => call.url.pathname.endsWith("/records/batch_create")));
  const tokens = calls.map((call) => call.url.searchParams.get("client_token") ?? "");
  assert.ok(tokens.every((token) => uuidV4.test(token)));
  assert.equal(tokens[1], tokens[2]);
  assert.equal(new Set(tokens).size, 3);
  assert.equal(ids.length, 1001);
  assert.ok(ids.every((id, index) => id.startsWith(`rec-k${index}-`)));
  assert.deepEqual(await client.batchCreate("app", "tbl", [], { onChunk: () => { throw new Error("空输入不应回调"); } }), []);
});

test("飞书批量回执不一致即抛错，onChunk 只在成功块后调用", async () => {
  const client = new FeishuClient(feishuConfig, { sleep: async () => undefined });
  const run = async (respond: (call: Call, index: number) => Response, action: (chunks: number[]) => Promise<unknown>) => {
    const chunks: number[] = [];
    const calls: Call[] = [];
    let error: unknown;
    await withFetch((call) => {
      if (isTenantToken(call)) return issueTenantToken();
      calls.push(call);
      return respond(call, calls.length);
    }, async () => { try { await action(chunks); } catch (caught) { error = caught; } });
    return { chunks, calls, error };
  };
  const updates = Array.from({ length: 501 }, (_, index) => ({ recordId: `rec${index}`, fields: { "值": index } }));
  const update = await run((call, index) => {
    const records = bodyOf(call).records as Array<{ record_id: string }>;
    return ok({ records: index === 1 ? records.map((record) => ({ record_id: record.record_id })) : [{ record_id: "rec-other" }] });
  }, (chunks) => client.batchUpdate("app", "tbl", updates, { onChunk: (count) => { chunks.push(count); } }));
  assert.match(String((update.error as Error).message), /批量更新回执与请求记录不一致/);
  assert.deepEqual(update.chunks, [500]);
  assert.equal(update.calls.length, 2);
  assert.ok(update.calls.every((call) => uuidV4.test(call.url.searchParams.get("client_token") ?? "")));
  assert.deepEqual((bodyOf(update.calls[1]).records as unknown[]), [{ record_id: "rec500", fields: { "值": 500 } }]);

  const short = await run(() => ok({ records: [{ record_id: "rec-a" }] }), (chunks) => client.batchCreate("app", "tbl", [{ a: 1 }, { a: 2 }], { onChunk: (count) => { chunks.push(count); } }));
  assert.match(String((short.error as Error).message), /批量创建回执与请求记录不一致/);
  assert.deepEqual(short.chunks, []);
  const duplicate = await run(() => ok({ records: [{ record_id: "rec-a" }, { record_id: "rec-a" }] }), (chunks) => client.batchCreate("app", "tbl", [{ a: 1 }, { a: 2 }], { onChunk: (count) => { chunks.push(count); } }));
  assert.match(String((duplicate.error as Error).message), /批量创建回执与请求记录不一致/);

  const removed = await run((call) => ok({ records: (bodyOf(call).records as string[]).map((id) => ({ record_id: id, deleted: true })) }), (chunks) => client.batchDelete("app", "tbl", ["rec1", "rec2"], { onChunk: (count) => { chunks.push(count); } }));
  assert.equal(removed.error, undefined);
  assert.deepEqual(removed.chunks, [2]);
  assert.deepEqual(bodyOf(removed.calls[0]), { records: ["rec1", "rec2"] });
  assert.match(removed.calls[0]!.url.pathname, /\/records\/batch_delete$/);
  assert.equal(removed.calls[0]!.url.searchParams.has("client_token"), false);
  const unconfirmed = await run(() => ok({ records: [{ record_id: "rec1", deleted: true }, { record_id: "rec2", deleted: false }] }), (chunks) => client.batchDelete("app", "tbl", ["rec1", "rec2"], { onChunk: (count) => { chunks.push(count); } }));
  assert.match(String((unconfirmed.error as Error).message), /批量删除回执未逐条确认/);
  assert.deepEqual(unconfirmed.chunks, []);

  const repeated = await run(() => ok({ records: [] }), () => client.batchDelete("app", "tbl", ["rec1", "rec1"]));
  assert.match(String((repeated.error as Error).message), /record_id 为空或重复/);
  assert.equal(repeated.calls.length, 0);
});

test("配置 600 秒缓存、密钥实例内 6 小时缓存，refreshSecrets 强制重读并合并并发", async () => {
  let now = 1_000_000;
  const reads: string[] = [];
  let secret: Parameter = { Name: "/amzshop/prod/secrets/FEISHU_APP_SECRET", Value: "s1", Version: 1 };
  let release: () => void = () => undefined;
  let gate: Promise<void> = Promise.resolve();
  const plain: Parameter = { Name: "/amzshop/prod/config/FEISHU_APP_ID", Value: "app-1", Version: 3 };
  const asin: Parameter = { Name: "/amzshop/prod/asin/SKU-1", Value: JSON.stringify({ sku: "SKU-1", asin: "B000000001" }), Version: 2 };
  setParameterReader(async (path, decrypt) => {
    reads.push(`${path.split("/").at(-2)}:${decrypt}`);
    if (path.endsWith("/secrets/bundle/")) return [];
    if (path.endsWith("/secrets/")) { await gate; return [secret]; }
    return path.endsWith("/config/") ? [plain] : [asin];
  }, () => now);
  try {
    const config = await getConfig();
    assert.deepEqual([...reads].sort(), ["asin:false", "bundle:true", "config:false", "secrets:true"], "无密钥包时回退逐个读取");
    assert.equal(config.get("FEISHU_APP_SECRET"), "s1");
    assert.equal(config.get("FEISHU_APP_ID"), "app-1");
    assert.equal(config.asins()[0]?.asin, "B000000001");
    const versionOf = (secretVersion: number): string => sha256(["/amzshop/prod/config/FEISHU_APP_ID:3", "/amzshop/prod/asin/SKU-1:2", `/amzshop/prod/secrets/FEISHU_APP_SECRET:${secretVersion}`].sort().join("\n")).slice(0, 16);
    assert.equal(config.version, versionOf(1));

    reads.length = 0;
    now += CONFIG_CACHE_TTL_MS - 1;
    assert.equal(await getConfig(), config);
    assert.deepEqual(reads, []);
    now += 2;
    const reloaded = await getConfig();
    assert.deepEqual([...reads].sort(), ["asin:false", "config:false"]);
    assert.equal(reloaded.get("FEISHU_APP_SECRET"), "s1");

    reads.length = 0;
    secret = { ...secret, Value: "s2", Version: 2 };
    gate = new Promise((resolve) => { release = resolve; });
    const first = refreshSecrets();
    const second = refreshSecrets();
    release();
    await Promise.all([first, second]);
    assert.deepEqual(reads, ["bundle:true", "secrets:true"]);
    assert.equal(config.get("FEISHU_APP_SECRET"), "s2");
    assert.equal(reloaded.get("FEISHU_APP_SECRET"), "s2");
    assert.equal(config.version, versionOf(2));

    reads.length = 0;
    now += SECRET_REFRESH_MIN_INTERVAL_MS - 1;
    await refreshSecrets();
    assert.deepEqual(reads, []);
    now += SECRET_CACHE_TTL_MS;
    await getConfig();
    assert.deepEqual([...reads].sort(), ["asin:false", "bundle:true", "config:false", "secrets:true"]);
  } finally {
    setParameterReader(guardReader);
  }
});

const amazonConfig = { get: (key: string) => `${key}-value`, optional: (_key: string, fallback = "") => fallback } as unknown as AppConfig;
let lwaSerial = 0;
const isLwa = (call: Call): boolean => call.url.hostname === "api.amazon.com";
const issueLwa = (): Response => json({ access_token: `atza-${++lwaSerial}`, expires_in: 3600 });

test("Amazon pace 按 key 保证最小调用间隔，同实例并发调用按顺序排队", async () => {
  const starts: Array<{ path: string; at: number }> = [];
  const client = new AmazonClient(amazonConfig);
  const pace = { key: `pace-${Date.now()}`, minIntervalMs: 60 };
  let lwaCalls = 0;
  await withFetch((call) => {
    if (isLwa(call)) { lwaCalls += 1; return issueLwa(); }
    starts.push({ path: call.url.pathname, at: Date.now() });
    return json({ payload: {} });
  }, () => Promise.all([
    client.sp("/a", { pace }),
    client.sp("/b", { pace }),
    client.spStatus("/c", { method: "POST", pace }),
    client.sp("/independent", { pace: { key: `${pace.key}-other`, minIntervalMs: 60 } }),
  ]));
  const at = (path: string): number => starts.find((item) => item.path === path)!.at;
  assert.ok(lwaCalls <= 1, `并发调用应合并 LWA 取 token: ${lwaCalls}`);
  assert.deepEqual(starts.filter((item) => item.path !== "/independent").map((item) => item.path), ["/a", "/b", "/c"]);
  assert.ok(at("/b") - at("/a") >= 55, `${at("/b") - at("/a")}`);
  assert.ok(at("/c") - at("/b") >= 55, `${at("/c") - at("/b")}`);
  assert.ok(at("/independent") < at("/b"));
  let followUp = 0;
  await withFetch((call) => { if (isLwa(call)) return issueLwa(); followUp = Date.now(); return json({ payload: {} }); }, () => client.sp("/d", { pace }));
  assert.ok(followUp - at("/c") >= 55, `${followUp - at("/c")}`);
});

test("SP-API 429 无 Retry-After 时退避不少于 1s、2s，有 Retry-After 时遵守", async () => {
  const delays: number[] = [];
  const client = new AmazonClient(amazonConfig, { sleep: async (milliseconds) => { delays.push(milliseconds); } });
  let calls = 0;
  const quota = (): Response => json({ errors: [{ code: "QuotaExceeded", message: "You exceeded your quota for the requested resource." }] }, 429);
  const result = await withFetch((call) => {
    if (isLwa(call)) return issueLwa();
    calls += 1;
    return calls <= 2 ? quota() : json({ payload: { ok: true } });
  }, () => client.sp<JsonObject>("/finances/2024-06-19/transactions"));
  assert.deepEqual(result, { payload: { ok: true } });
  assert.equal(calls, 3);
  assert.ok(between(delays[0], 1000, 1200) && between(delays[1], 2000, 2200), delays.join(","));

  delays.length = 0;
  calls = 0;
  const failure = await withFetch((call) => {
    if (isLwa(call)) return issueLwa();
    calls += 1;
    return calls === 1 ? json({ errors: [{ code: "QuotaExceeded" }] }, 429, { "retry-after": "5" }) : quota();
  }, () => client.sp("/finances/2024-06-19/transactions").then(() => undefined, (error: unknown) => error));
  assert.equal(calls, 3);
  assert.equal(delays[0], 5000);
  assert.ok(failure instanceof HttpError);
  assert.equal(failure.status, 429);
  assert.equal(failure.code, "QuotaExceeded");
  assert.equal(failure.retryable, true);
});

test("SP/Ads 返回 token 失效的 401/403 时强制刷新 access token 只重试一次", async () => {
  const client = new AmazonClient(amazonConfig, { sleep: async () => undefined });
  let rejected: string | undefined;
  const seen: string[] = [];
  const result = await withFetch((call) => {
    if (isLwa(call)) return issueLwa();
    const token = call.headers.get("x-amz-access-token") ?? "";
    seen.push(token);
    rejected ??= token;
    return token === rejected ? json({ errors: [{ code: "Unauthorized", message: "Access to requested resource is denied.", details: "The access token you provided has expired." }] }, 403) : json({ payload: "ok" });
  }, () => client.sp<JsonObject>("/orders/v0/orders/1"));
  assert.deepEqual(result, { payload: "ok" });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);

  let adsCalls = 0;
  const adsResult = await withFetch((call) => {
    if (isLwa(call)) return issueLwa();
    adsCalls += 1;
    return adsCalls === 1 ? json({ code: "UNAUTHORIZED", details: "HTTP 401 Unauthorized" }, 401) : json([{ profileId: 1 }]);
  }, () => client.ads<JsonObject[]>("/v2/profiles"));
  assert.deepEqual(adsResult, [{ profileId: 1 }]);
  assert.equal(adsCalls, 2);

  let deniedCalls = 0;
  const denied = await withFetch((call) => {
    if (isLwa(call)) return issueLwa();
    deniedCalls += 1;
    return json({ errors: [{ code: "Unauthorized", message: "Access to requested resource is denied." }] }, 403);
  }, () => client.sp("/orders/v0/orders/2").then(() => undefined, (error: unknown) => error));
  assert.equal(deniedCalls, 2);
  assert.ok(denied instanceof HttpError && denied.status === 403);

  let invalidCalls = 0;
  const invalid = await withFetch((call) => {
    if (isLwa(call)) return issueLwa();
    invalidCalls += 1;
    return json({ errors: [{ code: "InvalidInput", message: "bad" }] }, 400);
  }, () => client.sp("/orders/v0/orders/3").then(() => undefined, (error: unknown) => error));
  assert.equal(invalidCalls, 1);
  assert.ok(invalid instanceof HttpError && invalid.code === "InvalidInput" && !invalid.retryable);
});

test("spStatus 以 HttpError 暴露状态码，便于区分 429、其它 4xx 与 5xx", async () => {
  const client = new AmazonClient(amazonConfig, { sleep: async () => undefined });
  for (const [status, retryable, message] of [[429, true, "SP-API 可重试失败 HTTP 429。"], [503, true, "SP-API 可重试失败 HTTP 503。"], [400, false, "SP-API 失败 HTTP 400。"]] as const) {
    let calls = 0;
    const error = await withFetch((call) => {
      if (isLwa(call)) return issueLwa();
      calls += 1;
      return json({ errors: [{ code: status === 400 ? "InvalidInput" : "Transient" }] }, status);
    }, () => client.spStatus("/solicitations/v1/orders/1/solicitations/productReviewAndSellerFeedback", { method: "POST" }).then(() => undefined, (caught: unknown) => caught));
    assert.equal(calls, 1);
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, status);
    assert.equal(error.retryable, retryable);
    assert.equal(error.message, message);
  }
  const created = await withFetch((call) => isLwa(call) ? issueLwa() : new Response(null, { status: 201 }), () => client.spStatus("/solicitations/v1/orders/1/solicitations/productReviewAndSellerFeedback", { method: "POST" }));
  assert.equal(created, 201);
});

test("LWA 与飞书应用凭证失效时 refreshSecrets 强制重读后只重试一次", async () => {
  let now = 50_000_000;
  let secretReads = 0;
  const values: Record<string, string> = { CLIENT_ID: "cid", REFRESH_TOKEN: "refresh", CLIENT_SECRET: "old-secret", FEISHU_APP_ID: "cli_app", FEISHU_APP_SECRET: "old-app-secret" };
  setParameterReader(async (path) => {
    if (!path.endsWith("/secrets/")) return [];
    secretReads += 1;
    return Object.entries(values).map(([key, value]) => ({ Name: `/amzshop/prod/secrets/${key}`, Value: value, Version: secretReads }));
  }, () => now);
  try {
    const config = await getConfig();
    values.CLIENT_SECRET = "new-secret";
    now += SECRET_REFRESH_MIN_INTERVAL_MS + 1;
    const lwaSecrets: string[] = [];
    const amazon = new AmazonClient(config, { sleep: async () => undefined });
    const result = await withFetch((call) => {
      if (isLwa(call)) {
        const secret = new URLSearchParams(call.body).get("client_secret") ?? "";
        lwaSecrets.push(secret);
        return secret === "new-secret" ? json({ access_token: `atza-new-${++lwaSerial}`, expires_in: 3600 }) : json({ error: "invalid_client", error_description: "Client authentication failed" }, 401);
      }
      return (call.headers.get("x-amz-access-token") ?? "").startsWith("atza-new-") ? json({ payload: "ok" }) : json({ errors: [{ code: "Unauthorized" }] }, 403);
    }, () => amazon.sp<JsonObject>("/sellers/v1/marketplaceParticipations"));
    assert.deepEqual(result, { payload: "ok" });
    assert.deepEqual(lwaSecrets, ["old-secret", "new-secret"]);
    assert.equal(secretReads, 2);
    assert.equal(config.get("CLIENT_SECRET"), "new-secret");

    values.FEISHU_APP_SECRET = "new-app-secret";
    now += SECRET_REFRESH_MIN_INTERVAL_MS + 1;
    const appSecrets: string[] = [];
    const feishu = new FeishuClient(config, { sleep: async () => undefined });
    await withFetch((call) => {
      if (isTenantToken(call)) {
        const secret = String(bodyOf(call).app_secret);
        appSecrets.push(secret);
        return secret === "new-app-secret" ? json({ code: 0, tenant_access_token: "t-new-app", expire: 7200 }) : json({ code: 10014, msg: "app secret invalid" }, 400);
      }
      return call.headers.get("authorization") === "Bearer t-new-app" ? ok({ items: [] }) : json({ code: 99991663, msg: "Invalid access token" }, 400);
    }, () => feishu.listRecords("app", "tbl"));
    assert.deepEqual(appSecrets, ["old-app-secret", "new-app-secret"]);
    assert.equal(secretReads, 3);

    now += SECRET_REFRESH_MIN_INTERVAL_MS + 1;
    let tokenCalls = 0;
    const failure = await withFetch((call) => {
      if (isTenantToken(call)) { tokenCalls += 1; return json({ code: 10014, msg: "app secret invalid" }, 400); }
      return json({ code: 99991663, msg: "Invalid access token" }, 400);
    }, () => feishu.listRecords("app", "tbl").then(() => undefined, (error: unknown) => error));
    assert.equal(tokenCalls, 2);
    assert.equal(secretReads, 4);
    assert.ok(failure instanceof HttpError);
    assert.equal(failure.message, "飞书 Tenant Token 获取失败。");
  } finally {
    setParameterReader(guardReader);
  }
});

function stateHarness(initial: Array<Record<string, unknown>> = [], options: { pages?: Array<{ Items: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }>; updateError?: Error; deleteError?: Error } = {}) {
  const items = new Map(initial.map((item) => [`${String(item.pk)}|${String(item.sk)}`, item]));
  const sent: Array<{ type: string; input: Record<string, unknown> }> = [];
  const keyOf = (key: unknown): string => { const value = key as { pk: string; sk: string }; return `${value.pk}|${value.sk}`; };
  const db = {
    send: async (command: unknown) => {
      if (command instanceof GetCommand) { sent.push({ type: "get", input: command.input as Record<string, unknown> }); return { Item: items.get(keyOf(command.input.Key)) }; }
      if (command instanceof PutCommand) { sent.push({ type: "put", input: command.input as Record<string, unknown> }); items.set(keyOf(command.input.Item), command.input.Item as Record<string, unknown>); return {}; }
      if (command instanceof DeleteCommand) { sent.push({ type: "delete", input: command.input as Record<string, unknown> }); if (options.deleteError) throw options.deleteError; items.delete(keyOf(command.input.Key)); return {}; }
      if (command instanceof UpdateCommand) { sent.push({ type: "update", input: command.input as Record<string, unknown> }); if (options.updateError) throw options.updateError; return {}; }
      if (command instanceof QueryCommand) { sent.push({ type: "query", input: command.input as Record<string, unknown> }); return options.pages?.shift() ?? { Items: [] }; }
      throw new Error("未预期的 DynamoDB 命令。");
    },
  } as unknown as DynamoDBDocumentClient;
  return { state: new StateStore("test-state", db), items, sent };
}

test("完成任务保留 30 天（含 superseded），事件与通知完成态仍保留 400 天", async () => {
  const { state, items, sent } = stateHarness();
  const nowSeconds = Math.floor(Date.now() / 1000);
  await state.saveTask("finance", "done-task", { a: 1 }, "done");
  await state.saveTask("finance", "old-chain", { a: 1 }, "superseded");
  await state.saveTask("finance", "active-task", { a: 1 }, "active", "2026-09-28T00:00:00.000Z");
  const expires = (sk: string): number => Number(items.get(`TASK#finance|${sk}`)?.expiresAt);
  assert.equal(COMPLETED_TASK_RETENTION_SECONDS, 30 * 86_400);
  assert.equal(COMPLETED_STATE_RETENTION_SECONDS, 400 * 86_400);
  assert.ok(Math.abs(expires("done-task") - nowSeconds - COMPLETED_TASK_RETENTION_SECONDS) <= 2);
  assert.ok(Math.abs(expires("old-chain") - nowSeconds - COMPLETED_TASK_RETENTION_SECONDS) <= 2);
  assert.equal(items.get("TASK#finance|active-task")?.expiresAt, undefined);
  assert.equal(items.get("TASK#finance|active-task")?.nextAt, "2026-09-28T00:00:00.000Z");
  items.set("TASK#finance|lapsed", { pk: "TASK#finance", sk: "lapsed", status: "done", expiresAt: nowSeconds - 1 });
  assert.equal(await state.task("finance", "lapsed"), undefined);
  assert.equal((await state.task("finance", "done-task"))?.status, "done");
  sent.length = 0;
  await state.completeNotification("new|1");
  const update = sent[0]!.input as { ExpressionAttributeValues: Record<string, unknown> };
  assert.ok(Math.abs(Number(update.ExpressionAttributeValues[":expires"]) - nowSeconds - COMPLETED_STATE_RETENTION_SECONDS) <= 2);
});

test("通知意图先写待发指针再写 pending，保留首次创建时间；完成或过期后删除指针且不再复活", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const fresh = stateHarness();
  await fresh.state.saveNotification("new|1", ["💰新订单"], ["u1", "u2"]);
  assert.deepEqual(fresh.sent.map((item) => item.type), ["get", "put", "put"]);
  const pointer = (fresh.sent[1]!.input as { Item: Record<string, unknown> }).Item;
  const notification = (fresh.sent[2]!.input as { Item: Record<string, unknown> }).Item;
  assert.deepEqual(Object.keys(pointer).sort(), ["createdAt", "pk", "sk"]);
  assert.equal(pointer.pk, "NOTIFICATION_PENDING");
  assert.equal(pointer.sk, "new|1");
  assert.equal(notification.status, "pending");
  assert.equal(notification.createdAt, pointer.createdAt);
  assert.deepEqual(notification.recipients, ["u1", "u2"]);
  assert.deepEqual(notification.delivered, {});

  const legacy = stateHarness([{ pk: "NOTIFICATION", sk: "new|2", status: "pending", lines: ["旧快照"], recipients: ["u1"], delivered: { u1: "2026-09-23T13:40:00.000Z" }, updatedAt: "2026-09-23T13:34:00.000Z" }]);
  await legacy.state.saveNotification("new|2", ["新内容"], ["u9"]);
  assert.equal(legacy.items.get("NOTIFICATION_PENDING|new|2")?.createdAt, "2026-09-23T13:34:00.000Z");
  assert.deepEqual(legacy.items.get("NOTIFICATION|new|2")?.lines, ["旧快照"]);
  assert.deepEqual(legacy.items.get("NOTIFICATION|new|2")?.recipients, ["u1"]);
  assert.deepEqual(legacy.items.get("NOTIFICATION|new|2")?.delivered, { u1: "2026-09-23T13:40:00.000Z" });
  assert.equal(legacy.items.get("NOTIFICATION|new|2")?.createdAt, "2026-09-23T13:34:00.000Z");

  for (const status of ["done", "expired"]) {
    const terminal = stateHarness([{ pk: "NOTIFICATION", sk: "k", status, expiresAt: nowSeconds + 3600, lines: ["x"] }]);
    await terminal.state.saveNotification("k", ["y"], ["u1"]);
    assert.deepEqual(terminal.sent.map((item) => item.type), ["get"], status);
  }
  const lapsed = stateHarness([{ pk: "NOTIFICATION", sk: "k", status: "done", expiresAt: nowSeconds - 1, lines: ["x"], recipients: ["old"], delivered: { old: "t" }, createdAt: "2020-01-01T00:00:00.000Z" }]);
  await lapsed.state.saveNotification("k", ["y"], ["u1"]);
  assert.deepEqual(lapsed.items.get("NOTIFICATION|k")?.lines, ["y"]);
  assert.deepEqual(lapsed.items.get("NOTIFICATION|k")?.delivered, {});
  assert.notEqual(lapsed.items.get("NOTIFICATION|k")?.createdAt, "2020-01-01T00:00:00.000Z");

  await fresh.state.completeNotification("new|1");
  assert.deepEqual(fresh.sent.slice(-2).map((item) => item.type), ["update", "delete"]);
  assert.equal(fresh.items.has("NOTIFICATION_PENDING|new|1"), false);
  const denied = stateHarness([{ pk: "NOTIFICATION_PENDING", sk: "new|3", createdAt: "2026-09-28T00:00:00.000Z" }], { deleteError: Object.assign(new Error("not authorized to perform dynamodb:DeleteItem"), { name: "AccessDeniedException" }) });
  const logs: string[] = [];
  const consoleLog = console.log;
  console.log = (line: string) => { logs.push(line); };
  try { await denied.state.completeNotification("new|3"); } finally { console.log = consoleLog; }
  assert.deepEqual(denied.sent.map((item) => item.type), ["update", "delete"]);
  assert.equal(denied.items.has("NOTIFICATION_PENDING|new|3"), true);
  assert.match(logs.join("\n"), /notification_pointer_cleanup_failed/);

  await legacy.state.expireNotification("new|2", "超过 48 小时未送达");
  const expire = legacy.sent.at(-2)!.input as { ConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> };
  assert.match(expire.ConditionExpression, /attribute_exists\(pk\)/);
  assert.equal(expire.ExpressionAttributeValues[":expired"], "expired");
  assert.equal(expire.ExpressionAttributeValues[":reason"], "超过 48 小时未送达");
  assert.ok(Math.abs(Number(expire.ExpressionAttributeValues[":expires"]) - nowSeconds - COMPLETED_STATE_RETENTION_SECONDS) <= 2);
  assert.equal(legacy.sent.at(-1)!.type, "delete");
  assert.equal(legacy.items.has("NOTIFICATION_PENDING|new|2"), false);

  const alreadyDone = stateHarness([{ pk: "NOTIFICATION_PENDING", sk: "k", createdAt: "2026-09-20T00:00:00.000Z" }], { updateError: Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" }) });
  await alreadyDone.state.expireNotification("k", "过期");
  assert.equal(alreadyDone.items.has("NOTIFICATION_PENDING|k"), false);
  const broken = stateHarness([{ pk: "NOTIFICATION_PENDING", sk: "k", createdAt: "2026-09-20T00:00:00.000Z" }], { updateError: new Error("throttled") });
  await assert.rejects(broken.state.expireNotification("k", "过期"), /throttled/);
  assert.equal(broken.items.has("NOTIFICATION_PENDING|k"), true);
});

test("待发通知与通用分区查询单次不超过 limit，健康记录仅成功时写 lastSuccessAt", async () => {
  const pending = stateHarness([], { pages: [{ Items: [{ pk: "NOTIFICATION_PENDING", sk: "a", createdAt: "t" }] }] });
  assert.deepEqual(await pending.state.pendingNotifications(5), [{ pk: "NOTIFICATION_PENDING", sk: "a", createdAt: "t" }]);
  const pendingQuery = pending.sent[0]!.input as Record<string, unknown>;
  assert.equal(pendingQuery.KeyConditionExpression, "pk = :pk");
  assert.deepEqual(pendingQuery.ExpressionAttributeValues, { ":pk": "NOTIFICATION_PENDING" });
  assert.equal(pendingQuery.Limit, 5);
  assert.equal(pendingQuery.ScanIndexForward, true);

  const paged = stateHarness([], { pages: [
    { Items: [{ sk: "ads-daily|3" }, { sk: "ads-daily|2" }], LastEvaluatedKey: { pk: "TASK#ads-reports", sk: "ads-daily|2" } },
    { Items: [{ sk: "ads-daily|1" }, { sk: "ads-daily|0" }], LastEvaluatedKey: { pk: "TASK#ads-reports", sk: "ads-daily|0" } },
  ] });
  const newest = await paged.state.queryPartition("TASK#ads-reports", { beginsWith: "ads-daily|", newestFirst: true, limit: 3 });
  assert.deepEqual(newest.map((item) => item.sk), ["ads-daily|3", "ads-daily|2", "ads-daily|1"]);
  assert.equal(paged.sent.length, 2);
  const [firstQuery, secondQuery] = paged.sent.map((item) => item.input) as Array<Record<string, unknown>>;
  assert.equal(firstQuery!.KeyConditionExpression, "pk = :pk AND begins_with(sk, :prefix)");
  assert.deepEqual(firstQuery!.ExpressionAttributeValues, { ":pk": "TASK#ads-reports", ":prefix": "ads-daily|" });
  assert.equal(firstQuery!.ScanIndexForward, false);
  assert.equal(firstQuery!.Limit, 3);
  assert.equal(secondQuery!.Limit, 1);
  assert.deepEqual(secondQuery!.ExclusiveStartKey, { pk: "TASK#ads-reports", sk: "ads-daily|2" });

  const health = stateHarness();
  await health.state.recordHealth("finance", "done", { processed: 3 });
  await health.state.recordHealth("finance", "failed", { error: "HTTP 429" });
  const [success, failure] = health.sent.map((item) => item.input) as Array<{ Key: Record<string, unknown>; UpdateExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> }>;
  assert.deepEqual(success!.Key, { pk: "HEALTH", sk: "finance" });
  assert.match(success!.UpdateExpression, /#lastSuccessAt = :now/);
  assert.equal(success!.ExpressionAttributeNames["#lastSuccessAt"], "lastSuccessAt");
  assert.deepEqual(success!.ExpressionAttributeValues[":summary"], { processed: 3 });
  assert.equal(success!.ExpressionAttributeValues[":status"], "done");
  assert.doesNotMatch(failure!.UpdateExpression, /lastSuccessAt/);
  assert.equal(failure!.ExpressionAttributeNames["#lastSuccessAt"], undefined);
  assert.equal(failure!.ExpressionAttributeValues[":status"], "failed");

  const listed = stateHarness([], { pages: [{ Items: [{ pk: "HEALTH", sk: "finance" }] }] });
  assert.deepEqual(await listed.state.listHealth(), [{ pk: "HEALTH", sk: "finance" }]);
  assert.deepEqual((listed.sent[0]!.input as Record<string, unknown>).ExpressionAttributeValues, { ":pk": "HEALTH" });
});
