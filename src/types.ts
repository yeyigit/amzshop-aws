export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface AsinMapping {
  sku: string;
  asin: string;
  competitors: string[];
  adMarker: string;
}

export interface AppConfig {
  get(key: string): string;
  optional(key: string, fallback?: string): string;
  bool(key: string, fallback?: boolean): boolean;
  json<T>(key: string): T;
  asins(): AsinMapping[];
  version: string;
}

export interface BusinessEvent {
  module: string;
  eventKey: string;
  entityKey: string;
  version: number;
  occurredAt: string;
  payload: JsonObject;
}

export interface JobEvent {
  taskType: string;
  taskId?: string;
  scheduledAt?: string;
  cursor?: JsonObject;
  dryRun?: boolean;
}

export interface FeishuRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

export interface RetryOptions {
  attempts?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface BatchFailureResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}
