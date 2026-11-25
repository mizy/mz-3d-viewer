/**
 * Builds the publishable package into dist-lib/:
 *   index.js               the ESM entry (three is a peer dependency)
 *   index.js.map           source map
 *   types/**               .d.ts tree, entry at types/lib/index.d.ts
 *   occt/*                 worker + wasm + the licences OCCT requires us to ship
 *
 * `npm pack` then contains exactly this directory, so `configureCadAssets` can keep its default
 * of "next to the module" and the engine still resolves for a consumer.
 */
import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist-lib");
const occtSource = path.join(root, "public", "wasm", "occt");
const OCCT_FILES = [
  "step-worker.js",
  "occt-import-js.js",
  "occt-import-js.wasm",
  "license.occt.txt",
  "license.occt-import-js.txt"
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 失败，退出码 ${result.status}`);
  }
}

console.log("→ vite build（ESM，three external）");
run("pnpm", ["exec", "vite", "build", "--config", "vite.lib.config.ts"]);

console.log("→ tsc（只产出 .d.ts）");
run("pnpm", ["exec", "tsc", "-p", "tsconfig.lib.json"]);

console.log("→ 复制 OpenCascade 资源与许可");
const occtOut = path.join(out, "occt");
await mkdir(occtOut, { recursive: true });
await cp(path.join(root, "node_modules", "three", "LICENSE"), path.join(out, "LICENSE.three.txt"));
for (const file of OCCT_FILES) {
  await cp(path.join(occtSource, file), path.join(occtOut, file));
}

const entries = await readdir(out, { recursive: true });
let bytes = 0;
for (const entry of entries) {
  const info = await stat(path.join(out, entry));
  if (info.isFile()) bytes += info.size;
}
const missing = ["index.js", "index.js.map", "types/lib/index.d.ts", "LICENSE.three.txt", ...OCCT_FILES.map((file) => path.join("occt", file))]
  .filter((file) => !entries.includes(file.replaceAll("\\", "/")));
if (missing.length > 0) {
  throw new Error(`产物缺少：${missing.join(", ")}`);
}
console.log(`✓ dist-lib 就绪：${entries.length} 项，${(bytes / 1024 / 1024).toFixed(2)}MB`);
