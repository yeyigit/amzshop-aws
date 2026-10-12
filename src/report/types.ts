// 店铺报告的数据形状：Jobs 写入状态表（REPORT_DAY/<日期>、REPORT_MONTH/<月份>、REPORT_META/state），中台只读。
// 每一块独立可缺：缺失（undefined）表示这一块还没取到或取数失败，页面显示“—”，绝不当 0。
export const REPORT_DAY_PK = "REPORT_DAY";
export const REPORT_MONTH_PK = "REPORT_MONTH";
export const REPORT_META_PK = "REPORT_META";
// 数据结构变了就加 1：旧版本的日数据在下次运行时整体重算（未定稿的）或保持原样（已定稿的）。
export const REPORT_SCHEMA = 1;

export type SourceKey = "sales" | "lines" | "ads" | "skuAds" | "traffic" | "refunds" | "costs" | "inventory" | "reasons";
export type SourceStatus = "ok" | "estimate" | "pending" | "failed" | "unavailable";
export interface SourceState { status: SourceStatus; at?: string; note?: string }

// 亚马逊销售接口（与后台“销售快照”一致；不含已取消）。
export interface SalesPart { units: number; orders: number; sales: number; b2bUnits?: number; b2bSales?: number; currency: string }

// 订单逐行（全部订单报告 ∪ 飞书订单表，只算亚马逊订单、不含已取消）。费用都记正数；profit＝revenue−promo−commission−fba−cogs−storageEst。
export interface LinePart {
  lines: number; units: number; revenue: number; promo: number; commission: number; fba: number; cogs: number; storageEst: number; profit: number;
  estimatedLines: number; costMissingLines: number; costMissingUnits: number; missingInFeishu: number; missingInReport: number; duplicateKeys: number;
}

// 广告：source＝report 取自「广告每日总览」（SP 报表）；estimate＝报表未到时按预算表合计 × 近 14 天报表/预算比例估算，只有花费。
export interface AdsPart { source: "report" | "estimate"; spend: number; sales?: number; orders?: number; units?: number; impressions?: number; clicks?: number; budgetRaw?: number; ratio?: number }

// Data Kiosk salesAndTrafficByDate（后台业务报告口径）。
export interface TrafficPart {
  sessions: number; pageViews: number; buyBoxPct: number | null; unitSessionPct: number | null; unitsOrdered: number; orderedSales: number;
  unitsRefunded: number | null; refundRate: number | null; unitsShipped: number | null; shippedSales: number | null; feedback: number | null; negativeFeedback: number | null;
}

// 退款（REFUND_FACTS 逐笔、按入账的洛杉矶日期）：principal 为退给买家的本金与运费等（负数），feeBack 为退回的费用净额，promoBack 为冲回的促销；不计代收税。
export interface RefundPart { events: number; units: number; principal: number; feeBack: number; promoBack: number; loss: number; nonUsd: number }

// 多渠道配送单（S01-）：不是亚马逊销售，单列不进 5 个数；金额与毛利是订单表按售价的估算。
export interface OtherChannelPart { lines: number; units: number; sales: number; profit: number }

export interface SkuDay {
  units: number; revenue: number; promo: number; commission: number; fba: number; cogs: number; storageEst: number; profit: number; lines: number; estimatedLines: number; costMissing: number;
  adSpend?: number; adSales?: number; adOrders?: number; adClicks?: number; adImpressions?: number; adEstimate?: boolean;
  refundUnits?: number; refundLoss?: number;
}

export interface AsinTraffic { sessions: number; pageViews: number; buyBoxPct: number | null; unitSessionPct: number | null; units: number; sales: number }
export interface InventoryPart { fbaAvailable: number | null; inbound: number | null; awd: number | null; daysOfCover: number | null; level: string }
export interface ReasonLine { sku: string; text: string }

export interface DayChecks {
  reportLines: number | null; feishuLines: number; matched: number;
  salesVsLines: number | null; kioskVsSales: number | null;
}

export interface DayFacts {
  date: string; schema: number; version: number; status: "draft" | "final"; computedAt: string; finalAt?: string;
  sales?: SalesPart; lines?: LinePart; ads?: AdsPart; traffic?: TrafficPart; refunds?: RefundPart; other?: OtherChannelPart;
  skus: Record<string, SkuDay>; unattributedAds?: { spend: number; sales: number; orders: number };
  asinTraffic?: Record<string, AsinTraffic>; skuAsins?: Record<string, string>; clearanceSkus?: string[];
  inventory?: Record<string, InventoryPart>; inventoryAt?: string; reasons?: ReasonLine[];
  sources: Partial<Record<SourceKey, SourceState>>; checks?: DayChecks;
}

export type FeeKind = "storage" | "awdStorage" | "ltsf" | "subscription" | "vine" | "disposal" | "awd" | "other" | "reimbursement" | "unclassified" | "adsInvoice";
export interface FeeLine { kind: FeeKind; name: string; amount: number; currency: string; postedMonth: string }

// 多天合计（周、月、年）。coverage 记各块有数据的天数，不足的块页面会写明“只含 N 天”。
export type CoverageKey = "sales" | "lines" | "ads" | "adsReport" | "traffic" | "refunds";
export interface PeriodTotals {
  days: number; coverage: Record<CoverageKey, number>;
  sales?: SalesPart; lines?: LinePart;
  ads?: { spend: number; sales: number; orders: number; units: number; impressions: number; clicks: number; estimateDays: number };
  traffic?: TrafficPart; refunds?: RefundPart; other?: OtherChannelPart;
  skus: Record<string, SkuDay>; unattributedAds?: { spend: number; sales: number; orders: number };
  asinTraffic?: Record<string, AsinTraffic>;
}

// 月汇总：rollup 由当月各天合计而来（年报只读 24 个月汇总，不逐天读）；fees 取自资金流水。
export interface MonthFacts {
  month: string; schema: number; status: "draft" | "final"; computedAt: string; finalAt?: string;
  rollup?: PeriodTotals; rollupThrough?: string;
  fees?: { lines: FeeLine[]; storagePosted: boolean; at: string };
  firstDraft?: { at: string; expectedProfit: number | null; netProfit: number | null; sales: number | null };
}

export interface ReportMeta { earliest: string; latest: string; updatedAt: string }
