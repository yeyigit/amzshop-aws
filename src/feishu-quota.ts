import { restoreFeishuUsage, takeFeishuUsage, type FeishuUsage } from "./clients/feishu.js";
import type { StateStore } from "./state.js";
import { log } from "./log.js";
import { errorText, ymdInZone } from "./util.js";

// 飞书额度按租户、按自然月计（每月 1 日重置），用量按北京日期落库。
export const beijingDay = (ms: number): string => ymdInZone(new Date(ms), "Asia/Shanghai");
export const FEISHU_QUOTA_ALERT_KEY = "feishu-quota";
export const FEISHU_QUOTA_ALERT_REPEAT_MS = 12 * 3_600_000;
export const FEISHU_QUOTA_SUBJECT = "AMZShop: Feishu API monthly quota exhausted (99991403)";

export type Publish = (topicArn: string, subject: string, message: string) => Promise<void>;

// 把本实例累计的飞书调用次数落到 FEISHU_USAGE/<北京日期>；写入失败时放回计数等下次一并落库，不影响业务结果。返回本次取出的计数。
export async function flushFeishuUsage(state: StateStore, module: string, now = Date.now()): Promise<FeishuUsage> {
  const taken = takeFeishuUsage();
  if (!taken.calls && !taken.rejected) return taken;
  try {
    await state.addFeishuUsage(beijingDay(now), module, taken.calls, taken.rejected, taken.rejectedAt);
  } catch (error) {
    restoreFeishuUsage(taken);
    log("WARN", "feishu_usage_flush_failed", { module, calls: taken.calls, rejected: taken.rejected, error: errorText(error).slice(0, 200) });
  }
  return taken;
}

export async function monthCalls(state: StateStore, month: string): Promise<{ total: number; days: Record<string, unknown>[] }> {
  const days = await state.queryPartition("FEISHU_USAGE", { beginsWith: `${month}-`, limit: 40 });
  return { total: days.reduce((sum, day) => sum + (Number(day.total) || 0), 0), days };
}

export function quotaExhaustedLines(source: string, nowMs: number, monthTotal: number): string[] {
  const at = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(nowMs));
  return [
    `飞书 API 本月调用额度已用尽（错误码 99991403），由 ${source} 于北京时间 ${at} 发现；本月系统已记录成功调用约 ${monthTotal} 次。`,
    "影响：额度恢复前，飞书多维表格读写和飞书消息全部失败。订单、广告预算消息交回队列重试，超过重试次数后进入死信队列（保留 14 天）；定时任务记失败、不再逐次发邮件；已有业务数据不会被写成 0 或清空。",
    "恢复：额度每月 1 日自动重置；要提前恢复，需在飞书管理后台“费用中心”升级或购买额度。恢复后请让 Claude 定向重放死信队列里的消息，并补跑失败的每日任务。",
  ];
}

// 额度用尽立即发一封邮件；与维护任务共用 ALERT/feishu-quota 去重，12 小时内不重复。发送失败时释放占用，下次再发。
export async function alertFeishuQuota(state: StateStore, publish: Publish, topicArn: string, source: string, now = Date.now()): Promise<boolean> {
  if (!topicArn) return false;
  if (!(await state.claimAlert(FEISHU_QUOTA_ALERT_KEY, now, FEISHU_QUOTA_ALERT_REPEAT_MS, { source }))) return false;
  try {
    const { total } = await monthCalls(state, beijingDay(now).slice(0, 7));
    await publish(topicArn, FEISHU_QUOTA_SUBJECT, quotaExhaustedLines(source, now, total).join("\n"));
    return true;
  } catch (error) {
    await state.delete("ALERT", FEISHU_QUOTA_ALERT_KEY).catch(() => undefined);
    throw error;
  }
}
