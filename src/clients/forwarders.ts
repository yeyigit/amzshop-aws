import { delay, fetchJson } from "../http.js";

// SEND 物流商公开轨迹接口（物流商网站查询页背后的接口，不登录、不签名）。每家一个适配器：按亚马逊货件编号批量查，
// 统一成“物流商单号＋明细＋动态（最新在上，内容与网站一致）”。返回格式不符一律抛错，由调用方按该家失败处理、不写表。
export type ForwarderId = "niuku" | "jiufang" | "meishe";
export const FORWARDER_IDS: readonly ForwarderId[] = ["niuku", "jiufang", "meishe"];
export const FORWARDER_NAMES: Record<ForwarderId, string> = { niuku: "纽酷国际", jiufang: "九方通逊", meishe: "美设国际" };
export const FORWARDER_SHORT: Record<ForwarderId, string> = { niuku: "纽酷", jiufang: "九方", meishe: "美设" };

// 货件表「物流节点」的取值，按头程先后排序；节点取已到达中最靠后的一个。
export const MILESTONES = ["已下单", "已入仓", "已装柜", "已开船", "已到港", "已提柜", "已到海外仓", "已预约", "派送中", "已签收"] as const;
export type Milestone = typeof MILESTONES[number];

export interface ForwarderEvent {
  key: string;
  time: string;
  at?: number;
  code: string;
  label: string;
  text: string;
  milestone?: Milestone;
  exception: boolean;
  appointment?: string;
}

export interface ForwarderTrack {
  forwarder: ForwarderId;
  query: string;
  found: boolean;
  waybillNo: string;
  details: string[];
  vessel: string;
  events: ForwarderEvent[];
}

export interface TrackFacts { milestone?: Milestone; eta?: string; signed?: ForwarderEvent; latest?: ForwarderEvent }

export type HttpJson = (url: string, init?: RequestInit) => Promise<unknown>;
export interface ForwarderOptions { http?: HttpJson; sleep?: (milliseconds: number) => Promise<void>; meisheBaseUrl?: string }
export interface ForwarderAdapter { id: ForwarderId; track(ids: string[]): Promise<Map<string, ForwarderTrack>> }

type Row = Record<string, unknown>;
const text = (value: unknown): string => String(value ?? "").trim();
const same = (left: unknown, right: unknown): boolean => !!text(left) && text(left).toUpperCase() === text(right).toUpperCase();
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => !!item && typeof item === "object") : [];
const chunks = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size));

// 异常动态：甩柜、转船、延误、查验、扣货等（纽酷另有 1009 转船/晚开通知与异常标记，美设另有查验节点）。
export const EXCEPTION_WORDS = /甩柜|转船|晚开|延误|延迟|推迟|查验|扣关|扣货|扣留|退关|拥堵|改港|滞港|爆舱|拒收|丢失|破损|短少|异常/;
const ETA_PATTERNS = [
  /预计\s*(\d{4}-\d{1,2}-\d{1,2})\s*日?\s*到达?(?:目的)?港/,
  /预计到达?(?:目的)?港(?:日期|时间)?\s*(?:为|是)?\s*[:：]?\s*(\d{4}-\d{1,2}-\d{1,2})/,
];

// 物流商网站按北京时间显示：把显示的墙上时间按 UTC+8 转成时间戳（飞书日期列同样按北京时间显示，与网站一致，不做时区换算）。
export function beijingWallTime(value: string): number | undefined {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(value.trim());
  if (!match) return undefined;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] ?? 0) - 8, Number(match[5] ?? 0), Number(match[6] ?? 0));
  return Number.isFinite(ms) ? ms : undefined;
}

export function beijingText(ms: number, withTime = true): string {
  const iso = new Date(ms + 8 * 3_600_000).toISOString();
  return withTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

const ymd = (value: string): string => value.split("-").map((part, index) => index ? part.padStart(2, "0") : part).join("-");

export function etaOf(value: string): string | undefined {
  for (const pattern of ETA_PATTERNS) {
    const match = pattern.exec(value);
    if (match?.[1]) return ymd(match[1]);
  }
  return undefined;
}

// 一条动态压成一行；美设的中英文双行只留含中文的行。
function oneLine(value: unknown, chineseOnly = false): string {
  const lines = text(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const kept = chineseOnly && lines.some((line) => /[一-鿿]/.test(line)) ? lines.filter((line) => /[一-鿿]/.test(line)) : lines;
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

// 未知状态码按状态名兜底归类（含“预计”的不归类；“卸柜入仓/海外仓”先于“入仓”判断）。
const LABEL_MILESTONES: Array<[RegExp, Milestone]> = [
  [/部分签收/, "派送中"], [/签收/, "已签收"], [/派送/, "派送中"], [/预约/, "已预约"], [/卸柜入仓|海外仓/, "已到海外仓"],
  [/提柜/, "已提柜"], [/到港|抵港|卸船/, "已到港"], [/开船|离港/, "已开船"], [/装柜/, "已装柜"], [/入仓|入库/, "已入仓"], [/新订单|下单|订舱/, "已下单"],
];

export function labelMilestone(label: string): Milestone | undefined {
  if (!label || /预计/.test(label)) return undefined;
  return LABEL_MILESTONES.find(([pattern]) => pattern.test(label))?.[1];
}

function milestoneOf(codes: Record<string, Milestone | null>, code: string, label: string): Milestone | undefined {
  if (Object.hasOwn(codes, code)) return codes[code] ?? undefined;
  return labelMilestone(label);
}

export function trackFacts(track: ForwarderTrack): TrackFacts {
  let rank = -1;
  let milestone: Milestone | undefined;
  for (const event of track.events) {
    const index = event.milestone ? MILESTONES.indexOf(event.milestone) : -1;
    if (index > rank) { rank = index; milestone = event.milestone; }
  }
  const eta = track.events.map((event) => etaOf(event.text)).find(Boolean);
  const signed = track.events.find((event) => event.milestone === "已签收");
  const latest = track.events[0];
  return { ...(milestone ? { milestone } : {}), ...(eta ? { eta } : {}), ...(signed ? { signed } : {}), ...(latest ? { latest } : {}) };
}

export function forwarderForCarrier(carrier: unknown): ForwarderId | undefined {
  const value = text(carrier);
  if (/纽酷/.test(value)) return "niuku";
  if (/九方/.test(value)) return "jiufang";
  if (/美设/.test(value)) return "meishe";
  return undefined;
}

const notFound = (forwarder: ForwarderId, query: string): ForwarderTrack => ({ forwarder, query, found: false, waybillNo: "", details: [], vessel: "", events: [] });
const measure = (count: unknown, unit: string, weight: unknown, volume: unknown): string => [
  Number(count) > 0 ? `${Number(count)}${unit}` : "", Number(weight) > 0 ? `${Number(weight)}kg` : "", Number(volume) > 0 ? `${Number(volume)}cbm` : "",
].filter(Boolean).join(" ");

const defaultHttp: HttpJson = (url, init = {}) => fetchJson<unknown>(url, { ...init, headers: { accept: "application/json, text/plain, */*", ...(init.headers as Record<string, string> | undefined) } }, { attempts: 2, timeoutMs: 20_000, baseDelayMs: 1_000 });

// ---------- 纽酷国际：摘要按客户单号（＝货件编号）批量查出纽酷单号，再逐单取完整轨迹 ----------
const NIUKU_API = "https://api.usniuku.com";
const NIUKU_CODES: Record<string, Milestone | null> = {
  "101": "已下单", "103": null, "104": "已入仓", "99": null, "105": "已装柜", "106": null, "108": null, "96": null, "109": "已开船", "114": null,
  "116": "已到港", "118": "已到港", "97": null, "123": "已提柜", "125": "已到海外仓", "124": "已预约", "128": "派送中", "129": "已签收", "1009": null,
};

function niukuEnvelope(body: unknown, label: string): Row {
  const object = (body ?? {}) as Row;
  if (!body || typeof body !== "object" || text(object.code) !== "ok") throw new Error(`纽酷${label}返回异常：code=${text(object.code).slice(0, 40) || "缺失"}`);
  return object;
}

function niukuEvent(event: Row): ForwarderEvent {
  const seconds = Number(event.logsTime);
  const at = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  const code = text(event.status);
  const label = text(event.statusName);
  const content = oneLine(event.content);
  const appointmentTime = text(event.agreeOnTimeUi);
  const milestone = milestoneOf(NIUKU_CODES, code, label);
  return {
    key: `n${text(event.id) || `${code}|${seconds}`}`,
    time: at ? beijingText(at) : "",
    ...(at ? { at } : {}),
    code, label, text: content,
    ...(milestone ? { milestone } : {}),
    exception: code === "1009" || Number(event.isErrorLogistics) === 1 || EXCEPTION_WORDS.test(content),
    ...(appointmentTime ? { appointment: [appointmentTime.slice(5), text(event.argeeOnWarehouse)].filter(Boolean).join(" ") } : {}),
  };
}

export function niukuTrack(query: string, summary: Row, detail: Row): ForwarderTrack {
  const data = (detail.data ?? {}) as Row;
  if (!data || typeof data !== "object" || !Array.isArray(data.orderLogisticsResponses)) throw new Error("纽酷轨迹返回缺少 orderLogisticsResponses。");
  const source = rows(data.orderLogisticsResponses).length ? rows(data.orderLogisticsResponses) : rows(data.logisticsInformation);
  const events = source.map(niukuEvent);
  const vessel = text(summary.shipNo) || text(source.find((event) => text(event.shipNo))?.shipNo);
  return {
    forwarder: "niuku", query, found: true,
    waybillNo: text(data.orderNo) || text(summary.orderNo),
    details: [text(data.channelName), measure(data.ctn, "箱", data.kg, data.cbm), vessel ? `船 ${vessel}` : ""].filter(Boolean),
    vessel, events,
  };
}

export function niukuAdapter(options: ForwarderOptions = {}): ForwarderAdapter {
  const http = options.http ?? defaultHttp;
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  return {
    id: "niuku",
    async track(ids) {
      const output = new Map<string, ForwarderTrack>();
      for (const chunk of chunks(ids, 20)) {
        const summary = niukuEnvelope(await http(`${NIUKU_API}/portal/api/1.0/getLogisticsByClientNosNew?timespan=${Date.now()}`, {
          method: "POST", headers: { "content-type": "application/json;charset=UTF-8" }, body: JSON.stringify({ clientNos: chunk, queryTab: 0 }),
        }), "摘要");
        if (!Array.isArray(summary.data)) throw new Error("纽酷摘要返回缺少 data 列表。");
        for (const id of chunk) {
          const row = rows(summary.data).find((item) => same(item.clientNo, id) || same(item.fbaNo, id));
          const orderNo = text(row?.orderNo);
          if (!row || !orderNo) { output.set(id, notFound("niuku", id)); continue; }
          await sleep(300);
          const detail = niukuEnvelope(await http(`${NIUKU_API}/manager/api/1.0//order/publicLogisticsNode?timespan=${Date.now()}&orderNoOrPlanName=${encodeURIComponent(orderNo)}`), "轨迹");
          output.set(id, niukuTrack(id, row, detail));
        }
      }
      return output;
    },
  };
}

// ---------- 九方通逊：一次传货件编号数组，返回固定节点（只列已到达的） ----------
const JIUFANG_API = "https://www.jiufanglogistics.cn";
const JIUFANG_CODES: Record<string, Milestone | null> = {
  "2": null, "30": "已入仓", "40": "已装柜", "60": null, "70": null, "80": "已开船", "84": null, "86": "已到港", "90": "已到港", "95": "已到港",
  "100": null, "110": null, "115": "已提柜", "120": "已到海外仓", "125": null, "130": "派送中", "135": "派送中", "140": "已签收",
};

export function jiufangTrack(query: string, row: Row): ForwarderTrack {
  if (!Array.isArray(row.lines)) throw new Error("九方返回缺少 lines。");
  const reached = rows(row.lines).filter((line) => line.state === true);
  const events = reached.map((line): ForwarderEvent => {
    const code = text(line.status);
    const label = text(line.content);
    const remark = oneLine(line.remark);
    const time = text(line.operationDateTime);
    const at = beijingWallTime(time);
    const milestone = milestoneOf(JIUFANG_CODES, code, label);
    return { key: `j${code}`, time, ...(at ? { at } : {}), code, label, text: remark ? `${label}（${remark}）` : label, ...(milestone ? { milestone } : {}), exception: EXCEPTION_WORDS.test(remark) };
  }).reverse();
  const lastMile = text(row.trackNumber);
  return {
    forwarder: "jiufang", query, found: true, waybillNo: text(row.waybillNo),
    details: [text(row.shippingWay), measure(row.packageNum, "箱", row.weight, row.volume), lastMile ? `尾程 ${lastMile}` : ""].filter(Boolean),
    vessel: "", events,
  };
}

export function jiufangAdapter(options: ForwarderOptions = {}): ForwarderAdapter {
  const http = options.http ?? defaultHttp;
  return {
    id: "jiufang",
    async track(ids) {
      const output = new Map<string, ForwarderTrack>();
      for (const chunk of chunks(ids, 50)) {
        const body = (await http(`${JIUFANG_API}/test-api/seaair/waybills/selectWaybillStatusByWaybillNo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chunk) })) as Row;
        if (!body || typeof body !== "object" || Number(body.code) !== 200 || !Array.isArray(body.data)) throw new Error(`九方返回异常：code=${text(body?.code).slice(0, 40) || "缺失"}`);
        for (const id of chunk) {
          const row = rows(body.data).find((item) => same(item.shipmentId, id) || same(item.referenceNo, id));
          output.set(id, row ? jiufangTrack(id, row) : notFound("jiufang", id));
        }
      }
      return output;
    },
  };
}

// ---------- 美设国际：换行分隔批量查（网站上限 30 个），逐条轨迹带 +08:00 时间 ----------
export const MEISHE_DEFAULT_BASE_URL = "http://47.106.228.122";
const MEISHE_TENANT_PATH = "/pub-tracking/yuyue";
const MEISHE_NODES: Record<string, Milestone | null> = {
  Booked: "已下单", pickup: null, wmsIn: "已入仓", CtnStuffed: "已装柜", atd: "已开船", arrivedPod: "已到港", "卸船": "已到港",
  customCleared: null, customsInspectionExp: null, deliveryAppointed: "已预约", transferOut: "派送中", Deliveried: "已签收",
};

export function meisheTrack(query: string, item: Row): ForwarderTrack {
  if (!Array.isArray(item.trackings)) throw new Error("美设返回缺少 trackings。");
  const events = rows(item.trackings).map((tracking): ForwarderEvent => {
    const node = text(tracking.node);
    const content = oneLine(tracking.context, true);
    const eventTime = Date.parse(text(tracking.eventTime));
    const time = text(tracking.time);
    const at = Number.isFinite(eventTime) ? eventTime : beijingWallTime(time);
    const milestone = milestoneOf(MEISHE_NODES, node, node);
    const appointment = /预约送货时间为\s*(\d{4}-\d{1,2}-\d{1,2})(?:\s+(\d{1,2}:\d{2}))?/.exec(content);
    return {
      key: `m${text(tracking.id) || `${node}|${time}`}`, time: time || (at ? beijingText(at) : ""), ...(at ? { at } : {}), code: node, label: node, text: content,
      ...(milestone ? { milestone } : {}), exception: node === "customsInspectionExp" || EXCEPTION_WORDS.test(content),
      ...(appointment ? { appointment: [ymd(appointment[1]!).slice(5), appointment[2] ?? ""].filter(Boolean).join(" ") } : {}),
    };
  }).reverse();
  return {
    forwarder: "meishe", query, found: true, waybillNo: text(item.jobNum),
    details: [text(item.shipmentType), Number(item.pkgNum) > 0 ? `${Number(item.pkgNum)}件` : ""].filter(Boolean),
    vessel: "", events,
  };
}

export function meisheAdapter(options: ForwarderOptions = {}): ForwarderAdapter {
  const http = options.http ?? defaultHttp;
  const base = (options.meisheBaseUrl || MEISHE_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const host = new URL(base).host;
  return {
    id: "meishe",
    async track(ids) {
      const output = new Map<string, ForwarderTrack>();
      for (const chunk of chunks(ids, 20)) {
        const query = new URLSearchParams({ soNum: chunk.join("\n"), url: MEISHE_TENANT_PATH, host, noSubTracking: "true" });
        const body = await http(`${base}/edi/pubTracking?${query.toString()}`);
        if (!Array.isArray(body)) throw new Error("美设返回不是列表。");
        for (const id of chunk) {
          const item = rows(body).find((entry) => same(entry.trackingNum, id));
          const found = !!item && item.notFound !== true && (!!text(item.jobNum) || rows(item.trackings).length > 0);
          output.set(id, found ? meisheTrack(id, item!) : notFound("meishe", id));
        }
      }
      return output;
    },
  };
}

export function createForwarderAdapters(options: ForwarderOptions = {}): Record<ForwarderId, ForwarderAdapter> {
  return { niuku: niukuAdapter(options), jiufang: jiufangAdapter(options), meishe: meisheAdapter(options) };
}
