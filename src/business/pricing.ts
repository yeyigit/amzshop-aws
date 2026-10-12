import type { AppConfig, FeishuRecord, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { feishuFieldText, feishuRelationRecordIds } from "../util.js";

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value as Row[] : [];
const text = (value: unknown): string => String(value ?? "").trim();
const money = (value: unknown): number | null => { if (value === null || value === undefined || value === "") return null; const result = Number(value); return Number.isFinite(result) && result >= 0 ? Math.round((result + Number.EPSILON) * 100) / 100 : null; };

interface Listing { sku: string; asin: string; activeKnown: boolean; active: boolean; regular: number | null; sale: number | null; reason: string }
// 「价格观察时间」已于 2026-10-06 删除：与两个“最后成功同步时间”重复，原先的防旧写判断取的是写入时刻，起不到作用。
const fields = {
  regular: "AMZ售价", sale: "AMZ促销价", coupon: "AMZ Coupon后价", prime: "AMZ Prime专享价", deal: "AMZ Deal价",
  calculation: "活动计算价", status: "价格同步状态", regularSuccessAt: "常规价最后成功同步时间",
  activitySuccessAt: "活动最后成功同步时间", note: "活动说明",
} as const;

export function buildProfitRegistry(skuRecords: FeishuRecord[], profitRecords: FeishuRecord[]): { bySku: Map<string, FeishuRecord>; duplicates: string[]; unmapped: string[] } {
  const skuByRecordId = new Map<string, string>();
  for (const record of skuRecords) { const sku = feishuFieldText(record.fields["SKU编号"]); if (sku) skuByRecordId.set(record.record_id, sku); }
  const candidates = new Map<string, FeishuRecord[]>();
  const unmapped: string[] = [];
  for (const record of profitRecords) {
    const raw = record.fields["SKU编号"];
    let skus = [...new Set(feishuRelationRecordIds(raw).map((id) => skuByRecordId.get(id) ?? "").filter(Boolean))];
    if (!skus.length) { const direct = feishuFieldText(raw); if (direct) skus = [direct]; }
    if (skus.length !== 1) { unmapped.push(record.record_id); continue; }
    candidates.set(skus[0]!, [...(candidates.get(skus[0]!) ?? []), record]);
  }
  const bySku = new Map<string, FeishuRecord>();
  const duplicates: string[] = [];
  for (const [sku, records] of candidates) records.length === 1 ? bySku.set(sku, records[0]!) : duplicates.push(sku);
  return { bySku, duplicates, unmapped };
}

function scheduleActive(schedule: Row, now: number): boolean {
  const start = Date.parse(text(schedule.start_at ?? schedule.startDate));
  const end = Date.parse(text(schedule.end_at ?? schedule.endDate));
  return (!Number.isFinite(start) || start <= now) && (!Number.isFinite(end) || now <= end);
}

function schedulePrice(groups: Row[], now: number, currency: string): number | null {
  const prices: number[] = [];
  for (const group of groups) {
    const groupCurrency = text(group.currency ?? group.currencyCode ?? currency).toUpperCase();
    for (const schedule of rows(group.schedule)) {
      const scheduleCurrency = text(schedule.currency ?? schedule.currencyCode ?? groupCurrency).toUpperCase();
      const value = money(schedule.value_with_tax ?? schedule.value);
      if (scheduleCurrency === currency && value !== null && scheduleActive(schedule, now)) prices.push(value);
    }
  }
  return prices.length ? Math.min(...prices) : null;
}

function listing(item: Row, fba: Map<string, number>, now: number): Listing {
  const sku = text(item.sku);
  const summary = rows(item.summaries).find((entry) => text(entry.marketplaceId) === "ATVPDKIKX0DER") ?? {};
  const asin = text(summary.asin ?? item.asin);
  const statusValue = summary.status ?? summary.statuses;
  const statuses = Array.isArray(statusValue) ? statusValue.map(text) : [];
  if (statuses.length && !statuses.includes("BUYABLE")) return { sku, asin, activeKnown: true, active: false, regular: null, sale: null, reason: "Listing 非 BUYABLE" };
  let quantity = 0;
  let known = false;
  for (const availability of rows(item.fulfillmentAvailability)) {
    const channel = text(availability.fulfillmentChannelCode).toUpperCase();
    if (channel.includes("AMAZON") || channel === "AFN") continue;
    const value = money(availability.quantity);
    if (value !== null) { quantity += value; known = true; }
  }
  if (fba.has(sku)) { quantity += fba.get(sku) ?? 0; known = true; }
  if (!known) return { sku, asin, activeKnown: false, active: false, regular: null, sale: null, reason: "可售库存未知" };
  if (quantity <= 0) return { sku, asin, activeKnown: true, active: false, regular: null, sale: null, reason: "可售库存为0" };
  const regular: number[] = [];
  const sale: number[] = [];
  const attributes = (item.attributes ?? {}) as Row;
  for (const offer of rows(attributes.purchasable_offer)) {
    if (text(offer.marketplace_id) !== "ATVPDKIKX0DER" || text(offer.audience).toUpperCase() !== "ALL" || text(offer.currency).toUpperCase() !== "USD") continue;
    const normal = schedulePrice(rows(offer.our_price), now, "USD");
    const discounted = schedulePrice(rows(offer.discounted_price), now, "USD");
    if (normal !== null) regular.push(normal);
    if (discounted !== null) sale.push(discounted);
  }
  if (!regular.length) return { sku, asin, activeKnown: true, active: true, regular: null, sale: null, reason: "缺少 US/ALL/USD our_price" };
  return { sku, asin, activeKnown: true, active: true, regular: Math.min(...regular), sale: sale.length ? Math.min(...sale) : null, reason: "" };
}

async function fbaMap(amazon: AmazonClient): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  let nextToken = "";
  do {
    const response = await amazon.sp<JsonObject>("/fba/inventory/v1/summaries", { query: { granularityType: "Marketplace", granularityId: "ATVPDKIKX0DER", marketplaceIds: "ATVPDKIKX0DER", details: true, ...(nextToken ? { nextToken } : {}) } });
    const payload = (response.payload ?? {}) as JsonObject;
    if (!Array.isArray(payload.inventorySummaries)) throw new Error("FBA Inventory 响应缺少 inventorySummaries。 ");
    for (const item of rows(payload.inventorySummaries)) {
      const sku = text(item.sellerSku ?? item.sellerSKU);
      const quantity = Number(((item.inventoryDetails ?? {}) as Row).fulfillableQuantity);
      if (sku && Number.isFinite(quantity) && quantity >= 0) result.set(sku, (result.get(sku) ?? 0) + quantity);
    }
    // 官方 pagination 在响应顶层（与 payload 并列）。
    nextToken = text((response.pagination as JsonObject | undefined)?.nextToken ?? (payload.pagination as JsonObject | undefined)?.nextToken ?? payload.nextToken);
  } while (nextToken);
  return result;
}

async function listings(amazon: AmazonClient, sellerId: string, inventory: Map<string, number>): Promise<Listing[]> {
  const output: Listing[] = [];
  let pageToken = "";
  const seen = new Set<string>();
  const now = Date.now();
  do {
    const response = await amazon.sp<JsonObject>(`/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`, { query: { marketplaceIds: "ATVPDKIKX0DER", includedData: "summaries,attributes,offers,fulfillmentAvailability", withStatus: "BUYABLE", pageSize: 20, ...(pageToken ? { pageToken } : {}) } });
    if (!Array.isArray(response.items)) throw new Error("Listings Items 响应缺少 items。 ");
    output.push(...rows(response.items).map((item) => listing(item, inventory, now)));
    pageToken = text((response.pagination as JsonObject | undefined)?.nextToken);
    if (pageToken && seen.has(pageToken)) throw new Error("Listings Items pageToken 重复。 ");
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  return output;
}

let cachedSellerId = "";
export function resetSellerIdCache(): void { cachedSellerId = ""; }

// 配置参数优先；传入 state 时依次用实例内缓存、状态表 CACHE/sellerId，都缺失才用 Finances 反推一次并落盘，避免每小时占用 Finances 配额。
export async function resolveSellerId(config: AppConfig, amazon: AmazonClient, state?: StateStore): Promise<string> {
  const configured = ["SP_API_SELLER_ID", "SELLER_ID", "MERCHANT_ID"].map((key) => config.optional(key).trim()).find(Boolean);
  if (configured) return configured;
  if (state && cachedSellerId) return cachedSellerId;
  const stored = state ? text((await state.get("CACHE", "sellerId"))?.value) : "";
  if (stored) return cachedSellerId = stored;
  const postedBefore = new Date(Date.now() - 48 * 3_600_000);
  const postedAfter = new Date(postedBefore.getTime() - 179 * 86_400_000);
  const response = await amazon.sp<JsonObject>("/finances/2024-06-19/transactions", { query: { postedAfter: postedAfter.toISOString(), postedBefore: postedBefore.toISOString() } });
  const payload = (response.payload ?? response) as JsonObject;
  const sellerIds = new Set(rows(payload.transactions).map((transaction) => {
    const metadata = (transaction.sellingPartnerMetadata ?? transaction.SellingPartnerMetadata ?? {}) as Row;
    return text(metadata.sellingPartnerId ?? metadata.SellingPartnerId ?? transaction.sellerId);
  }).filter(Boolean));
  if (sellerIds.size !== 1) throw new Error("无法从受控配置或 Finances API 唯一确定 Selling Partner ID；请配置 SP_API_SELLER_ID。");
  const sellerId = [...sellerIds][0]!;
  if (state) {
    await state.put({ pk: "CACHE", sk: "sellerId", value: sellerId, source: "finances-2024-06-19", resolvedAt: new Date().toISOString() });
    cachedSellerId = sellerId;
  }
  return sellerId;
}

async function selection(amazon: AmazonClient, promotion: Row): Promise<Row> {
  const select = (promotion.selection ?? {}) as Row;
  if (text(select.type).toUpperCase() !== "ITEMS") return promotion;
  const id = text(select.selectionId);
  const revisionId = Number(select.revisionId);
  if (!id || !Number.isFinite(revisionId)) throw new Error("Promotions selection 缺少 selectionId/revisionId。 ");
  let paginationToken = "";
  const items: Row[] = [];
  const issues: Row[] = [];
  do {
    const response = await amazon.sp<JsonObject>(`/promotions/2025-12-01/promotions/${encodeURIComponent(text(promotion.promotionId))}/selections/${encodeURIComponent(id)}`, { query: { revisionId, locale: "en_US", limit: 100, includedData: "ISSUES", ...(paginationToken ? { paginationToken } : {}) } });
    const pageSelection = (response.selection ?? {}) as Row;
    const details = (pageSelection.selectionDetails ?? {}) as Row;
    if (!Array.isArray(details.items)) throw new Error("Promotions selection 响应缺少 items。 ");
    items.push(...rows(details.items));
    issues.push(...rows(details.issues));
    paginationToken = text((details.pagination as Row | undefined)?.nextToken);
  } while (paginationToken);
  return { ...promotion, selection: { ...select, selectionDetails: { items, issues } } };
}

async function promotions(amazon: AmazonClient, activeListings: Listing[]): Promise<{ available: boolean; items: Row[]; reason: string }> {
  try {
    const summaries = new Map<string, Row>();
    for (let offset = 0; offset < activeListings.length; offset += 10) {
      let paginationToken = "";
      do {
        const page = await amazon.sp<JsonObject>("/promotions/2025-12-01/promotions", { query: { marketplaceIds: "ATVPDKIKX0DER", statuses: "RUNNING", promotionTypes: "COUPON,DEAL,PRICE_DISCOUNT", skus: activeListings.slice(offset, offset + 10).map((item) => item.sku).join(","), revision: "PUBLISHED", limit: 100, includedData: "ISSUES,CUSTOMER_SEGMENTS", ...(paginationToken ? { paginationToken } : {}) } });
        if (!Array.isArray(page.promotions)) throw new Error("Promotions 响应缺少 promotions。 ");
        for (const item of rows(page.promotions)) if (text(item.promotionId)) summaries.set(text(item.promotionId), item);
        paginationToken = text((page.pagination as Row | undefined)?.nextToken);
      } while (paginationToken);
    }
    const result: Row[] = [];
    for (const id of summaries.keys()) {
      const detail = await amazon.sp<JsonObject>(`/promotions/2025-12-01/promotions/${encodeURIComponent(id)}`, { query: { includedData: "ISSUES,SELECTION,CUSTOMER_SEGMENTS", locale: "en_US" } });
      if (text(detail.promotionId) !== id) throw new Error("Promotions 详情 ID 不匹配。 ");
      result.push(await selection(amazon, detail as Row));
    }
    return { available: true, items: result, reason: "" };
  } catch (error) {
    return { available: false, items: [], reason: error instanceof Error ? error.message : String(error) };
  }
}

function hasError(promotion: Row, sku: string, asin: string): boolean {
  const top = rows(promotion.issues);
  const details = (((promotion.selection ?? {}) as Row).selectionDetails ?? {}) as Row;
  return [...top, ...rows(details.issues)].some((issue) => {
    if (text(issue.severity).toUpperCase() !== "ERROR") return false;
    const id = (issue.identifier ?? {}) as Row;
    return (!text(id.sku) && !text(id.asin)) || text(id.sku) === sku || text(id.asin) === asin;
  });
}

function applyDiscount(base: number, benefit: Row): number | null {
  if (text(benefit.type).toUpperCase() === "FIXED_PRICE") {
    const price = (benefit.price ?? {}) as Row;
    return text(price.currencyCode).toUpperCase() === "USD" ? money(price.amount) : null;
  }
  const discount = (benefit.discount ?? benefit) as Row;
  if (text(discount.type).toUpperCase() === "PERCENTAGE_OFF") {
    const percent = Number(discount.percentOff);
    return Number.isFinite(percent) && percent > 0 && percent <= 100 ? money(base * (1 - percent / 100)) : null;
  }
  if (text(discount.type).toUpperCase() === "AMOUNT_OFF" && text(discount.currencyCode).toUpperCase() === "USD") {
    const off = money(discount.amountOff);
    return off !== null && off <= base ? money(base - off) : null;
  }
  return null;
}

const EXCLUDED_COUPON_TYPES: Record<string, string> = { SUBSCRIBE_AND_SAVE: "订阅省券", REORDER_REWARDS: "复购奖励券" };

function activity(current: Listing, all: Row[], now: number): { ok: boolean; sale: number | null; coupon: number | null; prime: number | null; deal: number | null; calculation: number | null; note: string } {
  const prices = { sale: current.sale, coupon: null as number | null, prime: null as number | null, deal: null as number | null };
  const notes: string[] = [];
  for (const promotion of all) {
    if (text(promotion.marketplaceId) !== "ATVPDKIKX0DER" || text(promotion.status).toUpperCase() !== "RUNNING" || !scheduleActive((promotion.schedule ?? {}) as Row, now)) continue;
    if (hasError(promotion, current.sku, current.asin)) return { ok: false, ...prices, calculation: null, note: "活动存在 ERROR issue" };
    const select = (promotion.selection ?? {}) as Row;
    if (text(select.type).toUpperCase() === "CATALOG") return { ok: false, ...prices, calculation: null, note: "CATALOG selection 无法确认单 SKU" };
    const details = (select.selectionDetails ?? {}) as Row;
    const matches = rows(details.items).filter((item) => text(item.sku) === current.sku || (!!current.asin && text(item.asin) === current.asin));
    if (!matches.length) continue;
    if (matches.length > 1) return { ok: false, ...prices, calculation: null, note: "活动商品选择重复" };
    const type = text(promotion.promotionType).toUpperCase();
    // 订阅省券、复购奖励券只面向订阅/复购买家，不是普通买家可领的券价；缺省 couponType 按 STANDARD。
    const couponType = text(promotion.couponType).toUpperCase();
    if (type === "COUPON" && EXCLUDED_COUPON_TYPES[couponType]) { notes.push(`COUPON/${couponType}（${EXCLUDED_COUPON_TYPES[couponType]}，不计入 Coupon 后价）`); continue; }
    const segments = rows(promotion.customerSegments).map((item) => text(item.segmentId).toUpperCase()).filter(Boolean);
    if (segments.some((item) => item !== "PRIME_EXCLUSIVE")) continue;
    const prime = segments.includes("PRIME_EXCLUSIVE");
    const benefit = (type === "COUPON" ? promotion.benefit : matches[0]!.benefit) as Row;
    const price = applyDiscount(current.regular!, benefit ?? {});
    if (price === null) return { ok: false, ...prices, calculation: null, note: "活动折扣无法转换为 USD 单件价格" };
    const field = type === "COUPON" ? "coupon" : type === "DEAL" ? "deal" : prime ? "prime" : "sale";
    const prior = prices[field];
    prices[field] = prior === null ? price : Math.min(prior, price);
    notes.push(`${type}${prime ? "/PRIME_EXCLUSIVE" : ""} $${price.toFixed(2)}`);
  }
  const candidates = Object.values(prices).filter((item): item is number => item !== null);
  return { ok: true, ...prices, calculation: candidates.length ? Math.min(...candidates) : null, note: notes.join("；") || "当前无有效活动" };
}

export async function runPricing(_event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient): Promise<JsonObject> {
  const inventory = await fbaMap(amazon);
  const currentListings = await listings(amazon, await resolveSellerId(config, amazon, state), inventory);
  const active = currentListings.filter((item) => item.active && item.regular !== null);
  const promotionState = await promotions(amazon, active);
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const table = config.get("FEISHU_BITABLE_TABLE_ID_PROFIT_ESTIMATE");
  const [skuRecords, records] = await Promise.all([feishu.listRecords(app, config.get("FEISHU_BITABLE_TABLE_ID_SKUS")), feishu.listRecords(app, table)]);
  const registry = buildProfitRegistry(skuRecords, records);
  // BUYABLE 列表已完整拉取：毛利润预估里不在列表中的 SKU 与非 BUYABLE 分支一样按“已退出在售范围”处理。
  const listed = new Set(currentListings.map((item) => item.sku));
  const exited = [...registry.bySku.keys()].filter((sku) => !listed.has(sku)).map((sku): Listing => ({ sku, asin: "", activeKnown: true, active: false, regular: null, sale: null, reason: "Listing 非 BUYABLE" }));
  const activityFields = [fields.sale, fields.coupon, fields.prime, fields.deal, fields.calculation];
  let updated = 0;
  for (const current of [...currentListings, ...exited]) {
    const record = registry.bySku.get(current.sku);
    if (!record) continue;
    const observedAt = Date.now();
    if (current.activeKnown && !current.active) {
      // 退出在售只需一次清理：状态、说明一致且活动字段已空时不再重复写入。
      if (feishuFieldText(record.fields[fields.status]) === "已退出在售范围" && feishuFieldText(record.fields[fields.note]) === current.reason && activityFields.every((name) => feishuFieldText(record.fields[name]) === "")) continue;
      await feishu.update(app, table, record.record_id, { [fields.sale]: null, [fields.coupon]: null, [fields.prime]: null, [fields.deal]: null, [fields.calculation]: null, [fields.status]: "已退出在售范围", [fields.note]: current.reason, [fields.activitySuccessAt]: observedAt });
      updated += 1;
      continue;
    }
    if (current.regular === null) {
      await feishu.update(app, table, record.record_id, { [fields.status]: `常规价待确认：${current.reason}` });
      continue;
    }
    const update: Record<string, unknown> = { [fields.regular]: current.regular, [fields.regularSuccessAt]: observedAt };
    if (promotionState.available) {
      const snapshot = activity(current, promotionState.items, observedAt);
      if (snapshot.ok) Object.assign(update, { [fields.sale]: snapshot.sale, [fields.coupon]: snapshot.coupon, [fields.prime]: snapshot.prime, [fields.deal]: snapshot.deal, [fields.calculation]: snapshot.calculation, [fields.activitySuccessAt]: observedAt, [fields.note]: snapshot.note, [fields.status]: "常规价已更新；活动已确认" });
      else Object.assign(update, { [fields.status]: `常规价已更新；活动待确认：${snapshot.note}` });
    } else update[fields.status] = `常规价已更新；活动待确认：${promotionState.reason}`;
    await feishu.update(app, table, record.record_id, update);
    updated += 1;
  }
  return { status: "done", listings: currentListings.length, active: active.length, updated, duplicateProfitSkus: registry.duplicates.length, unmappedProfitRows: registry.unmapped.length, promotionsAvailable: promotionState.available };
}
