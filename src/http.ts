import type { RetryOptions } from "./types.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const delay = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("请求已取消。"));
  }, { once: true });
});

function retryDelay(response: Response, attempt: number, base: number): number {
  const value = response.headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  }
  return Math.min(8_000, base * (2 ** attempt) + Math.floor(Math.random() * 200));
}

function bodyCode(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  const first = Array.isArray(object.errors) && object.errors[0] && typeof object.errors[0] === "object" ? object.errors[0] as Record<string, unknown> : {};
  return String(object.code ?? object.error ?? object.errorCode ?? first.code ?? "").slice(0, 80);
}

export function httpError(response: Response, body: unknown, message?: string): HttpError {
  const code = bodyCode(body);
  const requestId = response.headers.get("x-amzn-requestid") ?? response.headers.get("x-request-id") ?? "";
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return new HttpError(response.status, code, requestId, message ?? `HTTP ${response.status} ${code}`.trim(), retryable);
}

export async function fetchJson<T>(url: string | URL, init: RequestInit = {}, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const wait = (milliseconds: number): Promise<void> => options.sleep ? options.sleep(milliseconds) : delay(milliseconds, options.signal);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("HTTP 请求超时。")), timeoutMs);
    const abort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = null; }
      }
      if (response.ok && body !== null) return body as T;
      const error = httpError(response, body);
      if (!error.retryable || attempt + 1 >= attempts) throw error;
      lastError = error;
      await wait(retryDelay(response, attempt, baseDelayMs));
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError && !error.retryable) throw error;
      if (attempt + 1 >= attempts) throw error;
      await wait(Math.min(8_000, baseDelayMs * (2 ** attempt)));
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  throw lastError ?? new Error("HTTP 请求失败。");
}
