import type { Json, JsonObject } from "../types.js";
import { AmazonClient, type Pace } from "../clients/amazon.js";

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
const text = (value: unknown): string => String(value ?? "").trim();
const amountOf = (money: unknown): number => Number((money as Row | undefined)?.amount);

export const MARKETPLACE_US = "ATVPDKIKX0DER";
export const COMPETITIVE_SUMMARY_PATH = "/batches/products/pricing/2022-05-01/items/competitiveSummary";
export const COMPETITIVE_SUMMARY_BATCH = 20;
// getCompetitiveSummary 官方 0.033 次/秒、突发 1：同一进程内批间至少 31 秒。
export const COMPETITIVE_SUMMARY_PACE: Pace = { key: "products-competitiveSummary", minIntervalMs: 31_000 };
export type SummaryData = "featuredBuyingOptions" | "referencePrices" | "lowestPricedOffers" | "similarItems";
// 竞品价任务的取数口径；竞品清单刷新查候选报价时用同一口径，以便同一轮比价直接复用。
export const PRICE_SUMMARY_DATA: SummaryData[] = ["featuredBuyingOptions", "referencePrices", "lowestPricedOffers"];

export interface OfferPromotion { type: string; text: string }
export interface OfferView { sellerId: string; fulfillmentType: string; landed: number; currency: string; weight: number; membership: string; promotions: OfferPromotion[] }
// similar：亚马逊“相似商品”ASIN（2026-10-05 实测为 similarItems[].items[].asin，在售 ASIN 每个 7 条、不在售的为空），保持亚马逊给出的顺序。
export interface SummaryView { asin: string; ok: boolean; error: string; featured: OfferView[]; lowestNew?: OfferView; similar: string[] }

function describeDiscount(discount: Row | undefined): string {
  const type = text(discount?.type).toUpperCase();
  if (type === "PERCENTAGE_OFF" && Number.isFinite(Number(discount?.percentOff))) return `${Number(discount!.percentOff)}%`;
  if (type === "AMOUNT_OFF" && Number.isFinite(amountOf(discount?.amountOff))) return `$${amountOf(discount!.amountOff).toFixed(2)}`;
  return "";
}

function firstNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") for (const item of Object.values(value as Row)) { const found = firstNumber(item); if (Number.isFinite(found)) return found; }
  return Number.NaN;
}

// 竞品促销：类型（COUPON/DEAL/BASKET_BUILDING=满减）＋折扣；满减另带门槛。
export function offerPromotions(offer: Row): OfferPromotion[] {
  return rows(offer.promotions).map((promotion) => {
    const type = text(promotion.promotionType).toUpperCase();
    const savings = (promotion.promotionSavings ?? {}) as Row;
    const discount = describeDiscount(savings.discount as Row | undefined);
    const discounted = amountOf(savings.discountedPrice);
    const condition = (((promotion.purchaseRequirements ?? {}) as Row).condition ?? {}) as Row;
    const quantity = firstNumber(condition.quantityThreshold);
    const spend = firstNumber(condition.amountThreshold);
    const threshold = Number.isFinite(quantity) ? `满 ${quantity} 件` : Number.isFinite(spend) ? `满 $${spend.toFixed(2)}` : "";
    const label = type === "BASKET_BUILDING" ? "满减" : type || "促销";
    const parts = [discount && `减 ${discount}`, Number.isFinite(discounted) ? `到手 $${discounted.toFixed(2)}` : "", threshold].filter(Boolean);
    return { type, text: `${label}${parts.length ? ` ${parts.join("，")}` : ""}` };
  }).filter((item) => item.type);
}

export function promotionSignature(promotions: OfferPromotion[]): string {
  return [...new Set(promotions.map((item) => item.text))].sort().join("；");
}

function view(offer: Row, weight: number, membership: string): OfferView | undefined {
  const listing = amountOf(offer.listingPrice);
  if (!Number.isFinite(listing) || listing < 0) return undefined;
  const options = rows(offer.shippingOptions);
  const shipping = options.find((item) => text(item.shippingOptionType).toUpperCase() === "DEFAULT") ?? options[0];
  const shippingAmount = shipping ? amountOf(shipping.price) : 0;
  const landed = Math.round((listing + (Number.isFinite(shippingAmount) ? shippingAmount : 0) + Number.EPSILON) * 100) / 100;
  return { sellerId: text(offer.sellerId), fulfillmentType: text(offer.fulfillmentType).toUpperCase(), landed, currency: text((offer.listingPrice as Row).currencyCode).toUpperCase(), weight, membership, promotions: offerPromotions(offer) };
}

const isNew = (value: unknown): boolean => !text(value) || text(value).toUpperCase() === "NEW";

export function parseSummary(asin: string, response: Row | undefined): SummaryView {
  const status = Number(((response?.status ?? {}) as Row).statusCode);
  const body = (response?.body ?? {}) as Row;
  const errors = rows(body.errors);
  if (!response || (Number.isFinite(status) && status !== 200) || errors.length) return { asin, ok: false, error: errors.map((item) => text(item.code)).filter(Boolean).join(",") || `HTTP ${Number.isFinite(status) ? status : "?"}`, featured: [], similar: [] };
  const featured: OfferView[] = [];
  for (const option of rows(body.featuredBuyingOptions)) {
    if (!isNew(option.buyingOptionType)) continue;
    for (const offer of rows(option.segmentedFeaturedOffers)) {
      if (!isNew(offer.condition)) continue;
      const segments = rows(offer.featuredOfferSegments);
      if (!segments.length) { const item = view(offer, 0, ""); if (item) featured.push(item); }
      for (const segment of segments) {
        const weight = Number(((segment.segmentDetails ?? {}) as Row).glanceViewWeightPercentage);
        const item = view(offer, Number.isFinite(weight) ? weight : 0, text(segment.customerMembership));
        if (item) featured.push(item);
      }
    }
  }
  featured.sort((a, b) => b.weight - a.weight);
  let lowestNew: OfferView | undefined;
  for (const group of rows(body.lowestPricedOffers)) {
    const input = (group.lowestPricedOffersInput ?? {}) as Row;
    if (!isNew(input.itemCondition)) continue;
    for (const offer of rows(group.offers)) {
      if (!isNew(offer.condition)) continue;
      const item = view(offer, 0, "");
      if (item && (!lowestNew || item.landed < lowestNew.landed)) lowestNew = item;
    }
  }
  const similar = [...new Set(rows(body.similarItems).flatMap((group) => rows(group.items)).map((item) => text(item.asin).toUpperCase()).filter((item) => /^[A-Z0-9]{10}$/.test(item) && item !== asin.toUpperCase()))];
  return { asin, ok: true, error: "", featured, ...(lowestNew ? { lowestNew } : {}), similar };
}

// 每批最多 20 个 ASIN，POST 批量接口；按 ASIN 返回解析结果（单个 ASIN 失败不影响同批其它 ASIN）。
export async function competitiveSummaries(amazon: AmazonClient, asins: string[], includedData: SummaryData[]): Promise<Map<string, SummaryView>> {
  const output = new Map<string, SummaryView>();
  for (let offset = 0; offset < asins.length; offset += COMPETITIVE_SUMMARY_BATCH) {
    const chunk = asins.slice(offset, offset + COMPETITIVE_SUMMARY_BATCH);
    const requests: Json[] = chunk.map((asin) => ({
      asin, marketplaceId: MARKETPLACE_US, includedData: [...includedData],
      ...(includedData.includes("lowestPricedOffers") ? { lowestPricedOffersInputs: [{ itemCondition: "New", offerType: "Consumer" }] } : {}),
      method: "GET", uri: "/products/pricing/2022-05-01/items/competitiveSummary",
    }));
    const response = await amazon.sp<JsonObject>(COMPETITIVE_SUMMARY_PATH, { method: "POST", body: { requests }, pace: COMPETITIVE_SUMMARY_PACE });
    const responses = rows(response.responses);
    const byAsin = new Map(responses.map((item) => [text(((item.body ?? {}) as Row).asin), item]));
    // 失败项的 body 可能不带 asin：批量响应与请求同序，按位置兜底。
    chunk.forEach((asin, index) => output.set(asin, parseSummary(asin, byAsin.get(asin) ?? (text(((responses[index]?.body ?? {}) as Row).asin) ? undefined : responses[index]))));
  }
  return output;
}
