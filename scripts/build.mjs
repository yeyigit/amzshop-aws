import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const entries = ["order", "ams", "pricing", "jobs", "offer", "portal"];
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

for (const name of entries) {
  await build({
    entryPoints: [`src/handlers/${name}.ts`],
    outfile: `dist/${name}/index.js`,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node24",
    sourcemap: true,
    minify: false,
  });
}

const files = {};
for (const name of entries) {
  const body = await readFile(`dist/${name}/index.js`);
  files[name] = { bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
}
await writeFile("dist/manifest.json", `${JSON.stringify({ node: process.version, files }, null, 2)}\n`);
