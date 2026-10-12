import { readdir, rm, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "tests", "aws");
const output = path.join(root, "dist-tests");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const tests = (await readdir(source)).filter((name) => name.endsWith(".test.ts"));
if (!tests.length) throw new Error("没有 AWS 测试。 ");
await Promise.all(tests.map((name) => build({
  entryPoints: [path.join(source, name)],
  outfile: path.join(output, name.replace(/\.ts$/, ".mjs")),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  sourcemap: "inline",
  logLevel: "warning",
})));
const result = spawnSync(process.execPath, ["--test", ...tests.map((name) => path.join(output, name.replace(/\.ts$/, ".mjs")))], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
