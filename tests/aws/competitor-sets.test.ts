import assert from "node:assert/strict";
import test from "node:test";
import { runCompetitorPrices } from "../../src/business/orders-periodic.js";
import { COMPETITIVE_SUMMARY_PATH } from "../../src/business/competitive.js";
import { COMPETITOR_DROP_AFTER, allocateSlots, catalogFacts, manualIndex, planCompetitorSets, runCompetitorRefresh, type AutoCompetitor, type CandidateFacts, type CompetitorSet, type PlanInput, type ProductObservation } from "../../src/business/competitor-sets.js";
import { HEALTH_RULES } from "../../src/business/maintenance.js";
import { runJob } from "../../src/business/jobs.js";
import { addDaysYmd, ymdInZone } from "../../src/util.js";
import type { AppConfig, AsinMapping } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
// 平时 14:00 那轮（不在任何大促窗口），避免用例随运行日期进入大促合并模式。
const DAILY_SLOT = "2026-10-07T06:00:00.000Z";
const OWN = "SELLER-OWN";
const US = "ATVPDKIKX0DER";
const TOY = "toy_display_on_website";
const BABY = "baby_product_display_on_website";
const XYLO = "B0OWN1XYLO";
const LADYBUG = "B0OWN2LADY";
const PARENT = "B0OWNPAREN";
const MANUAL = "B0MANUAL01";
const [A1, A2, A3, A4, A5] = ["B0COMPA001", "B0COMPA002", "B0COMPA003", "B0COMPA004", "B0COMPA005"] as [string, string, string, string, string];
const today = (): string => ymdInZone(new Date(), "Asia/Shanghai");

function makeConfig(values: Record<string, string> = {}, mappings: AsinMapping[] = [{ sku: "SKU-XYLO", asin: XYLO, competitors: [MANUAL], adMarker: "" }]): AppConfig {
  const all: Record<string, string> = { FEISHU_NOTIFY_USER_IDS: "u1", SP_API_SELLER_ID: OWN, ...values };
  return {
    get: (key: string) => { const value = all[key]; if (!value) throw new Error(`缺少 ${key}`); return value; },
    optional: (key: string, fallback = "") => all[key] ?? fallback,
    bool: (key: string, fallback = false) => all[key] === undefined ? fallback : all[key] === "true",
    json: () => { throw new Error("unused"); },
    asins: () => mappings.map((item) => ({ ...item, competitors: [...item.competitors] })),
    version: "test",
  };
}

interface CatalogItem { brand: string; title?: string; group?: string; rank?: number }
interface World {
  listings: Array<{ sku: string; asin: string; buyable: boolean }>;
  similar: Record<string, string[]>;
  catalog: Record<string, CatalogItem>;
  offers: Record<string, { price: number; featured?: boolean }>;
  fail: { similar?: boolean; catalog?: boolean };
}

const money = (amount: number): Row => ({ amount, currencyCode: "USD" });
const offerRow = (sellerId: string, price: number): Row => ({ sellerId, condition: "New", fulfillmentType: "AFN", listingPrice: money(price), shippingOptions: [{ shippingOptionType: "DEFAULT", price: money(0) }], featuredOfferSegments: [{ customerMembership: "NON_PRIME", segmentDetails: { glanceViewWeightPercentage: 100 } }] });

// 本店：木琴、瓢虫在售，父体不在售；木琴的相似商品里混有本店商品、本店品牌（大小写不同）、人工竞品、无报价、不同大类的商品。
function baseWorld(): World {
  return {
    listings: [{ sku: "SKU-XYLO", asin: XYLO, buyable: true }, { sku: "SKU-LADYBUG", asin: LADYBUG, buyable: true }, { sku: "SKU-PARENT", asin: PARENT, buyable: false }],
    similar: { [XYLO]: [LADYBUG, "B0OWNBRAND", MANUAL, "B0NOOFFER1", "B0SPOON001", A1, A2, A3], [LADYBUG]: [A3, A4] },
    catalog: {
      // 本店商品标题决定“非常相似”的核心词（用户 10/06）：木琴核心词 xylophone，瓢虫核心词 ladybug。
      [XYLO]: { brand: "Acme", title: "Acme Xylophone Toys for 1 Year Old, Colorful Musical Drum Set", group: TOY, rank: 45_000 },
      [LADYBUG]: { brand: "Acme", title: "Acme Ladybug Toy, Rolling Musical Bug for Toddlers", group: TOY, rank: 100_000 },
      B0OWNBRAND: { brand: "acme", group: TOY }, [MANUAL]: { brand: "BrandW", group: TOY, rank: 1_369 }, B0NOOFFER1: { brand: "BrandN", group: TOY },
      B0SPOON001: { brand: "BrandS", title: "BrandS Silicone Baby Spoon", group: BABY, rank: 54_690 },
      [A1]: { brand: "BrandI", title: "BrandI Wooden Xylophone for Toddlers 8-Key Musical", group: TOY, rank: 5_000 },
      [A2]: { brand: "BrandV", title: "BrandV Baby Learning Musical Xylophone", group: TOY, rank: 300 },
      [A3]: { brand: "BrandQ", title: "Musical Ladybug Baby Toys", group: TOY, rank: 900 },
      [A4]: { brand: "BrandF", title: "BrandF Musical Ladybug Rolling", group: TOY, rank: 100 },
      [A5]: { brand: "BrandT", title: "BrandT Stacking Cups Toy", group: TOY, rank: 2_000 },
    },
    offers: { B0OWNBRAND: { price: 11.11 }, [MANUAL]: { price: 15.99 }, B0SPOON001: { price: 8.99 }, [A1]: { price: 19.99 }, [A2]: { price: 24.99 }, [A3]: { price: 17.5, featured: false }, [A4]: { price: 9.99 }, [A5]: { price: 21.99 } },
    fail: {},
  };
}

function harness(world: World, initial: Row[] = [], StateClass: typeof MemoryState = MemoryState) {
  const state = new StateClass(initial);
  const sent: string[][] = [];
  const calls: Array<{ path: string; kind: string; asins: string[] }> = [];
  const amazon = {
    sp: async (path: string, init: { method?: string; query?: Row; body?: { requests?: Row[] } } = {}) => {
      if (path.startsWith("/listings/")) {
        calls.push({ path, kind: "listings", asins: [] });
        return { items: world.listings.map((item) => ({ sku: item.sku, summaries: [{ marketplaceId: US, asin: item.asin, status: item.buyable ? ["BUYABLE", "DISCOVERABLE"] : ["DISCOVERABLE"], itemName: `Acme ${item.sku}` }], offers: [{ marketplaceId: US, price: { amount: 12.99 } }] })) };
      }
      if (path === COMPETITIVE_SUMMARY_PATH) {
        const requests = init.body?.requests ?? [];
        const similar = requests.some((request) => (request.includedData as string[]).includes("similarItems"));
        calls.push({ path, kind: similar ? "similar" : "offers", asins: requests.map((request) => String(request.asin)) });
        if (similar && world.fail.similar) throw new Error("similar down");
        return { responses: requests.map((request) => {
          const asin = String(request.asin);
          if (similar) return { status: { statusCode: 200 }, body: { asin, marketplaceId: US, similarItems: [{ items: (world.similar[asin] ?? []).map((item) => ({ asin: item })) }] } };
          const offer = world.offers[asin];
          return { status: { statusCode: 200 }, body: { asin, marketplaceId: US,
            featuredBuyingOptions: offer && offer.featured !== false ? [{ buyingOptionType: "New", segmentedFeaturedOffers: [offerRow("S-FEAT", offer.price)] }] : [],
            lowestPricedOffers: offer ? [{ lowestPricedOffersInput: { itemCondition: "New", offerType: "Consumer" }, offers: [offerRow("S-LOW", offer.price)] }] : [] } };
        }) };
      }
      if (path === "/catalog/2022-04-01/items") {
        const ids = String(init.query?.identifiers ?? "").split(",").filter(Boolean);
        calls.push({ path, kind: "catalog", asins: ids });
        if (world.fail.catalog) throw new Error("catalog down");
        return { items: ids.filter((id) => world.catalog[id]).map((id) => {
          const item = world.catalog[id]!;
          return { asin: id, summaries: [{ marketplaceId: US, brand: item.brand, itemName: item.title ?? `${item.brand} toy` }], salesRanks: item.group ? [{ marketplaceId: US, displayGroupRanks: [{ websiteDisplayGroup: item.group, title: "x", rank: item.rank ?? 50_000 }] }] : [] };
        }) };
      }
      if (path === "/promotions/2025-12-01/promotions") return { promotions: [] };
      throw new Error(`unexpected ${path}`);
    },
  } as unknown as AmazonClient;
  const feishu = { sendText: async (_user: string, lines: string[]) => { sent.push(lines); } } as unknown as FeishuClient;
  return { state, sent, calls, amazon, feishu };
}

const autoOf = (state: MemoryState, asin: string): string[] => ((state.item("COMPETITOR_SET", asin)?.auto ?? []) as AutoCompetitor[]).map((entry) => entry.asin);
const notificationOf = (state: MemoryState, prefix: string): Row | undefined => state.partition("NOTIFICATION").find((item) => String(item.sk).startsWith(prefix));
const summaries = (sent: string[][]): string[][] => sent.filter((lines) => lines[0]?.startsWith("🔁"));

test("竞品首轮自动建清单：人工计入上限，排除本店商品/品牌、人工、无报价、不同大类；按 Buy Box→排名排序；比价复用刷新时的报价，新竞品只记基准；汇总消息先持久化再写清单", async () => {
  const world = baseWorld();
  // 加拿大站独有的本店 ASIN（报价对账缓存里有、美国站 listing 里没有）也不能当竞品。
  world.similar[XYLO] = [...world.similar[XYLO]!, "B0CAONLY01"];
  world.catalog.B0CAONLY01 = { brand: "Other", group: TOY, rank: 10 };
  world.offers.B0CAONLY01 = { price: 9.99 };
  const h = harness(world, [{ pk: "OFFER_LISTINGS", sk: "A2EUQ1WTGCTBG2", asins: { B0CAONLY01: { skus: ["SKU-CA"], hasOffer: true, buyable: true, title: "CA only" } }, refreshedAt: new Date().toISOString() }]);
  const config = makeConfig({ COMPETITOR_MAX_PER_PRODUCT: "3" });
  const first = await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, config, h.state.asStore(), h.amazon, h.feishu);
  assert.equal(first.refresh, "done");
  assert.equal(first.refreshAdded, 4);
  assert.deepEqual(autoOf(h.state, XYLO), [A2, A1], "人工 1 个占名额，只补 2 个；有 Buy Box 的按排名在前；A3 是瓢虫、与木琴不够相似，不加入");
  assert.deepEqual(autoOf(h.state, LADYBUG), [A4, A3]);
  assert.equal(h.state.item("COMPETITOR_SET", PARENT), undefined, "不在售的商品不建清单");
  assert.deepEqual(h.state.item("COMPETITOR_SET", XYLO)?.skus, ["SKU-XYLO"]);
  assert.equal(h.state.item("COMPETITOR_SET_META", "state")?.seq, 1);
  assert.equal(h.state.item("COMPETITOR_SET_META", "state")?.lastRefreshDay, today());
  assert.equal(h.state.item("HEALTH", "competitor-sets")?.lastStatus, "done");
  assert.deepEqual(h.calls.map((call) => call.kind), ["listings", "similar", "catalog", "offers"], "比价阶段全部复用刷新时查过的报价，不再多调一批");
  assert.deepEqual(h.calls[1]!.asins, [XYLO, LADYBUG], "只对在售的自有商品取相似商品");
  assert.ok(!h.calls[3]!.asins.includes("B0OWNBRAND"), "本店品牌不查报价");
  assert.ok(!h.calls[2]!.asins.includes("B0CAONLY01") && !h.calls[3]!.asins.includes("B0CAONLY01"), "其它站点的本店 ASIN 直接排除");
  assert.ok(!h.calls.flatMap((call) => call.asins).includes(PARENT));
  const messages = summaries(h.sent);
  assert.equal(messages.length, 1, "整轮只发一条汇总");
  const text = messages[0]!.join("\n");
  assert.match(text, /本次新增 4 个、移除 0 个；现跟踪 5 个竞品 ASIN（人工 1、自动 4）/);
  assert.match(text, /每个商品最多 3 个，人工填写的计入且永远保留/);
  assert.match(text, /【SKU-XYLO｜B0OWN1XYLO】现跟踪 3 个（人工 1、自动 2）/);
  assert.match(text, /＋ B0COMPA002 BrandV \$24\.99｜BrandV Baby Learning/);
  assert.match(text, /【SKU-LADYBUG｜B0OWN2LADY】现跟踪 2 个（人工 0、自动 2）/);
  assert.match(text, /COMPETITOR_EXCLUDE_ASINS/);
  for (const excluded of [LADYBUG, "B0OWNBRAND", "B0NOOFFER1", "B0SPOON001", "B0CAONLY01"]) assert.ok(!text.includes(`＋ ${excluded}`), `${excluded} 不应入选`);
  const pointer = h.state.writes.findIndex((write) => write.pk === "NOTIFICATION_PENDING" && write.sk.startsWith("competitor-set|1|"));
  const firstSet = h.state.writes.findIndex((write) => write.pk === "COMPETITOR_SET");
  assert.ok(pointer >= 0 && pointer < firstSet, "通知意图先于清单写入");
  assert.equal(notificationOf(h.state, "competitor-set|1|")?.status, "done");
  assert.equal(h.sent.filter((lines) => lines[0] === "竞品价格变化").length, 0, "新竞品只记基准");
  for (const asin of [MANUAL, A1, A2, A3, A4]) assert.ok(h.state.item("COMPETITOR_PRICE", asin), `${asin} 已记基准`);
  assert.equal(first.autoTracked, 4);

  // 同一天再跑：未到 7 天不刷新；价格变化照常提醒，自动竞品在原有行后追加品牌与标题。
  world.offers[A4] = { price: 11.49 };
  world.offers[MANUAL] = { price: 14.99 };
  h.calls.length = 0;
  const second = await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, config, h.state.asStore(), h.amazon, h.feishu);
  assert.equal(second.refresh, undefined);
  assert.deepEqual(h.calls.map((call) => call.kind), ["offers"]);
  assert.deepEqual(h.calls[0]!.asins, [MANUAL, A2, A1, A4, A3], "人工在前、自动按商品与清单顺序");
  const changes = h.sent.filter((lines) => lines[0] === "竞品价格变化");
  assert.deepEqual(changes.find((lines) => lines.includes(`竞品ASIN：${MANUAL}`)), ["竞品价格变化", "15.99 → 14.99", "SKU：SKU-XYLO", `竞品ASIN：${MANUAL}`, "Buy Box：FBA", "促销：无"], "人工竞品通知格式不变");
  assert.deepEqual(changes.find((lines) => lines.includes(`竞品ASIN：${A4}`)), ["竞品价格变化", "9.99 → 11.49", "SKU：SKU-LADYBUG", `竞品ASIN：${A4}`, "Buy Box：FBA", "促销：无", "竞品：BrandF｜BrandF Musical Ladybug Rolling（自动跟踪）"]);
  assert.equal(summaries(h.sent).length, 1, "清单没变不再发汇总");
});

const autoEntry = (asin: string, misses = 0, addedAt = "2026-09-01T06:00:00.000Z"): AutoCompetitor => ({ asin, addedAt, lastSeenAt: addedAt, misses, brand: `brand-${asin.slice(-3)}`, title: "t", price: 10, salesRank: 1000, similarRank: 1 });
const fact = (overrides: Partial<CandidateFacts> = {}): CandidateFacts => ({ found: true, brand: "Other", title: "t", groups: [TOY], salesRank: 1000, offer: true, featured: true, price: 12, ...overrides });
const setOf = (asin: string, auto: AutoCompetitor[], refreshSeq = 1): CompetitorSet => ({ pk: "COMPETITOR_SET", sk: asin, asin, skus: [`SKU-${asin.slice(-3)}`], active: true, auto, refreshSeq, refreshedAt: "2026-09-28T06:00:00.000Z", updatedAt: "2026-09-28T06:00:00.000Z" });

function planInput(products: ProductObservation[], previous: CompetitorSet[], facts: Record<string, CandidateFacts>, overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    products, previous: new Map(previous.map((set) => [set.asin, set])), manual: manualIndex([]), facts: new Map(Object.entries(facts)),
    ownAsins: new Set([XYLO, LADYBUG]), ownBrands: new Set(["acme"]), settings: { perProduct: 10, total: 0, excluded: new Set() },
    now: "2026-10-05T06:00:00.000Z", seq: 2, ...overrides,
  };
}

test("竞品清单防抖：连续 3 次不合格才移除，再次出现清零；排除名单、本店品牌立即移除；改成人工的不再占自动名额；取数失败原样保留；本店商品不在售也按次累计", () => {
  const previous = setOf(XYLO, [autoEntry(A1), autoEntry(A2, COMPETITOR_DROP_AFTER - 1), autoEntry(A3, 1), autoEntry(A4), autoEntry(A5), autoEntry("B0BRANDOWN"), autoEntry(MANUAL)]);
  const observed: ProductObservation = { asin: XYLO, skus: ["SKU-XYLO"], active: true, similar: [A1, A3], groups: [TOY] };
  const [plan] = planCompetitorSets(planInput([observed], [previous], { [A1]: fact(), [A3]: fact({ offer: false, featured: false }), "B0BRANDOWN": fact({ brand: "Acme" }) }, {
    settings: { perProduct: 10, total: 0, excluded: new Set([A5]) },
    manual: manualIndex([{ sku: "SKU-XYLO", asin: XYLO, competitors: [MANUAL], adMarker: "" }]),
  }));
  const next = new Map(plan!.next!.auto.map((entry) => [entry.asin, entry]));
  assert.equal(next.get(A1)?.misses, 0, "仍在相似商品里且合格");
  assert.equal(next.get(A3)?.misses, 2, "在相似商品里但没有报价：累计一次");
  assert.equal(next.get(A3)?.missReason, "没有全新品报价");
  assert.equal(next.get(A4)?.misses, 1, "只缺一次，不移除");
  assert.equal(next.get(A4)?.missReason, "不在亚马逊相似商品里");
  assert.equal(next.has(MANUAL), false);
  assert.deepEqual(plan!.removed.map((entry) => [entry.asin, entry.reason]).sort(), [
    [A2, `连续 ${COMPETITOR_DROP_AFTER} 次刷新不在亚马逊相似商品里`], [A5, "已加入排除名单"], ["B0BRANDOWN", "本店品牌"],
  ].sort());
  assert.ok(!plan!.removed.some((entry) => entry.asin === MANUAL), "改成人工竞品不算移除");
  assert.deepEqual(plan!.next!.auto.map((entry) => entry.asin), [A1, A4, A3], "未出现次数少的排在前面");

  const back = planCompetitorSets(planInput([{ ...observed, similar: [A4] }], [setOf(XYLO, [autoEntry(A4, 2)])], { [A4]: fact() }));
  assert.equal(back[0]!.next!.auto[0]!.misses, 0, "再次出现即清零");

  const unknown = planCompetitorSets(planInput([{ asin: XYLO, skus: ["SKU-XYLO"], active: true, groups: [TOY] }], [setOf(XYLO, [autoEntry(A1, 2)])], {}));
  assert.equal(unknown[0]!.next!.auto[0]!.misses, 2, "相似商品没取到：不算不合格");
  assert.deepEqual(unknown[0]!.removed, []);

  const inactive = planCompetitorSets(planInput([{ asin: XYLO, skus: [], active: false, groups: [] }], [setOf(XYLO, [autoEntry(A1, 2), autoEntry(A2)])], {}));
  assert.deepEqual(inactive[0]!.removed, [{ asin: A1, brand: "brand-001", reason: `连续 ${COMPETITOR_DROP_AFTER} 次刷新时本店商品不在售` }]);
  assert.equal(inactive[0]!.next!.auto[0]!.misses, 1);
  assert.deepEqual(inactive[0]!.next!.skus, ["SKU-YLO"], "不在售时沿用原 SKU");

  const emptied = planCompetitorSets(planInput([{ asin: XYLO, skus: [], active: false, groups: [] }], [setOf(XYLO, [autoEntry(A1, 2)])], {}));
  assert.equal(emptied[0]!.next, undefined, "不在售且已清空：删除该商品清单");

  const frozen = planCompetitorSets(planInput([observed], [setOf(XYLO, [autoEntry(A2, 2)], 2)], {}));
  assert.equal(frozen[0]!.frozen, true, "同一刷新序号已写过：原样保留，不重复累计");
  assert.equal(frozen[0]!.next!.auto[0]!.misses, 2);
});

test("竞品名额：每个商品人工先占；降低上限时多出的自动竞品按“未出现次数多、加入晚”的先移除；全店上限按不同 ASIN 轮流分配，已跟踪的不被新候选挤掉", () => {
  const previous = setOf(XYLO, [autoEntry(A1, 0, "2026-09-01T00:00:00.000Z"), autoEntry(A2, 1, "2026-09-02T00:00:00.000Z"), autoEntry(A3, 0, "2026-09-03T00:00:00.000Z")]);
  const observed: ProductObservation = { asin: XYLO, skus: ["SKU-XYLO"], active: true, similar: [A1, A3, A4], groups: [TOY] };
  const [plan] = planCompetitorSets(planInput([observed], [previous], { [A1]: fact(), [A3]: fact(), [A4]: fact() }, {
    settings: { perProduct: 3, total: 0, excluded: new Set() },
    manual: manualIndex([{ sku: "SKU-XYLO", asin: XYLO, competitors: [MANUAL], adMarker: "" }]),
  }));
  assert.deepEqual(plan!.next!.auto.map((entry) => entry.asin), [A1, A3]);
  assert.deepEqual(plan!.removed, [{ asin: A2, brand: "brand-002", reason: "超出每个商品 3 个的上限" }]);
  assert.deepEqual(plan!.added, [], "名额已满，新候选 A4 不加入");

  const manual = new Set([MANUAL]);
  const queues = [
    { product: LADYBUG, manual: new Set<string>(), entries: [A3, A4, A5] },
    { product: XYLO, manual, entries: [A1, A2, A3] },
  ];
  assert.deepEqual([...allocateSlots(queues, 10, 0, manual)], [[XYLO, [A1, A2, A3]], [LADYBUG, [A3, A4, A5]]], "未配置全店上限：只看每个商品的上限");
  assert.deepEqual([...allocateSlots(queues, 10, 4, manual)], [[XYLO, [A1, A2, A3]], [LADYBUG, [A3]]], "全店 4 个：人工占 1，剩 3 个按各商品第 1 名、第 2 名轮流分；已选中的 ASIN 再被别的商品跟踪不另占名额");
  assert.deepEqual([...allocateSlots(queues, 10, 5, manual)], [[XYLO, [A1, A2, A3]], [LADYBUG, [A3, A4]]], "同一 ASIN 被两个商品跟踪只算一个名额");
  assert.deepEqual([...allocateSlots(queues, 10, 1, manual)], [[XYLO, []], [LADYBUG, []]], "人工已用完全店名额：不再补自动");

  const totalCapped = planCompetitorSets(planInput([observed, { asin: LADYBUG, skus: ["SKU-LADYBUG"], active: true, similar: [A5], groups: [TOY] }], [setOf(XYLO, [autoEntry(A1), autoEntry(A3)])], { [A1]: fact(), [A3]: fact(), [A4]: fact(), [A5]: fact() }, { settings: { perProduct: 10, total: 2, excluded: new Set() } }));
  assert.deepEqual(totalCapped.map((item) => [item.asin, item.next?.auto.map((entry) => entry.asin), item.removed.map((entry) => entry.reason)]), [
    [XYLO, [A1], ["超出全店 2 个的上限"]], [LADYBUG, [A5], []],
  ]);
});

test("竞品清单刷新失败不影响当天比价：沿用已存清单、不写刷新元数据，次日重试；目录读不到也不冒险加入", async () => {
  const world = baseWorld();
  world.fail.similar = true;
  const h = harness(world, [{ pk: "COMPETITOR_SET_META", sk: "state", seq: 1, lastRefreshDay: addDaysYmd(today(), -8) }, { ...setOf(LADYBUG, [autoEntry(A4)]) }]);
  const config = makeConfig();
  const result = await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, config, h.state.asStore(), h.amazon, h.feishu);
  assert.equal(result.refresh, "failed");
  assert.match(String(result.refreshError), /similar down/);
  assert.equal(result.checked, 2, "人工 1 个＋已存自动 1 个照常比价");
  assert.equal(h.state.item("COMPETITOR_SET_META", "state")?.seq, 1, "失败不推进刷新序号与时间，下次照样到期");
  assert.equal(h.state.item("HEALTH", "competitor-sets"), undefined);
  assert.deepEqual(summaries(h.sent), []);

  world.fail.similar = false;
  world.fail.catalog = true;
  const catalogDown = await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, config, h.state.asStore(), h.amazon, h.feishu);
  assert.equal(catalogDown.refresh, "failed", "目录不可用时宁可不刷新，也不把品牌未知的商品加进来");
  assert.deepEqual(autoOf(h.state, LADYBUG), [A4]);

  world.fail.catalog = false;
  const retried = await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, config, h.state.asStore(), h.amazon, h.feishu);
  assert.equal(retried.refresh, "done");
  assert.deepEqual(autoOf(h.state, LADYBUG), [A4, A3]);
});

test("竞品清单 7 天刷新一次（按北京日期）；中途写入失败后重跑同一序号：已写的商品不重复累计，汇总消息只发一次且内容完整", async () => {
  const world = baseWorld();
  const recent = harness(world, [{ pk: "COMPETITOR_SET_META", sk: "state", seq: 4, lastRefreshDay: addDaysYmd(today(), -6) }]);
  const notDue = await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, makeConfig(), recent.state.asStore(), recent.amazon, recent.feishu);
  assert.equal(notDue.refresh, undefined);
  assert.ok(!recent.calls.some((call) => call.kind === "similar"));
  const due = harness(world, [{ pk: "COMPETITOR_SET_META", sk: "state", seq: 4, lastRefreshDay: addDaysYmd(today(), -7) }]);
  const ran = await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, makeConfig(), due.state.asStore(), due.amazon, due.feishu);
  assert.equal(ran.refresh, "done");
  assert.equal(due.state.item("COMPETITOR_SET_META", "state")?.seq, 5);
  assert.equal(notificationOf(due.state, "competitor-set|5|")?.status, "done");

  let failOnce = true;
  class FlakyState extends MemoryState {
    override async put(item: Row, condition?: string): Promise<void> {
      if (failOnce && item.pk === "COMPETITOR_SET" && item.sk === LADYBUG) { failOnce = false; throw new Error("DynamoDB timeout"); }
      await super.put(item, condition);
    }
  }
  const flaky = harness(baseWorld(), [], FlakyState);
  const broken = await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, makeConfig(), flaky.state.asStore(), flaky.amazon, flaky.feishu);
  assert.equal(broken.refresh, "failed");
  assert.equal(flaky.state.item("COMPETITOR_SET", XYLO)?.refreshSeq, 1, "木琴清单已写入");
  assert.equal(notificationOf(flaky.state, "competitor-set|1|")?.status, "pending", "汇总意图已持久化，待补发");
  assert.deepEqual(summaries(flaky.sent), []);
  const healed = await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, makeConfig(), flaky.state.asStore(), flaky.amazon, flaky.feishu);
  assert.equal(healed.refresh, "done");
  assert.equal(flaky.state.item("COMPETITOR_SET_META", "state")?.seq, 1, "重跑沿用同一序号");
  assert.deepEqual(autoOf(flaky.state, XYLO), [A2, A1], "A3 是瓢虫，与木琴不够相似（用户 10/06：只收同款或非常相似的）");
  assert.deepEqual(autoOf(flaky.state, LADYBUG), [A4, A3]);
  const messages = summaries(flaky.sent);
  assert.equal(messages.length, 1);
  assert.ok(messages[0]!.some((line) => line.startsWith("＋ B0COMPA002")) && messages[0]!.some((line) => line.startsWith("＋ B0COMPA004")), "消息含两次运行的全部新增");
});

test("比价读取时按当前配置过滤自动竞品：排除名单与上限当天生效；移除后再加入的竞品首次比价只记基准；停用自动竞品只比价人工并记健康", async () => {
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const addedAt = new Date(Date.now() - 60_000).toISOString();
  const world = baseWorld();
  const initial: Row[] = [
    { pk: "COMPETITOR_SET_META", sk: "state", seq: 3, lastRefreshDay: today() },
    { ...setOf(XYLO, [autoEntry(A1, 0, addedAt), autoEntry(A2, 0, addedAt), autoEntry(A3, 0, addedAt)]), skus: ["SKU-XYLO"] },
    { pk: "COMPETITOR_PRICE", sk: A2, price: 30, basis: "competitiveSummary-v1", promoSignature: "", updatedAt: old },
    { pk: "COMPETITOR_PRICE_META", sk: "basis", basis: "competitiveSummary-v1" },
  ];
  const h = harness(world, initial);
  const config = makeConfig({ COMPETITOR_EXCLUDE_ASINS: `${A1}，b0nothing0`, COMPETITOR_MAX_PER_PRODUCT: "3" });
  const result = await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, config, h.state.asStore(), h.amazon, h.feishu);
  assert.deepEqual(h.calls.map((call) => call.asins), [[MANUAL, A2, A3]], "A1 被排除；人工 1＋自动 2＝上限 3");
  assert.equal(result.autoTracked, 2);
  assert.equal(h.sent.filter((lines) => lines[0] === "竞品价格变化").length, 0, "A2 的旧价记录早于本次加入：只记基准");
  assert.equal(h.state.item("COMPETITOR_PRICE", A2)?.price, 24.99);
  world.offers[A2] = { price: 22.99 };
  await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, config, h.state.asStore(), h.amazon, h.feishu);
  assert.equal(h.sent.filter((lines) => lines[0] === "竞品价格变化" && lines.includes(`竞品ASIN：${A2}`)).length, 1, "加入后再变价照常提醒");

  h.calls.length = 0;
  const disabled = await runCompetitorPrices({ taskType: "competitor-prices", scheduledAt: DAILY_SLOT }, makeConfig({ COMPETITOR_AUTO_ENABLED: "false" }), h.state.asStore(), h.amazon, h.feishu);
  assert.deepEqual(h.calls.map((call) => call.asins), [[MANUAL]]);
  assert.equal(disabled.autoTracked, undefined);
  assert.equal(h.state.item("HEALTH", "competitor-sets")?.lastStatus, "done", "停用也记健康，避免误报");
  assert.deepEqual(autoOf(h.state, XYLO), [A1, A2, A3], "停用不删已存清单");
  await assert.rejects(() => runCompetitorRefresh({ taskType: "competitor-refresh", cursor: { apply: true } }, makeConfig({ COMPETITOR_AUTO_ENABLED: "false" }), h.state.asStore(), h.amazon, h.feishu), /已停用/);
});

test("目录事实：销售大类以销售排名为准（展示大类不同也以排名为准），新品没有排名时退回目录展示大类；每次最多查 20 个 ASIN", async () => {
  const queries: string[][] = [];
  const amazon = { sp: async (_path: string, init: { query: Row }) => {
    const ids = String(init.query.identifiers).split(",");
    queries.push(ids);
    return { items: ids.map((id) => ({ asin: id, summaries: [{ marketplaceId: US, brand: "B", itemName: `item ${id}`, websiteDisplayGroup: id === "B0NEWPULL0" ? TOY : BABY }],
      salesRanks: id === "B0NEWPULL0" ? [] : [{ marketplaceId: US, displayGroupRanks: [{ websiteDisplayGroup: id === "B0SOOTHER0" ? "hpc_display_on_website" : TOY, title: "x", rank: 500 }] }] })) };
  } } as unknown as AmazonClient;
  const extra = Array.from({ length: 19 }, (_, index) => `B0EXTRA${String(index).padStart(3, "0")}`);
  const facts = await catalogFacts(amazon, ["B0KAZOO000", "B0NEWPULL0", "B0SOOTHER0", ...extra]);
  assert.deepEqual(queries.map((ids) => ids.length), [20, 2]);
  assert.deepEqual(facts.get("B0KAZOO000"), { brand: "B", title: "item B0KAZOO000", groups: [TOY], salesRank: 500 }, "展示大类是 baby、排名在 toy：以排名为准");
  assert.deepEqual(facts.get("B0NEWPULL0")?.groups, [TOY], "新品无排名：退回展示大类");
  assert.equal(facts.get("B0NEWPULL0")?.salesRank, null);
  const pull: ProductObservation = { asin: "B0NEWPULL0", skus: ["SKU-PULL"], active: true, similar: ["B0SOOTHER0", A1], groups: facts.get("B0NEWPULL0")!.groups };
  const [plan] = planCompetitorSets(planInput([pull], [], { B0SOOTHER0: fact({ groups: ["hpc_display_on_website"] }), [A1]: fact() }));
  assert.deepEqual(plan!.added.map((entry) => entry.asin), [A1], "新品也能按大类排除不相干的商品");
});

test("手动 competitor-refresh 默认只读预览（不写状态、不发消息）；apply 立即刷新并发汇总，无变化不发；维护任务健康规则 8 天 6 小时", async () => {
  const world = baseWorld();
  const h = harness(world);
  const config = makeConfig();
  const preview = await runJob({ taskType: "competitor-refresh", taskId: "competitor-refresh|x" }, { config, state: h.state.asStore(), amazon: h.amazon, feishu: h.feishu });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.added, 4, "木琴 2 个＋瓢虫 2 个；瓢虫 A3 不进木琴清单");
  assert.deepEqual(h.state.writes, [], "预览零写入");
  assert.deepEqual(h.sent, []);
  const xyloPlan = (preview.plan as Row[]).find((item) => item.asin === XYLO);
  assert.deepEqual(xyloPlan?.added, [`${A2} BrandV $24.99`, `${A1} BrandI $19.99`]);
  const applied = await runCompetitorRefresh({ taskType: "competitor-refresh", cursor: { apply: true } }, config, h.state.asStore(), h.amazon, h.feishu);
  assert.equal(applied.mode, "apply");
  assert.equal(applied.notified, true);
  assert.equal(summaries(h.sent).length, 1);
  const again = await runCompetitorRefresh({ taskType: "competitor-refresh", cursor: { apply: true } }, config, h.state.asStore(), h.amazon, h.feishu);
  assert.equal(again.added, 0);
  assert.equal(again.removed, 0);
  assert.equal(summaries(h.sent).length, 1, "没有变化不发消息");
  assert.equal(h.state.item("COMPETITOR_SET_META", "state")?.seq, 2);
  assert.equal(HEALTH_RULES["competitor-sets"], (8 * 24 + 6) * 3_600_000);
});
