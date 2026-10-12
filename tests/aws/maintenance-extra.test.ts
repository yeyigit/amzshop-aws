import assert from "node:assert/strict";
import test from "node:test";
import { HEALTH_RULES, runMaintenance } from "../../src/business/maintenance.js";
import { sha256 } from "../../src/util.js";
import type { AppConfig, JobEvent } from "../../src/types.js";
import type { AmazonClient } from "../../src/clients/amazon.js";
import type { FeishuClient } from "../../src/clients/feishu.js";
import { MemoryState } from "./memory-state.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-30T10:05:00.000Z");
const EVENT: JobEvent = { taskType: "maintenance", scheduledAt: new Date(NOW).toISOString() };
const configOf = (values: Record<string, string>): AppConfig => ({ get: (key: string) => values[key] ?? key, optional: (key: string, fallback = "") => values[key] ?? fallback, bool: () => false, asins: () => [] }) as unknown as AppConfig;

function harness(state: MemoryState, values: Record<string, string>) {
  const emails: string[] = [];
  const run = (now: number, override?: Record<string, string>) => runMaintenance(EVENT, configOf(override ?? values), state.asStore(), {} as AmazonClient, {} as FeishuClient, {
    now: () => now, schedule: async () => "s", publish: async (_topic, _subject, message) => { emails.push(message); }, topicArn: "arn:aws:sns:us-east-1:000000000000:t",
  });
  return { emails, run };
}

// 所有日常任务都有近期成功记录，邮件里只剩被测问题。
const healthy = (now: number) => Object.keys(HEALTH_RULES).map((sk) => ({ pk: "HEALTH", sk, lastStatus: "done", lastSuccessAt: new Date(now - HOUR).toISOString() }));

test("A3 配置 ADS_REFRESH_TOKEN_ISSUED_AT 时第 335–365 天把 Ads 授权到期提醒纳入汇总邮件，12 小时内不重复", async () => {
  const issued = "2025-10-20";
  const values = { ADS_REFRESH_TOKEN_ISSUED_AT: issued, ADS_REFRESH_TOKEN: "Atzr|secret-refresh-token" };
  const early = new MemoryState(healthy(NOW));
  const h1 = harness(early, values);
  await h1.run(Date.parse(`${issued}T00:00:00Z`) + 300 * DAY);
  assert.equal(h1.emails.some((message) => /Ads 授权/.test(message)), false, "第 300 天不提醒");
  const due = Date.parse(`${issued}T00:00:00Z`) + 340 * DAY;
  const state = new MemoryState(healthy(due));
  const h = harness(state, values);
  await h.run(due);
  assert.equal(h.emails.length, 1);
  assert.match(h.emails[0]!, /Ads 授权将于 2026-10-20 过期，请重新授权/);
  await h.run(due + HOUR);
  assert.equal(h.emails.length, 1, "12 小时内不重复");
  assert.equal(JSON.stringify([...state.items.values()]).includes("secret-refresh-token"), false, "状态表不得保存令牌");
});

test("A3 未配置授权日：首次见到的令牌指纹记为旧令牌（不适用 365 天新规）永不提醒；重新授权换指纹后以首次见到时间为授权日", async () => {
  const state = new MemoryState(healthy(NOW));
  const h = harness(state, { ADS_REFRESH_TOKEN: "Atzr|legacy-token" });
  await h.run(NOW);
  const record = state.item("ADS_TOKEN", "current")!;
  assert.equal(record.fingerprint, sha256("Atzr|legacy-token").slice(0, 12));
  assert.equal(record.legacy, true);
  assert.equal(JSON.stringify(record).includes("legacy-token\""), false);
  for (const item of healthy(NOW + 400 * DAY)) await state.put(item);
  await h.run(NOW + 400 * DAY);
  assert.equal(h.emails.some((message) => /Ads 授权/.test(message)), false, "旧令牌不提醒");
  const renewedAt = NOW + 401 * DAY;
  await h.run(renewedAt, { ADS_REFRESH_TOKEN: "Atzr|renewed-token" });
  const renewed = state.item("ADS_TOKEN", "current")!;
  assert.equal(renewed.fingerprint, sha256("Atzr|renewed-token").slice(0, 12));
  assert.equal(renewed.legacy, false);
  assert.equal(renewed.firstSeenAt, new Date(renewedAt).toISOString());
  const warnAt = renewedAt + 336 * DAY;
  for (const item of healthy(warnAt)) await state.put(item);
  await h.run(warnAt, { ADS_REFRESH_TOKEN: "Atzr|renewed-token" });
  const expiry = new Date(renewedAt + 365 * DAY).toISOString().slice(0, 10);
  assert.match(h.emails.at(-1)!, new RegExp(`Ads 授权将于 ${expiry} 过期，请重新授权`));
});

test("新接入的健康规则以规则首次被评估时间为基线：上线当轮不误报“从未成功运行”，超过阈值才报", async () => {
  const baseline = NOW - 40 * HOUR;
  const records = healthy(NOW).filter((item) => !["payouts", "traffic-alert", "buybox-watch"].includes(item.sk));
  const state = new MemoryState([{ pk: "MAINTENANCE", sk: "state", baselineAt: new Date(baseline).toISOString(), alerts: {} }, ...records]);
  const h = harness(state, {});
  await h.run(NOW);
  assert.equal(h.emails.length, 0, "新规则上线当轮不报");
  await h.run(NOW + 4 * HOUR);
  assert.match(h.emails.at(-1)!, /buybox-watch 自 .* 起从未成功运行（阈值 3\.0 小时）/);
  await h.run(NOW + 27 * HOUR);
  assert.match(h.emails.at(-1)!, /payouts 自 .* 起从未成功运行（阈值 26\.0 小时）/);
  assert.match(h.emails.at(-1)!, /traffic-alert 自 .* 起从未成功运行（阈值 26\.0 小时）/);
});
