// 把一个密钥写进密钥包 /amzshop/prod/secrets/bundle/main（整体读-改-写，见 docs/部署说明.md「写入配置与密钥」）。
// 值只从终端隐藏输入读取：不走命令行参数、不打印、不落盘。只输出键名、版本与字节数。
// 用法（在仓库根目录，需已 aws login）：node scripts/set-secret.mts PORTAL_FEISHU_APP_SECRET [--replace] [--dry-run]
// 首次使用（密钥包还不存在）加 --init：从空包开始建，之后每个密钥照常逐个写入。
import { GetParametersByPathCommand, PutParameterCommand, SSMClient, type Parameter } from "@aws-sdk/client-ssm";

export const BUNDLE_PATH = "/amzshop/prod/secrets/bundle/";
export const BUNDLE_NAME = `${BUNDLE_PATH}main`;
export const MAX_BYTES = 4096;

export interface MergeResult { next: Record<string, string>; body: string; bytes: number; replaced: boolean }

// 纯函数：校验并合并。已有同名键必须显式 --replace（轮换），防止误覆盖；其它键原样保留。
export function mergeBundle(current: unknown, key: string, value: string, replace = false): MergeResult {
  if (!/^[A-Z0-9_]+$/.test(key)) throw new Error("键名只能是大写字母、数字和下划线。");
  if (!value || /[\r\n]/.test(value) || value.trim() !== value) throw new Error("值为空、含换行或首尾空格，已停止。");
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("现有密钥包不是 JSON 对象，已停止。");
  const entries = Object.entries(current as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== "string" || !item)) throw new Error("现有密钥包含非字符串或空值，已停止。");
  const replaced = entries.some(([name]) => name === key);
  if (replaced && !replace) throw new Error(`${key} 已存在；确认要轮换请加 --replace。`);
  const next = Object.fromEntries([...entries.filter(([name]) => name !== key), [key, value]].sort(([a], [b]) => String(a).localeCompare(String(b)))) as Record<string, string>;
  const body = JSON.stringify(next);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_BYTES) throw new Error(`合并后 ${bytes} 字节超过 Standard 参数 4 KB 上限，已停止。`);
  return { next, body, bytes, replaced };
}

async function readHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const input = process.stdin;
  if (!input.isTTY) {
    // 非交互终端（管道）：读一行，不回显也无从回显。
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  }
  return new Promise((resolve, reject) => {
    let value = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") { finish(); resolve(value); return; }
        if (char === "\u0003") { finish(); reject(new Error("已取消。")); return; }
        if (char === "\u007f" || char === "\b") { if (value) { value = value.slice(0, -1); process.stdout.write("\b \b"); } continue; }
        value += char;
        process.stdout.write("*");
      }
    };
    const finish = (): void => { input.off("data", onData); input.setRawMode(false); input.pause(); process.stdout.write("\n"); };
    input.on("data", onData);
  });
}

async function readBundle(ssm: SSMClient, allowMissing = false): Promise<Parameter | undefined> {
  const found: Parameter[] = [];
  let token: string | undefined;
  do {
    const page = await ssm.send(new GetParametersByPathCommand({ Path: BUNDLE_PATH, Recursive: true, WithDecryption: true, MaxResults: 10, ...(token ? { NextToken: token } : {}) }));
    found.push(...(page.Parameters ?? []));
    token = page.NextToken;
  } while (token);
  if (!found.length && allowMissing) return undefined;
  if (found.length !== 1 || found[0]?.Name !== BUNDLE_NAME || found[0].Type !== "SecureString") throw new Error(`${BUNDLE_PATH} 下应只有一个 SecureString 密钥包，实际 ${found.length} 个，已停止。${found.length ? "" : "首次使用请加 --init。"}`);
  return found[0];
}

async function main(): Promise<void> {
  const [key = ""] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const replace = process.argv.includes("--replace");
  const dryRun = process.argv.includes("--dry-run");
  const init = process.argv.includes("--init");
  if (!key) throw new Error("用法：node scripts/set-secret.mts <键名> [--replace] [--dry-run] [--init]");
  const ssm = new SSMClient({ region: process.env.AWS_REGION ?? "us-east-1", maxAttempts: 6 });
  const before = await readBundle(ssm, init);
  const current = (before ? JSON.parse(before.Value ?? "") : {}) as Record<string, string>;
  if (Object.hasOwn(current, key) && !replace) throw new Error(`${key} 已存在；确认要轮换请加 --replace。`);
  const value = await readHidden(`请粘贴 ${key} 的值（输入不显示），回车结束：`);
  const merged = mergeBundle(current, key, value, replace);
  const summary = { key, replaced: merged.replaced, keys: Object.keys(merged.next).length, bytes: merged.bytes, fromVersion: before?.Version ?? 0 };
  if (dryRun) { console.log(JSON.stringify({ mode: "dry-run", ...summary })); return; }
  await ssm.send(new PutParameterCommand({ Name: BUNDLE_NAME, Type: "SecureString", Tier: "Standard", Value: merged.body, Overwrite: true }));
  const after = await readBundle(ssm);
  const stored = JSON.parse(after?.Value ?? "") as Record<string, string>;
  const intact = Object.keys(current).every((name) => name === key || stored[name] === current[name]) && stored[key] === value && Object.keys(stored).length === Object.keys(merged.next).length;
  console.log(JSON.stringify({ mode: "applied", ...summary, toVersion: after?.Version, verified: intact }));
  if (!intact) { process.exitCode = 1; console.error("读回核对不一致：请停下来人工核对密钥包，不要继续写入。"); }
}

if (/set-secret\.mts$/.test(process.argv[1] ?? "")) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
