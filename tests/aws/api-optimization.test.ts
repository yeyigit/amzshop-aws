import assert from "node:assert/strict";
import test from "node:test";
import { runInventory } from "../../src/business/inventory.js";
import { resetSellerIdCache, resolveSellerId, runPricing } from "../../src/business/pricing.js";
import { applyFinanceWithDetailWait, runFinance } from "../../src/business/finance.js";
import { runReviews } from "../../src/business/reviews.js";
import { addDaysYmd, sha256, ymdInZone } from "../../src/util.js";
import type { AppConfig, FeishuRecord, JobEvent } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const DAY = 86_400_000;
const configOf = (asins: Row[] = [], optional: Record<string, string> = {}): AppConfig => ({
  get: (key: string) => optional[key] ?? key,
  optional: (key: string, fallback = "") => optional[key] ?? (key === "FEISHU_NOTIFY_USER_IDS" ? "u1" : fallback),
  bool: () => true,
  asins: () => asins,
}) as unknown as AppConfig;

// ---------- A1：旧 GAS→AWS 参数回归 ----------

test("A1 库存销量按 GAS 口径只统计 Amazon 履约（fulfillmentNetwork=AFN），不把自发货销量计入 FBA 补货", async () => {
  const end = addDaysYmd(ymdInZone(new Date(), "America/Los_Angeles"), -1);
  const salesQueries: Row[] = [];
  const amazon = { sp: async (path: string, init: { query?: Row }) => {
    if (path.startsWith("/fba/inventory")) return { payload: { inventorySummaries: [{ sellerSku: "SKU-A", inventoryDetails: { fulfillableQuantity: 30 } }] } };
    if (path.startsWith("/awd/")) return { inventory: [] };
    if (path.startsWith("/sales/")) {
      salesQueries.push(init.query ?? {});
      // 官方 getOrderMetrics：不传 fulfillmentNetwork 时返回全部履约网络（含 MFN）。
      const units = init.query?.fulfillmentNetwork === "AFN" ? 1 : 5;
      return { payload: Array.from({ length: 30 }, (_, index) => ({ interval: `${addDaysYmd(end, -index)}T00:00:00-07:00--x`, unitCount: units })) };
    }
    throw new Error(`unexpected ${path}`);
  } } as unknown as AmazonClient;
  const upserts: Row[] = [];
  const feishu = {
    listRecords: async (_app: string, table: string) => table === "FEISHU_BITABLE_TABLE_ID_INVENTORY_ALERTS" ? [{ record_id: "rec-A", fields: { SKU: "SKU-A", "预警等级": "正常" } }] : [{ record_id: "p-A", fields: { SKU: "SKU-A" } }],
    upsert: async (_app: string, _table: string, _key: unknown, fields: Row) => { upserts.push(fields); return "rec-A"; },
    batchUpdate: async () => undefined,
    sendText: async () => undefined,
  } as unknown as FeishuClient;
  await runInventory({ taskType: "inventory" }, configOf([{ sku: "SKU-A", asin: "B0A", competitors: [], adMarker: "" }]), new MemoryState().asStore(), amazon, feishu);
  assert.ok(salesQueries.length > 0);
  assert.ok(salesQueries.every((query) => query.fulfillmentNetwork === "AFN"), "库存销量查询必须带 fulfillmentNetwork=AFN");
});

test("A1 FBA Inventory 分页令牌在响应顶层 pagination.nextToken：库存与价格任务都读完全部页", async () => {
  const pagesSeen: string[] = [];
  const fbaPage = (query: Row | undefined) => {
    pagesSeen.push(String(query?.nextToken ?? "FIRST"));
    // 官方 GetInventorySummariesResponse：{ payload: { inventorySummaries }, pagination: { nextToken } }
    return query?.nextToken === "page-2"
      ? { payload: { inventorySummaries: [{ sellerSku: "SKU-B", inventoryDetails: { fulfillableQuantity: 10 } }] } }
      : { payload: { inventorySummaries: [{ sellerSku: "SKU-A", inventoryDetails: { fulfillableQuantity: 3 } }] }, pagination: { nextToken: "page-2" } };
  };
  const end = addDaysYmd(ymdInZone(new Date(), "America/Los_Angeles"), -1);
  const amazon = { sp: async (path: string, init: { query?: Row }) => {
    if (path.startsWith("/fba/inventory")) return fbaPage(init.query);
    if (path.startsWith("/awd/")) return { inventory: [] };
    if (path.startsWith("/sales/")) return { payload: [{ interval: `${end}T00:00:00-07:00--x`, unitCount: 1 }] };
    if (path.startsWith("/listings/")) return { items: [{ sku: "SKU-B", summaries: [{ marketplaceId: "ATVPDKIKX0DER", asin: "B0B", status: ["BUYABLE"] }], attributes: { purchasable_offer: [{ marketplace_id: "ATVPDKIKX0DER", audience: "ALL", currency: "USD", our_price: [{ schedule: [{ value_with_tax: 19.99 }] }] }] } }] };
    if (path.startsWith("/promotions/")) return { promotions: [] };
    throw new Error(`unexpected ${path}`);
  } } as unknown as AmazonClient;
  const upserts: Row[] = [];
  const updates: Array<{ recordId: string; fields: Row }> = [];
  const feishu = {
    listRecords: async (_app: string, table: string) => {
      if (table === "FEISHU_BITABLE_TABLE_ID_INVENTORY_ALERTS") return [{ record_id: "rec-A", fields: { SKU: "SKU-A" } }, { record_id: "rec-B", fields: { SKU: "SKU-B" } }];
      if (table === "FEISHU_BITABLE_TABLE_ID_SKUS") return [{ record_id: "sku-B", fields: { "SKU编号": "SKU-B" } }];
      if (table === "FEISHU_BITABLE_TABLE_ID_PROFIT_ESTIMATE") return [{ record_id: "profit-B", fields: { "SKU编号": [{ record_id: "sku-B" }] } }];
      return [{ record_id: "p-A", fields: { SKU: "SKU-A" } }, { record_id: "p-B", fields: { SKU: "SKU-B" } }];
    },
    upsert: async (_app: string, _table: string, _key: unknown, fields: Row) => { upserts.push(fields); return "rec"; },
    update: async (_app: string, _table: string, recordId: string, fields: Row) => { updates.push({ recordId, fields }); },
    batchUpdate: async () => undefined,
    sendText: async () => undefined,
  } as unknown as FeishuClient;
  const asins = [{ sku: "SKU-A", asin: "B0A", competitors: [], adMarker: "" }, { sku: "SKU-B", asin: "B0B", competitors: [], adMarker: "" }];
  await runInventory({ taskType: "inventory" }, configOf(asins), new MemoryState().asStore(), amazon, feishu);
  assert.deepEqual(pagesSeen, ["FIRST", "page-2"], "库存任务必须按顶层 pagination.nextToken 翻页");
  assert.equal(upserts.find((fields) => fields.SKU === "SKU-B")?.["FBA可售"], 10, "第二页 SKU 的 FBA 可售不能丢");
  pagesSeen.length = 0;
  resetSellerIdCache();
  await runPricing({ taskType: "pricing" }, configOf([], { SP_API_SELLER_ID: "seller-1" }), new MemoryState().asStore(), amazon, feishu);
  assert.deepEqual(pagesSeen, ["FIRST", "page-2"], "价格任务必须按顶层 pagination.nextToken 翻页");
  assert.equal(updates.find((item) => item.recordId === "profit-B")?.fields["AMZ售价"], 19.99, "第二页有库存的 SKU 仍按在售更新售价");
  resetSellerIdCache();
});

// ---------- A2：小清理 ----------

test("A2 Finance 扫描与 Seller ID 反推调用 listTransactions 不再传官方不存在的 pageSize", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-28T12:00:00.000Z") });
  const taskId = "finance|2026-09-24T00:30:00Z";
  const state = new MemoryState([{ pk: "TASK#finance", sk: taskId, module: "finance", status: "active", state: { startTime: "2026-09-27T00:00:00.000Z", endTime: "2026-09-27T12:00:00.000Z", windowStartTime: "2026-09-27T05:59:59.000Z", windowEndTime: "2026-09-27T11:59:59.000Z", pageOffset: 0, pageHash: "" } }]);
  const queries: Row[] = [];
  let sellerLookup = false;
  const amazon = { sp: async (_path: string, init: { query?: Row } = {}) => {
    queries.push(init.query ?? {});
    return sellerLookup ? { payload: { transactions: [{ sellingPartnerMetadata: { sellingPartnerId: "seller-1" } }] } } : { transactions: [] };
  } } as unknown as AmazonClient;
  const result = await runFinance({ taskType: "finance", taskId, scheduledAt: "2026-09-28T11:59:00.000Z" }, configOf(), state.asStore(), amazon, {} as FeishuClient, async () => "s");
  assert.equal(result.status, "done");
  assert.ok(queries.length >= 2 && queries.every((query) => "postedAfter" in query && !("pageSize" in query)), "扫描窗口查询不带 pageSize");
  queries.length = 0;
  sellerLookup = true;
  resetSellerIdCache();
  assert.equal(await resolveSellerId(configOf(), amazon, new MemoryState().asStore()), "seller-1");
  assert.equal(queries.length, 1);
  assert.equal("pageSize" in queries[0]!, false, "Seller ID 反推不带 pageSize");
  resetSellerIdCache();
});

function reviewFixture(tokenAgeMs: number) {
  const now = Date.now();
  const orderSeen = "111-0000000-0000001";
  const orderSent = "111-0000000-0000002";
  const taskId = "review|manual-a2";
  const state = new MemoryState([
    { pk: "TASK#review", sk: taskId, module: "review", status: "active", state: {
      scanStart: new Date(now - 30 * DAY).toISOString(), scanEnd: new Date(now - 25 * 3_600_000).toISOString(), startedAt: new Date(now - 25 * 3_600_000).toISOString(), scheduledAt: "", dryRun: false,
      nextToken: "token-page-2", nextTokenAt: new Date(now - tokenAgeMs).toISOString(), orderIndex: 0, complete: false, truncated: false, candidates: 1,
      counts: { checked: 1, success: 0 }, sites: {}, seen: sha256(orderSeen).slice(0, 8),
    } },
    { pk: "REVIEW", sk: orderSent, taskId: "review|earlier", marketplaceId: "ATVPDKIKX0DER", status: "sent", sentAt: new Date(now - 2 * DAY).toISOString() },
  ]);
  const order = (orderId: string): Row => ({ orderId, salesChannel: { marketplaceId: "ATVPDKIKX0DER" }, fulfillment: { fulfillmentStatus: "SHIPPED", fulfilledBy: "AMAZON", deliverByWindow: { latestDateTime: new Date(now - 10 * DAY).toISOString() } } });
  const queries: Row[] = [];
  let posts = 0;
  const amazon = {
    sp: async (path: string, init: { query?: Row } = {}) => {
      if (path === "/orders/2026-01-01/orders") { queries.push(init.query ?? {}); return init.query?.paginationToken ? { orders: [] } : { orders: [order(orderSeen), order(orderSent)] }; }
      throw new Error(`unexpected ${path}`);
    },
    spStatus: async () => { posts += 1; return 201; },
  } as unknown as AmazonClient;
  const records: FeishuRecord[] = [{ record_id: "r2", fields: { "订单编号": orderSent, "邀评状态": "已发送" } }];
  const feishu = {
    searchRecords: async () => records,
    update: async () => undefined,
    sendText: async () => undefined,
  } as unknown as FeishuClient;
  return { state, amazon, feishu, queries, taskId, posts: () => posts };
}

test("A2 邀评续跑：保存的分页令牌超过 23 小时即丢弃、从本批起点重扫；已处理订单按 seen 与 REVIEW 记录跳过，不重复 POST", async () => {
  const stale = reviewFixture(24 * 3_600_000);
  const result = await runReviews({ taskType: "review", taskId: stale.taskId }, configOf(), stale.state.asStore(), stale.amazon, stale.feishu, async () => "s");
  assert.equal(result.status, "done");
  assert.equal("paginationToken" in stale.queries[0]!, false, "超过 23 小时的令牌不得再用");
  assert.equal(stale.posts(), 0, "重扫不得重复 POST");
  const counts = result.counts as Record<string, number>;
  assert.equal(counts.alreadyInvited, 1, "REVIEW 已发送的订单记为已邀");
  assert.equal(counts.checked, 2, "seen 中的订单不重复计数");
  const fresh = reviewFixture(3_600_000);
  await runReviews({ taskType: "review", taskId: fresh.taskId }, configOf(), fresh.state.asStore(), fresh.amazon, fresh.feishu, async () => "s");
  assert.equal(fresh.queries[0]?.paginationToken, "token-page-2", "未过期的令牌照常续用");
});

// ---------- A4：Promotions couponType ----------

async function pricingWithCoupons(coupons: Row[]): Promise<Row> {
  resetSellerIdCache();
  const amazon = { sp: async (path: string) => {
    if (path.startsWith("/fba/inventory")) return { payload: { inventorySummaries: [{ sellerSku: "SKU-B", inventoryDetails: { fulfillableQuantity: 5 } }] } };
    if (path.startsWith("/listings/")) return { items: [{ sku: "SKU-B", summaries: [{ marketplaceId: "ATVPDKIKX0DER", asin: "B0B", status: ["BUYABLE"] }], attributes: { purchasable_offer: [{ marketplace_id: "ATVPDKIKX0DER", audience: "ALL", currency: "USD", our_price: [{ schedule: [{ value_with_tax: 20 }] }] }] } }] };
    if (path === "/promotions/2025-12-01/promotions") return { promotions: coupons.map((item) => ({ promotionId: item.promotionId })) };
    const detail = coupons.find((item) => path === `/promotions/2025-12-01/promotions/${String(item.promotionId)}`);
    if (detail) return detail;
    throw new Error(`unexpected ${path}`);
  } } as unknown as AmazonClient;
  const updates: Row[] = [];
  const feishu = {
    listRecords: async (_app: string, table: string) => table === "FEISHU_BITABLE_TABLE_ID_SKUS" ? [{ record_id: "sku-B", fields: { "SKU编号": "SKU-B" } }] : [{ record_id: "profit-B", fields: { "SKU编号": [{ record_id: "sku-B" }] } }],
    update: async (_app: string, _table: string, _id: string, fields: Row) => { updates.push(fields); },
  } as unknown as FeishuClient;
  await runPricing({ taskType: "pricing" }, configOf([], { SP_API_SELLER_ID: "seller-1" }), new MemoryState().asStore(), amazon, feishu);
  resetSellerIdCache();
  return updates[0]!;
}

const coupon = (promotionId: string, percentOff: number, couponType?: string): Row => ({
  promotionId, marketplaceId: "ATVPDKIKX0DER", status: "RUNNING", promotionType: "COUPON", ...(couponType ? { couponType } : {}), schedule: {},
  benefit: { discount: { type: "PERCENTAGE_OFF", percentOff } }, selection: { selectionDetails: { items: [{ sku: "SKU-B", asin: "B0B" }] } },
});

test("A4 订阅省券、复购奖励券不计入“AMZ Coupon后价”并在活动说明注明；普通券（含缺省 couponType）照常计算", async () => {
  const mixed = await pricingWithCoupons([coupon("P-SNS", 30, "SUBSCRIBE_AND_SAVE"), coupon("P-STD", 10, "STANDARD"), coupon("P-RR", 40, "REORDER_REWARDS")]);
  assert.equal(mixed["AMZ Coupon后价"], 18, "只按普通券 10% 计算");
  assert.equal(mixed["活动计算价"], 18);
  assert.equal(mixed["价格同步状态"], "常规价已更新；活动已确认");
  assert.match(String(mixed["活动说明"]), /SUBSCRIBE_AND_SAVE/);
  assert.match(String(mixed["活动说明"]), /REORDER_REWARDS/);
  assert.match(String(mixed["活动说明"]), /COUPON \$18\.00/);
  const onlySubscribe = await pricingWithCoupons([coupon("P-SNS", 30, "SUBSCRIBE_AND_SAVE")]);
  assert.equal(onlySubscribe["AMZ Coupon后价"], null);
  assert.equal(onlySubscribe["活动计算价"], null);
  assert.match(String(onlySubscribe["活动说明"]), /订阅省/);
  const legacy = await pricingWithCoupons([coupon("P-OLD", 10)]);
  assert.equal(legacy["AMZ Coupon后价"], 18, "未返回 couponType 按 STANDARD 处理");
});

// ---------- D1（用户 2026-09-30 追加）：AWD 补货单费用与匹配不到货件的费用 ----------

const awdFee = (id: string, orderId: string, description: string, amount: number, postedDate: string): Row => ({
  transactionId: id, transactionType: "ServiceFee", transactionStatus: "RELEASED", postedDate, description,
  totalAmount: { currencyCode: "USD", currencyAmount: amount },
  sellingPartnerMetadata: { sellingPartnerId: "SELLER1", marketplaceId: "ATVPDKIKX0DER", accountType: "Standard Orders" },
  relatedIdentifiers: [{ relatedIdentifierName: "SETTLEMENT_ID", relatedIdentifierValue: "10000000003" }, { relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: orderId }],
  breakdowns: [{ breakdownType: "Expenses", breakdownAmount: { currencyCode: "USD", currencyAmount: amount }, breakdowns: [{ breakdownType: "AmazonUpstreamStorageTransportationFee", breakdownAmount: { currencyCode: "USD", currencyAmount: amount } }] }],
});

function financeSheet() {
  const searches: string[] = [];
  const upserts: Array<{ table: string; key: Row; fields: Row }> = [];
  const feishu = {
    searchRecords: async (_app: string, table: string) => { searches.push(table); return []; },
    upsert: async (_app: string, table: string, key: Row, fields: Row) => { upserts.push({ table, key, fields }); return "rec-ledger"; },
    update: async () => undefined,
  } as unknown as FeishuClient;
  return { feishu, searches, upserts };
}

test("D1 AWD 补货单（repl-）费用不是货件表货件：直接记入账户其他资金流水，原卡在待匹配的复查也转入流水", async () => {
  const posted = new Date(Date.now() - DAY).toISOString();
  for (const forced of [undefined, "shipment" as const]) {
    const state = new MemoryState();
    const sheet = financeSheet();
    const transport = awdFee(`T-${forced ?? "new"}`, "repl-00000000-0000-4000-8000-000000000001", "AWDTransportationFee", -28.4, posted);
    const outcome = await applyFinanceWithDetailWait(configOf(), state.asStore(), {} as AmazonClient, sheet.feishu, transport, forced ? { forcedDestination: forced } : {});
    assert.equal(outcome, "done", String(forced));
    assert.equal(sheet.searches.includes("FEISHU_BITABLE_TABLE_ID_SHIPMENTS"), false, "补货单不去货件表匹配");
    assert.equal(sheet.upserts.length, 1);
    assert.equal(sheet.upserts[0]!.table, "FEISHU_BITABLE_TABLE_ID_FINANCE_LEDGER");
    assert.equal(sheet.upserts[0]!.fields["原币金额"], -28.4);
    assert.equal(sheet.upserts[0]!.fields["流水名称"], "AWD 运输费");
    const done = state.item("FINANCE", `SELLER1|ATVPDKIKX0DER|T-${forced ?? "new"}`);
    assert.equal(done?.destination, "ledger");
    assert.equal(state.item("FINANCE_PENDING", `SELLER1|ATVPDKIKX0DER|T-${forced ?? "new"}`), undefined);
  }
});

test("D1 AWD 月度仓储费（STARStorageBilling，关联标识是 US-2026-09-… 月度账单号）不是货件费用：直接记入账户其他资金流水“AWD 仓储费”，原卡在待匹配的复查也转入；AWD 入库处理费仍去货件表匹配", async () => {
  const posted = new Date(Date.now() - DAY).toISOString();
  const money = { currencyCode: "USD", currencyAmount: -42.1 };
  for (const forced of [undefined, "shipment" as const]) {
    const state = new MemoryState();
    const sheet = financeSheet();
    // 形状取自 2026-10-07 生产首笔（卖家 ID 换成测试值）。
    const storage: Row = {
      ...awdFee(`S-${forced ?? "new"}`, "US-2026-09-AEXAMPLESELLER", "STARStorageBilling", -42.1, posted),
      breakdowns: [{ breakdownType: "Expenses", breakdownAmount: money, breakdowns: [{ breakdownType: "AWDStorageFees", breakdownAmount: money }] }],
      items: [{ description: "STARStorageFee", totalAmount: money, breakdowns: [{ breakdownType: "FBAFees", breakdownAmount: money, breakdowns: [{ breakdownType: "STARStorageFee", breakdownAmount: money }] }] }],
    };
    const outcome = await applyFinanceWithDetailWait(configOf(), state.asStore(), {} as AmazonClient, sheet.feishu, storage, forced ? { forcedDestination: forced } : {});
    assert.equal(outcome, "done", String(forced));
    assert.equal(sheet.searches.includes("FEISHU_BITABLE_TABLE_ID_SHIPMENTS"), false, "仓储费不去货件表匹配");
    assert.equal(sheet.upserts.length, 1);
    assert.equal(sheet.upserts[0]!.table, "FEISHU_BITABLE_TABLE_ID_FINANCE_LEDGER");
    assert.equal(sheet.upserts[0]!.fields["流水名称"], "AWD 仓储费");
    assert.equal(sheet.upserts[0]!.fields["交易类型"], "服务费用");
    assert.equal(sheet.upserts[0]!.fields["业务分类"], "平台费用");
    assert.equal(sheet.upserts[0]!.fields["原币金额"], -42.1);
    assert.equal(sheet.upserts[0]!.fields["利润核算金额"], -42.1, "已发放的平台费用计入利润核算，同 FBA 仓储费");
    assert.equal(state.item("FINANCE", `SELLER1|ATVPDKIKX0DER|S-${forced ?? "new"}`)?.destination, "ledger");
    assert.equal(state.item("FINANCE_PENDING", `SELLER1|ATVPDKIKX0DER|S-${forced ?? "new"}`), undefined);
  }
  const inbound = financeSheet();
  const inboundState = new MemoryState();
  const processing = awdFee("P-inbound", "IB_2026-09-14_STAR-EXAMPLE0001", "AWDProcessingFee", -29.9, posted);
  assert.equal(await applyFinanceWithDetailWait(configOf(), inboundState.asStore(), {} as AmazonClient, inbound.feishu, processing), "waiting_match", "挂在 AWD 入库货件上的处理费照旧匹配货件");
  assert.deepEqual(inbound.searches, ["FEISHU_BITABLE_TABLE_ID_SHIPMENTS"]);
  assert.equal(inbound.upserts.length, 0);
});

test("挂订单号的库存赔偿（退款后买家未退货、免费换货）记入账户其他资金流水的“赔偿与补偿”并在备注写订单号，不碰订单表与货件表", async () => {
  const posted = new Date(Date.now() - DAY).toISOString();
  for (const [description, amount, name] of [["REVERSAL_REIMBURSEMENT", 6.95, "亚马逊物流买家未退货赔偿"], ["FREE_REPLACEMENT_REFUND_ITEMS", 8.9, "亚马逊物流免费换货赔偿"]] as const) {
    const state = new MemoryState();
    const sheet = financeSheet();
    const money = { currencyCode: "USD", currencyAmount: amount };
    // 形状取自生产交易（卖家 ID、订单号换成测试值）。
    const reimbursement: Row = { ...awdFee(`R-${description}`, "113-1234567-1234567", description, amount, posted), transactionType: "FBAInventoryReimbursement", breakdowns: [{ breakdownType: "Sales", breakdownAmount: money, breakdowns: [{ breakdownType: "FBAInventoryReimbursement", breakdownAmount: money }] }] };
    assert.equal(await applyFinanceWithDetailWait(configOf(), state.asStore(), {} as AmazonClient, sheet.feishu, reimbursement), "done", description);
    assert.deepEqual(sheet.searches, [], "不查订单表、货件表");
    assert.equal(sheet.upserts.length, 1);
    const row = sheet.upserts[0]!;
    assert.equal(row.table, "FEISHU_BITABLE_TABLE_ID_FINANCE_LEDGER");
    assert.equal(row.fields["流水名称"], name);
    assert.equal(row.fields["业务分类"], "赔偿与补偿");
    assert.equal(row.fields["交易类型"], "库存退款赔偿");
    assert.equal(row.fields["原币金额"], amount);
    assert.equal(row.fields["利润核算金额"], amount, "已发放的赔偿计入利润核算，同其它库存赔偿");
    assert.equal(row.fields["备注"], "订单 113-1234567-1234567");
    assert.equal(state.item("FINANCE", `SELLER1|ATVPDKIKX0DER|R-${description}`)?.destination, "ledger");
  }
});

test("D1 送去匹配货件的费用：14 天内匹配不到仍待匹配；入账超过 14 天仍匹配不到转记账户其他资金流水并注明，只记一处", async () => {
  const young = financeSheet();
  const youngState = new MemoryState();
  const fresh = awdFee("F-young", "FBA15ABCDE12", "FBAInboundTransportationFee", -12, new Date(Date.now() - 2 * DAY).toISOString());
  assert.equal(await applyFinanceWithDetailWait(configOf(), youngState.asStore(), {} as AmazonClient, young.feishu, fresh), "waiting_match");
  assert.equal(young.upserts.length, 0);
  assert.equal(youngState.item("FINANCE_PENDING", "SELLER1|ATVPDKIKX0DER|F-young")?.stage, "pending_match");
  const old = financeSheet();
  const oldState = new MemoryState();
  const aged = awdFee("F-old", "FBA15ABCDE12", "FBAInboundTransportationFee", -12, new Date(Date.now() - 20 * DAY).toISOString());
  assert.equal(await applyFinanceWithDetailWait(configOf(), oldState.asStore(), {} as AmazonClient, old.feishu, aged, { forcedDestination: "shipment" }), "done");
  assert.equal(old.upserts.length, 1);
  assert.equal(old.upserts[0]!.table, "FEISHU_BITABLE_TABLE_ID_FINANCE_LEDGER");
  assert.match(String(old.upserts[0]!.fields["备注"]), /未匹配到货件/);
  assert.equal(oldState.item("FINANCE", "SELLER1|ATVPDKIKX0DER|F-old")?.destination, "ledger");
  assert.equal(oldState.item("FINANCE_PENDING", "SELLER1|ATVPDKIKX0DER|F-old"), undefined);
});
