/**
 * Post-build step: patch the build stamp into dist/index.html, then emit dist/sw.js with a
 * content-hash based precache manifest. Run via `pnpm build` right after `vite build`.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");

/** Cached on first use instead of at install time: 7.6MB of wasm. */
const CAD_ENGINE_PATHS = ["wasm/occt/occt-import-js.js", "wasm/occt/occt-import-js.wasm"];

async function listFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path.join(dir, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const files = (await listFiles(dist)).sort();
  const indexHtml = files.find((file) => file === "index.html");
  if (indexHtml === undefined) {
    throw new Error("dist/index.html 不存在：先跑 vite build");
  }

  // Build hash covers every shipped byte so the stamp can never disagree with the assets.
  const digests = new Map();
  for (const file of files) {
    if (file === "sw.js") {
      continue;
    }
    digests.set(file, sha256(await readFile(path.join(dist, file))));
  }
  const build = createHash("sha256")
    .update([...digests.entries()].map(([file, digest]) => `${file}:${digest}`).join("\n"))
    .digest("hex")
    .slice(0, 10);

  const htmlPath = path.join(dist, "index.html");
  const html = await readFile(htmlPath, "utf8");
  const stamped = html.replace(/<meta name="x-build" content="[^"]*" \/>/, `<meta name="x-build" content="${build}" />`);
  if (stamped === html) {
    throw new Error("index.html 里没有找到 x-build meta：构建脚本与模板不同步");
  }
  await writeFile(htmlPath, stamped);

  const precache = files
    .filter((file) => file !== "sw.js")
    .filter((file) => !CAD_ENGINE_PATHS.includes(file))
    .filter((file) => !file.endsWith(".txt"))
    .map((file) => ({
      url: `./${file}`,
      revision: digests.get(file)
    }));

  const template = await readFile(path.join(root, "scripts", "sw-template.js"), "utf8");
  const sw = template
    .replace("__BUILD__", build)
    .replace("__PRECACHE__", JSON.stringify(precache, null, 2))
    .replace("__CAD_ENGINE__", JSON.stringify(CAD_ENGINE_PATHS.map((file) => `./${file}`)));
  await writeFile(path.join(dist, "sw.js"), sw);

  let total = 0;
  for (const file of files) {
    total += (await stat(path.join(dist, file))).size;
  }
  console.log(`build ${build}`);
  console.log(`precache ${precache.length} files, dist total ${(total / 1024 / 1024).toFixed(2)} MB (CAD engine deferred)`);
  for (const entry of precache) {
    console.log(`  ${entry.url}`);
  }
}

await main();
