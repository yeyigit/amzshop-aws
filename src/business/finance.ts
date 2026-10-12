import type { AppConfig, JobEvent, JsonObject } from "../types.js";
import { randomUUID } from "node:crypto";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { HttpError } from "../http.js";
import { StateStore, completedTaskExpiresAt } from "../state.js";
import { amazonLocalTime, auditEncode, canonicalHash, canonicalJson, feishuFieldText, sha256, stableKey } from "../util.js";
import { ensureOneTimeSchedule } from "../scheduling.js";
import { deliverNotification } from "../notifications.js";
import { transactionUpdateFacts } from "./events.js";

type Transaction = Record<string, unknown>;
type Schedule = typeof ensureOneTimeSchedule;
type Outcome = "done" | "waiting_release" | "waiting_match" | "waiting_detail";
type Phase = "scan" | "pending" | "unmatched";
export interface ApplyOptions { forcedDestination?: "shipment" | undefined; schedule?: Schedule | undefined }
interface Applied { outcome: Outcome; applied: boolean }
interface Tally { processed: number; skipped: number; deferred: number; waitingDetail: number }
interface ScanCursor { startTime: string; endTime: string; windowStartTime: string; windowEndTime: string; pageOffset: number; pageHash: string }
interface TaskCursor extends ScanCursor, Tally { mode: "daily" | "legacy"; phase: Phase; pendingAfter: string; unmatchedAfter: string; notDue: number }
interface FinanceRun { config: AppConfig; state: StateStore; amazon: AmazonClient; feishu: FeishuClient; schedule: Schedule; taskId: string }

const HOUR_MS = 3_600_000;
const WINDOW_MS = 6 * HOUR_MS;
const SLICE_BUDGET_MS = 300_000;
const WAKE_BUDGET_MS = 600_000;
const RECHECK_MS = 20 * HOUR_MS;
const WAKE_RATE_LIMIT_RETRIES = 4;
export const UNMATCHED_SHIPMENT_FEE_GRACE_MS = 14 * 24 * HOUR_MS;
const ORDER_ID_PATTERN = /^\d{3}-\d{7}-\d{7}$/;
const TRANSACTIONS_PATH = "/finances/2024-06-19/transactions";
const TERMINAL_STATUSES = ["done", "superseded", "deferred_to_daily", "archived"];
const LEGACY_WAITING_STATUSES = ["waiting_release", "waiting_detail"];
const PENDING_STAGES = ["pending", "waiting_release", "pending_match", "pending_detail"];
const WAITING_STAGES: Record<string, Outcome> = { waiting_release: "waiting_release", pending_match: "waiting_match", pending_detail: "waiting_detail" };
export const REFUND_NOTIFY_CUTOVER = "2026-09-23T11:50:48.731Z";
// Finances listTransactions and v0 listFinancialEventsByOrderId are both 0.5 req/s.
export const FINANCES_TRANSACTIONS_PACE = { key: "finances:listTransactions", minIntervalMs: 2_100 };
export const FINANCES_ORDER_EVENTS_PACE = { key: "finances:listFinancialEventsByOrderId", minIntervalMs: 2_100 };

const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => String(value ?? "").trim();
const normalized = (value: unknown): string => text(value).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();

export const refundNotifyAfter = (nowMs = Date.now()): number => Math.max(Date.parse(REFUND_NOTIFY_CUTOVER), nowMs - 72 * HOUR_MS);

function metadata(transaction: Transaction): { sellerId: string; marketplaceId: string; accountType: string } {
  const source = (transaction.sellingPartnerMetadata ?? transaction.SellingPartnerMetadata ?? {}) as Record<string, unknown>;
  return {
    sellerId: text(source.sellingPartnerId ?? source.SellingPartnerId ?? transaction.sellerId),
    marketplaceId: text(source.marketplaceId ?? source.MarketplaceId ?? transaction.marketplaceId),
    accountType: text(source.accountType ?? source.AccountType ?? transaction.accountType),
  };
}

export function uniqueKey(transaction: Transaction): string {
  const meta = metadata(transaction);
  const transactionId = text(transaction.transactionId ?? transaction.TransactionId);
  if (!meta.sellerId || !meta.marketplaceId || !transactionId) throw new Error("Finances transaction 缺少稳定唯一键字段。 ");
  return stableKey(meta.sellerId, meta.marketplaceId, transactionId);
}

function identifiers(transaction: Transaction): Array<{ name: string; value: string }> {
  return array(transaction.relatedIdentifiers ?? transaction.RelatedIdentifiers).map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    return { name: normalized(entry.relatedIdentifierName ?? entry.RelatedIdentifierName), value: text(entry.relatedIdentifierValue ?? entry.RelatedIdentifierValue) };
  });
}

function idValue(transaction: Transaction, name: string): string {
  return identifiers(transaction).find((item) => item.name === name)?.value ?? "";
}

function rawText(transaction: Transaction): string {
  return JSON.stringify(transaction);
}

// AWD→FBA 补货单（关联标识为 repl-<uuid>）的处理费、运输费不属于货件表里的任何货件，直接记入账户其他资金流水。
export function isAwdReplenishment(transaction: Transaction): boolean {
  return identifiers(transaction).some((item) => /^repl-[0-9a-f-]{8,}$/i.test(item.value));
}

// AWD 月度仓储费（描述 STARStorageBilling，关联标识是 US-<年>-<月>-<id> 这样的月度账单号）按月计费、不属于任何货件，与 FBA 仓储费一样记入账户其他资金流水。
export function isAwdStorageBilling(transaction: Transaction): boolean {
  return /^(?:STAR|AWD)STORAGE/.test(normalized(transaction.description ?? transaction.Description).replaceAll("_", ""));
}

const isAwdLedgerFee = (transaction: Transaction): boolean => isAwdReplenishment(transaction) || isAwdStorageBilling(transaction);

// 挂在订单号上的库存赔偿（退款后买家未退货 REVERSAL_REIMBURSEMENT、免费换货 FREE_REPLACEMENT_REFUND_ITEMS）订单表没有对应列，
// 与其它库存赔偿一样记入账户其他资金流水（2026-10-08 用户确认；此前只存状态表，飞书里看不到）。
const isInventoryReimbursement = (transaction: Transaction): boolean => normalized(transaction.transactionType ?? transaction.TransactionType).replaceAll("_", "") === "FBAINVENTORYREIMBURSEMENT";

function route(transaction: Transaction): "order" | "shipment" | "ledger" {
  const orderId = idValue(transaction, "ORDER_ID");
  if (ORDER_ID_PATTERN.test(orderId)) return isInventoryReimbursement(transaction) ? "ledger" : "order";
  if (isAwdLedgerFee(transaction)) return "ledger";
  const shipment = idValue(transaction, "SHIPMENT_ID") || (/^(?:FBA|STAR-)/i.test(orderId) ? orderId : "");
  const type = normalized(transaction.transactionType ?? transaction.TransactionType).replaceAll("_", "");
  const description = `${text(transaction.description ?? transaction.Description)} ${rawText(transaction)}`;
  if (shipment || (/FBA|INBOUND|SERVICE_FEE|SERVICEFEE/.test(type) && /inbound|placement|transport|AWD|carrier|customs|duty/i.test(description))) return "shipment";
  return "ledger";
}

function amount(transaction: Transaction): { value: number; currency: string } {
  const total = (transaction.totalAmount ?? transaction.TotalAmount ?? {}) as Record<string, unknown>;
  const value = Number(total.currencyAmount ?? total.CurrencyAmount ?? 0);
  if (!Number.isFinite(value)) throw new Error(`资金交易 ${uniqueKey(transaction)} 金额无效。`);
  return { value: Math.round((value + Number.EPSILON) * 100) / 100, currency: text(total.currencyCode ?? total.CurrencyCode) };
}

function classification(transaction: Transaction): { category: string; name: string; operating: boolean; note: string } {
  const type = normalized(transaction.transactionType ?? transaction.TransactionType);
  const compactType = type.replaceAll("_", "");
  const description = text(transaction.description ?? transaction.Description);
  const source = `${type}|${description}|${rawText(transaction)}`;
  const hasTransferProof = identifiers(transaction).some((item) => item.name === "DISBURSEMENT_ID" || item.name === "TRANSFER_ID");
  if (compactType === "TRANSFER" || hasTransferProof || /disbursement|balance.{0,10}transfer|reserve.{0,20}(movement|transfer)|预留款|结算划转/i.test(source)) {
    return { category: "账户划转", name: /reserve|预留/i.test(source) ? "预留款移动" : "结算划转", operating: false, note: "账户内部划转，不计入利润。" };
  }
  if (/REIMBURSEMENT|compensation|赔偿|补偿/i.test(source)) return { category: "赔偿与补偿", name: description || "亚马逊赔偿", operating: true, note: "" };
  if (compactType === "PRODUCTADSPAYMENT" || /AdvertisingFee/i.test(source)) return { category: "广告费用", name: "广告费用", operating: true, note: "" };
  if (compactType.startsWith("SERVICEFEE")) return { category: "平台费用", name: description || "平台服务费", operating: true, note: "" };
  return { category: "待分类", name: `待分类｜${text(transaction.transactionType ?? transaction.TransactionType) || "未知类型"}${description ? `｜${description}` : ""}`, operating: false, note: "Amazon 新类型或无法安全判断，等待人工分类。" };
}

export function displayTransactionType(type: string): string {
  const key = normalized(type).replaceAll("_", "");
  if (["SHIPMENT", "TRANSFER"].includes(key)) return "清算";
  if (["SERVICEFEE", "SERVICEFEEREVERSAL", "SERVICEFEECORRECTION", "PRODUCTADSPAYMENT"].includes(key)) return "服务费用";
  return ({ FBAINVENTORYREIMBURSEMENT: "库存退款赔偿", ADJUSTMENT: "资金调整", DEBTRECOVERY: "债务追回", ADHOCDISBURSEMENT: "临时付款", REMOVALSHIPMENT: "移除货件" } as Record<string, string>)[key] ?? type;
}

export function displayLedgerName(transaction: Transaction, fallback: string): string {
  const type = normalized(transaction.transactionType ?? transaction.TransactionType).replaceAll("_", "");
  const description = normalized(transaction.description ?? transaction.Description).replaceAll("_", "");
  if (type === "REMOVALSHIPMENT") return "移除货件（待分类）";
  if (type === "PRODUCTADSPAYMENT" || description === "ADVERTISINGFEE") return "广告费用";
  if (type === "FBAINVENTORYREIMBURSEMENT" && /CLAWBACK|REVERSEDREIMBURSEMENT/.test(description)) return "亚马逊物流取消的退款赔偿";
  return ({
    FBAREVERSEDREIMBURSEMENT: "亚马逊物流取消的退款赔偿", WAREHOUSELOST: "亚马逊物流仓库丢失赔偿",
    // CustomerReturnHRREvent（明细项 CustomerReturnHRRUnitFee）是高退货率商品的退货处理费，是扣款不是赔偿（2026-10-11 改名）。
    WAREHOUSEDAMAGE: "亚马逊物流仓库损坏赔偿", CUSTOMERRETURNHRREVENT: "亚马逊物流高退货率处理费",
    MISSINGFROMINBOUND: "亚马逊物流入库短缺赔偿", REVERSALREIMBURSEMENT: "亚马逊物流买家未退货赔偿", FREEREPLACEMENTREFUNDITEMS: "亚马逊物流免费换货赔偿", FBASTORAGEBILLING: "亚马逊物流仓储费",
    FBALONGTERMSTORAGEBILLING: "亚马逊物流长期仓储费", SUBSCRIPTION: "月度服务费",
    VINECHARGE: "Vine 费用", DEBTPAYMENT: "待分类｜债务追回｜债务付款", FBADISPOSAL: "亚马逊物流弃置费用",
    AWDPROCESSINGFEE: "AWD 处理费", AWDTRANSPORTATIONFEE: "AWD 运输费", STARSTORAGEBILLING: "AWD 仓储费",
  } as Record<string, string>)[description] ?? fallback;
}

// 卖家、站点与交易 ID 已在「流水唯一键」里；亚马逊原始状态与完整交易在状态表 FINANCE/，飞书只写人看的列（2026-10-06 字段精简）。
export function ledgerFields(transaction: Transaction): Record<string, unknown> {
  const key = uniqueKey(transaction);
  const meta = metadata(transaction);
  const money = amount(transaction);
  const cls = classification(transaction);
  const status = normalized(transaction.transactionStatus ?? transaction.TransactionStatus);
  const type = text(transaction.transactionType ?? transaction.TransactionType);
  const description = text(transaction.description ?? transaction.Description);
  const released = status === "RELEASED" || status === "DEFERRED_RELEASED";
  const postedAt = Date.parse(text(transaction.postedDate ?? transaction.PostedDate));
  if (!Number.isFinite(postedAt)) throw new Error(`资金交易 ${key} 交易时间无效。`);
  // 关联标识是压缩编码、人看不懂；挂亚马逊订单号的流水（库存赔偿）在备注写明订单号，方便对单。
  const orderId = idValue(transaction, "ORDER_ID");
  const notes = [status === "DEFERRED" ? "DEFERRED 待释放，利润核算金额为 0；同一 transactionId 后续更新。" : cls.note, ORDER_ID_PATTERN.test(orderId) ? `订单 ${orderId}` : ""].filter(Boolean);
  const now = Date.now();
  return {
    "流水唯一键": key,
    "交易时间": postedAt,
    "交易状态": released ? "已发放" : status === "DEFERRED" ? "暂缓" : text(transaction.transactionStatus ?? transaction.TransactionStatus),
    "交易类型": displayTransactionType(type),
    "业务分类": cls.category,
    "流水名称": displayLedgerName(transaction, cls.name),
    "原币金额": money.value,
    "利润核算金额": released && cls.operating ? money.value : 0,
    "币种": money.currency,
    "账户类型": meta.accountType,
    "亚马逊交易类型": type,
    "原始描述": description,
    "关联标识": auditEncode(identifiers(transaction)),
    "金额明细": auditEncode({ totalAmount: transaction.totalAmount ?? transaction.TotalAmount, breakdowns: transaction.breakdowns ?? transaction.Breakdowns ?? [], items: transaction.items ?? transaction.Items ?? [] }),
    "最后更新时间": now,
    "备注": notes.join("；"),
  };
}

async function persistRaw(state: StateStore, transaction: Transaction, destination: string, stage: string, extra: Record<string, unknown> = {}): Promise<void> {
  const sk = uniqueKey(transaction);
  const item = { pk: stage === "done" ? "FINANCE" : "FINANCE_PENDING", sk, status: normalized(transaction.transactionStatus ?? transaction.TransactionStatus), stage, destination, transaction, transactionHash: canonicalHash(transaction), updatedAt: new Date().toISOString(), ...extra };
  await state.put(item);
  if (stage === "done") await state.delete("FINANCE_PENDING", sk);
}

// DynamoDB returns map keys in arbitrary order, so stored facts are compared by canonical hash (canonical JSON for rows written before the hash existed).
function sameTransaction(record: Record<string, unknown> | undefined, transaction: Transaction, hash = canonicalHash(transaction)): boolean {
  if (!record || !record.transaction || typeof record.transaction !== "object") return false;
  return typeof record.transactionHash === "string" && record.transactionHash ? record.transactionHash === hash : canonicalJson(record.transaction) === canonicalJson(transaction);
}

export async function orderFinancialEvents(amazon: AmazonClient, orderId: string): Promise<Record<string, unknown>> {
  const events: Record<string, unknown> = {};
  let nextToken = "";
  const seen = new Set<string>();
  do {
    const response = await amazon.sp<JsonObject>(`/finances/v0/orders/${encodeURIComponent(orderId)}/financialEvents`, { query: nextToken ? { NextToken: nextToken } : {}, pace: FINANCES_ORDER_EVENTS_PACE });
    const payload = (response.payload ?? response) as Record<string, unknown>;
    const page = (payload.FinancialEvents ?? payload.financialEvents ?? payload) as Record<string, unknown>;
    for (const [key, value] of Object.entries(page)) {
      if (Array.isArray(value)) events[key] = [...array(events[key]), ...value];
      else if (events[key] === undefined) events[key] = value;
    }
    nextToken = text(payload.NextToken ?? payload.nextToken);
    if (nextToken && seen.has(nextToken)) throw new Error("订单财务返回重复 NextToken。 ");
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return events;
}

// 开关 FINANCE_ORDER_DETAIL_SOURCE：默认 v0（listFinancialEventsByOrderId，官方 2027-08-27 移除）；只有明确配置 v2024 才从 2024-06-19 交易条目生成。
export type FinanceOrderDetailSource = "v0" | "v2024";
export function financeOrderDetailSource(config: AppConfig): FinanceOrderDetailSource {
  const raw = typeof config.optional === "function" ? config.optional("FINANCE_ORDER_DETAIL_SOURCE", "v0") : "v0";
  return String(raw ?? "").trim().toLowerCase() === "v2024" ? "v2024" : "v0";
}

const V0_CHARGE_NAMES: Record<string, string> = { OurPricePrincipal: "Principal", OurPriceTax: "Tax", ShippingPrincipal: "ShippingCharge", ShippingTax: "ShippingTax", GiftwrapPrincipal: "GiftWrap", GiftwrapTax: "GiftWrapTax" };
const v0Money = (node: Transaction): Record<string, unknown> => {
  const source = (node.breakdownAmount ?? node.BreakdownAmount ?? {}) as Transaction;
  return { CurrencyAmount: source.currencyAmount ?? source.CurrencyAmount, CurrencyCode: source.currencyCode ?? source.CurrencyCode };
};
const children = (item: Transaction, group: string): Transaction[] => (array(item.breakdowns ?? item.Breakdowns) as Transaction[]).filter((node) => text(node.breakdownType ?? node.BreakdownType) === group).flatMap((node) => array(node.breakdowns ?? node.Breakdowns) as Transaction[]);
const itemId = (item: Transaction, name: string): string => text((array(item.relatedIdentifiers ?? item.RelatedIdentifiers) as Transaction[]).find((entry) => normalized(entry.itemRelatedIdentifierName ?? entry.relatedIdentifierName) === name)?.itemRelatedIdentifierValue);
const productContext = (item: Transaction): Transaction => ((array(item.contexts ?? item.Contexts) as Transaction[]).find((entry) => normalized(entry.contextType) === "PRODUCT_CONTEXT") ?? {}) as Transaction;
// 退款金额只算买家侧收费调整（商品、运费、礼品包装、其它），代扣的 MarketplaceFacilitator 税在 v0 属 ItemTaxWithheldList，不计。
const chargeNodes = (item: Transaction): Transaction[] => [...children(item, "ProductCharges"), ...children(item, "Shipping"), ...children(item, "Other"), ...children(item, "Tax").filter((node) => !/MarketplaceFacilitator/i.test(text(node.breakdownType)))];

// 零金额退款（如 CA 站 0 CAD 退款）条目可能没有任何分项：金额为 0 时取条目或交易总额的币种记一条 0 收费行，与 v0 的 0 CAD 收费行口径一致；
// 条目有金额却没有分项时不猜，按“明细未就绪”等待。
function refundCharges(item: Transaction, transaction: Transaction): Array<Record<string, unknown>> {
  const nodes = chargeNodes(item);
  if (nodes.length || children(item, "AmazonFees").length || children(item, "PromoRebates").length) return nodes.map((node) => ({ ChargeType: V0_CHARGE_NAMES[text(node.breakdownType)] ?? text(node.breakdownType), ChargeAmount: v0Money(node) }));
  const total = (item.totalAmount ?? {}) as Transaction;
  const value = Number(total.currencyAmount ?? 0);
  if (!Number.isFinite(value) || value !== 0) throw new Error("退款条目有金额但没有分项，财务费用明细未就绪。");
  const currency = text(total.currencyCode) || text(((transaction.totalAmount ?? {}) as Transaction).currencyCode);
  return currency ? [{ ChargeType: "Principal", ChargeAmount: { CurrencyAmount: 0, CurrencyCode: currency } }] : [];
}

// 免费换货单的清算：交易金额明确为 0，每个条目都没有任何分项（同一笔 v0 给一组 0 金额收费行、没有费用行）。返回交易币种，不是则返回空串。
function freeShipmentCurrency(transaction: Transaction): string {
  const total = (transaction.totalAmount ?? transaction.TotalAmount) as Transaction | undefined;
  const items = array(transaction.items ?? transaction.Items) as Transaction[];
  const zeroItem = (item: Transaction): boolean => {
    const raw = ((item.totalAmount ?? item.TotalAmount ?? {}) as Transaction).currencyAmount;
    return !array(item.breakdowns ?? item.Breakdowns).length && (raw === undefined || raw === null || Number(raw) === 0);
  };
  return hasExplicitAmount(total) && money(total).amount === 0 && items.length && items.every(zeroItem) ? money(total).currency : "";
}

// 2024-06-19 按订单交易 → v0 同形财务事件，退款明细、清算费用、弃置费沿用 v0 计算：
// 退款 adjustmentId＝条目 ORDER_ADJUSTMENT_ITEM_ID，SKU 与数量来自 ProductContext；佣金/配送费来自 AmazonFees 分项；促销来自 PromoRebates。
// 延期原交易（DEFERRED_RELEASED，带 RELEASE_TRANSACTION_ID）与放款交易（RELEASED，带 DEFERRED_TRANSACTION_ID）互指、分项相同：只计一次，
// 配对双方条目 ID 或分项不一致时按“明细未就绪”等待，不猜。不按条目 ID 跨交易去重：同一订单项分批发货时条目 ID 相同但是真实的多次发货。
export function eventsFromTransactions(transactions: Transaction[]): Record<string, unknown> {
  const byId = new Map(transactions.map((transaction) => [text(transaction.transactionId ?? transaction.TransactionId), transaction]));
  const counted = new Set<string>();
  const kept: Transaction[] = [];
  const signature = (transaction: Transaction): string => canonicalHash((array(transaction.items ?? transaction.Items) as Transaction[]).map((item) => ({ id: itemId(item, "ORDER_ADJUSTMENT_ITEM_ID"), breakdowns: item.breakdowns ?? item.Breakdowns ?? [] })));
  const ordered = [...transactions].sort((a, b) => (normalized(a.transactionStatus) === "RELEASED" ? 0 : 1) - (normalized(b.transactionStatus) === "RELEASED" ? 0 : 1));
  for (const transaction of ordered) {
    const id = text(transaction.transactionId ?? transaction.TransactionId);
    const partner = idValue(transaction, "DEFERRED_TRANSACTION_ID") || idValue(transaction, "RELEASE_TRANSACTION_ID");
    if (partner && counted.has(partner)) {
      if (signature(transaction) !== signature(byId.get(partner)!)) throw new Error(`订单交易 ${id} 与配对交易分项不一致，财务费用明细未就绪。`);
      continue;
    }
    counted.add(id);
    kept.push(transaction);
  }
  const shipments: Transaction[] = [];
  const refunds: Transaction[] = [];
  const services: Transaction[] = [];
  for (const transaction of kept) {
    const type = normalized(transaction.transactionType ?? transaction.TransactionType).replaceAll("_", "");
    const postedDate = text(transaction.postedDate ?? transaction.PostedDate);
    const items = array(transaction.items ?? transaction.Items) as Transaction[];
    if (type === "SHIPMENT") {
      const free = freeShipmentCurrency(transaction);
      shipments.push({ PostedDate: postedDate, ShipmentItemList: items.map((item) => ({
        SellerSKU: text(productContext(item).sku), QuantityShipped: productContext(item).quantityShipped,
        ItemChargeList: free ? [{ ChargeType: "Principal", ChargeAmount: { CurrencyAmount: 0, CurrencyCode: free } }] : chargeNodes(item).map((node) => ({ ChargeType: V0_CHARGE_NAMES[text(node.breakdownType)] ?? text(node.breakdownType), ChargeAmount: v0Money(node) })),
        ItemFeeList: children(item, "AmazonFees").map((node) => ({ FeeType: text(node.breakdownType), FeeAmount: v0Money(node) })),
        PromotionList: children(item, "PromoRebates").map((node) => ({ PromotionType: text(node.breakdownType), PromotionAmount: v0Money(node) })),
      })) });
    } else if (type === "REFUND") refunds.push({ PostedDate: postedDate, ShipmentItemAdjustmentList: items.map((item) => ({
      OrderAdjustmentItemId: itemId(item, "ORDER_ADJUSTMENT_ITEM_ID"), SellerSKU: text(productContext(item).sku), QuantityShipped: productContext(item).quantityShipped,
      ItemChargeAdjustmentList: refundCharges(item, transaction),
      ItemFeeAdjustmentList: children(item, "AmazonFees").map((node) => ({ FeeType: text(node.breakdownType), FeeAmount: v0Money(node) })),
      PromotionAdjustmentList: children(item, "PromoRebates").map((node) => ({ PromotionType: text(node.breakdownType), PromotionAmount: v0Money(node) })),
    })) });
    else if (type === "SERVICEFEE") {
      const fees = items.flatMap((item) => children(item, "FBAFees")).filter((node) => text(node.breakdownType) === "FBADisposalFee").map((node) => ({ FeeType: "FBADisposalFee", FeeAmount: v0Money(node) }));
      if (fees.length) services.push({ PostedDate: postedDate, FeeList: fees });
    }
  }
  return { ShipmentEventList: shipments, RefundEventList: refunds, ServiceFeeEventList: services };
}

export async function orderTransactions(amazon: AmazonClient, orderId: string): Promise<Transaction[]> {
  const byKey = new Map<string, Transaction>();
  let nextToken = "";
  const seen = new Set<string>();
  do {
    const response = await amazon.sp<JsonObject>(TRANSACTIONS_PATH, {
      query: { relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: orderId, pageSize: 500, ...(nextToken ? { nextToken } : {}) },
      pace: FINANCES_TRANSACTIONS_PACE,
    });
    for (const transaction of array(response.transactions ?? (response.payload as JsonObject | undefined)?.transactions) as Transaction[]) byKey.set(uniqueKey(transaction), transaction);
    nextToken = text(response.nextToken ?? (response.payload as JsonObject | undefined)?.nextToken);
    if (nextToken && seen.has(nextToken)) throw new Error("订单财务分页 nextToken 重复。");
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return [...byKey.values()];
}

function money(value: unknown): { amount: number; currency: string } {
  const source = (value ?? {}) as Record<string, unknown>;
  const amount = Number(source.CurrencyAmount ?? source.currencyAmount ?? 0);
  return { amount: Number.isFinite(amount) ? amount : 0, currency: text(source.CurrencyCode ?? source.currencyCode) };
}

function hasExplicitAmount(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const raw = (value as Transaction).CurrencyAmount ?? (value as Transaction).currencyAmount;
  return raw !== undefined && raw !== null && String(raw).trim() !== "" && Number.isFinite(Number(raw));
}

interface RefundEvent { postedDate: string; refundAmount: number; quantity: number }
interface RefundFact { adjustmentId: string; orderId: string; sku: string; quantity: number; postedDate: string; refundAmount: number; feeAdjustment: number; promotionAdjustment: number; currencies: string[]; charges: unknown[]; fees: unknown[]; promotions: unknown[]; events?: RefundEvent[] }

export function selectShipmentFinanceCurrency(skuCurrencies: Set<string>, orderCurrencies: Set<string>): string | undefined {
  const currencies = skuCurrencies.size ? skuCurrencies : orderCurrencies;
  return currencies.size === 1 ? [...currencies][0] : undefined;
}

// 按结算报告核对：OrderAdjustmentItemId 是订单项级 ID，同一订单项可有多笔各自结算的退款。
// 同一 adjustmentId 的多笔退款逐笔累加（金额、费用返还、促销、数量），入账时间取最晚，并保留逐笔 events 供通知；完全相同的重复事件只计一次。
export function refundFacts(events: Record<string, unknown>, orderId: string): RefundFact[] {
  const byId = new Map<string, RefundFact>();
  const seenEvents = new Set<string>();
  for (const event of array(events.RefundEventList ?? events.refundEventList) as Transaction[]) {
    for (const item of array(event.ShipmentItemAdjustmentList ?? event.shipmentItemAdjustmentList) as Transaction[]) {
      const adjustmentId = text(item.OrderAdjustmentItemId ?? item.orderAdjustmentItemId);
      if (!adjustmentId) throw new Error("退款事件缺少 OrderAdjustmentItemId，无法保证幂等。 ");
      const eventKey = canonicalHash({ postedDate: event.PostedDate ?? event.postedDate, item });
      if (seenEvents.has(eventKey)) continue;
      seenEvents.add(eventKey);
      const charges = array(item.ItemChargeAdjustmentList ?? item.itemChargeAdjustmentList);
      const fees = array(item.ItemFeeAdjustmentList ?? item.itemFeeAdjustmentList);
      const promotions = array(item.PromotionAdjustmentList ?? item.promotionAdjustmentList);
      const currencies = new Set<string>();
      const sum = (entries: unknown[], amountKey: string, lowerKey: string): number => entries.reduce<number>((total, entry) => {
        const row = (entry ?? {}) as Record<string, unknown>;
        const value = money(row[amountKey] ?? row[lowerKey]);
        if (value.currency) currencies.add(value.currency);
        return total + value.amount;
      }, 0);
      const piece: RefundFact = {
        adjustmentId, orderId, sku: text(item.SellerSKU ?? item.SellerSku ?? item.sellerSKU ?? item.sellerSku),
        quantity: Number(item.QuantityShipped ?? item.quantityShipped ?? item.QuantityRefunded ?? item.quantityRefunded ?? 0),
        postedDate: text(event.PostedDate ?? event.postedDate), refundAmount: sum(charges, "ChargeAmount", "chargeAmount"),
        feeAdjustment: sum(fees, "FeeAmount", "feeAmount"), promotionAdjustment: sum(promotions, "PromotionAmount", "promotionAmount"),
        currencies: [...currencies], charges, fees, promotions,
      };
      const one: RefundEvent = { postedDate: piece.postedDate, refundAmount: piece.refundAmount, quantity: piece.quantity };
      const prior = byId.get(adjustmentId);
      if (!prior) { byId.set(adjustmentId, { ...piece, events: [one] }); continue; }
      if (prior.sku && piece.sku && prior.sku !== piece.sku) throw new Error(`退款调整 ${adjustmentId} 的 SKU 不一致。`);
      byId.set(adjustmentId, {
        ...prior, sku: prior.sku || piece.sku, quantity: prior.quantity + piece.quantity,
        postedDate: Date.parse(piece.postedDate) > Date.parse(prior.postedDate) ? piece.postedDate : prior.postedDate,
        refundAmount: prior.refundAmount + piece.refundAmount, feeAdjustment: prior.feeAdjustment + piece.feeAdjustment, promotionAdjustment: prior.promotionAdjustment + piece.promotionAdjustment,
        currencies: [...new Set([...prior.currencies, ...piece.currencies])], charges: [...prior.charges, ...charges], fees: [...prior.fees, ...fees], promotions: [...prior.promotions, ...promotions],
        events: [...(prior.events ?? []), one].sort((a, b) => Date.parse(a.postedDate) - Date.parse(b.postedDate)),
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.adjustmentId.localeCompare(b.adjustmentId));
}

// 退款逐笔事实（按 adjustmentId 合并）存状态表，飞书只写可见的退款列；先写事实再写飞书，重试按事实重算、结果不变。
export const REFUND_FACTS_PK = "REFUND_FACTS";
export const refundFactsKey = (orderId: string, sku: string): string => stableKey(orderId, sku.trim().toLowerCase());

// Only refunds posted after notifyAfterMs are announced (see refundNotifyAfter); older history is recorded silently.
export async function updateRefunds(config: AppConfig, state: StateStore, feishu: FeishuClient, orderId: string, facts: RefundFact[], notifyAfterMs: number): Promise<void> {
  if (!facts.length) throw new Error(`订单 ${orderId} 的 Refund 交易没有权威退款明细。`);
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const table = config.get("FEISHU_BITABLE_TABLE_ID_ORDERS");
  const records = await feishu.searchRecords(app, table, { "订单编号": orderId });
  if (!records.length) throw new Error(`退款未找到订单行: ${orderId}`);
  const bySku = new Map<string, RefundFact[]>();
  for (const fact of facts) {
    const sku = fact.sku.trim().toLowerCase();
    if (!sku) throw new Error(`退款调整 ${fact.adjustmentId} 缺少 SellerSKU。`);
    bySku.set(sku, [...(bySku.get(sku) ?? []), fact]);
  }
  for (const record of records) {
    const sku = feishuFieldText(record.fields.SKU).toLowerCase();
    const incoming = bySku.get(sku) ?? [];
    if (!incoming.length) continue;
    const key = refundFactsKey(orderId, sku);
    const stored = (await state.get(REFUND_FACTS_PK, key))?.facts;
    const current = Array.isArray(stored) ? stored as RefundFact[] : [];
    const mergedById = new Map(current.map((fact) => [fact.adjustmentId, fact]));
    for (const fact of incoming) mergedById.set(fact.adjustmentId, fact);
    const merged = [...mergedById.values()].sort((a, b) => a.adjustmentId.localeCompare(b.adjustmentId));
    await state.put({ pk: REFUND_FACTS_PK, sk: key, orderId, sku, facts: merged, updatedAt: new Date().toISOString() });
    const currencies = [...new Set(merged.flatMap((fact) => fact.currencies))];
    const quantity = merged.reduce((sum, fact) => sum + fact.quantity, 0);
    const refundAmount = merged.reduce((sum, fact) => sum + fact.refundAmount, 0);
    const originalAmount = Number(feishuFieldText(record.fields["付款金额"]));
    const originalCurrency = feishuFieldText(record.fields["金额币种"]) || feishuFieldText(record.fields["费用币种"]);
    const status = Number.isFinite(originalAmount) && originalAmount > 0 && currencies.length === 1 && currencies[0] === originalCurrency
      ? (Math.abs(refundAmount) + 0.005 >= Math.abs(originalAmount) && quantity >= Number(feishuFieldText(record.fields["数量"])) ? "全额退款" : "部分退款")
      : "已发生退款（待核算）";
    const latest = Math.max(...merged.map((fact) => Date.parse(fact.postedDate)).filter(Number.isFinite));
    const refundTime = Number.isFinite(latest) ? amazonLocalTime(new Date(latest).toISOString()) : "";
    await feishu.update(app, table, record.record_id, {
      "已退款": "是", "退款状态": status, "退款数量": quantity, "退款币种": currencies.join(","),
      "退款金额": currencies.length === 1 ? Number(refundAmount.toFixed(2)) : null,
      "退款费用返还": currencies.length === 1 ? Number(merged.reduce((sum, fact) => sum + fact.feeAdjustment, 0).toFixed(2)) : null,
      ...(refundTime ? { "退款时间": refundTime } : {}),
    });
    bySku.delete(sku);
  }
  if (bySku.size) throw new Error(`退款调整无法匹配订单 SKU: ${orderId} / ${[...bySku.keys()].join(",")}`);
  const purchaseAt = records.map((record) => feishuFieldText(record.fields["下单时间"])).find(Boolean) ?? "";
  // 每笔退款一条通知：最早一笔沿用原键 refund|订单|adjustmentId（已发过的不重发），其后各笔键尾加入账时间。
  for (const fact of facts) {
    const currency = fact.currencies.join(",") || "币种未知";
    const perEvent = fact.events?.length ? fact.events : [{ postedDate: fact.postedDate, refundAmount: fact.refundAmount, quantity: fact.quantity }];
    for (const [index, event] of perEvent.entries()) {
      if (!(Date.parse(event.postedDate) > notifyAfterMs)) continue;
      const eventKey = index === 0 ? `refund|${orderId}|${fact.adjustmentId}` : `refund|${orderId}|${fact.adjustmentId}|${event.postedDate}`;
      await deliverNotification(config, state, feishu, eventKey, ["⚡️订单退款", `${fact.sku} x ${event.quantity}`, `金额：${currency === "USD" ? "$" : ""}${Math.abs(event.refundAmount).toFixed(2)}${currency === "USD" ? "" : ` ${currency}`}`, ...(purchaseAt ? [`下单时间：${purchaseAt}`] : []), `订单编号：${orderId}`]);
    }
  }
}

export interface ShipmentFinanceResult { updatedRows: number; filledFields: Record<string, number>; missingDetails: number; mismatches: Array<{ recordId: string; sku: string; field: string; current: string; expected: number }> }

// A SKU is ready once its settlement carries at least one ItemFeeList amount; commission, fulfillment and promotion
// absent from a ready SKU are known zeros (GAS semantics). A free replacement is ready too: its charges are all explicit
// zeros and it has no fee or promotion lines, so all three are zero. A SKU without ready details is never written.
export async function updateShipmentFinance(config: AppConfig, feishu: FeishuClient, orderId: string, events: Record<string, unknown>, postedDate: string, missingOnly = false): Promise<ShipmentFinanceResult> {
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const table = config.get("FEISHU_BITABLE_TABLE_ID_ORDERS");
  const records = await feishu.searchRecords(app, table, { "订单编号": orderId });
  if (!records.length) throw new Error(`清算未找到订单行: ${orderId}`);
  const totals = new Map<string, { commission: number; shipping: number; promotion: number; currencies: Set<string>; ready: boolean }>();
  const globalCurrencies = new Set<string>();
  const shipmentEvents = [...array(events.ShipmentEventList ?? events.shipmentEventList), ...array(events.ShipmentSettleEventList ?? events.shipmentSettleEventList)] as Transaction[];
  for (const shipment of shipmentEvents) {
    for (const item of array(shipment.ShipmentItemList ?? shipment.shipmentItemList) as Transaction[]) {
      const sku = text(item.SellerSKU ?? item.SellerSku ?? item.sellerSKU ?? item.sellerSku);
      if (!sku) continue;
      const target = totals.get(sku.toLowerCase()) ?? { commission: 0, shipping: 0, promotion: 0, currencies: new Set<string>(), ready: false };
      totals.set(sku.toLowerCase(), target);
      const cost = (raw: unknown): number => {
        if (!hasExplicitAmount(raw)) throw new Error(`订单 ${orderId}/${sku} 财务费用明细未就绪。`);
        const value = money(raw);
        if (value.currency) { target.currencies.add(value.currency); globalCurrencies.add(value.currency); }
        return -value.amount;
      };
      const fees = array(item.ItemFeeList ?? item.itemFeeList) as Transaction[];
      const promotions = array(item.PromotionList ?? item.promotionList) as Transaction[];
      for (const fee of fees) {
        const type = normalized(fee.FeeType ?? fee.feeType ?? fee.Type ?? fee.type).replaceAll("_", "");
        const value = cost(fee.FeeAmount ?? fee.feeAmount ?? fee.Amount ?? fee.amount ?? fee.TotalAmount ?? fee.totalAmount);
        target.ready = true;
        if (["COMMISSION", "REFERRALFEE", "FIXEDCLOSINGFEE", "VARIABLECLOSINGFEE"].includes(type)) target.commission += value;
        else if (type.includes("FULFILLMENT")) target.shipping += value;
      }
      for (const promotion of promotions) target.promotion += cost(promotion.PromotionAmount ?? promotion.promotionAmount ?? promotion.Amount ?? promotion.amount);
      // 免费换货单不收佣金、不收配送费（核对过订单表里的换货单，结算都是 0 且没有费用行）：收费行全是明确的 0、又没有费用和促销行时三项记 0，与 GAS 一致。
      const charges = (array(item.ItemChargeList ?? item.itemChargeList) as Transaction[]).map((charge) => charge.ChargeAmount ?? charge.chargeAmount);
      if (!fees.length && !promotions.length && charges.length && charges.every((raw) => hasExplicitAmount(raw) && money(raw).amount === 0)) {
        for (const { currency } of charges.map(money)) if (currency) { target.currencies.add(currency); globalCurrencies.add(currency); }
        target.ready = true;
      }
    }
  }
  if (!totals.size) {
    if (missingOnly) return { updatedRows: 0, filledFields: {}, missingDetails: records.length, mismatches: [] };
    throw new Error(`订单 ${orderId} 的 Shipment 交易财务费用明细未就绪：没有 SKU 明细。`);
  }
  const feeTime = amazonLocalTime(postedDate);
  const updates: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
  const filledFields: Record<string, number> = {};
  const mismatches: ShipmentFinanceResult["mismatches"] = [];
  let missingDetails = 0;
  for (const record of records) {
    const skuText = feishuFieldText(record.fields.SKU);
    const sku = skuText.toLowerCase();
    const target = totals.get(sku);
    if (!target?.ready) {
      if (missingOnly) { missingDetails += 1; continue; }
      throw new Error(`订单 ${orderId}/${sku} 财务费用明细未就绪。`);
    }
    const currency = selectShipmentFinanceCurrency(target.currencies, globalCurrencies);
    if (!currency) throw new Error(`订单 ${orderId}/${sku} 财务币种缺失或混合。`);
    const fees: Record<string, number> = { "佣金": Number(target.commission.toFixed(2)), "配送费": Number(target.shipping.toFixed(2)), "促销费用": Number(target.promotion.toFixed(2)) };
    const sourceFields: Record<string, unknown> = { ...fees, ...(feeTime ? { "费用更新时间": feeTime } : {}), "费用币种": currency };
    if (missingOnly) {
      for (const [field, expected] of Object.entries(fees)) {
        const current = feishuFieldText(record.fields[field]);
        if (current !== "" && !(Math.abs(Number(current) - expected) < 0.005)) mismatches.push({ recordId: record.record_id, sku: skuText, field, current, expected });
      }
    }
    const fields = missingOnly ? Object.fromEntries(Object.entries(sourceFields).filter(([field]) => feishuFieldText(record.fields[field]) === "")) : sourceFields;
    if (Object.keys(fields).length) {
      updates.push({ recordId: record.record_id, fields });
      for (const field of Object.keys(fields)) filledFields[field] = (filledFields[field] ?? 0) + 1;
    }
  }
  for (const update of updates) await feishu.update(app, table, update.recordId, update.fields);
  return { updatedRows: updates.length, filledFields, missingDetails, mismatches };
}

export async function updateOrderDisposalFee(config: AppConfig, feishu: FeishuClient, orderId: string, events: Record<string, unknown>, postedDate: string): Promise<number> {
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const table = config.get("FEISHU_BITABLE_TABLE_ID_ORDERS");
  const records = (await feishu.searchRecords(app, table, { "订单编号": orderId })).sort((a, b) => a.record_id.localeCompare(b.record_id));
  if (!records.length) throw new Error(`弃置费未找到订单行: ${orderId}`);
  let cents = 0;
  const currencies = new Set<string>();
  let seen = false;
  for (const service of array(events.ServiceFeeEventList ?? events.serviceFeeEventList) as Transaction[]) {
    for (const fee of array(service.FeeList ?? service.feeList) as Transaction[]) {
      if (normalized(fee.FeeType ?? fee.feeType).replaceAll("_", "") !== "FBADISPOSALFEE") continue;
      const raw = fee.FeeAmount ?? fee.feeAmount ?? fee.Amount ?? fee.amount;
      if (!hasExplicitAmount(raw)) throw new Error(`订单 ${orderId} 弃置费财务费用明细未就绪。`);
      const value = money(raw);
      if (!value.currency) throw new Error(`订单 ${orderId} 弃置费币种缺失。`);
      currencies.add(value.currency);
      cents -= Math.round(value.amount * 100);
      seen = true;
    }
  }
  if (!seen) throw new Error(`订单 ${orderId} 弃置费财务费用明细未就绪。`);
  if (currencies.size !== 1) throw new Error(`订单 ${orderId} 弃置费币种混合。`);
  const currency = [...currencies][0]!;
  const feeTime = amazonLocalTime(postedDate);
  const weights = records.map((record) => Math.max(0, Number(feishuFieldText(record.fields["付款金额"]))) || Math.max(0, Number(feishuFieldText(record.fields["数量"]))) || 1);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  let allocated = 0;
  const updates: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const share = index === records.length - 1 ? cents - allocated : Math.round(cents * weights[index]! / weightTotal);
    allocated += share;
    const current = feishuFieldText(record.fields["弃置费"]);
    const currentCurrency = feishuFieldText(record.fields["费用币种"]);
    if (currentCurrency && currentCurrency !== currency) throw new Error(`订单 ${orderId} 弃置费与已有费用币种冲突。`);
    if (current && Number(current) !== 0) {
      if (Math.round(Number(current) * 100) !== share) throw new Error(`订单 ${orderId} 弃置费已有非零值且与权威金额不符，拒绝覆盖。`);
      continue;
    }
    if (share) updates.push({ recordId: record.record_id, fields: { "弃置费": share / 100, ...(feeTime ? { "费用更新时间": feeTime } : {}), ...(!currentCurrency ? { "费用币种": currency } : {}) } });
  }
  for (const update of updates) await feishu.update(app, table, update.recordId, update.fields);
  return updates.length;
}

// 订单路由只把退款、清算费用与弃置费写进订单行（各自先确认订单行存在）；原始交易只存状态表 FINANCE/，订单表不再保存原始交易 JSON。
async function appendOrderFact(config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient, transaction: Transaction, schedule: Schedule): Promise<void> {
  const orderId = idValue(transaction, "ORDER_ID");
  const type = normalized(transaction.transactionType ?? transaction.TransactionType);
  if (type === "REFUND" || type === "SHIPMENT" || (type === "SERVICE_FEE" || type === "SERVICEFEE") && normalized(transaction.description ?? transaction.Description).replaceAll("_", "") === "FBADISPOSAL") {
    const events = financeOrderDetailSource(config) === "v2024" ? eventsFromTransactions(await orderTransactions(amazon, orderId)) : await orderFinancialEvents(amazon, orderId);
    const postedDate = text(transaction.postedDate ?? transaction.PostedDate);
    if (type === "REFUND") {
      // The return-reason follow-up belongs to the first successful application of this refund transaction only.
      const firstApply = !(await state.get("FINANCE", uniqueKey(transaction)));
      await updateRefunds(config, state, feishu, orderId, refundFacts(events, orderId), refundNotifyAfter());
      if (firstApply) {
        const nextAt = new Date(Date.now() + 60_000);
        await schedule({ taskType: "order-reason", taskId: `refund-reason|${orderId}|${text(transaction.transactionId ?? transaction.TransactionId)}`, scheduledAt: nextAt.toISOString() }, nextAt);
      }
    } else if (type === "SHIPMENT") await updateShipmentFinance(config, feishu, orderId, events, postedDate);
    else await updateOrderDisposalFee(config, feishu, orderId, events, postedDate);
  }
}

function shipmentId(transaction: Transaction): string {
  const direct = idValue(transaction, "SHIPMENT_ID") || idValue(transaction, "ORDER_ID");
  const match = direct.match(/(?:^|_)(FBA[A-Z0-9_-]{3,}|STAR-[A-Z0-9_-]{3,})$/i);
  return match?.[1] ?? direct;
}

const shipmentFeeNames = ["运输费", "海关费", "入库配置费", "其他费用"] as const;
const roundFee = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
interface ShipmentFeeEntry { category: string; amount: number; currency?: string; postedDate: string; transactionStatus?: string; description: string }
type ShipmentFeeIndex = Record<string, ShipmentFeeEntry>;

function shipmentFeeDescription(transaction: Transaction): string {
  const parts = [transaction.transactionType ?? transaction.TransactionType, transaction.description ?? transaction.Description];
  const breakdowns = (value: unknown): void => {
    for (const item of array(value) as Transaction[]) { parts.push(item.breakdownType ?? item.BreakdownType); breakdowns(item.breakdowns ?? item.Breakdowns); }
  };
  breakdowns(transaction.breakdowns ?? transaction.Breakdowns);
  for (const item of array(transaction.items ?? transaction.Items) as Transaction[]) { parts.push(item.description ?? item.Description); breakdowns(item.breakdowns ?? item.Breakdowns); }
  return [...new Set(parts.map(text).filter(Boolean))].join(" | ");
}

function shipmentFeeField(description: string): typeof shipmentFeeNames[number] {
  if (/GlobalInboundTransportationDuty|transportation.{0,30}(duty|customs)|customs|custom\s*dut|tariff|brokerage|clearance|\bdut(?:y|ies)\b|海关|关税|清关/i.test(description)) return "海关费";
  if (/FBAInboundConvenience|InboundConvenienceCharge|inbound.{0,30}(placement|configuration)|placement.{0,30}(service|fee)|placement\s*option|入库.{0,12}(配置|安置)|配置费/i.test(description)) return "入库配置费";
  if (/transport|transportation|freight|partnered\s*carrier|shipping\s*service|linehaul|运输费|承运/i.test(description)) return "运输费";
  return "其他费用";
}

function shipmentFeeEntry(transaction: Transaction): ShipmentFeeEntry {
  const value = amount(transaction);
  if (value.currency.toUpperCase() !== "USD") throw new Error("货件费用不是 USD，已保留原交易待人工核对。");
  const description = shipmentFeeDescription(transaction) || "未知费用类型";
  return { category: shipmentFeeField(description), amount: roundFee(-value.value), currency: "USD", postedDate: text(transaction.postedDate ?? transaction.PostedDate), transactionStatus: normalized(transaction.transactionStatus ?? transaction.TransactionStatus), description };
}

export function mergeShipmentFee(fields: Record<string, unknown>, feeIndex: ShipmentFeeIndex, transactionId: string, incoming: ShipmentFeeEntry): { feeIndex: ShipmentFeeIndex; updates: Record<string, unknown>; changed: boolean } {
  if (!transactionId || !Number.isFinite(incoming.amount) || incoming.currency !== "USD") throw new Error("货件费用索引条目无效。");
  const previous = feeIndex[transactionId];
  if (previous && previous.amount === incoming.amount && previous.currency === incoming.currency && previous.description === incoming.description && previous.postedDate === incoming.postedDate && previous.transactionStatus === incoming.transactionStatus) return { feeIndex, updates: {}, changed: false };
  const nextIndex = { ...feeIndex, [transactionId]: incoming };
  const totals: Record<typeof shipmentFeeNames[number], number> = { "运输费": 0, "海关费": 0, "入库配置费": 0, "其他费用": 0 };
  const counts = { ...totals };
  const latest: Record<typeof shipmentFeeNames[number], number> = { "运输费": 0, "海关费": 0, "入库配置费": 0, "其他费用": 0 };
  const details = (index: ShipmentFeeIndex): string[] => [...new Set(Object.values(index).filter((entry) => shipmentFeeField(entry.description) === "其他费用").map((entry) => `${entry.description || "未知费用类型"} ${roundFee(Number(entry.amount))}`))];
  for (const entry of Object.values(nextIndex)) {
    if (!Number.isFinite(Number(entry.amount)) || (entry.currency && String(entry.currency).toUpperCase() !== "USD")) throw new Error("货件历史费用索引损坏。");
    const field = shipmentFeeField(entry.description);
    totals[field] = roundFee(totals[field] + Number(entry.amount));
    counts[field] += 1;
    latest[field] = Math.max(latest[field], Date.parse(entry.postedDate) || 0);
  }
  const oldDetails = new Set(details(feeIndex));
  const preservedLines = String(fields["其他费用明细"] ?? "").split(/\r?\n/).filter((line) => line && !oldDetails.has(line));
  const updates: Record<string, unknown> = {
    "其他费用明细": [...new Set([...preservedLines, ...details(nextIndex)])].join("\n"),
    "费用合计": roundFee(shipmentFeeNames.reduce((sum, field) => sum + totals[field], 0)),
    "费用更新时间": Date.now(),
  };
  for (const field of shipmentFeeNames) {
    updates[field] = counts[field] ? totals[field] : null;
    updates[`${field}扣费时间`] = latest[field] || null;
  }
  return { feeIndex: nextIndex, updates, changed: true };
}

export async function appendShipmentFact(config: AppConfig, state: StateStore, feishu: FeishuClient, transaction: Transaction): Promise<void> {
  const id = shipmentId(transaction);
  if (!id) throw new Error("SHIPMENT_ID_MISSING");
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const table = config.get("FEISHU_BITABLE_TABLE_ID_SHIPMENTS");
  const records = await feishu.searchRecords(app, table, { "货件编号": id });
  if (!records.length) throw new Error("SHIPMENT_NOT_FOUND");
  if (records.length !== 1) throw new Error(`货件费用匹配数量不是 1: ${id}`);
  const record = records[0]!;
  const shipmentKey = feishuFieldText(record.fields["货件唯一键"]);
  if (!shipmentKey) throw new Error(`货件 ${id} 缺少唯一键。`);
  const owner = randomUUID();
  if (!await state.acquireLease("shipment-fee", shipmentKey, owner, 960_000)) throw new Error(`货件 ${id} 费用更新忙，稍后重试。`);
  try {
    const current = await state.get("SHIPMENT_FEE_INDEX", shipmentKey);
    if (!current && Number(feishuFieldText(record.fields["费用合计"]))) throw new Error(`货件 ${id} 有旧费用但无已迁索引，拒绝双算。`);
    const feeIndex = (current?.feeIndex ?? {}) as ShipmentFeeIndex;
    const transactionId = text(transaction.transactionId ?? transaction.TransactionId);
    const merged = mergeShipmentFee(record.fields, feeIndex, transactionId, shipmentFeeEntry(transaction));
    if (!merged.changed) return;
    await feishu.update(app, table, record.record_id, merged.updates);
    await state.put({ ...(current ?? {}), pk: "SHIPMENT_FEE_INDEX", sk: shipmentKey, feeIndex: merged.feeIndex, updatedAt: new Date().toISOString() });
  } finally {
    await state.releaseLease("shipment-fee", shipmentKey, owner);
  }
}

async function applyTransaction(config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient, transaction: Transaction, options: ApplyOptions): Promise<"done" | "waiting_release" | "waiting_match"> {
  // 补货单费用与 AWD 月度仓储费即使来自旧的“待匹配货件”复查（forcedDestination=shipment）也改记流水。
  const destination = isAwdLedgerFee(transaction) ? "ledger" : options.forcedDestination ?? route(transaction);
  const status = normalized(transaction.transactionStatus ?? transaction.TransactionStatus);
  const recheck = { nextAt: new Date(Date.now() + RECHECK_MS).toISOString() };
  const ledger = (note = ""): Promise<string> => {
    const fields = ledgerFields(transaction);
    if (note) fields["备注"] = [text(fields["备注"]), note].filter(Boolean).join("；");
    return feishu.upsert(config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS"), config.get("FEISHU_BITABLE_TABLE_ID_FINANCE_LEDGER"), { "流水唯一键": uniqueKey(transaction) }, fields, { "首次发现时间": Date.now() });
  };
  if (status === "DEFERRED" || (destination === "shipment" && !["RELEASED", "DEFERRED_RELEASED"].includes(status))) {
    await persistRaw(state, transaction, destination, "waiting_release", recheck);
    if (destination === "ledger") await ledger();
    return "waiting_release";
  }
  await persistRaw(state, transaction, destination, "pending");
  if (destination === "order") await appendOrderFact(config, state, amazon, feishu, transaction, options.schedule ?? ensureOneTimeSchedule);
  else if (destination === "shipment") {
    try { await appendShipmentFact(config, state, feishu, transaction); }
    catch (error) {
      if (!["SHIPMENT_ID_MISSING", "SHIPMENT_NOT_FOUND"].includes(String((error as Error).message))) throw error;
      // 入账超过 14 天仍匹配不到货件：不再无限等待，改记账户其他资金流水并注明（只记一处，FINANCE 完成后不会再回头记货件）。
      const postedAt = Date.parse(text(transaction.postedDate ?? transaction.PostedDate));
      if (Number.isFinite(postedAt) && Date.now() - postedAt > UNMATCHED_SHIPMENT_FEE_GRACE_MS) {
        await ledger(`未匹配到货件（入账超过 14 天，标识 ${shipmentId(transaction) || "缺失"}），已记入其他资金流水`);
        await persistRaw(state, transaction, "ledger", "done", { matchFallback: true });
        return "done";
      }
      await persistRaw(state, transaction, destination, "pending_match", recheck);
      return "waiting_match";
    }
  }
  else await ledger();
  await persistRaw(state, transaction, destination, "done");
  return "done";
}

export async function applyFinanceWithDetailWait(config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient, transaction: Transaction, options: ApplyOptions = {}): Promise<Outcome> {
  try { return await applyTransaction(config, state, amazon, feishu, transaction, options); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes("财务费用明细未就绪")) throw error;
    const key = uniqueKey(transaction);
    const pending = await state.get("FINANCE_PENDING", key);
    if (!pending) throw new Error("Finance 明细未就绪但原始交易未持久化。", { cause: error });
    await state.put({ ...pending, stage: "pending_detail", detailReason: "order_finance_details_not_ready", nextAt: new Date(Date.now() + RECHECK_MS).toISOString() });
    return "waiting_detail";
  }
}

// Unchanged facts are skipped: FINANCE rows are final, and FINANCE_PENDING rows in a waiting stage are rechecked by the daily run once nextAt is due.
async function applyChanged(run: FinanceRun, transaction: Transaction, forcedDestination?: "shipment"): Promise<Applied> {
  const key = uniqueKey(transaction);
  const hash = canonicalHash(transaction);
  if (sameTransaction(await run.state.get("FINANCE", key), transaction, hash)) return { outcome: "done", applied: false };
  const pending = await run.state.get("FINANCE_PENDING", key);
  const waiting = WAITING_STAGES[text(pending?.stage)];
  if (waiting && sameTransaction(pending, transaction, hash)) return { outcome: waiting, applied: false };
  return { outcome: await applyFinanceWithDetailWait(run.config, run.state, run.amazon, run.feishu, transaction, { forcedDestination, schedule: run.schedule }), applied: true };
}

function count(tally: Tally, result: Applied): void {
  if (result.applied) tally.processed += 1; else tally.skipped += 1;
  if (result.outcome !== "done") tally.deferred += 1;
  if (result.outcome === "waiting_detail") tally.waitingDetail += 1;
}

const bySk = (items: Record<string, unknown>[]): Record<string, unknown>[] => [...items].sort((a, b) => text(a.sk) < text(b.sk) ? -1 : text(a.sk) > text(b.sk) ? 1 : 0);

// SP-API Finances nextToken expires quickly. Resume from a small posted-time window, not from a token saved by a previous Lambda invocation.
async function scanWindows(run: FinanceRun, cursor: ScanCursor, tally: Tally, exceeded: () => boolean, save: () => Promise<void>): Promise<boolean> {
  const end = Date.parse(cursor.endTime);
  const seen = new Set<string>();
  let nextToken = "";
  let lastSavedAt = Date.now();
  while (Date.parse(cursor.windowStartTime) < end) {
    const requestToken = nextToken;
    const response = await run.amazon.sp<JsonObject>(TRANSACTIONS_PATH, {
      query: { postedAfter: cursor.windowStartTime, postedBefore: cursor.windowEndTime, ...(nextToken ? { nextToken } : {}) },
      pace: FINANCES_TRANSACTIONS_PACE,
    });
    const transactions = array(response.transactions ?? (response.payload as JsonObject | undefined)?.transactions) as Transaction[];
    const responseHash = sha256(JSON.stringify(transactions));
    if (cursor.pageOffset && cursor.pageHash !== responseHash) cursor.pageOffset = 0;
    cursor.pageHash = responseHash;
    for (let index = cursor.pageOffset; index < transactions.length; index += 1) {
      count(tally, await applyChanged(run, transactions[index]!));
      cursor.pageOffset = index + 1;
      if (cursor.pageOffset % 8 === 0 || Date.now() - lastSavedAt >= 60_000) {
        await save();
        lastSavedAt = Date.now();
      }
      if (exceeded()) return false;
    }
    const next = text(response.nextToken ?? (response.payload as JsonObject | undefined)?.nextToken);
    if (next && (next === requestToken || seen.has(next))) throw new Error("Finances 分页 nextToken 重复。 ");
    if (next) seen.add(next);
    nextToken = next;
    cursor.pageOffset = 0;
    cursor.pageHash = "";
    if (!nextToken) {
      if (Date.parse(cursor.windowEndTime) >= end) cursor.windowStartTime = cursor.endTime;
      else {
        cursor.windowStartTime = new Date(Math.max(Date.parse(cursor.windowStartTime) + 1, Date.parse(cursor.windowEndTime) - 1_000)).toISOString();
        cursor.windowEndTime = new Date(Math.min(Date.parse(cursor.windowStartTime) + WINDOW_MS, end)).toISOString();
      }
    }
    await save();
    lastSavedAt = Date.now();
    if (exceeded()) return false;
  }
  return true;
}

async function recheckPending(run: FinanceRun, cursor: TaskCursor, exceeded: () => boolean, save: () => Promise<void>): Promise<boolean> {
  const refreshed = new Map<string, Transaction[]>();
  let lastSavedAt = Date.now();
  for (const item of bySk(await run.state.list("FINANCE_PENDING"))) {
    const key = text(item.sk);
    if (key <= cursor.pendingAfter) continue;
    if (exceeded()) return false;
    const stage = text(item.stage);
    if (PENDING_STAGES.includes(stage) && item.transaction && typeof item.transaction === "object" && !Array.isArray(item.transaction)) {
      const nextAt = Date.parse(text(item.nextAt));
      if (Number.isFinite(nextAt) && nextAt > Date.now()) cursor.notDue += 1;
      else count(cursor, await recheck(run, item, stage, item.transaction as Transaction, refreshed));
    }
    cursor.pendingAfter = key;
    if (Date.now() - lastSavedAt >= 60_000) {
      await save();
      lastSavedAt = Date.now();
    }
  }
  return true;
}

async function recheck(run: FinanceRun, item: Record<string, unknown>, stage: string, stored: Transaction, refreshed: Map<string, Transaction[]>): Promise<Applied> {
  let current = stored;
  const key = uniqueKey(stored);
  const orderId = idValue(stored, "ORDER_ID");
  if (stage === "waiting_release" && ORDER_ID_PATTERN.test(orderId)) {
    const transactions = refreshed.get(orderId) ?? await orderTransactions(run.amazon, orderId);
    refreshed.set(orderId, transactions);
    current = transactions.find((fact) => uniqueKey(fact) === key) ?? stored;
  }
  if (sameTransaction(await run.state.get("FINANCE", key), current)) {
    // Already applied (the FINANCE_PENDING delete after the FINANCE write did not land, or the list was stale): drop the leftover pointer.
    await run.state.delete("FINANCE_PENDING", key);
    return { outcome: "done", applied: false };
  }
  if (stage === "waiting_release" && sameTransaction(item, current)) {
    await run.state.put({ ...item, nextAt: new Date(Date.now() + RECHECK_MS).toISOString(), checkedAt: new Date().toISOString() });
    return { outcome: "waiting_release", applied: false };
  }
  return { outcome: await applyFinanceWithDetailWait(run.config, run.state, run.amazon, run.feishu, current, { forcedDestination: item.destination === "shipment" ? "shipment" : undefined, schedule: run.schedule }), applied: true };
}

async function recheckUnmatched(run: FinanceRun, cursor: TaskCursor, exceeded: () => boolean, save: () => Promise<void>): Promise<boolean> {
  let lastSavedAt = Date.now();
  for (const item of bySk(await run.state.list("SHIPMENT_FINANCE_UNMATCHED"))) {
    const key = text(item.sk);
    if (key <= cursor.unmatchedAfter) continue;
    if (exceeded()) return false;
    if (item.status === "pending" && item.transaction && typeof item.transaction === "object" && !Array.isArray(item.transaction)) {
      const result = await applyChanged(run, item.transaction as Transaction, "shipment");
      if (result.outcome === "done") await run.state.put({ ...item, status: "done", resolvedAt: new Date().toISOString() });
      count(cursor, result);
    }
    cursor.unmatchedAfter = key;
    if (Date.now() - lastSavedAt >= 60_000) {
      await save();
      lastSavedAt = Date.now();
    }
  }
  return true;
}

async function advanceCheckpoint(state: StateStore, until: string): Promise<void> {
  const current = Date.parse(text((await state.get("CHECKPOINT", "finance"))?.until));
  if (Number.isFinite(current) && current >= Date.parse(until)) return;
  await state.put({ pk: "CHECKPOINT", sk: "finance", until, overlapDays: 7, updatedAt: new Date().toISOString() });
}

async function dailyCursor(run: FinanceRun): Promise<TaskCursor> {
  const endMs = Date.now() - 180_000;
  const until = Date.parse(text((await run.state.get("CHECKPOINT", "finance"))?.until));
  const oldest = endMs - 179 * 86_400_000;
  const configured = Date.parse(run.config.optional("FINANCE_START_DATE", "2025-04-01T00:00:00.000Z"));
  const startMs = Number.isFinite(until) ? Math.min(until, endMs) - 7 * 86_400_000 : Number.isFinite(configured) ? Math.max(configured, oldest) : oldest;
  const startTime = new Date(startMs).toISOString();
  return {
    mode: "daily", phase: "scan", startTime, endTime: new Date(endMs).toISOString(), windowStartTime: startTime, windowEndTime: new Date(Math.min(startMs + WINDOW_MS, endMs)).toISOString(),
    pageOffset: 0, pageHash: "", pendingAfter: "", unmatchedAfter: "", processed: 0, skipped: 0, deferred: 0, waitingDetail: 0, notDue: 0,
  };
}

function resumeCursor(saved: JsonObject, mode: "daily" | "legacy"): TaskCursor {
  const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const startTime = text(saved.startTime);
  const endTime = text(saved.endTime);
  const windowStartTime = text(saved.windowStartTime) || startTime;
  const phase = mode === "daily" && (["scan", "pending", "unmatched"] as const).find((value) => value === saved.phase) || "scan";
  return {
    mode, phase, startTime, endTime, windowStartTime,
    windowEndTime: text(saved.windowEndTime) || new Date(Math.min(Date.parse(windowStartTime) + WINDOW_MS, Date.parse(endTime))).toISOString(),
    pageOffset: number(saved.pageOffset), pageHash: text(saved.pageHash),
    pendingAfter: mode === "daily" ? text(saved.pendingAfter) : "", unmatchedAfter: mode === "daily" ? text(saved.unmatchedAfter) : "",
    processed: number(saved.processed), skipped: number(saved.skipped), deferred: number(saved.deferred), waitingDetail: number(saved.waitingDetail), notDue: number(saved.notDue),
  };
}

export function financeRunMode(event: JobEvent, task: Record<string, unknown> | undefined): "terminal" | "wake" | "supersede" | "legacy" | "daily" {
  const status = text(task?.status);
  const saved = (task?.state ?? {}) as Record<string, unknown>;
  if (TERMINAL_STATUSES.includes(status)) return "terminal";
  if (saved.sourceEvent !== undefined && saved.sourceEvent !== null) return "wake";
  if (LEGACY_WAITING_STATUSES.includes(status)) return "supersede";
  if (typeof event.cursor?.startTime === "string" && typeof event.cursor?.endTime === "string" && status !== "active") return "supersede";
  return status === "active" && saved.mode !== "daily" ? "legacy" : "daily";
}

async function supersede(run: FinanceRun, task: Record<string, unknown> | undefined): Promise<JsonObject> {
  const previousStatus = text(task?.status);
  const previous = task?.state && typeof task.state === "object" && !Array.isArray(task.state) ? task.state as JsonObject : {};
  await run.state.saveTask("finance", run.taskId, { ...previous, previousStatus, supersededAt: new Date().toISOString() }, "superseded");
  return { status: "done", superseded: true, mode: "superseded", taskId: run.taskId, previousStatus };
}

async function runWake(run: FinanceRun, saved: JsonObject): Promise<JsonObject> {
  const startedAt = Date.now();
  const notice = saved.notice && typeof saved.notice === "object" && !Array.isArray(saved.notice) ? saved.notice : transactionUpdateFacts(saved.payload);
  const orderId = ORDER_ID_PATTERN.test(text(notice.orderId)) ? text(notice.orderId) : "";
  const posted = Date.parse(text(notice.postedDate) || text(saved.occurredAt));
  const tally: Tally = { processed: 0, skipped: 0, deferred: 0, waitingDetail: 0 };
  const exceeded = (): boolean => Date.now() - startedAt >= WAKE_BUDGET_MS;
  const summary = (): JsonObject => ({ mode: "wake", taskId: run.taskId, ...(orderId ? { orderId } : {}), ...tally });
  const deferToDaily = async (reason: string): Promise<JsonObject> => {
    // The daily run's overlap scan and FINANCE_PENDING recheck own whatever this wake could not finish.
    await run.state.put({ pk: "TASK#finance", sk: run.taskId, module: "finance", status: "deferred_to_daily", state: { ...saved, deferredReason: reason, ...tally }, updatedAt: new Date().toISOString(), expiresAt: completedTaskExpiresAt() });
    return { status: "done", deferredToDaily: true, reason, ...summary() };
  };
  try {
    if (orderId) {
      for (const transaction of await orderTransactions(run.amazon, orderId)) {
        count(tally, await applyChanged(run, transaction));
        if (exceeded()) return deferToDaily("budget");
      }
    } else if (!Number.isFinite(posted)) return deferToDaily("missing_posted_date");
    else {
      const startTime = new Date(posted - WINDOW_MS).toISOString();
      const endMs = Math.min(Date.now() - 180_000, posted + WINDOW_MS);
      const window: ScanCursor = { startTime, endTime: new Date(endMs).toISOString(), windowStartTime: startTime, windowEndTime: new Date(Math.min(posted, endMs)).toISOString(), pageOffset: 0, pageHash: "" };
      if (Date.parse(startTime) < endMs && !await scanWindows(run, window, tally, exceeded, async () => undefined)) return deferToDaily("budget");
    }
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 429) throw error;
    const retries = Number(saved.rateLimitRetries ?? 0);
    if (retries >= WAKE_RATE_LIMIT_RETRIES) return deferToDaily("rate_limited");
    const nextAt = new Date(Date.now() + 15 * 60_000);
    await run.state.saveTask("finance", run.taskId, { ...saved, rateLimitRetries: retries + 1 }, "waiting_rate_limit", nextAt.toISOString());
    await run.schedule({ taskType: "finance", taskId: run.taskId, scheduledAt: nextAt.toISOString() }, nextAt);
    return { status: "waiting_rate_limit", nextAt: nextAt.toISOString(), retries: retries + 1, ...summary() };
  }
  await run.state.saveTask("finance", run.taskId, { ...saved, ...tally }, "done");
  return { status: "done", ...summary() };
}

async function runScanTask(run: FinanceRun, task: Record<string, unknown> | undefined, mode: "daily" | "legacy"): Promise<JsonObject> {
  const startedAt = Date.now();
  const saved = (task?.state ?? {}) as JsonObject;
  const resumable = !!text(saved.startTime) && !!text(saved.endTime) && (mode === "legacy" || saved.mode === "daily");
  if (mode === "legacy" && !resumable) return supersede(run, task);
  const cursor = resumable ? resumeCursor(saved, mode) : await dailyCursor(run);
  const snapshot = (): JsonObject => ({ ...cursor });
  const sliceNextAt = new Date(startedAt + 15 * 60_000).toISOString();
  const save = async (): Promise<void> => { await run.state.saveTask("finance", run.taskId, snapshot(), "active", sliceNextAt); };
  const exceeded = (): boolean => Date.now() - startedAt >= SLICE_BUDGET_MS;
  const result = (status: string): JsonObject => ({ status, mode: cursor.mode, taskId: run.taskId, phase: cursor.phase, processed: cursor.processed, skipped: cursor.skipped, deferred: cursor.deferred, waitingDetail: cursor.waitingDetail, notDue: cursor.notDue });
  const continueLater = async (): Promise<JsonObject> => {
    const nextAt = new Date(Date.now() + 60_000);
    await run.state.saveTask("finance", run.taskId, snapshot(), "active", nextAt.toISOString());
    await run.schedule({ taskType: "finance", taskId: run.taskId, scheduledAt: nextAt.toISOString() }, nextAt);
    return result("active");
  };
  const finish = async (): Promise<JsonObject> => {
    await run.state.saveTask("finance", run.taskId, snapshot(), "done");
    return result("done");
  };
  // A pending 429 deferral count survives until this slice makes progress, so handlers/jobs.ts can cap consecutive deferrals.
  const retries = Number(saved.financeRateLimitRetries ?? 0);
  await run.state.saveTask("finance", run.taskId, { ...snapshot(), ...(retries > 0 ? { financeRateLimitRetries: retries } : {}) }, "active", sliceNextAt);
  if (cursor.phase === "scan") {
    if (!await scanWindows(run, cursor, cursor, exceeded, save)) return continueLater();
    if (cursor.mode === "legacy") return finish();
    cursor.phase = "pending";
    await save();
  }
  if (cursor.phase === "pending") {
    if (!await recheckPending(run, cursor, exceeded, save)) return continueLater();
    cursor.phase = "unmatched";
    await save();
  }
  if (!await recheckUnmatched(run, cursor, exceeded, save)) return continueLater();
  await advanceCheckpoint(run.state, cursor.endTime);
  return finish();
}

// Modes: legacy chains (waiting_* or +24h follow-ups carrying a cursor) are superseded; tasks holding a sourceEvent are one-shot wakes;
// an old active scan may finish its cursor; everything else is the daily run, which ends done and never schedules itself for +24h.
export async function runFinance(event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient, schedule: Schedule = ensureOneTimeSchedule): Promise<JsonObject> {
  const taskId = event.taskId ?? `finance|${event.scheduledAt ?? new Date().toISOString()}`;
  const task = await state.task("finance", taskId);
  const run: FinanceRun = { config, state, amazon, feishu, schedule, taskId };
  const mode = financeRunMode(event, task);
  if (mode === "terminal") return { status: "done", mode, taskId, taskStatus: text(task?.status) };
  if (mode === "supersede") return supersede(run, task);
  if (mode === "wake") return runWake(run, (task?.state ?? {}) as JsonObject);
  return runScanTask(run, task, mode);
}
