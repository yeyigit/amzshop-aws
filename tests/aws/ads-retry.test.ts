import assert from "node:assert/strict";
import test from "node:test";
import { shouldRetryAdsTransientError } from "../../src/handlers/jobs.js";
import { HttpError } from "../../src/http.js";

// 逐 SKU 客单价（写投放词监控）的两条用例随 2026-10-09 投放词监控停写删除；逐 SKU 每日销售快照见 ads-workflow.test.ts。

test("Ads 暂态 HTTP 与超时进入续跑，其它任务和永久错误不静音，连续 24 次后按普通失败处理", () => {
  const ads = { taskType: "ads-continue" };
  const rateLimited = new HttpError(429, "rate_limit", "", "rate limited", true);
  const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });
  assert.equal(shouldRetryAdsTransientError(ads, rateLimited), true);
  assert.equal(shouldRetryAdsTransientError(ads, timeout), true);
  assert.equal(shouldRetryAdsTransientError(ads, new HttpError(400, "invalid", "", "invalid", false)), false);
  assert.equal(shouldRetryAdsTransientError({ taskType: "finance" }, rateLimited), false);
  assert.equal(shouldRetryAdsTransientError({ taskType: "ads-daily", cursor: { dataNotReadyRetries: 23 } }, rateLimited), true);
  assert.equal(shouldRetryAdsTransientError({ taskType: "ads-daily", cursor: { dataNotReadyRetries: 24 } }, rateLimited), false);
  assert.equal(shouldRetryAdsTransientError({ taskType: "ads-continue", cursor: { mode: "DAILY", dataNotReadyRetries: 30 } }, timeout), false);
});
