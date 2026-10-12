import assert from "node:assert/strict";
import test from "node:test";
import {
  beijingWallTime, etaOf, forwarderForCarrier, jiufangAdapter, labelMilestone, meisheAdapter, niukuAdapter, trackFacts,
  type ForwarderAdapter, type ForwarderEvent, type ForwarderId, type ForwarderTrack, type Milestone,
} from "../../src/clients/forwarders.js";
import { FORWARDER_FIELD_NAMES, runForwarderBackfill, runForwarderTracking, traceText } from "../../src/business/forwarder-tracking.js";
import { runShipments } from "../../src/business/shipments.js";
import { HEALTH_RULES } from "../../src/business/maintenance.js";
import type { AppConfig, FeishuRecord, JsonObject } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const HOUR = 3_600_000;
const bj = (value: string): number => beijingWallTime(value)!;
const NOW = bj("2026-10-06 12:50");

// ---------- 三家适配器（合成数据，结构照抄真实返回） ----------

function fakeHttp(route: (url: string, init?: RequestInit) => unknown) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const http = async (url: string, init?: RequestInit): Promise<unknown> => {
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return route(url, init);
  };
  return { http, calls };
}

test("纽酷：摘要按货件编号批量查出纽酷单号，只对查到的取轨迹；动态最新在上、时间按北京时间显示；转船通知记为异常；查无单独标记", async () => {
  const { http, calls } = fakeHttp((url) => {
    if (url.includes("getLogisticsByClientNosNew")) return { code: "ok", data: [
      { orderNo: "NK000000001", clientNo: "FBA19TEST001", fbaNo: "FBA19TEST001", shipNo: "TEST VESSEL 001E", statusTxt: "预计抵港" },
      { orderNo: "", clientNo: "FBA19TESTNONE", fbaNo: "", tab: "3" },
    ] };
    if (url.includes("publicLogisticsNode")) return { code: "ok", data: { orderNo: "NK000000001", channelName: "测试专线", ctn: 3, kg: 36.2, cbm: 0.31, orderLogisticsResponses: [
      { id: 5, status: "114", statusName: "预计抵港", content: "【CN】船期更新，预计2026-10-31到目的港，请耐心等待！", logsTime: bj("2026-10-05 20:52") / 1000, isErrorLogistics: 0 },
      { id: 4, status: "109", statusName: "已开船", content: "【CN】您的订单已开船，船司预计2026-10-26到港", logsTime: bj("2026-10-05 20:41") / 1000, isErrorLogistics: 0 },
      { id: 3, status: "1009", statusName: "转船/晚开通知", content: "由于船东甩柜问题导致转船\n原船名航次：OLD/001E;  ETA：10-26,\n新船名航次：TEST VESSEL", logsTime: bj("2026-09-28 00:00") / 1000, isErrorLogistics: 0 },
      { id: 2, status: "104", statusName: "货物入仓", content: "【CN】您的订单已在【测试仓】入仓成功，准备预配柜", logsTime: bj("2026-09-20 14:12") / 1000, isErrorLogistics: 0 },
      { id: 1, status: "101", statusName: "新订单", content: "【CN】您的订单已提交", logsTime: bj("2026-09-20 09:26") / 1000, isErrorLogistics: 0 },
    ] } };
    throw new Error(`unexpected ${url}`);
  });
  const result = await niukuAdapter({ http, sleep: async () => {} }).track(["FBA19TEST001", "FBA19TESTNONE"]);
  assert.deepEqual(calls[0]!.body, { clientNos: ["FBA19TEST001", "FBA19TESTNONE"], queryTab: 0 });
  assert.equal(calls.filter((call) => call.url.includes("publicLogisticsNode")).length, 1, "只对查到的单取轨迹");
  assert.match(calls[1]!.url, /orderNoOrPlanName=NK000000001$/);
  const track = result.get("FBA19TEST001")!;
  assert.equal(track.found, true);
  assert.equal(track.waybillNo, "NK000000001");
  assert.deepEqual(track.details, ["测试专线", "3箱 36.2kg 0.31cbm", "船 TEST VESSEL 001E"]);
  assert.deepEqual(track.events.map((event) => event.time), ["2026-10-05 20:52", "2026-10-05 20:41", "2026-09-28 00:00", "2026-09-20 14:12", "2026-09-20 09:26"]);
  assert.equal(track.events[2]!.exception, true);
  assert.equal(track.events[2]!.text, "由于船东甩柜问题导致转船 原船名航次：OLD/001E; ETA：10-26, 新船名航次：TEST VESSEL");
  assert.equal(track.events.filter((event) => event.exception).length, 1);
  const facts = trackFacts(track);
  assert.equal(facts.milestone, "已开船");
  assert.equal(facts.eta, "2026-10-31", "取最新一条动态里的预计到港");
  assert.equal(facts.latest?.key, "n5");
  assert.equal(result.get("FBA19TESTNONE")!.found, false);
  await assert.rejects(() => niukuAdapter({ http: async () => ({ code: "error", data: [] }), sleep: async () => {} }).track(["FBA19TEST001"]), /纽酷摘要返回异常/);
});

test("九方：一次传货件编号数组；只列已到达的节点、最新在上；离港记为已开船；查无在 data2", async () => {
  const { http, calls } = fakeHttp(() => ({ code: 200, data: [{
    referenceNo: "FBA19TEST002", shipmentId: "FBA19TEST002", waybillNo: "LCL0000001A", shippingWay: "海运", packageNum: 6, weight: 63.1, volume: 0.57, trackNumber: "1ZTEST",
    lines: [
      { status: 2, content: "已提货", operationDateTime: null, remark: null, state: true },
      { status: 30, content: "已入库", operationDateTime: "2026-06-16 10:42", remark: null, state: true },
      { status: 80, content: "已离港", operationDateTime: "2026-06-22", remark: "船公司甩柜，改配下一班", state: true },
      { status: 90, content: "已到港", operationDateTime: null, remark: null, state: false },
      { status: 140, content: "已签收", operationDateTime: null, remark: null, state: false },
    ],
  }], data2: ["FBA19TESTNONE"] }));
  const result = await jiufangAdapter({ http }).track(["FBA19TEST002", "FBA19TESTNONE"]);
  assert.deepEqual(calls[0]!.body, ["FBA19TEST002", "FBA19TESTNONE"]);
  const track = result.get("FBA19TEST002")!;
  assert.equal(track.waybillNo, "LCL0000001A");
  assert.deepEqual(track.details, ["海运", "6箱 63.1kg 0.57cbm", "尾程 1ZTEST"]);
  assert.deepEqual(track.events.map((event) => `${event.time}|${event.text}`), ["2026-06-22|已离港（船公司甩柜，改配下一班）", "2026-06-16 10:42|已入库", "|已提货"]);
  assert.equal(track.events[0]!.at, Date.parse("2026-06-22T00:00:00+08:00"));
  assert.equal(track.events[0]!.exception, true, "备注里的甩柜记为异常");
  assert.equal(trackFacts(track).milestone, "已开船");
  assert.equal(result.get("FBA19TESTNONE")!.found, false);
});

test("美设：换行分隔批量查、地址可覆盖；只留中文行；查验节点记为异常；预约与签收时间；查无 notFound", async () => {
  const { http, calls } = fakeHttp(() => [
    { trackingNum: "FBA19TEST003", jobNum: "MSEC-000000001", pkgNum: 8, shipmentType: "FBASEA", notFound: null, state: "3", trackings: [
      { id: 1, time: "2026-01-12 15:20", context: "起运地仓库已收货。\nOrigin warehouse received the cargo.", node: "wmsIn", eventTime: "2026-01-12T15:20:11+08:00" },
      { id: 2, time: "2026-01-19 10:05", context: "海关查验未放行，改配下一船期", node: "customsInspectionExp", eventTime: "2026-01-19T10:05:42+08:00" },
      { id: 3, time: "2026-01-27 09:48", context: "您的货物已离港，TEST/001E实际开航时间2026-01-26，预计到港日期2026-02-24。\nVessel departed", node: "atd", eventTime: "2026-01-27T09:48:05+08:00" },
      { id: 4, time: "2026-03-02 14:10", context: "货物已提前预约，预约送货时间为2026-03-04，如遇到港延后会更新。\nAppointment", node: "deliveryAppointed", eventTime: "2026-03-02T14:10:37+08:00" },
      { id: 5, time: "2026-03-04 11:26", context: "货物已派送完成，POD/ISA 已上传系统。\nShipment is delivered", node: "Deliveried", eventTime: "2026-03-04T11:26:09+08:00" },
    ] },
    { trackingNum: "FBA19TESTNONE", notFound: true, state: "0", trackings: [] },
  ]);
  const result = await meisheAdapter({ http, meisheBaseUrl: "http://10.0.0.1:8080/" }).track(["FBA19TEST003", "FBA19TESTNONE"]);
  const url = new URL(calls[0]!.url);
  assert.equal(url.origin + url.pathname, "http://10.0.0.1:8080/edi/pubTracking");
  assert.equal(url.searchParams.get("soNum"), "FBA19TEST003\nFBA19TESTNONE");
  assert.equal(url.searchParams.get("url"), "/pub-tracking/yuyue");
  assert.equal(url.searchParams.get("host"), "10.0.0.1:8080");
  const track = result.get("FBA19TEST003")!;
  assert.equal(track.waybillNo, "MSEC-000000001");
  assert.deepEqual(track.events.map((event) => event.key), ["m5", "m4", "m3", "m2", "m1"]);
  assert.equal(track.events[0]!.text, "货物已派送完成，POD/ISA 已上传系统。");
  assert.equal(track.events[1]!.appointment, "03-04");
  assert.equal(track.events.find((event) => event.code === "customsInspectionExp")!.exception, true);
  const facts = trackFacts(track);
  assert.equal(facts.milestone, "已签收");
  assert.equal(facts.eta, "2026-02-24");
  assert.equal(facts.signed?.at, Date.parse("2026-03-04T11:26:09+08:00"));
  assert.equal(result.get("FBA19TESTNONE")!.found, false);
  await assert.rejects(() => meisheAdapter({ http: async () => ({ error: "x" }) }).track(["FBA19TEST003"]), /美设返回不是列表/);
});

test("预计到港、节点兜底与承运商识别", () => {
  assert.equal(etaOf("【CN】您的订单已开船，船司预计2026-10-19到港"), "2026-10-19");
  assert.equal(etaOf("预计到港日期2026-3-1。"), "2026-03-01");
  assert.equal(etaOf("【US】您的订单已卸船，预计10-09-10-12可提"), undefined);
  assert.equal(etaOf("您的订单已装柜，预计2026-09-25开船"), undefined);
  assert.equal(labelMilestone("预计抵港"), undefined);
  assert.equal(labelMilestone("已卸柜入仓"), "已到海外仓");
  assert.equal(labelMilestone("部分签收"), "派送中");
  assert.equal(labelMilestone("已派送 - 快递"), "派送中");
  assert.equal(forwarderForCarrier("SEND-纽酷国际"), "niuku");
  assert.equal(forwarderForCarrier("SEND-九方通逊"), "jiufang");
  assert.equal(forwarderForCarrier("SEND-美设国际"), "meishe");
  assert.equal(forwarderForCarrier("SEND-其他物流"), undefined);
  assert.equal(forwarderForCarrier("AWD货件分销"), undefined);
});

// ---------- 任务 ----------

const ALL_FIELDS = ["货件唯一键", "货件编号", "承运商", "当前状态", "目的仓", "货件创建时间", "亚马逊更新时间", ...FORWARDER_FIELD_NAMES];

function makeConfig(values: Record<string, string> = {}): AppConfig {
  const all: Record<string, string> = { FEISHU_NOTIFY_USER_IDS: "u1", FEISHU_BITABLE_APP_TOKEN_ORDERS: "app", FEISHU_BITABLE_TABLE_ID_SHIPMENTS: "ships", ...values };
  return {
    get: (key: string) => { const value = all[key]; if (!value) throw new Error(`缺少 ${key}`); return value; },
    optional: (key: string, fallback = "") => all[key] ?? fallback,
    bool: (key: string, fallback = false) => all[key] === undefined ? fallback : all[key] === "true",
    json: () => { throw new Error("unused"); },
    asins: () => [],
    version: "test",
  };
}

const record = (id: string, carrier: string, status: string, created: string, extra: Row = {}): FeishuRecord => ({
  record_id: `rec-${id}`, fields: { "货件唯一键": `FBA:${id}`, "货件编号": id, ...(carrier ? { "承运商": carrier } : {}), "当前状态": status, "目的仓": "XYZ1", "货件创建时间": bj(created), ...extra },
});

function sheet(records: FeishuRecord[], fields = ALL_FIELDS) {
  const updates: Array<Array<{ recordId: string; fields: Row }>> = [];
  const sent: string[][] = [];
  let failNextUpdate = false;
  const feishu = {
    listFields: async () => fields.map((name) => ({ field_name: name })),
    listRecords: async () => structuredClone(records),
    batchUpdate: async (_app: string, _table: string, rows: Array<{ recordId: string; fields: Row }>) => {
      if (failNextUpdate) { failNextUpdate = false; throw new Error("飞书写入超时"); }
      updates.push(structuredClone(rows));
      for (const row of rows) Object.assign(records.find((item) => item.record_id === row.recordId)!.fields, row.fields);
    },
    sendText: async (_user: string, lines: string[]) => { sent.push(lines); },
  } as unknown as FeishuClient;
  return { feishu, updates, sent, records, failUpdateOnce: () => { failNextUpdate = true; } };
}

const event = (key: string, time: string, text: string, milestone?: Milestone, extra: Partial<ForwarderEvent> = {}): ForwarderEvent => ({ key, time, at: bj(time), code: "", label: "", text, ...(milestone ? { milestone } : {}), exception: false, ...extra });
const tracked = (forwarder: ForwarderId, query: string, waybillNo: string, events: ForwarderEvent[], extra: Partial<ForwarderTrack> = {}): ForwarderTrack => ({ forwarder, query, found: true, waybillNo, details: ["测试专线"], vessel: "", events, ...extra });

function world(data: Partial<Record<ForwarderId, Record<string, ForwarderTrack>>>) {
  const calls: string[][] = [];
  const down = new Set<ForwarderId>();
  const adapter = (id: ForwarderId): ForwarderAdapter => ({
    id,
    track: async (ids) => {
      calls.push([id, ...ids]);
      if (down.has(id)) throw new Error(`${id} 接口 503`);
      return new Map(ids.map((query) => [query, data[id]?.[query] ?? { forwarder: id, query, found: false, waybillNo: "", details: [], vessel: "", events: [] }]));
    },
  });
  return { adapters: { niuku: adapter("niuku"), jiufang: adapter("jiufang"), meishe: adapter("meishe") }, calls, down, data };
}

const queriedIds = (calls: string[][]): string[] => calls.flatMap((call) => call.slice(1));
const writtenNames = (updates: Array<Array<{ fields: Row }>>): string[] => [...new Set(updates.flatMap((batch) => batch.flatMap((row) => Object.keys(row.fields))))];

test("每小时：按承运商选物流商（空的三家都查、其他承运商不查）；只写 7 列；首次跟踪只提醒 48 小时内的节点；没变化不写、同步时间每 6 小时才刷新", async () => {
  const records = [
    record("FBA19A", "SEND-纽酷国际", "运输中", "2026-09-19 11:40"),
    record("FBA19B", "SEND-九方通逊", "运输中", "2026-09-01 10:00"),
    record("FBA19C", "SEND-其他物流", "运输中", "2026-09-01 10:00"),
    record("FBA19D", "AWD货件分销", "接收中", "2026-09-14 08:30"),
    record("FBA19E", "", "运输中", "2026-10-01 09:00"),
    record("FBA19F", "SEND-纽酷国际", "已完成", "2026-05-12 10:00"),
    record("FBA19G", "SEND-纽酷国际", "运输中", "2026-10-05 09:00"),
    record("FBA19H", "", "已取消", "2026-09-03 12:00"),
  ];
  const w = world({
    niuku: { FBA19A: tracked("niuku", "FBA19A", "NK000000001", [
      event("n2", "2026-10-05 20:41", "【CN】您的订单已开船，船司预计2026-10-26到港", "已开船"),
      event("n1", "2026-09-20 14:12", "【CN】您的订单已入仓", "已入仓"),
    ], { vessel: "TEST VESSEL 001E" }) },
    jiufang: { FBA19B: tracked("jiufang", "FBA19B", "LCL0000001A", [event("j80", "2026-09-10", "已离港", "已开船"), event("j30", "2026-09-03 16:25", "已入库", "已入仓")]) },
    meishe: { FBA19E: tracked("meishe", "FBA19E", "MSEC-000000001", [event("m1", "2026-10-02 15:06", "起运地仓库已收货", "已入仓")]) },
  });
  const s = sheet(records);
  const state = new MemoryState();
  const config = makeConfig();
  const result = await runForwarderTracking({ taskType: "forwarder-tracking" }, config, state.asStore(), {} as AmazonClient, s.feishu, { adapters: w.adapters, now: () => NOW });
  assert.equal(result.status, "done");
  assert.deepEqual(new Set(queriedIds(w.calls)), new Set(["FBA19A", "FBA19B", "FBA19E", "FBA19G"]), "其他物流商、AWD分销、已完成未跟踪、已取消都不查");
  assert.deepEqual(w.calls.find((call) => call[0] === "niuku"), ["niuku", "FBA19A", "FBA19E", "FBA19G"]);
  assert.ok(w.calls.some((call) => call[0] === "jiufang" && call.includes("FBA19G")), "指定的物流商查无时另两家也查");
  assert.equal(s.updates.length, 1, "一轮的变化一次批量写");
  assert.deepEqual(s.updates[0]!.map((row) => row.recordId).sort(), ["rec-FBA19A", "rec-FBA19B", "rec-FBA19E", "rec-FBA19G"]);
  assert.ok(writtenNames(s.updates).every((name) => FORWARDER_FIELD_NAMES.includes(name)), "只写 7 个物流列");
  const a = s.updates[0]!.find((row) => row.recordId === "rec-FBA19A")!.fields;
  assert.equal(a["物流节点"], "已开船");
  assert.equal(a["物流最新动态"], "2026-10-05 20:41 您的订单已开船，船司预计2026-10-26到港");
  assert.equal(a["物流预计到港"], bj("2026-10-26"));
  assert.equal(a["物流商单号"], "NK000000001");
  assert.equal(a["物流轨迹"], "纽酷国际｜NK000000001｜测试专线\n2026-10-05 20:41 【CN】您的订单已开船，船司预计2026-10-26到港\n2026-09-20 14:12 【CN】您的订单已入仓");
  assert.equal(a["物流同步时间"], NOW);
  assert.equal(Object.hasOwn(a, "物流签收时间"), false, "没签收不写空");
  assert.deepEqual(s.updates[0]!.find((row) => row.recordId === "rec-FBA19G")!.fields, { "物流最新动态": "纽酷国际暂未查到此单，可能尚未录入" });
  assert.equal(records.find((item) => item.record_id === "rec-FBA19A")!.fields["当前状态"], "运输中", "亚马逊的当前状态不动");
  assert.equal(state.item("FORWARDER_TRACK", "FBA:FBA19E")?.forwarder, "meishe");
  assert.equal(state.item("FORWARDER_TRACK", "FBA:FBA19E")?.detected, true);
  assert.deepEqual(s.sent, [["🚢 物流动态（1 个货件）", "FBA19A → XYZ1（纽酷）", "  已开船 10-05 20:41：TEST VESSEL 001E，预计 10-26 到港"]], "九方 9/10 的开船超过 48 小时，首次跟踪只记不提醒");
  assert.ok((state.item("FORWARDER_TRACK", "FBA:FBA19B")?.notified as string[]).includes("m:已开船"));

  await runForwarderTracking({ taskType: "forwarder-tracking" }, config, state.asStore(), {} as AmazonClient, s.feishu, { adapters: w.adapters, now: () => NOW + HOUR });
  assert.equal(s.updates.length, 1, "没变化不写");
  assert.equal(s.sent.length, 1, "不重复提醒");
  await runForwarderTracking({ taskType: "forwarder-tracking" }, config, state.asStore(), {} as AmazonClient, s.feishu, { adapters: w.adapters, now: () => NOW + 7 * HOUR });
  assert.equal(s.updates.length, 2);
  assert.deepEqual(s.updates[1]!.map((row) => [row.recordId, Object.keys(row.fields).join(",")]).sort(), [["rec-FBA19A", "物流同步时间"], ["rec-FBA19B", "物流同步时间"], ["rec-FBA19E", "物流同步时间"]], "6 小时后只刷新同步时间，查无的不刷新");
});

test("新节点、预计到港推迟 ≥2 天与异常合并成一条；写表中断后重跑同一条只发一次；推迟不足 2 天不提醒", async () => {
  const records = [record("FBA19A", "SEND-纽酷国际", "运输中", "2026-09-19 11:40"), record("FBA19B", "SEND-九方通逊", "运输中", "2026-09-01 10:00")];
  const departed = event("n2", "2026-09-29 03:34", "【CN】您的订单已开船，船司预计2026-10-26到港", "已开船");
  const w = world({
    niuku: { FBA19A: tracked("niuku", "FBA19A", "NK000000001", [departed]) },
    jiufang: { FBA19B: tracked("jiufang", "FBA19B", "LCL0000001A", [event("j80", "2026-09-10", "已离港", "已开船")]) },
  });
  const s = sheet(records);
  const state = new MemoryState();
  const config = makeConfig();
  const run = (now: number) => runForwarderTracking({ taskType: "forwarder-tracking" }, config, state.asStore(), {} as AmazonClient, s.feishu, { adapters: w.adapters, now: () => now });
  await run(NOW);
  assert.equal(s.sent.length, 0, "首次跟踪的旧节点不提醒");
  w.data.niuku!.FBA19A = tracked("niuku", "FBA19A", "NK000000001", [
    event("n5", "2026-10-06 11:15", "【CN】船期更新，预计2026-10-31到目的港，请耐心等待！"),
    event("n4", "2026-10-06 10:00", "由于船东甩柜问题导致转船，新船名航次：TEST", undefined, { exception: true }),
    departed,
  ]);
  w.data.jiufang!.FBA19B = tracked("jiufang", "FBA19B", "LCL0000001A", [event("j90", "2026-10-06 08:00", "已到港", "已到港"), event("j80", "2026-09-10", "已离港", "已开船")]);
  s.failUpdateOnce();
  await assert.rejects(() => run(NOW + HOUR), /飞书写入超时/);
  assert.equal(s.sent.length, 0, "写表失败时不发送（意图已持久化）");
  await run(NOW + 2 * HOUR);
  assert.deepEqual(s.sent, [[
    "🚢 物流动态（2 个货件）",
    "FBA19A → XYZ1（纽酷）", "  预计到港推迟：10-26 → 10-31（+5 天）",
    "FBA19B → XYZ1（九方）", "  已到港 10-06 08:00",
    "⚠️ 异常", "FBA19A：由于船东甩柜问题导致转船，新船名航次：TEST",
  ]]);
  assert.equal(state.partition("NOTIFICATION").length, 1, "中断重跑沿用同一个通知键");
  assert.equal(state.partition("NOTIFICATION")[0]!.status, "done");
  await run(NOW + 3 * HOUR);
  assert.equal(s.sent.length, 1, "已提醒的不再提醒");
  w.data.niuku!.FBA19A = tracked("niuku", "FBA19A", "NK000000001", [event("n6", "2026-10-06 16:00", "【CN】船期更新，预计2026-11-01到目的港"), departed]);
  await run(NOW + 4 * HOUR);
  assert.equal(s.sent.length, 1, "比上次提醒的日期只推迟 1 天，不提醒");
  assert.equal(records[0]!.fields["物流预计到港"], bj("2026-11-01"), "表里照常更新预计到港");
});

test("某家接口失败只影响该家：不写、不改状态、健康不记；查到过的货件之后查无时保留旧值", async () => {
  const records = [record("FBA19A", "SEND-纽酷国际", "运输中", "2026-09-19 11:40"), record("FBA19B", "SEND-九方通逊", "运输中", "2026-09-01 10:00")];
  const w = world({
    niuku: { FBA19A: tracked("niuku", "FBA19A", "NK000000001", [event("n1", "2026-09-20 14:12", "【CN】您的订单已入仓", "已入仓")]) },
    jiufang: { FBA19B: tracked("jiufang", "FBA19B", "LCL0000001A", [event("j30", "2026-09-03 16:25", "已入库", "已入仓")]) },
  });
  const s = sheet(records);
  const state = new MemoryState();
  const run = (now: number) => runForwarderTracking({ taskType: "forwarder-tracking" }, makeConfig(), state.asStore(), {} as AmazonClient, s.feishu, { adapters: w.adapters, now: () => now });
  w.down.add("niuku");
  const failed = await run(NOW);
  assert.equal(failed.failed, "niuku");
  assert.match(String(failed.errors), /niuku: niuku 接口 503/);
  assert.deepEqual(s.updates[0]!.map((row) => row.recordId), ["rec-FBA19B"]);
  assert.equal(state.item("FORWARDER_TRACK", "FBA:FBA19A"), undefined);
  assert.equal(state.item("HEALTH", "forwarder-niuku"), undefined);
  assert.equal(state.item("HEALTH", "forwarder-jiufang")?.lastStatus, "done");
  assert.equal(state.item("HEALTH", "forwarder-meishe")?.lastStatus, "done", "没货件要查也记成功");
  assert.ok(!w.calls.some((call) => call[0] !== "niuku" && call.includes("FBA19A")), "指定物流商出错时不去别家查");
  w.down.delete("niuku");
  await run(NOW + HOUR);
  assert.equal(records[0]!.fields["物流商单号"], "NK000000001");
  delete w.data.niuku!.FBA19A;
  const before = structuredClone(records[0]!.fields);
  await run(NOW + 8 * HOUR);
  assert.deepEqual(records[0]!.fields, before, "查无时不清空、不刷新同步时间");
  assert.equal(state.item("FORWARDER_TRACK", "FBA:FBA19A")?.waybillNo, "NK000000001");
});

test("回填：默认只读预览（不写表、不写状态、不发消息）；apply 才写且全程静默；已完成且已签收的随即停止，之后每小时不再查", async () => {
  const records = [record("FBA19F", "SEND-纽酷国际", "已完成", "2026-05-12 10:00"), record("FBA19A", "SEND-纽酷国际", "运输中", "2026-10-05 09:00")];
  const w = world({ niuku: {
    FBA19F: tracked("niuku", "FBA19F", "NK000000009", [event("n9", "2026-07-14 15:05", "【US】已签收", "已签收"), event("n8", "2026-06-16 09:30", "【CN】您的订单已开船", "已开船")]),
    FBA19A: tracked("niuku", "FBA19A", "NK000000001", [event("n2", "2026-10-06 09:00", "【CN】您的订单已开船，船司预计2026-10-31到港", "已开船")]),
  } });
  const s = sheet(records);
  const state = new MemoryState();
  const preview = await runForwarderBackfill({ taskType: "forwarder-backfill" }, makeConfig(), state.asStore(), {} as AmazonClient, s.feishu, { adapters: w.adapters, now: () => NOW });
  assert.equal(preview.mode, "backfill-preview");
  assert.equal(preview.updated, 2);
  assert.equal((preview.preview as JsonObject[]).length, 2);
  assert.equal(s.updates.length, 0);
  assert.equal(state.writes.length, 0, "预览不写任何状态（含租约）");
  assert.equal(s.sent.length, 0);
  const applied = await runForwarderBackfill({ taskType: "forwarder-backfill", cursor: { apply: true } }, makeConfig(), state.asStore(), {} as AmazonClient, s.feishu, { adapters: w.adapters, now: () => NOW });
  assert.equal(applied.mode, "backfill");
  assert.equal(s.updates[0]!.length, 2);
  assert.equal(records[0]!.fields["物流签收时间"], bj("2026-07-14 15:05"));
  assert.equal(s.sent.length, 0, "回填不发消息（含 48 小时内的开船）");
  assert.equal(state.item("FORWARDER_TRACK", "FBA:FBA19F")?.stopReason, "亚马逊已完成");
  assert.equal(state.item("FORWARDER_TRACK", "FBA:FBA19A")?.stoppedAt, undefined);
  w.calls.length = 0;
  await runForwarderTracking({ taskType: "forwarder-tracking" }, makeConfig(), state.asStore(), {} as AmazonClient, s.feishu, { adapters: w.adapters, now: () => NOW + HOUR });
  assert.deepEqual(queriedIds(w.calls), ["FBA19A"], "已停止的不再查");
  assert.equal(s.sent.length, 0, "回填记为已知的节点之后也不提醒");
});

test("停止条件与开关：签收满 3 天停；亚马逊已取消立即停；停用时空跑记健康、不调接口；缺列时写入报错、预览照常", async () => {
  const records = [record("FBA19A", "SEND-纽酷国际", "接收中", "2026-09-01 10:00"), record("FBA19B", "SEND-纽酷国际", "运输中", "2026-09-01 10:00")];
  const w = world({ niuku: {
    FBA19A: tracked("niuku", "FBA19A", "NK000000001", [event("n9", "2026-10-02 15:48", "【US】已签收", "已签收")]),
    FBA19B: tracked("niuku", "FBA19B", "NK000000002", [event("n1", "2026-09-20 14:12", "【CN】您的订单已入仓", "已入仓")]),
  } });
  const s = sheet(records);
  const state = new MemoryState();
  const run = (now: number, config = makeConfig()) => runForwarderTracking({ taskType: "forwarder-tracking" }, config, state.asStore(), {} as AmazonClient, s.feishu, { adapters: w.adapters, now: () => now });
  await run(NOW);
  assert.equal(state.item("FORWARDER_TRACK", "FBA:FBA19A")?.stoppedAt, undefined, "签收后先继续查 3 天");
  records[1]!.fields["当前状态"] = "已取消";
  await run(NOW + 3 * 24 * HOUR + HOUR);
  assert.equal(state.item("FORWARDER_TRACK", "FBA:FBA19A")?.stopReason, "物流商已签收满 3 天");
  assert.equal(state.item("FORWARDER_TRACK", "FBA:FBA19B")?.stopReason, "亚马逊已取消");
  assert.ok(!w.calls.at(-1)!.includes("FBA19B"), "已取消的不再查");
  w.calls.length = 0;
  await run(NOW + 4 * 24 * HOUR);
  assert.equal(w.calls.length, 0);

  const disabled = await run(NOW + 5 * 24 * HOUR, makeConfig({ FORWARDER_TRACKING_ENABLED: "false" }));
  assert.equal(disabled.retired, true);
  assert.equal(w.calls.length, 0);
  assert.equal(state.item("HEALTH", "forwarder-niuku")?.summary && (state.item("HEALTH", "forwarder-niuku")!.summary as Row).disabled, true);

  const bare = sheet([record("FBA19X", "SEND-纽酷国际", "运输中", "2026-10-01 10:00")], ALL_FIELDS.filter((name) => name !== "物流轨迹"));
  await assert.rejects(() => runForwarderTracking({ taskType: "forwarder-tracking" }, makeConfig(), new MemoryState().asStore(), {} as AmazonClient, bare.feishu, { adapters: w.adapters, now: () => NOW }), /货件表缺少字段：物流轨迹/);
  const dry = await runForwarderTracking({ taskType: "forwarder-tracking", dryRun: true }, makeConfig(), new MemoryState().asStore(), {} as AmazonClient, bare.feishu, { adapters: w.adapters, now: () => NOW });
  assert.equal(dry.missingFields, "物流轨迹");
  assert.equal(bare.updates.length, 0);
});

test("物流轨迹过长时略去最早的动态", () => {
  const events = Array.from({ length: 400 }, (_, index) => event(`n${index}`, "2026-09-01 10:00", `第 ${index} 条：${"很长的内容".repeat(4)}`));
  const value = traceText(tracked("niuku", "FBA19A", "NK000000001", events));
  assert.ok(value.length <= 8_000);
  assert.match(value, /……更早 \d+ 条略$/);
  assert.ok(value.includes("第 0 条"), "保留最新的");
});

test("亚马逊货件同步：物流商已跟踪的货件不发“已发货/运输中”，“已送达”照发；未跟踪的照发；物流商轨迹停用时恢复照发", async () => {
  const table: Record<string, FeishuRecord> = {
    "FBA:FBA1": { record_id: "s1", fields: { "货件唯一键": "FBA:FBA1", "当前状态": "处理中", "承运商": "SEND-纽酷国际" } },
    "FBA:FBA2": { record_id: "s2", fields: { "货件唯一键": "FBA:FBA2", "当前状态": "处理中" } },
    "FBA:FBA3": { record_id: "s3", fields: { "货件唯一键": "FBA:FBA3", "当前状态": "运输中", "承运商": "SEND-九方通逊" } },
    "FBA:FBA4": { record_id: "s4", fields: { "货件唯一键": "FBA:FBA4", "当前状态": "处理中", "物流商单号": "MSEC-1" } },
  };
  const sent: string[][] = [];
  const feishu = {
    searchRecords: async (_app: string, tableId: string, key: Record<string, string>) => tableId === "FEISHU_BITABLE_TABLE_ID_SKUS" ? [{ record_id: "sku", fields: {} }] : table[key["货件唯一键"] ?? ""] ? [structuredClone(table[key["货件唯一键"]!]!)] : [],
    upsert: async (_app: string, tableId: string, _key: unknown, fields: Row) => { if (tableId === "FEISHU_BITABLE_TABLE_ID_SHIPMENTS") Object.assign(table[String(fields["货件唯一键"])]!.fields, fields); return "rec"; },
    sendText: async (_user: string, lines: string[]) => { sent.push(lines); },
  } as unknown as FeishuClient;
  const amazon = { sp: async (path: string) => {
    if (path === "/fba/inbound/v0/shipments") return { payload: { ShipmentData: [
      { ShipmentId: "FBA1", ShipmentName: "a", ShipmentStatus: "SHIPPED" }, { ShipmentId: "FBA2", ShipmentName: "b", ShipmentStatus: "SHIPPED" },
      { ShipmentId: "FBA3", ShipmentName: "c", ShipmentStatus: "DELIVERED" }, { ShipmentId: "FBA4", ShipmentName: "d", ShipmentStatus: "IN_TRANSIT" },
    ] } };
    if (path.endsWith("/items")) return { payload: { ItemData: [] } };
    return { shipments: [] };
  } } as unknown as AmazonClient;
  const configOf = (enabled: string): AppConfig => ({ get: (key: string) => key, optional: (key: string, fallback = "") => key === "FEISHU_NOTIFY_USER_IDS" ? "u1" : fallback, bool: (key: string, fallback = false) => key === "FORWARDER_TRACKING_ENABLED" ? enabled === "true" : fallback, asins: () => [] }) as unknown as AppConfig;
  await runShipments({ taskType: "shipment" }, configOf("true"), new MemoryState().asStore(), amazon, feishu);
  assert.deepEqual(sent, [["📦货件状态更新", "货件：FBA2（FBA）", "处理中 → 已发货"], ["📦货件状态更新", "货件：FBA3（FBA）", "运输中 → 已送达"]]);
  for (const key of ["FBA:FBA1", "FBA:FBA2", "FBA:FBA4"]) table[key]!.fields["当前状态"] = "处理中";
  sent.length = 0;
  await runShipments({ taskType: "shipment" }, configOf("false"), new MemoryState().asStore(), amazon, feishu);
  assert.deepEqual(sent.map((lines) => lines[1]), ["货件：FBA1（FBA）", "货件：FBA2（FBA）", "货件：FBA4（FBA）"], "停用后恢复照发");
});

test("健康规则：物流商轨迹 3 小时、单家物流商 6 小时", () => {
  assert.equal(HEALTH_RULES["forwarder-tracking"], 3 * HOUR);
  for (const id of ["niuku", "jiufang", "meishe"]) assert.equal(HEALTH_RULES[`forwarder-${id}`], 6 * HOUR);
});
