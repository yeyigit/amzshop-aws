import type { StateStore } from "../../src/state.js";
import type { JsonObject } from "../../src/types.js";

type Item = Record<string, unknown>;
const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);
const conditional = (): Error => Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });

// 内存版 StateStore：按 WP1 契约模拟任务 TTL、通知待发指针、事件认领与租约，供业务测试使用。
export class MemoryState {
  readonly items = new Map<string, Item>();
  readonly writes: Array<{ op: string; pk: string; sk: string }> = [];
  constructor(initial: Item[] = []) { for (const item of initial) this.items.set(this.key(String(item.pk), String(item.sk)), clone(item)); }
  private key(pk: string, sk: string): string { return `${pk}\u0000${sk}`; }
  item(pk: string, sk: string): Item | undefined { return this.items.get(this.key(pk, sk)); }
  partition(pk: string): Item[] { return [...this.items.values()].filter((item) => item.pk === pk).sort((a, b) => String(a.sk).localeCompare(String(b.sk))); }
  asStore(): StateStore { return this as unknown as StateStore; }

  async get(pk: string, sk: string): Promise<Item | undefined> { return clone(this.item(pk, sk)); }
  async put(item: Item, condition?: string): Promise<void> {
    if (condition && /attribute_not_exists\(pk\)/.test(condition) && this.item(String(item.pk), String(item.sk))) throw conditional();
    this.items.set(this.key(String(item.pk), String(item.sk)), clone(item));
    this.writes.push({ op: "put", pk: String(item.pk), sk: String(item.sk) });
  }
  async putVersioned(item: Item, expectedRev: number | undefined): Promise<boolean> {
    const current = this.item(String(item.pk), String(item.sk));
    if (expectedRev === undefined ? current !== undefined : !current || Number(current.rev ?? 0) !== expectedRev) return false;
    this.items.set(this.key(String(item.pk), String(item.sk)), clone({ ...item, rev: (expectedRev ?? 0) + 1 }));
    this.writes.push({ op: "put", pk: String(item.pk), sk: String(item.sk) });
    return true;
  }
  async delete(pk: string, sk: string): Promise<void> { this.items.delete(this.key(pk, sk)); this.writes.push({ op: "delete", pk, sk }); }
  async list(pk: string): Promise<Item[]> { return clone(this.partition(pk)); }
  async queryPartition(pk: string, options: { beginsWith?: string; limit?: number; newestFirst?: boolean } = {}): Promise<Item[]> {
    const items = this.partition(pk).filter((item) => !options.beginsWith || String(item.sk).startsWith(options.beginsWith));
    if (options.newestFirst) items.reverse();
    return clone(items.slice(0, options.limit ?? 100));
  }
  async saveTask(taskType: string, taskId: string, state: JsonObject, status: string, nextAt?: string): Promise<void> {
    await this.put({ pk: `TASK#${taskType}`, sk: taskId, module: taskType, status, state, updatedAt: new Date().toISOString(), ...(nextAt ? { nextAt } : {}), ...(status === "done" || status === "superseded" ? { expiresAt: Math.floor(Date.now() / 1000) + 30 * 86_400 } : {}) });
  }
  async task(taskType: string, taskId: string): Promise<Item | undefined> {
    const item = this.item(`TASK#${taskType}`, taskId);
    return item?.expiresAt !== undefined && Number(item.expiresAt) <= Math.floor(Date.now() / 1000) ? undefined : clone(item);
  }
  async saveNotification(eventKey: string, lines: string[], recipients: string[], post?: JsonObject): Promise<void> {
    const existing = this.item("NOTIFICATION", eventKey);
    if (existing?.status === "done" || existing?.status === "expired") return;
    const createdAt = String(existing?.createdAt ?? existing?.updatedAt ?? new Date().toISOString());
    const keptPost = existing ? existing.post : post;
    await this.put({ pk: "NOTIFICATION_PENDING", sk: eventKey, createdAt });
    await this.put({ pk: "NOTIFICATION", sk: eventKey, status: "pending", lines: existing?.lines ?? lines, recipients: existing?.recipients ?? recipients, delivered: existing?.delivered ?? {}, ...(keptPost ? { post: keptPost } : {}), createdAt, updatedAt: new Date().toISOString() });
  }
  async queryRange(pk: string, from: string, to: string, limit = 1000): Promise<Item[]> {
    return clone(this.partition(pk).filter((item) => String(item.sk) >= from && String(item.sk) <= to).slice(0, limit));
  }
  async markRecipient(eventKey: string, recipient: string): Promise<void> {
    const item = this.item("NOTIFICATION", eventKey) ?? { pk: "NOTIFICATION", sk: eventKey };
    item.delivered = { ...(item.delivered as Item | undefined), [recipient]: new Date().toISOString() };
    this.items.set(this.key("NOTIFICATION", eventKey), item);
  }
  async notification(eventKey: string): Promise<Item | undefined> { return this.get("NOTIFICATION", eventKey); }
  async completeNotification(eventKey: string): Promise<void> {
    const item = this.item("NOTIFICATION", eventKey) ?? { pk: "NOTIFICATION", sk: eventKey };
    this.items.set(this.key("NOTIFICATION", eventKey), { ...item, status: "done" });
    await this.delete("NOTIFICATION_PENDING", eventKey);
  }
  async pendingNotifications(limit = 100): Promise<Item[]> { return this.queryPartition("NOTIFICATION_PENDING", { limit }); }
  async expireNotification(eventKey: string, reason: string): Promise<void> {
    const item = this.item("NOTIFICATION", eventKey);
    if (item && item.status !== "done") this.items.set(this.key("NOTIFICATION", eventKey), { ...item, status: "expired", expiredReason: reason });
    await this.delete("NOTIFICATION_PENDING", eventKey);
  }
  async recordHealth(taskType: string, status: string, summary: JsonObject): Promise<void> {
    const now = new Date().toISOString();
    const item = this.item("HEALTH", taskType) ?? { pk: "HEALTH", sk: taskType };
    this.items.set(this.key("HEALTH", taskType), { ...item, lastStatus: status, updatedAt: now, summary, ...(status === "done" ? { lastSuccessAt: now } : {}) });
  }
  async listHealth(): Promise<Item[]> { return this.list("HEALTH"); }
  async addFeishuUsage(day: string, module: string, calls: number, rejected: number, rejectedAt?: string): Promise<void> {
    const item = this.item("FEISHU_USAGE", day) ?? { pk: "FEISHU_USAGE", sk: day };
    item.total = Number(item.total ?? 0) + calls;
    if (calls > 0) item[`m_${module}`] = Number(item[`m_${module}`] ?? 0) + calls;
    if (rejected > 0) { item.rejected = Number(item.rejected ?? 0) + rejected; item.lastRejectedAt = rejectedAt ?? new Date().toISOString(); }
    item.updatedAt = new Date().toISOString();
    this.items.set(this.key("FEISHU_USAGE", day), item);
    this.writes.push({ op: "update", pk: "FEISHU_USAGE", sk: day });
  }
  async claimAlert(key: string, nowMs: number, repeatMs: number, details: JsonObject = {}): Promise<boolean> {
    const item = this.item("ALERT", key);
    if (item && Date.parse(String(item.emailedAt)) >= nowMs - repeatMs) return false;
    this.items.set(this.key("ALERT", key), { pk: "ALERT", sk: key, emailedAt: new Date(nowMs).toISOString(), details });
    return true;
  }
  async claimEvent(entityKey: string, eventKey: string, version: number, owner: string, leaseMs: number): Promise<{ status: "claimed" | "duplicate" | "busy"; owner?: string; item?: Item }> {
    const pk = `EVENT#${entityKey}`;
    const item = this.item(pk, eventKey);
    if (item?.stage === "done" && Number(item.version ?? 0) >= version) return { status: "duplicate", item: clone(item) };
    if (item && Number(item.leaseExpiresAt ?? 0) > Date.now() && item.leaseOwner !== owner) return { status: "busy", item: clone(item) };
    if (item && Number(item.version ?? 0) > version) return { status: "busy", item: clone(item) };
    const next = { ...(item ?? { pk, sk: eventKey }), stage: "processing", leaseOwner: owner, leaseExpiresAt: Date.now() + leaseMs, version, updatedAt: new Date().toISOString() };
    this.items.set(this.key(pk, eventKey), next);
    return { status: "claimed", owner, item: clone(next) };
  }
  async completeEvent(entityKey: string, eventKey: string, _owner: string, result: JsonObject): Promise<void> { this.finish(entityKey, eventKey, { stage: "done", result }); }
  async continueEvent(entityKey: string, eventKey: string, _owner: string, result: JsonObject): Promise<void> { this.finish(entityKey, eventKey, { stage: "waiting", result }); }
  async failEvent(entityKey: string, eventKey: string, _owner: string, error: unknown): Promise<void> { this.finish(entityKey, eventKey, { stage: "failed", lastError: String(error) }); }
  private finish(entityKey: string, eventKey: string, fields: Item): void {
    const pk = `EVENT#${entityKey}`;
    const { leaseOwner: _owner, leaseExpiresAt: _lease, ...rest } = this.item(pk, eventKey) ?? { pk, sk: eventKey };
    this.items.set(this.key(pk, eventKey), { ...rest, ...fields, updatedAt: new Date().toISOString() });
  }
  async acquireLease(): Promise<boolean> { return true; }
  async releaseLease(): Promise<void> {}
}
