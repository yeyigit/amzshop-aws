import type { AppConfig } from "../types.js";

// 页面数字跳飞书多维表格（用户 10/07 晚要求）：只拼地址，不调飞书接口。
// 飞书网址只认 table、view 两个参数（仪表盘也用 table=blk…），不能带筛选条件，所以只能打开表、视图或仪表盘。
export type LinkKey = "sales" | "orders" | "pending" | "adSpend" | "funds" | "payouts" | "stock" | "shipments" | "ads" | "campaigns" | "profit";
export interface PortalLink { url: string; label: string }
export type PortalLinks = Partial<Record<LinkKey, PortalLink>>;

// 默认打开各数字的来源表（表 ID 取现有配置）；label 是飞书里的表名，用于悬停提示。
const DEFAULTS: Record<LinkKey, { tableKey: string; label: string }> = {
  sales: { tableKey: "FEISHU_BITABLE_TABLE_ID_ORDERS", label: "订单表" },
  orders: { tableKey: "FEISHU_BITABLE_TABLE_ID_ORDERS", label: "订单表" },
  pending: { tableKey: "FEISHU_BITABLE_TABLE_ID_ORDERS", label: "订单表" },
  adSpend: { tableKey: "FEISHU_BITABLE_TABLE_ID_ADS", label: "广告预算表" },
  funds: { tableKey: "FEISHU_BITABLE_TABLE_ID_BALANCES", label: "亚马逊余额快照" },
  payouts: { tableKey: "FEISHU_BITABLE_TABLE_ID_PAYOUTS", label: "亚马逊放款" },
  stock: { tableKey: "FEISHU_BITABLE_TABLE_ID_INVENTORY_ALERTS", label: "库存预警" },
  shipments: { tableKey: "FEISHU_BITABLE_TABLE_ID_SHIPMENTS", label: "货件表" },
  ads: { tableKey: "FEISHU_BITABLE_TABLE_ID_ADS_DAILY_OVERVIEW", label: "广告每日总览" },
  campaigns: { tableKey: "FEISHU_BITABLE_TABLE_ID_ADS_CAMPAIGN_DAILY", label: "广告活动日报" },
  profit: { tableKey: "FEISHU_BITABLE_TABLE_ID_PROFIT_ESTIMATE", label: "毛利润预估" },
};
export const LINK_KEYS = Object.keys(DEFAULTS) as LinkKey[];

const BASE_URL = /^https:\/\/[a-z0-9-]+\.(?:feishu\.cn|larksuite\.com)\/(?:base|wiki)\/[A-Za-z0-9]+$/;
const TARGET = /^(?:tbl[A-Za-z0-9]{6,}(?:\/vew[A-Za-z0-9]{4,})?|blk[A-Za-z0-9]{6,})$/;

export function feishuUrl(base: string, target: string): string {
  const [table, view] = target.split("/");
  return `${base}?table=${table}${view ? `&view=${view}` : ""}`;
}

// PORTAL_FEISHU_BASE_URL 缺失或格式不对：数字照常显示、只是不可点。PORTAL_FEISHU_LINKS 写错的项忽略、用默认表。
export function portalLinks(config: AppConfig): PortalLinks {
  const base = config.optional("PORTAL_FEISHU_BASE_URL", "").trim().replace(/\/+$/, "");
  if (!BASE_URL.test(base)) return {};
  let overrides: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(config.optional("PORTAL_FEISHU_LINKS", "").trim() || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) overrides = parsed as Record<string, unknown>;
  } catch { overrides = {}; }
  const links: PortalLinks = {};
  for (const key of LINK_KEYS) {
    const override = (overrides[key] ?? {}) as { to?: unknown; label?: unknown };
    const custom = typeof override.to === "string" && TARGET.test(override.to.trim()) ? override.to.trim() : "";
    const target = custom || config.optional(DEFAULTS[key].tableKey, "").trim();
    if (!TARGET.test(target)) continue;
    const customLabel = typeof override.label === "string" ? override.label.trim().slice(0, 30) : "";
    const label = custom ? customLabel || "飞书多维表格" : DEFAULTS[key].label;
    links[key] = { url: feishuUrl(base, target), label };
  }
  return links;
}
