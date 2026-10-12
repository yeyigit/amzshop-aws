import type { AppConfig, FeishuRecord, JobEvent, JsonObject } from "../types.js";
import { AmazonClient } from "../clients/amazon.js";
import { FeishuClient } from "../clients/feishu.js";
import { StateStore } from "../state.js";
import { flushNotification, prepareNotification } from "../notifications.js";
import { forwarderForCarrier } from "../clients/forwarders.js";
import { FORWARDER_FIELDS } from "./forwarder-tracking.js";
import { feishuFieldText } from "../util.js";

type Row = Record<string, unknown>;
interface ShipmentItem { key: string; sku: string; fnsku: string; planned: number; received: number }
interface ShipmentModel { key: string; type: "FBA" | "AWD"; shipmentId: string; name: string; destination: string; address: string; internalId: string; status: string; createdAt: string; updatedAt: string; items: ShipmentItem[] }

const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => String(value ?? "").trim();
const number = (value: unknown): number => { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; };
const iso = (value: unknown): string => { const parsed = Date.parse(text(value)); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ""; };

function statusZh(value: unknown): string {
  const raw = text(value).toUpperCase();
  return ({ UNCONFIRMED: "未确认", WORKING: "处理中", READY_TO_SHIP: "待发货", SHIPPED: "已发货", IN_TRANSIT: "运输中", DELIVERED: "已送达", CHECKED_IN: "已登记入仓", RECEIVING: "接收中", CLOSED: "已完成", CANCELLED: "已取消", DELETED: "已删除", ERROR: "异常", ABANDONED: "已放弃", CREATED: "已创建", VOIDED: "已作废", ACTIVE: "进行中", ERRORED: "错误" } as Record<string, string>)[raw] ?? raw;
}

function groupItems(rows: Row[], key: string, asinBySku: Map<string, string>): ShipmentItem[] {
  const grouped = new Map<string, ShipmentItem>();
  for (const row of rows) {
    const sku = text(row.amazonSku ?? row.msku ?? row.sku ?? row.SellerSKU);
    if (!sku) continue;
    const current = grouped.get(sku) ?? { key: `${key}:${sku}`, sku, fnsku: text(row.fnsku ?? row.FulfillmentNetworkSKU), planned: 0, received: 0 };
    current.planned += number(row.plannedQuantity ?? row.expectedQuantity ?? row.quantity ?? row.QuantityShipped);
    current.received += number(row.receivedQuantity ?? row.QuantityReceived);
    if (!current.fnsku) current.fnsku = text(row.fnsku ?? row.FulfillmentNetworkSKU);
    grouped.set(sku, current);
    void asinBySku;
  }
  return [...grouped.values()];
}

function fbaModel(shipment: Row, items: Row[], asinBySku: Map<string, string>): ShipmentModel {
  const shipmentId = text(shipment.ShipmentId);
  const key = `FBA:${shipmentId}`;
  const name = text(shipment.ShipmentName);
  const match = name.match(/\((\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\)/);
  const createdAt = match ? new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2]), Number(match[4]), Number(match[5]))).toISOString() : "";
  return { key, type: "FBA", shipmentId, name, destination: text(shipment.DestinationFulfillmentCenterId), address: "", internalId: "", status: statusZh(shipment.ShipmentStatus), createdAt, updatedAt: "", items: groupItems(items, key, asinBySku) };
}

function awdModel(shipment: Row, asinBySku: Map<string, string>): ShipmentModel {
  const shipmentId = text(shipment.shipmentId);
  const key = `AWD:${shipmentId}`;
  const address = (shipment.destinationAddress ?? {}) as Row;
  return {
    key,
    type: "AWD",
    shipmentId,
    name: text(shipment.externalReferenceId ?? shipment.warehouseReferenceId),
    destination: text(address.name),
    address: [address.addressLine1, address.addressLine2, address.city, address.stateOrProvinceCode, address.postalCode, address.countryCode].map(text).filter(Boolean).join(", "),
    internalId: text(shipment.trackingId ?? shipment.warehouseReferenceId),
    status: statusZh(shipment.shipmentStatus),
    createdAt: iso(shipment.createdAt),
    updatedAt: iso(shipment.updatedAt),
    items: groupItems(list(shipment.shipmentSkuQuantities) as Row[], key, asinBySku),
  };
}

export async function fetchFbaShipmentItems(amazon: AmazonClient, shipmentId: string): Promise<Row[]> {
  const items: Row[] = [];
  const seen = new Set<string>();
  let token = "";
  do {
    const response = await amazon.sp<JsonObject>(token ? "/fba/inbound/v0/shipmentItems" : `/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/items`, {
      query: token ? { QueryType: "NEXT_TOKEN", MarketplaceId: "ATVPDKIKX0DER", NextToken: token } : { MarketplaceId: "ATVPDKIKX0DER" },
    });
    const payload = (response.payload ?? response) as JsonObject;
    items.push(...list(payload.ItemData) as Row[]);
    token = text(payload.NextToken);
    if (token && seen.has(token)) throw new Error(`FBA 货件 ${shipmentId} 明细分页 NextToken 重复。`);
    if (token) seen.add(token);
  } while (token);
  return items;
}

export async function probeFbaHistory(amazon: AmazonClient): Promise<JsonObject> {
  const response = await amazon.sp<JsonObject>("/fba/inbound/v0/shipments", { query: {
    QueryType: "DATE_RANGE", MarketplaceId: "ATVPDKIKX0DER",
    ShipmentStatusList: "WORKING,READY_TO_SHIP,SHIPPED,RECEIVING,CANCELLED,DELETED,CLOSED,ERROR,IN_TRANSIT,DELIVERED,CHECKED_IN",
    LastUpdatedAfter: "2025-01-01T00:00:00.000Z", LastUpdatedBefore: new Date(Date.now() - 180_000).toISOString(),
  } });
  const payload = (response.payload ?? response) as JsonObject;
  if (!Array.isArray(payload.ShipmentData)) throw new Error("FBA v0 历史发现响应缺少 ShipmentData。");
  const first = (payload.ShipmentData as Row[]).find((item) => text(item.ShipmentId));
  if (!first) throw new Error("FBA v0 历史发现未返回既有货件，需核对发现范围。");
  const items = await fetchFbaShipmentItems(amazon, text(first.ShipmentId));
  return { historicalFirstPage: payload.ShipmentData.length, historicalHasNext: !!payload.NextToken, sampleShipmentItems: items.length };
}

// 已由物流商跟踪的货件（承运商为纽酷/九方/美设之一或已有物流商单号）：物流商的入仓、开船更早更准，亚马逊“已发货/运输中”不再通知；
// 物流商轨迹停用（FORWARDER_TRACKING_ENABLED=false）时恢复照发。“已送达/已登记入仓/接收中”是亚马逊入库进度，照发。
function forwarderTracked(config: AppConfig, fields: Record<string, unknown> | undefined): boolean {
  if (!fields || !config.bool("FORWARDER_TRACKING_ENABLED", true)) return false;
  return !!forwarderForCarrier(feishuFieldText(fields["承运商"])) || !!feishuFieldText(fields[FORWARDER_FIELDS.waybill]);
}

async function upsertModel(model: ShipmentModel,config: AppConfig, state: StateStore, feishu: FeishuClient, silent: boolean, skuCache: Map<string, FeishuRecord[]>): Promise<void> {
  const app = config.get("FEISHU_BITABLE_APP_TOKEN_ORDERS");
  const shipmentTable = config.get("FEISHU_BITABLE_TABLE_ID_SHIPMENTS");
  const detailTable = config.get("FEISHU_BITABLE_TABLE_ID_SHIPMENT_DETAILS");
  const skuTable = config.get("FEISHU_BITABLE_TABLE_ID_SKUS");
  const old = await feishu.searchRecords(app, shipmentTable, { "货件唯一键": model.key });
  if (old.length > 1) throw new Error(`货件唯一键重复: ${model.key}`);
  const oldStatus = text(old[0]?.fields["当前状态"]);
  const oldUpdated = Date.parse(text(old[0]?.fields["亚马逊更新时间"]));
  const newUpdated = Date.parse(model.updatedAt);
  const stale = Number.isFinite(oldUpdated) && Number.isFinite(newUpdated) && newUpdated < oldUpdated;
  const changed = !!oldStatus && oldStatus !== model.status;
  const now = Date.now();
  const fields: Record<string, unknown> = {
    "货件唯一键": model.key,
    "货件类型": model.type,
    "货件编号": model.shipmentId,
    "货件名称": model.name,
    "目的仓": model.destination,
    "目的仓地址": model.address,
    "亚马逊内部编号": model.internalId,
    // “上次状态”只在状态真正变化时写入，保留变化前的状态。
    ...(stale ? {} : { "当前状态": model.status, ...(changed ? { "上次状态": oldStatus } : {}) }),
    ...(model.createdAt ? { "货件创建时间": Date.parse(model.createdAt) } : {}),
    // 只写接口返回的真实更新时间：FBA v0 不返回，留空。
    ...(model.updatedAt && !stale ? { "亚马逊更新时间": Date.parse(model.updatedAt) } : {}),
    "最后同步时间": now,
    ...(old.length ? {} : { "首次同步时间": now }),
  };
  // 状态变化通知意图先于飞书写入持久化；写完再发送，重试时补发未完成的意图。
  const notifyKey = `shipment|${model.key}|${model.status}`;
  const notifiable = ["已发货", "运输中", "已送达", "已登记入仓", "接收中"].includes(model.status)
    && !(["已发货", "运输中"].includes(model.status) && forwarderTracked(config, old[0]?.fields));
  const prepared = !silent && !stale && changed && notifiable
    ? await prepareNotification(config, state, notifyKey, ["📦货件状态更新", `货件：${model.shipmentId}（${model.type}）`, `${oldStatus} → ${model.status}`])
    : undefined;
  // 人工字段“承运商”刻意不在写入集合中；复用已查到的货件记录直接更新。
  const shipmentRecordId = await feishu.upsert(app, shipmentTable, { "货件唯一键": model.key }, fields, {}, { existing: old });
  for (const item of model.items) {
    const skuRecords = skuCache.get(item.sku) ?? await feishu.searchRecords(app, skuTable, { "SKU编号": item.sku });
    skuCache.set(item.sku, skuRecords);
    if (skuRecords.length > 1) throw new Error(`SKU信息表存在重复 SKU: ${item.sku}`);
    await feishu.upsert(app, detailTable, { "明细唯一键": item.key }, {
      "明细唯一键": item.key,
      "关联货件": [shipmentRecordId],
      ...(skuRecords[0] ? { "SKU编号": [skuRecords[0].record_id] } : {}),
      "FNSKU": item.fnsku,
      "计划数量": item.planned,
      "实收数量": item.received,
      "差异数量": item.received - item.planned,
      "最后同步时间": now,
      ...(old.length ? {} : { "首次同步时间": now }),
      ...(skuRecords[0] ? {} : { "备注": `SKU信息表未找到 ${item.sku}` }),
    });
  }
  if (!silent) await flushNotification(state, feishu, notifyKey, prepared);
}

export async function runShipments(event: JobEvent, config: AppConfig, state: StateStore, amazon: AmazonClient, feishu: FeishuClient): Promise<JsonObject> {
  const asinBySku = new Map(config.asins().map((item) => [item.sku, item.asin]));
  const until = new Date(Date.now() - 180_000).toISOString();
  const checkpoint = await state.get("CHECKPOINT", "shipment");
  const checkpointUntil = text(checkpoint?.until);
  const overlapDays = Math.max(1, number(checkpoint?.overlapDays) || 7);
  const after = text(event.cursor?.updatedAfter)
    || text(checkpoint?.resumeAfter)
    || (checkpointUntil ? new Date(Date.parse(checkpointUntil) - overlapDays * 86_400_000).toISOString() : `${config.optional("SHIPMENT_SYNC_START_DATE", "2025-01-01")}T00:00:00.000Z`);
  const skuCache = new Map<string, FeishuRecord[]>();
  let fbaCount = 0;
  let token = "";
  const fbaSeen = new Set<string>();
  do {
    const response = await amazon.sp<JsonObject>("/fba/inbound/v0/shipments", { query: token ? { QueryType: "NEXT_TOKEN", MarketplaceId: "ATVPDKIKX0DER", NextToken: token } : { QueryType: "DATE_RANGE", MarketplaceId: "ATVPDKIKX0DER", ShipmentStatusList: "WORKING,READY_TO_SHIP,SHIPPED,RECEIVING,CANCELLED,DELETED,CLOSED,ERROR,IN_TRANSIT,DELIVERED,CHECKED_IN", LastUpdatedAfter: after, LastUpdatedBefore: until } });
    const payload = (response.payload ?? response) as JsonObject;
    for (const shipment of list(payload.ShipmentData) as Row[]) {
      const id = text(shipment.ShipmentId);
      if (!id) continue;
      await upsertModel(fbaModel(shipment, await fetchFbaShipmentItems(amazon, id), asinBySku), config, state, feishu, !!event.dryRun, skuCache);
      fbaCount += 1;
    }
    token = text(payload.NextToken);
    if (token && fbaSeen.has(token)) throw new Error("FBA 货件分页 NextToken 重复。 ");
    if (token) fbaSeen.add(token);
  } while (token);

  let awdCount = 0;
  token = "";
  const awdSeen = new Set<string>();
  do {
    const response = await amazon.sp<JsonObject>("/awd/2024-05-09/inboundShipments", { query: { sortBy: "UPDATED_AT", sortOrder: "ASCENDING", updatedAfter: after, updatedBefore: until, maxResults: 25, ...(token ? { nextToken: token } : {}) } });
    for (const summary of list(response.shipments) as Row[]) {
      const id = text(summary.shipmentId);
      if (!id) continue;
      const detail = await amazon.sp<JsonObject>(`/awd/2024-05-09/inboundShipments/${encodeURIComponent(id)}`, { query: { skuQuantities: "SHOW" } });
      await upsertModel(awdModel(detail as Row, asinBySku), config, state, feishu, !!event.dryRun, skuCache);
      awdCount += 1;
    }
    token = text(response.nextToken);
    if (token && awdSeen.has(token)) throw new Error("AWD 货件分页 nextToken 重复。 ");
    if (token) awdSeen.add(token);
  } while (token);
  await state.put({ pk: "CHECKPOINT", sk: "shipment", until, resumeAfter: "", overlapDays, updatedAt: new Date().toISOString() });
  return { status: "done", fbaShipments: fbaCount, awdShipments: awdCount, updatedAfter: after, updatedBefore: until };
}
