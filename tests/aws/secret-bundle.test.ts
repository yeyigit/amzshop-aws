import assert from "node:assert/strict";
import test from "node:test";
import type { Parameter } from "@aws-sdk/client-ssm";
import { SECRET_REFRESH_MIN_INTERVAL_MS, getConfig, refreshSecrets, setParameterReader, type ParameterReader } from "../../src/config.js";
import { sha256 } from "../../src/util.js";

process.env.PARAMETER_PREFIX = "/amzshop/prod/";
const guardReader: ParameterReader = async () => { throw new Error("测试不得访问 SSM。"); };
const plain: Parameter = { Name: "/amzshop/prod/config/FEISHU_APP_ID", Value: "cli_app", Version: 3 };
const individual: Parameter[] = [{ Name: "/amzshop/prod/secrets/CLIENT_SECRET", Value: "old-individual", Version: 1 }];

// 读取器：记录每次读取的路径与是否解密；密钥包路径返回 bundle，逐个读取路径返回旧参数（有密钥包时不应被读取）。
function install(bundle: () => Parameter[]) {
  const reads: string[] = [];
  let now = 5_000_000;
  setParameterReader(async (path, decrypt) => {
    reads.push(`${path.replace("/amzshop/prod/", "")}:${decrypt}`);
    if (path.endsWith("/secrets/bundle/")) return bundle();
    if (path.endsWith("/secrets/")) return individual;
    return path.endsWith("/config/") ? [plain] : [];
  }, () => now);
  return { reads, advance: (ms: number) => { now += ms; } };
}

test("密钥包存在时只读并解密密钥包一次，不再逐个读取 secrets/；版本随密钥包版本变化", async () => {
  let version = 1;
  const values = { CLIENT_SECRET: "bundle-secret", REFRESH_TOKEN: "bundle-refresh", FEISHU_APP_SECRET: "bundle-app" };
  const env = install(() => [{ Name: "/amzshop/prod/secrets/bundle/main", Value: JSON.stringify(values), Version: version }]);
  try {
    const config = await getConfig();
    assert.deepEqual([...env.reads].sort(), ["asin/:false", "config/:false", "secrets/bundle/:true"]);
    assert.equal(config.get("CLIENT_SECRET"), "bundle-secret", "密钥包优先于旧的逐个参数");
    assert.equal(config.get("REFRESH_TOKEN"), "bundle-refresh");
    assert.equal(config.get("FEISHU_APP_ID"), "cli_app", "普通配置不受影响");
    assert.equal(config.version, sha256(["/amzshop/prod/config/FEISHU_APP_ID:3", "/amzshop/prod/secrets/bundle/main:1"].sort().join("\n")).slice(0, 16));

    env.reads.length = 0;
    version = 2;
    values.CLIENT_SECRET = "rotated-secret";
    env.advance(SECRET_REFRESH_MIN_INTERVAL_MS + 1);
    await refreshSecrets();
    assert.deepEqual(env.reads, ["secrets/bundle/:true"], "认证失败强制重读也只读密钥包一次");
    assert.equal(config.get("CLIENT_SECRET"), "rotated-secret");
  } finally {
    setParameterReader(guardReader);
  }
});

test("密钥包格式错误明确报错且不泄露值：非对象、空值、多个参数", async () => {
  const cases: Array<[string, Parameter[], RegExp]> = [
    ["数组", [{ Name: "/amzshop/prod/secrets/bundle/main", Value: JSON.stringify(["leak-me"]), Version: 1 }], /必须是 JSON 对象/],
    ["非 JSON", [{ Name: "/amzshop/prod/secrets/bundle/main", Value: "leak-me{", Version: 1 }], /格式无效/],
    ["空值", [{ Name: "/amzshop/prod/secrets/bundle/main", Value: JSON.stringify({ CLIENT_SECRET: "leak-me", REFRESH_TOKEN: "" }), Version: 1 }], /REFRESH_TOKEN 无效或值为空/],
    ["多个参数", [{ Name: "/amzshop/prod/secrets/bundle/a", Value: "{}", Version: 1 }, { Name: "/amzshop/prod/secrets/bundle/b", Value: "{}", Version: 1 }], /应只有一个密钥包参数/],
  ];
  for (const [label, bundle, pattern] of cases) {
    install(() => bundle);
    try {
      await assert.rejects(getConfig({ force: true }), (error: Error) => {
        assert.match(error.message, pattern, label);
        assert.equal(error.message.includes("leak-me"), false, `${label}：错误信息不得包含密钥值`);
        return true;
      });
    } finally {
      setParameterReader(guardReader);
    }
  }
});
