import type { AppConfig, FeishuRecord, JobEvent, JsonObject } from "../types.js";
import { AmazonClient, type Pace } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { flushNotification, prepareNotification, type PreparedNotification } from "../notifications.js";
import { log } from "../log.js";
import { HttpError } from "../http.js";
import { errorText, feishuFieldText, ymdInZone } from "../util.js";

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
const text = (value: unknown): string => String(value ?? "").trim();
const MARKETPLACE = "ATVPDKIKX0DER";
const DAY = 86_400_000;
// Transfers listPayouts/listExpectedPayouts 与 Finances listBalances/listSummary 官方各 0.5 次/秒（与生产任务共用配额）。
export const PAYOUT_PACE: Record<"transfers" | "balances" | "summary", Pace> = {
  transfers: { key: "transfers:payouts", minIntervalMs: 2_100 },
  balances: { key: "finances:listBalances", minIntervalMs: 2_100 },
  summary: { key: "finances:listSummary", minIntervalMs: 2_100 },
};
const RISK_STATUSES = new Set(["AT_RISK", "DISABLED", "FAILED", "CANCELLED"]);
// listPayouts 里放款已发起、尚未到账的状态：结算已关闭，金额此时才最终确定。
const INITIATED_STATUSES = new Set(["STARTED", "IN_TRANSIT"]);
const PAID_RECENT_MS = 48 * 3_600_000;

interface PayoutFact {
  key: string; settlementId: string; payoutId: string; status: string; accountType: string;
  amount?: number; currency?: string; scheduledDate?: string; createdAt?: string; periodStart?: string; periodEnd?: string;
  paymentMethod?: string; accountTail?: string; paidAt?: string;
}

// Transfers 实际返回 {unit, value}（与官方模型的 currencyCode/currencyAmount 不同）；两种写法都认，缺失不补 0。
function money(value: unknown): { amount?: number; currency?: string } {
  const source = (value ?? {}) as Row;
  const raw = source.value ?? source.currencyAmount ?? source.amount;
  const amount = raw === undefined || raw === null || text(raw) === "" ? Number.NaN : Number(raw);
  const currency = text(source.unit ?? source.currencyCode).toUpperCase();
  return { ...(Number.isFinite(amount) ? { amount } : {}), ...(currency ? { currency } : {}) };
}

const settlementOf = (item: Row): string => text(rows(item.relatedIdentifiers).find((entry) => text(entry.relatedIdentifierName).toUpperCase() === "SETTLEMENT_ID")?.relatedIdentifierValue);
const optionalText = (value: unknown): string | undefined => text(value) || undefined;
const iso = (value: unknown): string | undefined => Number.isFinite(Date.parse(text(value))) ? text(value) : undefined;
const clean = <T extends Record<string, unknown>>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

// Transfers listPayouts 返回的 nextToken 已是 URL 编码形式（2026-10-12 生产实测含 %3D）：原样放进查询参数会被二次编码，
// 亚马逊报 400 Invalid nextToken。先解码一次再交给查询参数编码，线上即为亚马逊给的原样令牌；不含 %XX 的令牌（base64 等）原样使用。
export function pageToken(token: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(token)) return token;
  try { return decodeURIComponent(token); } catch { return token; }
}

async function paged(amazon: AmazonClient, path: string, query: Record<string, string>, key: string, pace: Pace): Promise<Row[]> {
  const output: Row[] = [];
  const seen = new Set<string>();
  let nextToken = "";
  do {
    const response = await amazon.sp<JsonObject>(path, { query: { ...query, ...(nextToken ? { nextToken: pageToken(nextToken) } : {}) }, pace });
    const payload = ((response as Row).payload ?? response) as Row;
    output.push(...rows(payload[key]));
    nextToken = text(payload.nextToken ?? (response as Row).nextToken);
    if (nextToken && seen.has(nextToken)) throw new Error(`${path} nextToken 重复。`);
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return output;
}

function mergeFacts(expected: Row[] | undefined, payouts: Row[] | undefined): PayoutFact[] {
  const facts = new Map<string, PayoutFact>();
  const merge = (key: string, next: PayoutFact): void => { facts.set(key, { ...(facts.get(key) ?? {}), ...clean(next as unknown as Row) } as PayoutFact); };
  for (const item of expected ?? []) {
    const settlementId = settlementOf(item);
    if (!settlementId) { log("WARN", "payout_expected_without_settlement", { status: text(item.status) }); continue; }
    merge(settlementId, clean({
      key: settlementId, settlementId, payoutId: "", status: text(item.status), accountType: text((item.partnerMetadata as Row | undefined)?.accountType), ...money(item.amount),
      scheduledDate: iso(item.scheduledDate), periodStart: iso((item.period as Row | undefined)?.startDate), periodEnd: iso((item.period as Row | undefined)?.endDate),
      paymentMethod: optionalText(item.paymentMethod), accountTail: optionalText(item.accountTail),
    }) as PayoutFact);
  }
  // 实际放款覆盖同一结算的预计放款（状态以 currentStatus 为准），预计发起日等只在预计放款里出现的值保留。
  for (const item of payouts ?? []) {
    const payoutId = text(item.id);
    const settlementId = settlementOf(item);
    const key = settlementId || (payoutId ? `payout:${payoutId}` : "");
    if (!key) continue;
    const paidAt = rows(item.statusHistory).filter((entry) => text(entry.status).toUpperCase() === "PAID").map((entry) => text(entry.lastUpdatedDate)).find((value) => Number.isFinite(Date.parse(value)));
    merge(key, clean({
      key, settlementId, payoutId, status: text(item.currentStatus ?? item.status), accountType: text((item.partnerMetadata as Row | undefined)?.accountType), ...money(item.amount),
      createdAt: iso(item.creationDate), periodStart: iso((item.period as Row | undefined)?.startDate), periodEnd: iso((item.period as Row | undefined)?.endDate),
      paymentMethod: optionalText(item.paymentMethod), accountTail: optionalText(item.accountTail), paidAt,
    }) as PayoutFact);
  }
  return [...facts.values()];
}

const beijingDate = (value?: string): string => value ? ymdInZone(new Date(value), "Asia/Shanghai") : "未知";
const beijingTime = (value?: string): string => value ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value)) : "未知";
const amountLine = (fact: PayoutFact): string => fact.amount === undefined ? "金额：未知" : `金额：${fact.currency === "USD" ? "$" : ""}${fact.amount.toFixed(2)}${fact.currency && fact.currency !== "USD" ? ` ${fact.currency}` : ""}`;
const receiveLine = (fact: PayoutFact): string => `收款：${fact.paymentMethod ?? "未知"}${fact.accountTail ? ` 尾号 ${fact.accountTail}` : ""}`;

function notice(fact: PayoutFact, previous: Row | undefined, bootstrap: boolean, now: number): string[] | undefined {
  const status = fact.status.toUpperCase();
  const prior = text(previous?.status).toUpperCase();
  const base = [`结算ID：${fact.settlementId || "无"}`, `账户：${fact.accountType || "未知"}`];
  if (RISK_STATUSES.has(status)) return prior === status ? undefined : [`⚠️ 放款异常：${status}`, amountLine(fact), `预计发起：${beijingDate(fact.scheduledDate)}`, receiveLine(fact), ...base];
  if (status === "PAID") {
    const recent = Number.isFinite(Date.parse(fact.paidAt ?? "")) && now - Date.parse(fact.paidAt!) <= PAID_RECENT_MS;
    if (prior === "PAID" || (!previous && (bootstrap || !recent))) return undefined;
    return ["✅ 放款到账", amountLine(fact), `到账时间：${beijingTime(fact.paidAt ?? fact.createdAt)}`, receiveLine(fact), ...base];
  }
  // 预计放款（SCHEDULED）金额在结算期内每天变化，新结算刚开时 Amazon 还会短暂返回上一期的结算额（2026-10-01 实测），只写表不发消息；
  // 结算关闭、放款首次以 STARTED/IN_TRANSIT 出现时按最终金额发一次“放款已发起”（用户 2026-10-05 决定）。
  if (!INITIATED_STATUSES.has(status) || fact.amount === undefined) return undefined;
  if (INITIATED_STATUSES.has(prior) || prior === "PAID") return undefined;
  return ["💵 放款已发起", amountLine(fact), `发起时间：${beijingTime(fact.createdAt)}`, `结算期：${beijingDate(fact.periodStart)} 至 ${beijingDate(fact.periodEnd)}`, receiveLine(fact), ...base];
}

function balanceRows(balances: Row[], day: string, now: number): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  const names: Record<string, string> = { AVAILABLE: "可用", RESERVED: "预留", DEFERRED: "递延", ACCOUNT_LEVEL_RESERVE: "账户级预留" };
  for (const total of balances) {
    const accountType = text((total.partnerMetadata as Row | undefined)?.accountType) || "UNKNOWN";
    const amount = money(total.amount);
    const currency = amount.currency ?? "";
    const fields: Record<string, unknown> = { "快照唯一键": `${day}|${accountType}|${currency}`, "日期": day, "账户类型": accountType, "币种": currency, "同步时间": now };
    const visit = (node: Row): void => {
      const type = text(node.balanceType).toUpperCase();
      const value = money(node.amount).amount;
      if (type === "TOTAL" && value !== undefined) fields["总额"] = value;
      else if (names[type] && value !== undefined) fields[names[type]!] = value;
      for (const child of rows(node.balances)) visit(child);
    };
    visit(total);
    output.push(fields);
  }
  return output;
}

// 资金任务（每天 09:30）：预计放款、近 60 天放款、余额，及按放款的 SETTLEMENT_ID 查结算汇总。
// 只写两张新表「亚马逊放款」「亚马逊余额快照」；金额、币种、日期按 Amazon 原值写，缺失不补 0；任一接口失败保留该来源的表内旧值，本轮失败交给重试。
// 消息：放款发起（首次 STARTED/IN_TRANSIT，最终金额）、变为 AT_RISK/DISABLED/FAILED/CANCELLED、变为 PAID；键含结算ID与状态，先持久化意图、再写表、再发送。
export async function runPayouts(_event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient): Promise<JsonObject> {
  const now = Date.now();
  const failures: string[] = [];
  const attempt = async <T>(name: string, run: () => Promise<T>): Promise<T | undefined> => {
    try { return await run(); } catch (error) { failures.push(`${name}: ${errorText(error).slice(0, 160)}`); log("WARN", "payouts_source_failed", { source: name, error: errorText(error).slice(0, 200) }); return undefined; }
  };
  const expected = await attempt("listExpectedPayouts", () => paged(amazon, "/finances/transfers/2024-06-01/payouts/expected", { marketplaceIds: MARKETPLACE }, "expectedPayouts", PAYOUT_PACE.transfers));
  const payouts = await attempt("listPayouts", () => paged(amazon, "/finances/transfers/2024-06-01/payouts", { marketplaceIds: MARKETPLACE, createdAfter: new Date(now - 60 * DAY).toISOString() }, "payouts", PAYOUT_PACE.transfers));
  const balances = await attempt("listBalances", () => paged(amazon, "/finances/2024-06-19/balances", { marketplaceIds: MARKETPLACE }, "balances", PAYOUT_PACE.balances));
  const facts = mergeFacts(expected, payouts);
  const bootstrap = (await state.queryPartition("PAYOUT", { limit: 1 })).length === 0;
  const previous = new Map<string, Row | undefined>();
  for (const fact of facts) previous.set(fact.key, await state.get("PAYOUT", fact.key));
  // listSummary 只接受 YYYY-MM-DD 期间或结算 ID；按结算 ID 查，已到账且已取得汇总的结算不再重复查。
  const summaries = new Map<string, Row>();
  // 生产实测（2026-09-30）：SELLER_WALLET 的 NO_PAYOUT_EXPECTED 结算查汇总必返回 400 InvalidInput。无放款的结算不查；
  // 单个结算汇总 400/404 视为该结算没有汇总（不写结算净额），不当作接口故障；429/5xx/网络错误仍按来源失败处理。
  for (const fact of facts) {
    if (!fact.settlementId || previous.get(fact.key)?.summaryDone === true || fact.status.toUpperCase() === "NO_PAYOUT_EXPECTED") continue;
    const found = await attempt(`listSummary(${fact.settlementId})`, async () => {
      try { return await paged(amazon, "/finances/2024-06-19/summary", { relatedIdentifierName: "SETTLEMENT_ID", relatedIdentifierValue: fact.settlementId }, "summaries", PAYOUT_PACE.summary); }
      catch (error) {
        if (error instanceof HttpError && (error.status === 400 || error.status === 404)) { log("WARN", "payout_summary_unavailable", { settlementId: fact.settlementId, status: error.status, code: error.code }); return []; }
        throw error;
      }
    });
    if (found?.[0]) summaries.set(fact.key, found[0]);
  }
  const prepared = new Map<string, PreparedNotification | undefined>();
  for (const fact of facts) {
    const lines = notice(fact, previous.get(fact.key), bootstrap, now);
    if (lines) { const eventKey = `payout|${fact.key}|${fact.status.toUpperCase()}`; prepared.set(eventKey, await prepareNotification(config, state, eventKey, lines)); }
  }
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const payoutTable = config.optional("FEISHU_BITABLE_TABLE_ID_PAYOUTS");
  const balanceTable = config.optional("FEISHU_BITABLE_TABLE_ID_BALANCES");
  let payoutRows = 0, balanceWrites = 0;
  if (payoutTable && facts.length) {
    const existing = await feishu.listRecords(app, payoutTable);
    for (const fact of facts) {
      const summary = summaries.get(fact.key);
      const net = summary ? money(summary.netProceeds).amount : undefined;
      const time = (value?: string): number | undefined => value ? Date.parse(value) : undefined;
      const fields = clean({
        "放款唯一键": fact.key, "结算ID": fact.settlementId || undefined, "放款ID": fact.payoutId || undefined, "状态": fact.status || undefined,
        "金额": fact.amount, "币种": fact.currency, "预计发起日": time(fact.scheduledDate), "发起时间": time(fact.createdAt),
        "结算期开始": time(fact.periodStart), "结算期结束": time(fact.periodEnd), "收款方式": fact.paymentMethod, "卡尾号": fact.accountTail,
        "账户类型": fact.accountType || undefined, "结算净额": net, "最后同步时间": now,
      });
      await feishu.upsert(app, payoutTable, { "放款唯一键": fact.key }, fields, { "首次发现时间": now }, { existing: existing.filter((record: FeishuRecord) => feishuFieldText(record.fields["放款唯一键"]) === fact.key) });
      payoutRows += 1;
    }
  }
  if (balanceTable && balances) {
    const existing = await feishu.listRecords(app, balanceTable);
    for (const fields of balanceRows(balances, ymdInZone(new Date(now), "Asia/Shanghai"), now)) {
      const key = String(fields["快照唯一键"]);
      await feishu.upsert(app, balanceTable, { "快照唯一键": key }, fields, {}, { existing: existing.filter((record: FeishuRecord) => feishuFieldText(record.fields["快照唯一键"]) === key) });
      balanceWrites += 1;
    }
  }
  for (const fact of facts) {
    const prior = previous.get(fact.key);
    const summaryDone = prior?.summaryDone === true || (fact.status.toUpperCase() === "PAID" && summaries.has(fact.key));
    await state.put({ pk: "PAYOUT", sk: fact.key, status: fact.status, summaryDone, firstSeenAt: text(prior?.firstSeenAt) || new Date(now).toISOString(), updatedAt: new Date().toISOString() });
  }
  const notified: string[] = [];
  for (const [eventKey, intent] of prepared) if ((await flushNotification(state, feishu, eventKey, intent)) === "sent") notified.push(eventKey);
  if (failures.length) throw new Error(`资金数据部分失败（已写入其余来源，失败来源保留表内旧值）：${failures.join("；")}`);
  return { status: "done", payouts: facts.length, payoutRows, balanceRows: balanceWrites, notified: notified.length, ...(!payoutTable || !balanceTable ? { tablesDisabled: true } : {}), ...(bootstrap ? { bootstrap: true } : {}) };
}
