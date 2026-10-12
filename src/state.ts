import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { JsonObject } from "./types.js";
import { log } from "./log.js";
import { errorText, nowIso } from "./util.js";

export interface ClaimResult { status: "claimed" | "duplicate" | "busy"; owner?: string; item?: Record<string, unknown> }

export interface PartitionQuery { beginsWith?: string; limit?: number; newestFirst?: boolean }

export const COMPLETED_STATE_RETENTION_SECONDS = 400 * 24 * 60 * 60;
export const COMPLETED_TASK_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export function completedStateExpiresAt(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) + COMPLETED_STATE_RETENTION_SECONDS;
}

export function completedTaskExpiresAt(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) + COMPLETED_TASK_RETENTION_SECONDS;
}

export function blocksCompletedReplay(item: Record<string, unknown> | undefined, version: number, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return item?.stage === "done"
    && Number(item.version ?? 0) >= version
    && (item.expiresAt === undefined || Number(item.expiresAt) > nowSeconds);
}

const region = process.env.CONTROL_REGION;
const client = DynamoDBDocumentClient.from(new DynamoDBClient(region ? { region } : {}), { marshallOptions: { removeUndefinedValues: true } });

function conditional(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: string }).name === "ConditionalCheckFailedException";
}

export class StateStore {
  constructor(readonly tableName = process.env.STATE_TABLE_NAME ?? "amzshop-prod-state", private readonly db: DynamoDBDocumentClient = client) {}

  async get(pk: string, sk: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.db.send(new GetCommand({ TableName: this.tableName, Key: { pk, sk }, ConsistentRead: true }));
    return response.Item;
  }

  async put(item: Record<string, unknown>, condition?: string): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(item), "utf8") > 380_000) throw new Error("DynamoDB item 超过 380 KB 安全阈值。 ");
    await this.db.send(new PutCommand({ TableName: this.tableName, Item: item, ...(condition ? { ConditionExpression: condition } : {}) }));
  }

  // 乐观并发写：expectedRev 为 undefined 表示必须新建；否则只有库内 rev 等于 expectedRev（旧项无 rev 视为 0）才写入，写入后 rev+1。冲突返回 false。
  async putVersioned(item: Record<string, unknown>, expectedRev: number | undefined): Promise<boolean> {
    if (Buffer.byteLength(JSON.stringify(item), "utf8") > 380_000) throw new Error("DynamoDB item 超过 380 KB 安全阈值。 ");
    const fresh = expectedRev === undefined;
    try {
      await this.db.send(new PutCommand({
        TableName: this.tableName,
        Item: { ...item, rev: (expectedRev ?? 0) + 1 },
        ConditionExpression: fresh ? "attribute_not_exists(pk)" : expectedRev === 0 ? "attribute_not_exists(#rev) OR #rev = :rev" : "#rev = :rev",
        ...(fresh ? {} : { ExpressionAttributeNames: { "#rev": "rev" }, ExpressionAttributeValues: { ":rev": expectedRev } }),
      }));
      return true;
    } catch (error) {
      if (conditional(error)) return false;
      throw error;
    }
  }

  async list(pk: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const response = await this.db.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      items.push(...(response.Items ?? []));
      cursor = response.LastEvaluatedKey;
    } while (cursor);
    return items;
  }

  async delete(pk: string, sk: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.tableName, Key: { pk, sk } }));
  }

  async acquireLease(scope: string, key: string, owner: string, leaseMs: number): Promise<boolean> {
    const now = Date.now();
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: `LEASE#${scope}`, sk: key },
        UpdateExpression: "SET leaseOwner = :owner, leaseExpiresAt = :expires",
        ConditionExpression: "attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt < :now OR leaseOwner = :owner",
        ExpressionAttributeValues: { ":owner": owner, ":expires": now + leaseMs, ":now": now },
      }));
      return true;
    } catch (error) {
      if (conditional(error)) return false;
      throw error;
    }
  }

  async releaseLease(scope: string, key: string, owner: string): Promise<void> {
    try {
      await this.db.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: `LEASE#${scope}`, sk: key }, ConditionExpression: "leaseOwner = :owner", ExpressionAttributeValues: { ":owner": owner } }));
    } catch (error) {
      if (!conditional(error)) throw error;
    }
  }

  async claimEvent(entityKey: string, eventKey: string, version: number, owner: string, leaseMs: number): Promise<ClaimResult> {
    const pk = `EVENT#${entityKey}`;
    const sk = eventKey;
    const existing = await this.get(pk, sk);
    if (existing && blocksCompletedReplay(existing, version)) return { status: "duplicate", item: existing };
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);
    try {
      const response = await this.db.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        UpdateExpression: "SET #module = if_not_exists(#module, :module), #stage = :processing, #owner = :owner, #lease = :lease, #version = :version, #updated = :updated REMOVE #expires ADD #attempts :one",
        ConditionExpression: "(attribute_not_exists(#lease) OR #lease < :now OR #owner = :owner) AND (attribute_not_exists(#version) OR #version <= :version) AND (attribute_not_exists(#stage) OR #stage <> :done OR #version < :version OR (attribute_exists(#expires) AND #expires <= :nowSeconds))",
        ExpressionAttributeNames: { "#module": "module", "#stage": "stage", "#owner": "leaseOwner", "#lease": "leaseExpiresAt", "#version": "version", "#updated": "updatedAt", "#attempts": "attempts", "#expires": "expiresAt" },
        ExpressionAttributeValues: { ":module": entityKey.split("#", 1)[0], ":processing": "processing", ":owner": owner, ":lease": now + leaseMs, ":now": now, ":nowSeconds": nowSeconds, ":version": version, ":updated": nowIso(), ":one": 1, ":done": "done" },
        ReturnValues: "ALL_NEW",
      }));
      return { status: "claimed", owner, ...(response.Attributes ? { item: response.Attributes } : {}) };
    } catch (error) {
      if (!conditional(error)) throw error;
      const item = await this.get(pk, sk);
      if (item && blocksCompletedReplay(item, version)) return { status: "duplicate", item };
      return { status: "busy", ...(item ? { item } : {}) };
    }
  }

  async completeEvent(entityKey: string, eventKey: string, owner: string, result: JsonObject): Promise<void> {
    await this.db.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { pk: `EVENT#${entityKey}`, sk: eventKey },
      UpdateExpression: "SET #stage = :done, #result = :result, #updated = :updated, #expires = :expires REMOVE #owner, #lease, #error",
      ConditionExpression: "#owner = :owner",
      ExpressionAttributeNames: { "#stage": "stage", "#result": "result", "#updated": "updatedAt", "#owner": "leaseOwner", "#lease": "leaseExpiresAt", "#error": "lastError", "#expires": "expiresAt" },
      ExpressionAttributeValues: { ":done": "done", ":result": result, ":updated": nowIso(), ":owner": owner, ":expires": completedStateExpiresAt() },
    }));
  }

  async continueEvent(entityKey: string, eventKey: string, owner: string, result: JsonObject): Promise<void> {
    await this.db.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { pk: `EVENT#${entityKey}`, sk: eventKey },
      UpdateExpression: "SET #stage = :waiting, #result = :result, #updated = :updated REMOVE #owner, #lease, #error",
      ConditionExpression: "#owner = :owner",
      ExpressionAttributeNames: { "#stage": "stage", "#result": "result", "#updated": "updatedAt", "#owner": "leaseOwner", "#lease": "leaseExpiresAt", "#error": "lastError" },
      ExpressionAttributeValues: { ":waiting": "waiting", ":result": result, ":updated": nowIso(), ":owner": owner },
    }));
  }

  async failEvent(entityKey: string, eventKey: string, owner: string, error: unknown): Promise<void> {
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: `EVENT#${entityKey}`, sk: eventKey },
        UpdateExpression: "SET #stage = :failed, #error = :error, #updated = :updated REMOVE #owner, #lease",
        ConditionExpression: "#owner = :owner",
        ExpressionAttributeNames: { "#stage": "stage", "#error": "lastError", "#updated": "updatedAt", "#owner": "leaseOwner", "#lease": "leaseExpiresAt" },
        ExpressionAttributeValues: { ":failed": "failed", ":error": errorText(error).slice(0, 1000), ":updated": nowIso(), ":owner": owner },
      }));
    } catch (secondary) {
      if (!conditional(secondary)) throw secondary;
    }
  }

  async saveTask(taskType: string, taskId: string, state: JsonObject, status: string, nextAt?: string): Promise<void> {
    await this.put({
      pk: `TASK#${taskType}`,
      sk: taskId,
      module: taskType,
      status,
      state,
      updatedAt: nowIso(),
      ...(nextAt ? { nextAt } : {}),
      ...(status === "done" || status === "superseded" ? { expiresAt: completedTaskExpiresAt() } : {}),
    });
  }

  async task(taskType: string, taskId: string): Promise<Record<string, unknown> | undefined> {
    const item = await this.get(`TASK#${taskType}`, taskId);
    return item?.expiresAt !== undefined && Number(item.expiresAt) <= Math.floor(Date.now() / 1000) ? undefined : item;
  }

  // post：富文本消息的标题与链接（店铺报告）；已有意图时沿用原内容，不改写。
  async saveNotification(eventKey: string, lines: string[], recipients: string[], post?: JsonObject): Promise<void> {
    const existing = await this.get("NOTIFICATION", eventKey);
    const lapsed = existing?.expiresAt !== undefined && Number(existing.expiresAt) <= Math.floor(Date.now() / 1000);
    if ((existing?.status === "done" || existing?.status === "expired") && !lapsed) return;
    const current = lapsed ? undefined : existing;
    const createdAt = String(current?.createdAt ?? current?.updatedAt ?? nowIso());
    const keptPost = current ? current.post : post;
    await this.put({ pk: "NOTIFICATION_PENDING", sk: eventKey, createdAt });
    await this.put({
      pk: "NOTIFICATION",
      sk: eventKey,
      status: "pending",
      lines: current?.lines ?? lines,
      recipients: current?.recipients ?? recipients,
      delivered: current?.delivered ?? {},
      ...(keptPost ? { post: keptPost } : {}),
      createdAt,
      updatedAt: nowIso(),
    });
  }

  async markRecipient(eventKey: string, recipient: string): Promise<void> {
    const name = `#recipient`;
    await this.db.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { pk: "NOTIFICATION", sk: eventKey },
      UpdateExpression: `SET delivered.${name} = :done, updatedAt = :updated`,
      ExpressionAttributeNames: { [name]: recipient },
      ExpressionAttributeValues: { ":done": nowIso(), ":updated": nowIso() },
    }));
  }

  async notification(eventKey: string): Promise<Record<string, unknown> | undefined> {
    return this.get("NOTIFICATION", eventKey);
  }

  async completeNotification(eventKey: string): Promise<void> {
    await this.db.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { pk: "NOTIFICATION", sk: eventKey },
      UpdateExpression: "SET #status = :done, updatedAt = :updated, expiresAt = :expires",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":done": "done", ":updated": nowIso(), ":expires": completedStateExpiresAt() },
    }));
    try {
      await this.delete("NOTIFICATION_PENDING", eventKey);
    } catch (error) {
      log("WARN", "notification_pointer_cleanup_failed", { eventKey, error: errorText(error).slice(0, 200) });
    }
  }

  async pendingNotifications(limit = 100): Promise<Record<string, unknown>[]> {
    return this.queryPartition("NOTIFICATION_PENDING", { limit });
  }

  async expireNotification(eventKey: string, reason: string): Promise<void> {
    const now = nowIso();
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: "NOTIFICATION", sk: eventKey },
        UpdateExpression: "SET #status = :expired, #reason = :reason, #expiredAt = :now, #updated = :now, #expires = :expires",
        ConditionExpression: "attribute_exists(pk) AND #status <> :done",
        ExpressionAttributeNames: { "#status": "status", "#reason": "expiredReason", "#expiredAt": "expiredAt", "#updated": "updatedAt", "#expires": "expiresAt" },
        ExpressionAttributeValues: { ":expired": "expired", ":reason": reason.slice(0, 500), ":now": now, ":expires": completedStateExpiresAt(), ":done": "done" },
      }));
    } catch (error) {
      if (!conditional(error)) throw error;
    }
    await this.delete("NOTIFICATION_PENDING", eventKey);
  }

  async recordHealth(taskType: string, status: string, summary: JsonObject): Promise<void> {
    const success = status === "done";
    await this.db.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { pk: "HEALTH", sk: taskType },
      UpdateExpression: `SET #lastStatus = :status, #updated = :now, #summary = :summary${success ? ", #lastSuccessAt = :now" : ""}`,
      ExpressionAttributeNames: { "#lastStatus": "lastStatus", "#updated": "updatedAt", "#summary": "summary", ...(success ? { "#lastSuccessAt": "lastSuccessAt" } : {}) },
      ExpressionAttributeValues: { ":status": status, ":now": nowIso(), ":summary": summary },
    }));
  }

  async listHealth(): Promise<Record<string, unknown>[]> {
    return this.list("HEALTH");
  }

  // 飞书调用量：每个北京日期一条（sk=YYYY-MM-DD），total 与按模块的 m_<模块> 原子累加；记录额度用尽次数与最近时间；保留 400 天。
  async addFeishuUsage(day: string, module: string, calls: number, rejected: number, rejectedAt?: string): Promise<void> {
    const names: Record<string, string> = { "#total": "total", "#updated": "updatedAt", "#expires": "expiresAt" };
    const values: Record<string, unknown> = { ":calls": calls, ":updated": nowIso(), ":expires": completedStateExpiresAt() };
    const add = ["#total :calls"];
    const set = ["#updated = :updated", "#expires = if_not_exists(#expires, :expires)"];
    if (calls > 0) { names["#module"] = `m_${module}`; add.push("#module :calls"); }
    if (rejected > 0) {
      Object.assign(names, { "#rejected": "rejected", "#rejectedAt": "lastRejectedAt" });
      Object.assign(values, { ":rejected": rejected, ":rejectedAt": rejectedAt ?? nowIso() });
      add.push("#rejected :rejected");
      set.push("#rejectedAt = :rejectedAt");
    }
    await this.db.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { pk: "FEISHU_USAGE", sk: day },
      UpdateExpression: `SET ${set.join(", ")} ADD ${add.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
  }

  // 跨函数的告警去重：距上次发送不足 repeatMs 时返回 false；成功占用后才发送，发送失败须调用方删除该记录以便下次重发。
  async claimAlert(key: string, nowMs: number, repeatMs: number, details: JsonObject = {}): Promise<boolean> {
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: "ALERT", sk: key },
        UpdateExpression: "SET #emailedAt = :now, #details = :details, #expires = :expires",
        ConditionExpression: "attribute_not_exists(#emailedAt) OR #emailedAt < :cutoff",
        ExpressionAttributeNames: { "#emailedAt": "emailedAt", "#details": "details", "#expires": "expiresAt" },
        ExpressionAttributeValues: { ":now": new Date(nowMs).toISOString(), ":cutoff": new Date(nowMs - repeatMs).toISOString(), ":details": details, ":expires": Math.floor(nowMs / 1000) + 30 * 86_400 },
      }));
      return true;
    } catch (error) {
      if (conditional(error)) return false;
      throw error;
    }
  }

  // 排序键在 [from, to] 之间（含两端，按字符串比较），如报告日数据按日期取一段。
  async queryRange(pk: string, from: string, to: string, limit = 1000): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const response = await this.db.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
        ExpressionAttributeValues: { ":pk": pk, ":from": from, ":to": to },
        Limit: limit - items.length,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      items.push(...(response.Items ?? []).slice(0, limit - items.length));
      cursor = response.LastEvaluatedKey;
    } while (cursor && items.length < limit);
    return items;
  }

  async queryPartition(pk: string, options: PartitionQuery = {}): Promise<Record<string, unknown>[]> {
    const limit = Math.max(1, Math.floor(options.limit ?? 100));
    const items: Record<string, unknown>[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const response = await this.db.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: options.beginsWith ? "pk = :pk AND begins_with(sk, :prefix)" : "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk, ...(options.beginsWith ? { ":prefix": options.beginsWith } : {}) },
        ScanIndexForward: !options.newestFirst,
        Limit: limit - items.length,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      items.push(...(response.Items ?? []).slice(0, limit - items.length));
      cursor = response.LastEvaluatedKey;
    } while (cursor && items.length < limit);
    return items;
  }
}
