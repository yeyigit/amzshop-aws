import assert from "node:assert/strict";
import test from "node:test";
import { CACHE_SCHEMA, inventoryHealthView, storeHealthView, type LiveData } from "../../src/portal/sources.js";
import { buildView } from "../../src/portal/view.js";
import { renderPortalPage } from "../../src/portal/page.js";
import { FEED_PREFIXES, feedItems, type InventoryRow } from "../../src/portal/metrics.js";

// 中台的店铺健康与压货（docs/模块说明.md「店铺健康、库龄与 SQP」）：只读两条状态，页面加顶部提示、库存格一行、商品库存列标记。
const NOW = Date.parse("2026-10-11T03:15:00Z");
const fresh = new Date(NOW - 60_000).toISOString();

test("状态映射：店铺健康摘要与库存健康结果转成页面用的精简视图；没有状态时为空", () => {
  assert.equal(storeHealthView(undefined), null);
  assert.equal(inventoryHealthView(undefined), null);
  const health = storeHealthView({
    account: { status: "NORMAL", ahrStatus: "GREAT", ahrScore: 260, issues: ["Listing 政策违规 1"], fetchedAt: "2026-10-11T01:25:00Z" },
    listings: Array.from({ length: 25 }, (_, index) => ({ market: "美国站", sku: `SKU-${index}`, asin: "B0X", kind: "issue", text: "x".repeat(300), since: "2026-10-11T02:25:00Z" })),
    updatedAt: "2026-10-11T02:25:00Z",
  });
  assert.deepEqual(health?.account, { status: "NORMAL", ahrStatus: "GREAT", ahrScore: 260, issues: ["Listing 政策违规 1"], fetchedAt: "2026-10-11T01:25:00Z" });
  assert.equal(health?.listings.length, 20, "最多带 20 条");
  assert.equal(health?.listings[0]?.text.length, 160);
  const aging = inventoryHealthView({ snapshotDate: "2026-10-10", totals: { storageNextMonth: 640.5, aisNextMonth: 120.5, excessSkus: 3 }, skus: [{ sku: "SKU-A", status: "Excess", aged181: 190, willAge90: 4, storageNextMonth: 230.5, aisNextMonth: 90.5, monthsToClear: 6, cashPerUnit: 5.49 }] });
  assert.deepEqual(aging, { snapshotDate: "2026-10-10", storageNextMonth: 640.5, aisNextMonth: 120.5, excessSkus: 3, skus: { "SKU-A": { status: "Excess", aged181: 190, willAge90: 4, storageNextMonth: 230.5, aisNextMonth: 90.5, monthsToClear: 6 } }, updatedAt: "" });
});

test("页面数据：带上店铺健康、压货汇总，商品行带超龄件数、冗余与下月仓储；没有这两类数据时为空、原有内容不受影响", () => {
  const live: LiveData = {
    offers: {}, traffic: {}, competitors: {}, health: {}, sale: null,
    storeHealth: storeHealthView({ account: { status: "NORMAL", ahrStatus: "GREAT", ahrScore: 260, issues: [], fetchedAt: fresh }, listings: [{ market: "美国站", sku: "SKU-B", kind: "not-buyable", text: "不可售（原在售）", since: fresh }], updatedAt: fresh }),
    inventoryHealth: inventoryHealthView({ snapshotDate: "2026-10-10", totals: { storageNextMonth: 293, aisNextMonth: 90.5, excessSkus: 1 }, skus: [{ sku: "SKU-A", status: "Excess", aged181: 190, willAge90: 4, storageNextMonth: 230.5, aisNextMonth: 90.5, monthsToClear: 6 }, { sku: "SKU-B", status: "Healthy", aged181: 0, willAge90: 0, storageNextMonth: 62.5, aisNextMonth: null, monthsToClear: 4 }] }),
  };
  const inventory: InventoryRow[] = ["SKU-A", "SKU-B"].map((sku) => ({ sku, asin: "", name: sku, sales30: 30, fbaAvailable: 200, fbaDays: 150, level: "正常", reason: "", dataTime: "", stale: false }));
  const options = { nowMs: NOW, title: "AMZ中台", user: { name: "Owner", avatar: "" }, asinBySku: {} };
  const view = buildView({ live: { data: live, fetchedAt: fresh, schema: CACHE_SCHEMA }, inventory: { data: inventory, fetchedAt: fresh, schema: CACHE_SCHEMA } }, options);
  assert.equal(view.storeHealth?.account?.ahrScore, 260);
  assert.deepEqual(view.storeHealth?.listings.map((row) => row.sku), ["SKU-B"]);
  assert.deepEqual(view.aging, { snapshotDate: "2026-10-10", excessSkus: 1, excess: ["SKU-A"], storageNextMonth: 293, aisNextMonth: 90.5, aged181: 190 });
  const a = view.products.find((row) => row.sku === "SKU-A")!;
  const b = view.products.find((row) => row.sku === "SKU-B")!;
  assert.deepEqual([a.aged181, a.excessStock, a.storageNextMonth, a.monthsToClear], [190, true, 230.5, 6]);
  assert.deepEqual([b.aged181, b.excessStock], [0, false]);
  const bare = buildView({ inventory: { data: inventory, fetchedAt: fresh, schema: CACHE_SCHEMA } }, options);
  assert.deepEqual([bare.storeHealth, bare.aging, bare.products[0]?.aged181, bare.products[0]?.excessStock], [null, null, null, false]);
  assert.equal(CACHE_SCHEMA, 3, "live 区块结构变了，旧缓存立即重取");
});

test("页面骨架有店铺健康提示条；近 7 天动态收录店铺健康与压货消息（含每月预告）", () => {
  const html = renderPortalPage(buildView({}, { nowMs: NOW, title: "AMZ中台", user: { name: "Owner", avatar: "" }, asinBySku: {} }), "nonce");
  assert.match(html, /<div class="health-strip" id="health" role="alert" hidden><\/div>/);
  assert.doesNotMatch(html, /sellercentral\.amazon/, "不放卖家后台链接");
  assert.ok(FEED_PREFIXES.some(([prefix]) => prefix === "store-health|"));
  const items = feedItems([
    { sk: "store-health|2026-10-11|abc", lines: ["🩺 店铺健康", "⚠️ 美国站 SKU-B：不可售了（原在售）"], createdAt: fresh },
    { sk: "inventory-health|2026-10-11|def", lines: ["📦 压货与仓储费", "🔴 SKU-A 被亚马逊标为冗余"], createdAt: fresh },
    { sk: "inventory-health-month|2026-10", lines: ["📦 本月 15 日超龄附加费预告", "下月仓储估算合计 $641"], createdAt: fresh },
  ], NOW);
  assert.deepEqual(items.map((item) => item.kind).sort(), ["inventory-health", "inventory-health", "store-health"]);
});
