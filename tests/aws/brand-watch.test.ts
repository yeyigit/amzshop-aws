import assert from "node:assert/strict";
import test from "node:test";
import { runBrandWatch, titleSimilarity, titleTokens } from "../../src/business/brand-watch.js";
import type { AppConfig } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { MemoryState } from "./memory-state.js";

type Row = Record<string, unknown>;
const OWN = "SELLER-OWN";
const US = "ATVPDKIKX0DER";
const CA = "A2EUQ1WTGCTBG2";

function makeConfig(values: Record<string, string> = {}): AppConfig {
  const all: Record<string, string> = { FEISHU_NOTIFY_USER_IDS: "u1", SP_API_SELLER_ID: OWN, ...values };
  return {
    get: (key: string) => { const value = all[key]; if (!value) throw new Error(`缺少 ${key}`); return value; },
    optional: (key: string, fallback = "") => all[key] ?? fallback,
    bool: (_key: string, fallback = false) => fallback,
    json: () => { throw new Error("unused"); },
    asins: () => [],
    version: "test",
  };
}

const catalogItem = (asin: string, brand: string, itemName: string, marketplaceId = US): Row => ({ asin, summaries: [{ marketplaceId, brand, itemName }] });

function world(options: { listingsFail?: boolean } = {}) {
  const calls: Array<{ path: string; query: Row }> = [];
  const amazon = {
    sp: async (path: string, init: { query?: Row } = {}) => {
      const query = init.query ?? {};
      calls.push({ path, query });
      if (path.startsWith("/listings/")) {
        if (options.listingsFail) throw new Error("listings down");
        if (query.marketplaceIds === US) return { items: [{ sku: "SKU-XYLO", summaries: [{ marketplaceId: US, asin: "B0OWN00001", status: ["BUYABLE"], itemName: "Acme Baby Xylophone Toy Musical Drum with Light" }], offers: [{ marketplaceId: US, price: { amount: 14.49 } }] }] };
        if (query.marketplaceIds === CA) return { items: [{ sku: "SKU-SAND", summaries: [{ marketplaceId: CA, asin: "B0CAOWN001", status: ["DISCOVERABLE"], itemName: "Acme Sand Bucket" }], offers: [] }] };
        return { items: [] };
      }
      if (path === "/catalog/2022-04-01/items") {
        if (query.marketplaceIds !== US) return { items: [] };
        return { items: [
          catalogItem("B0OWN00001", "Acme", "Acme Baby Xylophone Toy Musical Drum with Light"),
          catalogItem("B0CAOWN001", "Acme", "Acme Sand Bucket"),
          catalogItem("B0FAKE0001", "acme", "Acme Baby Xylophone Toy Musical Drum Light Up for Infants"),
          catalogItem("B0OTHER001", "OtherBrand", "OtherBrand xylophone"),
        ] };
      }
      if (path.startsWith("/catalog/2022-04-01/items/")) return { summaries: [{ brand: "Acme" }] };
      throw new Error(`unexpected ${path}`);
    },
  } as unknown as AmazonClient;
  const sent: string[][] = [];
  const feishu = { sendText: async (_user: string, lines: string[]) => { sent.push(lines); } } as unknown as FeishuClient;
  return { amazon, feishu, sent, calls };
}

test("品牌冒用检查：本店任何站点的 ASIN 都不误报、品牌不一致不报；每个站点＋ASIN 只提醒一次，并按标题给出疑似对应 SKU", async () => {
  const w = world();
  const state = new MemoryState();
  const config = makeConfig({ BRAND_WATCH_BRANDS: "Acme" });
  const first = await runBrandWatch({ taskType: "brand-watch" }, config, state.asStore(), w.amazon, w.feishu);
  assert.equal(first.status, "done");
  assert.equal(first.notified, 1);
  assert.equal(first.ownAsins, 2);
  assert.equal(w.sent.length, 1);
  const lines = w.sent[0]!;
  assert.deepEqual(lines.slice(0, 5), ["🔎 发现冒用你品牌的 listing（美国站）", "品牌：Acme", "对方 ASIN：B0FAKE0001", "链接：https://www.amazon.com/dp/B0FAKE0001", "标题：Acme Baby Xylophone Toy Musical Drum Light Up for Infants"]);
  assert.match(lines[5]!, /^疑似对应你的 SKU：SKU-XYLO（标题相似 \d+%）$/);
  const searches = w.calls.filter((call) => call.path === "/catalog/2022-04-01/items");
  assert.equal(searches.length, 3, "美/加/墨各搜一次");
  assert.ok(searches.every((call) => call.query.keywords === "Acme" && call.query.brandNames === "Acme"), "必须带品牌过滤");
  const second = await runBrandWatch({ taskType: "brand-watch" }, config, state.asStore(), w.amazon, w.feishu);
  assert.equal(second.notified, 0);
  assert.equal(w.sent.length, 1, "同一站点＋ASIN 只提醒一次");
  assert.equal(state.item("BRAND_WATCH", `${US}|B0FAKE0001`)?.notificationKey, `brand-watch|${US}|B0FAKE0001`);
});

test("品牌名未配置时取本店商品目录品牌并缓存；本店 listing 读不到且无 26 小时内缓存时任务失败，不冒险误报", async () => {
  const w = world();
  const state = new MemoryState();
  const result = await runBrandWatch({ taskType: "brand-watch" }, makeConfig(), state.asStore(), w.amazon, w.feishu);
  assert.equal(result.brands, 1);
  assert.deepEqual(state.item("OFFER_META", "brands")?.brands, ["Acme"]);
  const down = world({ listingsFail: true });
  await assert.rejects(() => runBrandWatch({ taskType: "brand-watch" }, makeConfig({ BRAND_WATCH_BRANDS: "Acme" }), new MemoryState().asStore(), down.amazon, down.feishu), /listing 读取失败且无 26 小时内的缓存/);
  assert.equal(down.sent.length, 0);
});

test("标题相似度忽略品牌词、常见词与重音", () => {
  const own = titleTokens("Acme Baby Xylophone Toy Musical Drum with Light", "Acme");
  assert.deepEqual([...own].sort(), ["drum", "light", "musical", "xylophone"]);
  assert.equal(titleSimilarity(own, titleTokens("Acme Xylophone Musical Drum Light Up for Infants", "Acme")), 0.8);
  assert.deepEqual([...titleTokens("Juguete de Jardín Cubo", "Acme")].sort(), ["cubo", "jardin", "juguete"]);
});
