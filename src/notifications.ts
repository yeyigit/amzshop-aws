import type { AppConfig, JsonObject } from "./types.js";
import { FeishuClient } from "./clients/feishu.js";
import { StateStore } from "./state.js";
import { log } from "./log.js";
import { errorText, sha256 } from "./util.js";

export const NOTIFICATION_RESEND_AFTER_MS = 10 * 60_000;
export const NOTIFICATION_MAX_AGE_MS = 48 * 3_600_000;
export type NotificationOutcome = "sent" | "done" | "expired" | "stale" | "none";
// post：带标题与链接的富文本消息（店铺报告）；没有时按原样发纯文本。补发时沿用保存的标题与链接。
export interface NotificationPost { title: string; link?: { text: string; url: string } }
export interface PreparedNotification { lines: string[]; recipients: string[]; post?: NotificationPost }
export interface ResendSummary { checked: number; resent: number; young: number; cleaned: number; expired: string[]; failed: string[] }

type Item = Record<string, unknown> | undefined;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
const timeOf = (value: unknown): number => Date.parse(String(value ?? ""));

function recipients(config: AppConfig): string[] {
  return config.optional("FEISHU_NOTIFY_USER_IDS", "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function notificationCreatedAt(item: Item, pointer?: Item): number {
  return [item?.createdAt, pointer?.createdAt, item?.updatedAt].map(timeOf).find(Number.isFinite) ?? Number.NaN;
}

function storedPost(value: unknown): NotificationPost | undefined {
  if (!value || typeof value !== "object") return undefined;
  const post = value as Record<string, unknown>;
  const link = post.link as Record<string, unknown> | undefined;
  if (typeof post.title !== "string" || !post.title) return undefined;
  return { title: post.title, ...(link && typeof link.url === "string" && typeof link.text === "string" ? { link: { text: link.text, url: link.url } } : {}) };
}

async function send(state: StateStore, feishu: FeishuClient, eventKey: string, lines: string[], targets: string[], delivered: Record<string, unknown>, post?: NotificationPost): Promise<void> {
  for (const recipient of targets) {
    if (delivered[recipient]) continue;
    const uuid = sha256(`${eventKey}|${recipient}`).slice(0, 32);
    if (post) await feishu.sendPost(recipient, { title: post.title, lines, ...(post.link ? { link: post.link } : {}) }, uuid);
    else await feishu.sendText(recipient, lines, uuid);
    await state.markRecipient(eventKey, recipient);
  }
  await state.completeNotification(eventKey);
}

// 先持久化通知意图（含待发指针），业务写入完成后再用 flushNotification 发送。recipients 缺省取 FEISHU_NOTIFY_USER_IDS。
export async function prepareNotification(config: AppConfig, state: StateStore, eventKey: string, lines: string[], options: { recipients?: string[]; post?: NotificationPost } = {}): Promise<PreparedNotification | undefined> {
  const target = options.recipients ?? recipients(config);
  if (!target.length) return undefined;
  await state.saveNotification(eventKey, lines, target, options.post as unknown as JsonObject | undefined);
  return { lines, recipients: target, ...(options.post ? { post: options.post } : {}) };
}

// 只发送仍待发且未超过 48 小时的意图；done/expired 与陈旧意图一律不发（陈旧意图由维护任务标记过期）。
export async function flushNotification(state: StateStore, feishu: FeishuClient, eventKey: string, prepared?: PreparedNotification, now = Date.now()): Promise<NotificationOutcome> {
  const stored = await state.notification(eventKey);
  if (stored?.status === "done") return "done";
  if (stored?.status === "expired") return "expired";
  if (!stored && !prepared) return "none";
  const createdAt = notificationCreatedAt(stored);
  if (stored && (Number.isFinite(createdAt) ? now - createdAt > NOTIFICATION_MAX_AGE_MS : !prepared)) {
    log("WARN", "notification_stale_skipped", { eventKey });
    return "stale";
  }
  const lines = stored && Array.isArray(stored.lines) ? strings(stored.lines) : prepared?.lines ?? [];
  const targets = stored && Array.isArray(stored.recipients) ? strings(stored.recipients) : prepared?.recipients ?? [];
  await send(state, feishu, eventKey, lines, targets, (stored?.delivered ?? {}) as Record<string, unknown>, storedPost(stored?.post) ?? prepared?.post);
  return "sent";
}

export async function deliverNotification(config: AppConfig, state: StateStore, feishu: FeishuClient, eventKey: string, lines: string[]): Promise<NotificationOutcome> {
  const prepared = await prepareNotification(config, state, eventKey, lines);
  return prepared ? flushNotification(state, feishu, eventKey, prepared) : "none";
}

// 按 NOTIFICATION_PENDING 指针补发：创建满 10 分钟且不超过 48 小时逐接收人补发；超过 48 小时标记过期不再打扰。
export async function resendPendingNotifications(state: StateStore, feishu: FeishuClient, options: { now?: number; limit?: number; deadline?: number } = {}): Promise<ResendSummary> {
  const now = options.now ?? Date.now();
  const summary: ResendSummary = { checked: 0, resent: 0, young: 0, cleaned: 0, expired: [], failed: [] };
  for (const pointer of await state.pendingNotifications(options.limit ?? 500)) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) break;
    const eventKey = String(pointer.sk ?? "");
    if (!eventKey) continue;
    summary.checked += 1;
    const pointerAt = timeOf(pointer.createdAt);
    if (Number.isFinite(pointerAt) && now - pointerAt < NOTIFICATION_RESEND_AFTER_MS) { summary.young += 1; continue; }
    try {
      const stored = await state.notification(eventKey);
      if (!stored || stored.status === "done" || stored.status === "expired") {
        await state.delete("NOTIFICATION_PENDING", eventKey);
        summary.cleaned += 1;
        continue;
      }
      const createdAt = notificationCreatedAt(stored, pointer);
      const lines = strings(stored.lines);
      if (!Number.isFinite(createdAt) || now - createdAt > NOTIFICATION_MAX_AGE_MS || !lines.length) {
        await state.expireNotification(eventKey, lines.length ? "超过 48 小时未送达，已停止补发" : "通知内容缺失，无法补发");
        summary.expired.push(eventKey);
        continue;
      }
      if (now - createdAt < NOTIFICATION_RESEND_AFTER_MS) { summary.young += 1; continue; }
      await send(state, feishu, eventKey, lines, strings(stored.recipients), (stored.delivered ?? {}) as Record<string, unknown>, storedPost(stored.post));
      summary.resent += 1;
    } catch (error) {
      summary.failed.push(eventKey);
      log("WARN", "notification_resend_failed", { eventKey, error: errorText(error).slice(0, 200) });
    }
  }
  return summary;
}

// 指针上线前遗留的待发通知（没有指针）：超过 48 小时或时间未知一律过期；未满 48 小时补建指针交给常规补发。
export async function sweepLegacyNotifications(state: StateStore, now = Date.now()): Promise<{ checked: number; expired: string[]; repointed: number }> {
  const [items, pointers] = await Promise.all([state.list("NOTIFICATION"), state.list("NOTIFICATION_PENDING")]);
  const pointed = new Set(pointers.map((item) => String(item.sk ?? "")));
  const result = { checked: 0, expired: [] as string[], repointed: 0 };
  for (const item of items) {
    const eventKey = String(item.sk ?? "");
    if (!eventKey || pointed.has(eventKey) || item.status === "done" || item.status === "expired") continue;
    result.checked += 1;
    const createdAt = notificationCreatedAt(item);
    const lines = strings(item.lines);
    if (!Number.isFinite(createdAt) || now - createdAt > NOTIFICATION_MAX_AGE_MS || !lines.length) {
      await state.expireNotification(eventKey, "指针上线前遗留的待发通知超过 48 小时，已停止补发");
      result.expired.push(eventKey);
    } else {
      await state.saveNotification(eventKey, lines, strings(item.recipients));
      result.repointed += 1;
    }
  }
  return result;
}

// notification-resume 手动入口：按同一规则补发指针项并清理遗留项，返回本次补发数。
export async function resumePendingNotifications(state: StateStore, feishu: FeishuClient): Promise<number> {
  const summary = await resendPendingNotifications(state, feishu);
  await sweepLegacyNotifications(state);
  return summary.resent;
}
