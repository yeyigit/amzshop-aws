import { GetParametersByPathCommand, SSMClient, type Parameter } from "@aws-sdk/client-ssm";
import type { AppConfig, AsinMapping } from "./types.js";
import { parseJson, sha256 } from "./util.js";

export const CONFIG_CACHE_TTL_MS = 600_000;
export const SECRET_CACHE_TTL_MS = 6 * 3_600_000;
export const SECRET_REFRESH_MIN_INTERVAL_MS = 60_000;
// 密钥包：secrets/bundle/ 下唯一一个 SecureString，内容为 {原参数名: 值}。每次冷启动只解密一次（逐个参数读取时每个各解密一次）；
// 密钥包不存在时回退逐个读取 secrets/（旧的逐个参数已于 2026-10-05 删除，回退只作重建密钥包前的应急）。
export const SECRET_BUNDLE_DIR = "secrets/bundle/";

export type ParameterReader = (path: string, decrypt: boolean) => Promise<Parameter[]>;
interface SecretValues { values: Map<string, string>; versions: string[] }
interface PlainValues { values: Map<string, string>; asins: AsinMapping[]; versions: string[] }
interface Slot<T> { value: T | undefined; loadedAt: number; loading: Promise<T> | undefined }

let ssm: SSMClient | undefined;
const ssmReader: ParameterReader = (path, decrypt) => readPath(ssm ??= new SSMClient(process.env.CONTROL_REGION ? { region: process.env.CONTROL_REGION } : {}), path, decrypt);
let reader: ParameterReader = ssmReader;
let clock = (): number => Date.now();
let plainSlot: Slot<PlainValues> = { value: undefined, loadedAt: 0, loading: undefined };
let secretSlot: Slot<SecretValues> = { value: undefined, loadedAt: 0, loading: undefined };
const liveSecrets: SecretValues = { values: new Map(), versions: [] };
let current: { plain: PlainValues; config: ParameterConfig } | undefined;

export class ParameterConfig implements AppConfig {
  constructor(
    private readonly configValues: Map<string, string>,
    private readonly secrets: SecretValues,
    private readonly asinValues: AsinMapping[],
    private readonly versions: string[],
  ) {}

  get version(): string {
    return sha256([...this.versions, ...this.secrets.versions].sort().join("\n")).slice(0, 16);
  }

  get(key: string): string {
    const value = this.secrets.values.get(key) ?? this.configValues.get(key);
    if (value === undefined || value === "") throw new Error(`缺少 Parameter Store 配置 ${key}。`);
    return value;
  }

  optional(key: string, fallback = ""): string {
    return this.secrets.values.get(key) ?? this.configValues.get(key) ?? fallback;
  }

  bool(key: string, fallback = false): boolean {
    const raw = this.optional(key, String(fallback)).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    throw new Error(`${key} 必须是布尔值。`);
  }

  json<T>(key: string): T {
    return parseJson<T>(this.get(key), key);
  }

  asins(): AsinMapping[] {
    return this.asinValues.map((item) => ({ ...item, competitors: [...item.competitors] }));
  }
}

function parameterMap(parameters: Parameter[], prefix: string): Map<string, string> {
  const output = new Map<string, string>();
  for (const parameter of parameters) {
    if (!parameter.Name?.startsWith(prefix) || parameter.Value === undefined) continue;
    const key = parameter.Name.slice(prefix.length);
    if (!key || output.has(key)) throw new Error(`Parameter Store 参数名冲突: ${parameter.Name}`);
    output.set(key, parameter.Value);
  }
  return output;
}

function bundleMap(parameters: Parameter[], path: string): Map<string, string> {
  if (parameters.length !== 1) throw new Error(`${path} 下应只有一个密钥包参数，实际 ${parameters.length} 个。`);
  const bundle = parameters[0]!;
  const parsed = parseJson<unknown>(bundle.Value ?? "", bundle.Name ?? path);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${bundle.Name} 必须是 JSON 对象。`);
  const output = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key) || typeof value !== "string" || !value) throw new Error(`${bundle.Name} 的键 ${key.slice(0, 64)} 无效或值为空。`);
    output.set(key, value);
  }
  if (!output.size) throw new Error(`${bundle.Name} 为空。`);
  return output;
}

async function readPath(client: SSMClient, path: string, decrypt: boolean): Promise<Parameter[]> {
  const output: Parameter[] = [];
  let nextToken: string | undefined;
  const seen = new Set<string>();
  do {
    const response = await client.send(new GetParametersByPathCommand({
      Path: path,
      Recursive: true,
      WithDecryption: decrypt,
      MaxResults: 10,
      ...(nextToken ? { NextToken: nextToken } : {}),
    }));
    output.push(...(response.Parameters ?? []));
    nextToken = response.NextToken;
    if (nextToken && seen.has(nextToken)) throw new Error(`Parameter Store ${path} 返回重复 NextToken。`);
    if (nextToken) seen.add(nextToken);
  } while (nextToken);
  return output;
}

function parseAsins(parameters: Parameter[], prefix: string): AsinMapping[] {
  const rows: AsinMapping[] = [];
  const seenSku = new Set<string>();
  for (const parameter of parameters) {
    if (!parameter.Name?.startsWith(prefix) || parameter.Value === undefined) continue;
    if (Buffer.byteLength(parameter.Value, "utf8") > 4096) throw new Error(`${parameter.Name} 超过 Standard 参数 4 KB 上限。`);
    const value = parseJson<Partial<AsinMapping>>(parameter.Value, parameter.Name);
    const sku = String(value.sku ?? "").trim();
    const asin = String(value.asin ?? "").trim();
    if (!sku) throw new Error(`${parameter.Name} 缺少 sku。`);
    if (seenSku.has(sku)) throw new Error(`asin 映射存在重复 SKU: ${sku}`);
    seenSku.add(sku);
    rows.push({
      sku,
      asin,
      competitors: Array.isArray(value.competitors) ? value.competitors.map(String).map((item) => item.trim()).filter(Boolean) : [],
      adMarker: String(value.adMarker ?? "").trim(),
    });
  }
  return rows.sort((a, b) => a.sku.localeCompare(b.sku));
}

const root = (): string => (process.env.PARAMETER_PREFIX ?? "/amzshop/prod/").replace(/\/*$/, "/");
const versionsOf = (parameters: Parameter[]): string[] => parameters.map((item) => `${item.Name}:${item.Version ?? 0}`);

async function loadPlain(): Promise<PlainValues> {
  const prefix = root();
  const [plain, asins] = await Promise.all([reader(`${prefix}config/`, false), reader(`${prefix}asin/`, false)]);
  return { values: parameterMap(plain, `${prefix}config/`), asins: parseAsins(asins, `${prefix}asin/`), versions: versionsOf([...plain, ...asins]) };
}

async function loadSecrets(): Promise<SecretValues> {
  const prefix = root();
  const bundle = await reader(`${prefix}${SECRET_BUNDLE_DIR}`, true);
  const secrets = bundle.length ? bundle : await reader(`${prefix}secrets/`, true);
  const loaded = { values: bundle.length ? bundleMap(bundle, `${prefix}${SECRET_BUNDLE_DIR}`) : parameterMap(secrets, `${prefix}secrets/`), versions: versionsOf(secrets) };
  liveSecrets.values = loaded.values;
  liveSecrets.versions = loaded.versions;
  return loaded;
}

async function fill<T>(slot: Slot<T>, load: () => Promise<T>): Promise<T> {
  const loading = load();
  slot.loading = loading;
  try {
    const value = await loading;
    slot.value = value;
    slot.loadedAt = clock();
    return value;
  } finally {
    if (slot.loading === loading) slot.loading = undefined;
  }
}

function cached<T>(slot: Slot<T>, ttlMs: number, force: boolean, load: () => Promise<T>): Promise<T> {
  if (!force && slot.value !== undefined && clock() - slot.loadedAt < ttlMs) return Promise.resolve(slot.value);
  if (!force && slot.loading) return slot.loading;
  return fill(slot, load);
}

export async function getConfig(options: { force?: boolean } = {}): Promise<ParameterConfig> {
  const force = options.force === true;
  const [plain] = await Promise.all([
    cached(plainSlot, CONFIG_CACHE_TTL_MS, force, loadPlain),
    cached(secretSlot, SECRET_CACHE_TTL_MS, force, loadSecrets),
  ]);
  if (current?.plain !== plain) current = { plain, config: new ParameterConfig(plain.values, liveSecrets, plain.asins, plain.versions) };
  return current.config;
}

export async function refreshSecrets(): Promise<void> {
  if (secretSlot.loading) {
    await secretSlot.loading;
    return;
  }
  if (secretSlot.value !== undefined && clock() - secretSlot.loadedAt < SECRET_REFRESH_MIN_INTERVAL_MS) return;
  await fill(secretSlot, loadSecrets);
}

export function clearConfigCache(): void {
  plainSlot = { value: undefined, loadedAt: 0, loading: undefined };
  secretSlot = { value: undefined, loadedAt: 0, loading: undefined };
  current = undefined;
}

export function setParameterReader(next?: ParameterReader, now?: () => number): void {
  reader = next ?? ssmReader;
  clock = now ?? ((): number => Date.now());
  clearConfigCache();
}
