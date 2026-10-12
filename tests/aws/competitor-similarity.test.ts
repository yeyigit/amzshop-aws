import assert from "node:assert/strict";
import test from "node:test";
import { competitorSettings, manualIndex, planCompetitorSets, productCore, productMatcher, trackedCompetitors, type AutoCompetitor, type CandidateFacts, type CompetitorSet, type PlanInput, type ProductObservation } from "../../src/business/competitor-sets.js";
import type { AppConfig, AsinMapping } from "../../src/types.js";
import { MemoryState } from "./memory-state.js";

// 每个商品最多 10 个是上限、不强行补满，必须同款或非常相似才算。以下商品、品牌与竞品标题均为虚构示例。
const OWN = {
  xylophone: "Acme Xylophone Toys for 1 Year Old, Colorful Musical Drum Set",
  kazoo: "Acme Kazoo Toy 3PCS Wooden Flute Humming Harmonica Set",
  sandbox: "Sandbox Toys for Toddlers, Beach Bucket and Shovel Set",
  ladybug: "Acme Rolling Ladybug Toy for Toddlers Moving Musical Bug",
  spinner: "Acme Spinning Top Toy Set with Launcher, Gyro Spinner for Kids",
  railway: "Wooden Railway Train Set for Kids, Bridge and Station Pieces",
  robot: "Acme Dancing Robot for Kids, Walking Robot Toy with Music",
  xylophone2: "Toddler Xylophone and Drum Set, Musical Instrument Toys",
  pullString: "Acme Pull String Toy, Hedgehog Activity Cube for Travel",
};
const matches = (own: string, competitor: string): boolean => productMatcher({ asin: "B0OWN00000", skus: [], title: own, brand: "Acme" })!(competitor);

test("核心词取标题第一段（去品牌与通用词）：木琴 xylophone、卡祖笛 kazoo/flute、沙池玩具 sandbox、瓢虫 rolling/ladybug、陀螺 spinning/top、小火车 railway/train、机器人 dancing/robot、拉绳玩具 pull/string", () => {
  assert.deepEqual(productCore(OWN.xylophone, "Acme"), ["xylophone"]);
  assert.deepEqual(productCore(OWN.kazoo, "Acme"), ["kazoo", "wooden", "flute", "humming", "harmonica"]);
  assert.deepEqual(productCore(OWN.sandbox, ""), ["sandbox"]);
  assert.deepEqual(productCore(OWN.ladybug, "Acme"), ["rolling", "ladybug", "moving", "bug"]);
  assert.deepEqual(productCore(OWN.spinner, "Acme"), ["spinning", "top"]);
  assert.deepEqual(productCore(OWN.railway, ""), ["wooden", "railway", "train"]);
  assert.deepEqual(productCore(OWN.robot, "Acme"), ["dancing", "robot"]);
  assert.deepEqual(productCore(OWN.xylophone2, ""), ["xylophone", "drum"]);
  assert.deepEqual(productCore(OWN.pullString, "Acme"), ["pull", "string"]);
});

test("非常相似判定：不相干的全部判否，同款与非常相似的判是", () => {
  // 不相干的例子：卡祖笛配摇铃/会说话的毛绒/变声器，拉绳玩具配形状分类/摇铃，陀螺配瓢虫/玩具车，跳舞机器人配只有“机器人”一个核心词相同的商品。
  for (const [own, competitor] of [
    [OWN.kazoo, "BrandA 10PCS Baby Rattle Set 3-6-12 Months, Infant Grasping Toys"],
    [OWN.kazoo, "BrandB Talking Plush Baby Singing Toy, Repeats What You Say"],
    [OWN.kazoo, "BrandA Kids Voice Changer Toy, Toddler Microphone with Fun Sounds"],
    [OWN.kazoo, "BrandC Suction Cup Toys, Sensory Baby Toys 6 Months Plus, Window Play Set"],
    [OWN.pullString, "BrandD Shape Sorter Toy - Kids Block Sorter with 16 Colorful Shapes"],
    [OWN.pullString, "BrandD Shape Sorter Baby Toys, Sorting & Stacking Blocks Toy for Toddlers"],
    [OWN.pullString, "BrandE Ocean Friends Shake Rattle Toy for Babies"],
    [OWN.spinner, "BrandF Baby Toys 6 to 12 Months, Musical Ladybug Rolling Infant Toys"],
    [OWN.spinner, "BrandA Baby Push and Go Car Toys for Toddlers 1-3"],
    [OWN.ladybug, "BrandG Baby Toys 6-12 Months, Musical Caterpillar with Lights"],
    [OWN.robot, "BrandH Talking Robot Toys for Kids 3-5, 3 Pack Electrical Robots"],
  ] as const) assert.equal(matches(own, competitor), false, competitor);
  for (const [own, competitor] of [
    [OWN.xylophone, "BrandI Wooden Xylophone for Toddlers - 8-Key Musical Instrument"],
    [OWN.xylophone, "BrandJ Musical Xylophone Drum Toy with Light-Up Keys for Toddlers 1-3"],
    [OWN.sandbox, "Sandbox Toys for Ages 1-3 Years Beach Toys Sand Toy for 1 2 3 Year Old"],
    [OWN.ladybug, "BrandF Baby Toys 6 to 12 Months, Musical Ladybug Rolling Infant Toys"],
    [OWN.ladybug, "Baby Toys 6 to 12 Months Rolling Ladybug Musical Infant Toy for 12 Mon"],
    [OWN.railway, "Railway Train Toys for Boys 3-5, Wooden Rail Set with Bridge"],
    [OWN.robot, "BrandK Remote Control Robot Toys for Boys, Dancing Robot with Lights"],
    [OWN.pullString, "BrandL Baby Pull String Toys - Montessori Baby Toy for 6-12 Months, Soft"],
    [OWN.spinner, "Spinning Top Toys for Kids, Classic Gyro Set"],
    [OWN.kazoo, "Baby Kazoo Flute Toy for Toddlers"],
  ] as const) assert.equal(matches(own, competitor), true, competitor);
});

const NOW = "2026-10-06T06:00:00.000Z";
const entry = (asin: string, title: string, misses = 0): AutoCompetitor => ({ asin, addedAt: "2026-10-01T06:00:00.000Z", lastSeenAt: "2026-10-01T06:00:00.000Z", misses, brand: "Other", title, price: 10, salesRank: 1000, similarRank: 1 });
const fact = (title: string): CandidateFacts => ({ found: true, brand: "Other", title, groups: ["toy"], salesRank: 1000, offer: true, featured: true, price: 12 });
const setOf = (asin: string, skus: string[], auto: AutoCompetitor[]): CompetitorSet => ({ pk: "COMPETITOR_SET", sk: asin, asin, skus, active: true, auto, refreshSeq: 1, refreshedAt: "2026-10-01T06:00:00.000Z", updatedAt: "2026-10-01T06:00:00.000Z" });
const input = (products: ProductObservation[], previous: CompetitorSet[], facts: Record<string, CandidateFacts>, settings: Partial<PlanInput["settings"]> = {}): PlanInput => ({
  products, previous: new Map(previous.map((set) => [set.asin, set])), manual: manualIndex([]), facts: new Map(Object.entries(facts)),
  ownAsins: new Set(products.map((product) => product.asin)), ownBrands: new Set(["acme"]),
  settings: { perProduct: 10, total: 0, excluded: new Set(), ...settings }, now: NOW, seq: 2,
});

test("刷新时不够相似的已跟踪自动竞品立即移除（不等 3 次防抖）、不够相似的候选不加入；取不到核心词时不自动加入；不在售商品不知标题时不做相似判定", () => {
  const ladybug: ProductObservation = { asin: "B0OWNLADYB", skus: ["SKU-LADYBUG"], active: true, similar: ["B0LADYB001", "B0CAR00001", "B0LADYB002"], groups: ["toy"], title: OWN.ladybug, brand: "Acme" };
  const facts = {
    B0LADYB001: fact("BrandF Baby Toys 6 to 12 Months, Musical Ladybug Rolling Infant Toys"),
    B0CAR00001: fact("BrandA Baby Push and Go Car Toys for Toddlers 1-3"),
    B0LADYB002: fact("Baby Toys 6 to 12 Months Rolling Ladybug Musical Infant Toy"),
  };
  const [plan] = planCompetitorSets(input([ladybug], [setOf(ladybug.asin, ladybug.skus, [entry("B0LADYB001", "BrandF Musical Ladybug Rolling"), entry("B0CAR00001", "BrandA Baby Push and Go Car Toys")])], facts));
  assert.deepEqual(plan!.next?.auto.map((item) => item.asin), ["B0LADYB001", "B0LADYB002"]);
  assert.deepEqual(plan!.removed, [{ asin: "B0CAR00001", brand: "Other", reason: "与本店商品不够相似" }]);
  assert.deepEqual(plan!.added.map((item) => item.asin), ["B0LADYB002"]);

  const vague: ProductObservation = { asin: "B0OWNVAGUE", skus: ["SKU-VAGUE"], active: true, similar: ["B0LADYB001"], groups: ["toy"], title: "Acme Baby Toys for Toddlers 1-3", brand: "Acme" };
  const [none] = planCompetitorSets(input([vague], [], facts));
  assert.deepEqual(none!.added, [], "本店标题只有通用词：宁缺毋滥");

  const inactive: ProductObservation = { asin: "B0OWNOLD00", skus: ["SKU-OLD"], active: false, groups: [] };
  const [frozen] = planCompetitorSets(input([inactive], [setOf(inactive.asin, inactive.skus, [entry("B0CAR00001", "BrandA Baby Push and Go Car Toys")])], {}));
  assert.deepEqual(frozen!.next?.auto.map((item) => item.asin), ["B0CAR00001"], "不知标题不判相似，按原防抖累计");
  assert.equal(frozen!.next?.auto[0]?.misses, 1);
});

test("排除名单可按商品：<SKU或自有ASIN>:<竞品ASIN> 只从该商品移除，同一竞品在别的商品下保留；纯 ASIN 仍是全店排除；关键词配置可覆盖核心词", async () => {
  const config = (values: Record<string, string>, mappings: AsinMapping[] = []): AppConfig => ({
    get: (key: string) => values[key] ?? "", optional: (key: string, fallback = "") => values[key] ?? fallback, bool: (_key: string, fallback = false) => fallback,
    json: () => { throw new Error("unused"); }, asins: () => mappings, version: "test",
  });
  const settings = competitorSettings(config({ COMPETITOR_EXCLUDE_ASINS: "B0GLOBAL01, SKU-SPINNER:B0SHARED01，B0OWNLADYB：b0other001", COMPETITOR_KEYWORDS_JSON: '{"SKU-PULL": ["pull string", "hedgehog"]}' }))!;
  assert.deepEqual([...settings.excluded], ["B0GLOBAL01"]);
  assert.deepEqual([...settings.excludedFor.get("sku-spinner")!], ["B0SHARED01"]);
  assert.deepEqual([...settings.excludedFor.get("b0ownladyb")!], ["B0OTHER001"]);
  assert.deepEqual(settings.keywords.get("sku-pull"), [["pull", "string"], ["hedgehog"]]);
  assert.throws(() => competitorSettings(config({ COMPETITOR_KEYWORDS_JSON: "[1]" })), /JSON 对象/);

  const spinner: ProductObservation = { asin: "B0OWNSPIN0", skus: ["SKU-SPINNER"], active: true, similar: ["B0SHARED01"], groups: ["toy"], title: OWN.ladybug, brand: "Acme" };
  const ladybug: ProductObservation = { asin: "B0OWNLADYB", skus: ["SKU-LADYBUG"], active: true, similar: ["B0SHARED01"], groups: ["toy"], title: OWN.ladybug, brand: "Acme" };
  const shared = entry("B0SHARED01", "BrandF Musical Ladybug Rolling");
  const plans = planCompetitorSets(input([spinner, ladybug], [setOf(spinner.asin, spinner.skus, [shared]), setOf(ladybug.asin, ladybug.skus, [shared])], { B0SHARED01: fact("BrandF Baby Toys, Musical Ladybug Rolling Infant Toys") }, { excludedFor: settings.excludedFor }));
  assert.deepEqual(plans[0]!.removed, [{ asin: "B0SHARED01", brand: "Other", reason: "已加入排除名单" }], "只从陀螺的清单移除");
  assert.deepEqual(plans[1]!.next?.auto.map((item) => item.asin), ["B0SHARED01"], "瓢虫照常跟踪");

  const pull: ProductObservation = { asin: "B0OWNPULL0", skus: ["SKU-PULL"], active: true, similar: ["B0HEDGE001"], groups: ["toy"], title: OWN.pullString, brand: "Acme" };
  const hedgehog = { B0HEDGE001: fact("BrandM Baby Hedgehog Push Toy, Stack and Roll Set") };
  assert.deepEqual(planCompetitorSets(input([pull], [], hedgehog))[0]!.added, [], "按核心词 pull string 不算相似");
  assert.deepEqual(planCompetitorSets(input([pull], [], hedgehog, { keywords: settings.keywords }))[0]!.added.map((item) => item.asin), ["B0HEDGE001"], "配置关键词 hedgehog 后算相似");

  const state = new MemoryState([setOf(spinner.asin, spinner.skus, [shared, entry("B0SPINONLY", "Spinner")]), setOf(ladybug.asin, ladybug.skus, [shared])] as unknown as Record<string, unknown>[]);
  const tracked = await trackedCompetitors(config({}, [{ sku: "SKU-SPINNER", asin: "B0OWNSPIN0", competitors: [], adMarker: "" }]), state.asStore(), settings);
  const byAsin = new Map(tracked.map((item) => [item.asin, item.skus]));
  assert.deepEqual(byAsin.get("B0SHARED01"), ["SKU-LADYBUG"], "比价读取时也只对陀螺排除，瓢虫仍比价");
  assert.deepEqual(byAsin.get("B0SPINONLY"), ["SKU-SPINNER"]);
});
