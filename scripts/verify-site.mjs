/**
 * Acceptance run for the built site. Every check prints ✓/✗ and the process exits non-zero
 * if any check fails, so "it works" is a claim backed by this output.
 *
 * Usage:
 *   node scripts/verify-site.mjs                 # headed real Chrome (WebGPU available)
 *   node scripts/verify-site.mjs --headless      # headless Chrome
 *   node scripts/verify-site.mjs --base=/        # serve at the site root instead of a subdir
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const samples = path.join(root, "samples");
const args = process.argv.slice(2);
const headless = args.includes("--headless");
const baseArg = args.find((arg) => arg.startsWith("--base="));
const urlArg = args.find((arg) => arg.startsWith("--url="));
const port = 8898;
/** --url=… runs the very same suite against a live deployment (e.g. GitHub Pages). */
const remoteUrl = urlArg === undefined ? null : urlArg.slice("--url=".length);
const base = remoteUrl === null
  ? (baseArg === undefined ? "/mz-3d-viewer/" : baseArg.slice("--base=".length))
  : new URL(remoteUrl).pathname;
const siteUrl = remoteUrl === null ? `http://127.0.0.1:${port}${base}` : remoteUrl;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(siteUrl);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`本地服务器未启动：${siteUrl}`);
}

const server = remoteUrl === null
  ? spawn(process.execPath, [path.join(root, "scripts", "serve-dist.mjs"), base, String(port)], { stdio: "ignore" })
  : null;
if (server !== null) {
  await waitForServer();
}
console.log(`目标：${siteUrl}（${remoteUrl === null ? "本地 dist" : "线上部署"}，${headless ? "headless" : "有头"} Chrome）`);

const browser = await chromium.launch({ channel: "chrome", headless });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const consoleErrors = [];
const pageErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (error) => pageErrors.push(error.message));

const tempDir = await mkdtemp(path.join(tmpdir(), "mz-3d-verify-"));
const junkFile = path.join(tempDir, "not-a-model.txt");
await writeFile(junkFile, "这不是模型文件\n");

const sample = {
  stl: path.join(samples, "stl", "rack.stl"),
  stlCube: path.join(samples, "stl", "cube-10x10.stl"),
  obj: [path.join(samples, "obj", "cube.obj"), path.join(samples, "obj", "cube.mtl"), path.join(samples, "obj", "cube-texture.png")],
  glb: path.join(samples, "gltf", "Duck.glb"),
  step: path.join(samples, "step", "conical-surface.step"),
  iges: path.join(samples, "iges", "cube-10x10.igs"),
  brep: path.join(samples, "brep", "as1_pe_203.brep")
};

async function boot(url = siteUrl, timeout = 30000) {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => window.__mzViewer !== undefined, null, { timeout });
  await page.waitForTimeout(400);
}

const GRID_WIDTH = 192;
const GRID_HEIGHT = 128;

/**
 * Downsampled luminance signature of the next rendered frame.
 *
 * Comparing against a fixed background colour does not work: tone mapping shifts
 * `scene.background` away from its hex value. Every "is it visible" question is therefore
 * answered by diffing against a real baseline frame captured with the models hidden.
 */
async function signature() {
  return page.evaluate(async ({ gridWidth, gridHeight }) => {
    const dataUrl = await window.__mzViewer.capture();
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("PNG 解码失败"));
      image.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);

    const sums = new Float64Array(gridWidth * gridHeight);
    const counts = new Float64Array(gridWidth * gridHeight);
    for (let y = 0; y < canvas.height; y++) {
      const cellY = Math.min(gridHeight - 1, Math.floor((y * gridHeight) / canvas.height));
      for (let x = 0; x < canvas.width; x++) {
        const index = (y * canvas.width + x) * 4;
        const luminance = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
        const cell = cellY * gridWidth + Math.min(gridWidth - 1, Math.floor((x * gridWidth) / canvas.width));
        sums[cell] += luminance;
        counts[cell] += 1;
      }
    }
    const cells = new Array(gridWidth * gridHeight);
    for (let i = 0; i < cells.length; i++) {
      cells[i] = counts[i] === 0 ? 0 : Math.round(sums[i] / counts[i]);
    }
    return { cells, width: canvas.width, height: canvas.height, dataUrlLength: dataUrl.length };
  }, { gridWidth: GRID_WIDTH, gridHeight: GRID_HEIGHT });
}

function diffRatio(a, b, threshold = 6) {
  let differing = 0;
  for (let i = 0; i < a.cells.length; i++) {
    if (Math.abs(a.cells[i] - b.cells[i]) > threshold) differing += 1;
  }
  return differing / a.cells.length;
}

function meanLuminance(frame) {
  let sum = 0;
  for (const value of frame.cells) sum += value;
  return sum / frame.cells.length;
}

function stdLuminance(frame) {
  const mean = meanLuminance(frame);
  let sumSquares = 0;
  for (const value of frame.cells) sumSquares += (value - mean) ** 2;
  return Math.sqrt(sumSquares / frame.cells.length);
}

/**
 * Screen-space bounding box of the pixels that differ from the baseline, as a fraction of
 * the frame. Extent is the right measure for "is it framed well": a hollow part like a comb
 * rack covers few pixels even when it fills the viewport.
 */
function diffBox(a, b, threshold = 6) {
  let minX = GRID_WIDTH;
  let maxX = -1;
  let minY = GRID_HEIGHT;
  let maxY = -1;
  for (let y = 0; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const index = y * GRID_WIDTH + x;
      if (Math.abs(a.cells[index] - b.cells[index]) <= threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) {
    return { widthRatio: 0, heightRatio: 0 };
  }
  return {
    widthRatio: (maxX - minX + 1) / GRID_WIDTH,
    heightRatio: (maxY - minY + 1) / GRID_HEIGHT
  };
}

/** Frame with every model hidden — the baseline for "is anything of the model on screen". */
async function baselineFrame() {
  await setAllVisible(false);
  const frame = await signature();
  await setAllVisible(true);
  return frame;
}

async function setAllVisible(visible) {
  await page.evaluate((nextVisible) => {
    for (const model of window.__mzViewer.stage.modelList) {
      window.__mzViewer.stage.setVisible(model.id, nextVisible);
    }
  }, visible);
  await page.waitForTimeout(250);
}

async function loadSample(files) {
  await page.setInputFiles("#fileInput", files);
  await page.waitForFunction(() => document.getElementById("progressWrap").hidden === true, null, { timeout: 90000 });
  await page.waitForTimeout(500);
  return page.evaluate(() => window.__mzViewer.summary());
}

// ---------------------------------------------------------------- 1. boot

await boot();
check("启动：WebGPU 后端", (await page.textContent("#backendBadge")) === "WebGPU", await page.textContent("#backendBadge"));
check("启动：GPU 适配器可用", (await page.evaluate(async () => (await navigator.gpu?.requestAdapter()) !== null)) === true);
const buildStamp = (await page.textContent("#buildStamp")).trim();
const metaBuild = await page.getAttribute('meta[name="x-build"]', "content");
// Local runs also pin the stamp to the freshly built dist/index.html; remote runs can only
// compare what the page itself reports.
const distHtml = remoteUrl === null ? await readFile(path.join(root, "dist", "index.html"), "utf8") : "";
const htmlBuild = remoteUrl === null ? (/<meta name="x-build" content="([^"]+)" \/>/.exec(distHtml)?.[1] ?? "") : metaBuild;
check("启动：build 号一致", buildStamp === `build ${metaBuild}` && metaBuild === htmlBuild, `${buildStamp} / meta ${metaBuild} / dist ${htmlBuild}`);
check("启动：无控制台错误", consoleErrors.length === 0 && pageErrors.length === 0, [...consoleErrors, ...pageErrors].slice(0, 3).join(" | "));

// ---------------------------------------------------------------- 2. every file format

const stlSummary = await loadSample([sample.stl]);
const stlFrame = await signature();
const emptyFrame = await baselineFrame();
const emptyDiff = diffRatio(stlFrame, emptyFrame);
const stlBox = diffBox(stlFrame, emptyFrame);
check("STL 加载并渲染（缩小后可复现）", stlSummary.models.length === 1 && stlSummary.models[0].triangles === 3012 && emptyDiff > 0.05 && (stlBox.widthRatio > 0.4 || stlBox.heightRatio > 0.35),
  `tri=${stlSummary.models[0]?.triangles} 模型屏幕跨度 ${(stlBox.widthRatio * 100).toFixed(0)}% × ${(stlBox.heightRatio * 100).toFixed(0)}%`);
check("截图返回 PNG", stlFrame.dataUrlLength > 20000 && stlFrame.width > 100, `${stlFrame.width}x${stlFrame.height} ${(stlFrame.dataUrlLength / 1024).toFixed(0)}KB`);

await boot();
const objSummary = await loadSample(sample.obj);
const objToast = (await page.textContent("#toast")) ?? "";
check("OBJ + MTL + 贴图加载", objSummary.models.length === 1 && objSummary.models[0].format === "obj" && objSummary.models[0].triangles === 12 && !objToast.includes("没有找到同名 .mtl"),
  `tri=${objSummary.models[0]?.triangles} toast=${objToast.slice(0, 40)}`);

await boot();
const glbSummary = await loadSample([sample.glb]);
const glbFrame = await signature();
const glbDiff = diffRatio(glbFrame, await baselineFrame());
check("glTF/GLB 加载并渲染（含贴图）", glbSummary.models[0]?.triangles > 1000 && glbDiff > 0.02 && stdLuminance(glbFrame) > 5,
  `tri=${glbSummary.models[0]?.triangles} 模型占画面 ${(glbDiff * 100).toFixed(1)}%`);

await boot();
const stepSummary = await loadSample([sample.step]);
const stepFrame = await signature();
const stepDiff = diffRatio(stepFrame, await baselineFrame());
check("STEP 加载并渲染（OpenCascade wasm）", stepSummary.models[0]?.format === "step" && stepSummary.models[0]?.triangles > 100 && stepDiff > 0.02,
  `tri=${stepSummary.models[0]?.triangles} 模型占画面 ${(stepDiff * 100).toFixed(1)}%`);

await boot();
const igesSummary = await loadSample([sample.iges]);
check("IGES 加载", igesSummary.models[0]?.format === "iges" && igesSummary.models[0]?.triangles > 0, `tri=${igesSummary.models[0]?.triangles}`);

await boot();
const brepSummary = await loadSample([sample.brep]);
check("BREP 加载", brepSummary.models[0]?.format === "brep" && brepSummary.models[0]?.triangles > 0, `tri=${brepSummary.models[0]?.triangles}`);

await boot();
const multiSummary = await loadSample([sample.stl, sample.glb]);
check("多文件同时打开", multiSummary.models.length === 2, multiSummary.models.map((model) => model.name).join(", "));

await boot();
await loadSample([junkFile]);
const junkToast = (await page.textContent("#toast")) ?? "";
check("不支持的格式给提示而不是静默失败", junkToast.includes("没识别到模型文件"), junkToast.slice(0, 60));

// ---------------------------------------------------------------- 3. display & interaction

await boot();
await loadSample([sample.stl]);
const solidFrame = await signature();
await page.click("#styleEdges");
await page.waitForFunction(() => window.__mzViewer.summary().style === "edges", null, { timeout: 30000 });
await page.waitForTimeout(600);
const edgeFrame = await signature();
const edgeDiff = diffRatio(edgeFrame, solidFrame);
const edgeFrameAgain = await signature();
check("带边线模式生效（谱面被画出边线）", edgeDiff > 0.002 && (await page.isChecked("#styleEdges")) === true,
  `${(edgeDiff * 100).toFixed(2)}% 的格子变亮`);
check("边线模式像素稳定", diffRatio(edgeFrame, edgeFrameAgain) < 0.01, `${(diffRatio(edgeFrame, edgeFrameAgain) * 100).toFixed(2)}% 抖动`);

await page.click("#styleWireframe");
await page.waitForFunction(() => window.__mzViewer.summary().style === "wireframe", null, { timeout: 30000 });
await page.waitForTimeout(600);
const wireFrame = await signature();
check("线框模式生效", meanLuminance(wireFrame) < meanLuminance(solidFrame) * 0.9,
  `实心亮度 ${meanLuminance(solidFrame).toFixed(1)} → 线框 ${meanLuminance(wireFrame).toFixed(1)}`);
await page.click("#styleSolid");
await page.waitForTimeout(300);

await page.click(".model-item .icon-btn");
await page.waitForTimeout(300);
const hiddenState = await page.evaluate(() => window.__mzViewer.summary());
check("隐藏 / 显示模型", hiddenState.models[0].visible === false, `visible=${hiddenState.models[0].visible}`);
await page.click(".model-item .icon-btn");
await page.waitForTimeout(300);
check("重新显示模型", (await page.evaluate(() => window.__mzViewer.summary())).models[0].visible === true);

const statsMm = await page.textContent("#statsBox");
await page.selectOption("#unitSelect", "cm");
await page.waitForTimeout(200);
const statsCm = await page.textContent("#statsBox");
check("单位切换改变包围盒读数", statsMm !== statsCm && statsCm.includes("cm"), statsCm.match(/[\d.]+ × [\d.]+ × [\d.]+/)?.[0] ?? "");

await page.click('[data-view="top"]');
await page.waitForTimeout(500);
const topViewPosition = await page.evaluate(() => {
  const camera = window.__mzViewer.stage.camera;
  return [camera.position.x, camera.position.y, camera.position.z];
});
await page.click('[data-view="front"]');
await page.waitForTimeout(500);
const frontViewPosition = await page.evaluate(() => {
  const camera = window.__mzViewer.stage.camera;
  return [camera.position.x, camera.position.y, camera.position.z];
});
check("标准视图切换真的动了相机", topViewPosition[1] !== frontViewPosition[1] && Math.abs(frontViewPosition[2]) > Math.abs(frontViewPosition[0]),
  `顶 ${topViewPosition.map((v) => v.toFixed(1)).join(",")} → 前 ${frontViewPosition.map((v) => v.toFixed(1)).join(",")}`);

await page.check("#sectionToggle");
await page.fill("#sectionOffset", "0");
await page.dispatchEvent("#sectionOffset", "input");
await page.waitForTimeout(700);
const sectionZero = await signature();
await page.fill("#sectionOffset", "100");
await page.dispatchEvent("#sectionOffset", "input");
await page.waitForTimeout(700);
const sectionHundred = await signature();
const sectionBaseline = await baselineFrame();
const zeroVsEmpty = diffRatio(sectionZero, sectionBaseline);
const hundredVsEmpty = diffRatio(sectionHundred, sectionBaseline);
check("剖面切到 0% 时几何真的被裁掉", zeroVsEmpty < hundredVsEmpty * 0.2 && hundredVsEmpty > 0.05,
  `0% 残留 ${(zeroVsEmpty * 100).toFixed(1)}% vs 100% 完整 ${(hundredVsEmpty * 100).toFixed(1)}%`);
await page.uncheck("#sectionToggle");
await page.waitForTimeout(500);
const sectionOff = await signature();
check("关掉剖面后模型完整回来", diffRatio(sectionOff, sectionBaseline) > 0.05 && diffRatio(sectionOff, sectionHundred) < 0.05,
  `与完整态差异 ${(diffRatio(sectionOff, sectionHundred) * 100).toFixed(2)}%`);

await page.click('[data-view="iso"]');
await page.click("#fitBtn");
await page.waitForTimeout(500);
const fittedFrame = await signature();
const fittedBox = diffBox(fittedFrame, await baselineFrame());
check("适应视图后模型撑满画面", fittedBox.widthRatio > 0.5 || fittedBox.heightRatio > 0.5,
  `跨度 ${(fittedBox.widthRatio * 100).toFixed(0)}% × ${(fittedBox.heightRatio * 100).toFixed(0)}%`);

const beforeRemove = (await page.evaluate(() => window.__mzViewer.summary())).models.length;
await page.click(".model-item .icon-btn:last-child");
await page.waitForTimeout(300);
const afterRemove = await page.evaluate(() => window.__mzViewer.summary());
check("移除模型", afterRemove.models.length === beforeRemove - 1 && afterRemove.models.length === 0);

// ---------------------------------------------------------------- 4. PWA

const manifestOk = await page.evaluate(async () => {
  const response = await fetch("./manifest.webmanifest");
  if (!response.ok) return `manifest ${response.status}`;
  const manifest = await response.json();
  const maskable = manifest.icons.some((icon) => icon.purpose === "maskable");
  return manifest.scope === "./" && maskable && manifest.display === "standalone" ? "ok" : JSON.stringify({ scope: manifest.scope, maskable });
});
check("manifest 可解析且含 maskable 图标、scope 相对路径", manifestOk === "ok", String(manifestOk));

const swState = await page.evaluate(async () => {
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration === undefined || registration === null) return "未注册";
  const names = await caches.keys();
  const shell = names.find((name) => name.startsWith("shell-"));
  const cache = await caches.open(shell);
  const keys = (await cache.keys()).map((request) => new URL(request.url).pathname);
  const unhashed = keys.filter((key) => /assets\/index\.(js|css)$/.test(key));
  return {
    scope: new URL(registration.scope).pathname,
    controlled: navigator.serviceWorker.controller !== null,
    shellCache: shell,
    entries: keys.length,
    hasHashedShell: unhashed.length === 0 && keys.some((key) => /assets\/index\.[\w-]+\.js$/.test(key)),
    hasWorker: keys.some((key) => key.endsWith("/wasm/occt/step-worker.js")),
    hasIcons: keys.some((key) => key.endsWith("/icons/icon-512.png")),
    names
  };
});
check("Service Worker 已注册并接管页面", swState.controlled === true && swState.scope === base, JSON.stringify({ scope: swState.scope, controlled: swState.controlled }));
check("外壳预缓存：哈希资源 + worker + 图标", swState.hasHashedShell === true && swState.hasWorker === true && swState.hasIcons === true,
  `${swState.entries} 个条目，缓存 ${(swState.names ?? []).join(", ")}`);

// The engine is warmed by the page (src/pwa/cadEngineWarm.ts) and verified against the built
// bytes, because "it is in some cache" is exactly the claim that was wrong before.
const cadReady = await page
  .waitForFunction(() => window.__mzViewer?.cadEngine().status === "ready", null, { timeout: 150000 })
  .then(() => true)
  .catch(() => false);
const cadCached = await page.evaluate(async () => {
  const sizes = {};
  for (const name of await caches.keys()) {
    if (!name.startsWith("cad-")) continue;
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (response === undefined) continue;
      const blob = await response.blob();
      sizes[new URL(request.url).pathname.split("/").pop()] = blob.size;
    }
  }
  return sizes;
});
const localEngineSizes = {
  "occt-import-js.js": (await stat(path.join(root, "dist", "wasm", "occt", "occt-import-js.js"))).size,
  "occt-import-js.wasm": (await stat(path.join(root, "dist", "wasm", "occt", "occt-import-js.wasm"))).size
};
check("OpenCascade 引擎完整进 SW 缓存（字节数与构建产物逐一对齐）",
  cadReady === true && cadCached["occt-import-js.wasm"] === localEngineSizes["occt-import-js.wasm"] && cadCached["occt-import-js.js"] === localEngineSizes["occt-import-js.js"],
  `状态=${await page.evaluate(() => window.__mzViewer.cadEngine().status)} wasm ${cadCached["occt-import-js.wasm"] ?? "缺失"}/${localEngineSizes["occt-import-js.wasm"]} js ${cadCached["occt-import-js.js"] ?? "缺失"}/${localEngineSizes["occt-import-js.js"]}`);

// ---------------------------------------------------------------- 5. offline

const offlineContext = page.context();
await page.evaluate(() => navigator.serviceWorker.ready);
// GitHub Pages pins cache-control: max-age=600, so without this the browser's own HTTP cache
// would serve "offline" requests and every offline check below would be meaningless.
const cdp = await offlineContext.newCDPSession(page);
await cdp.send("Network.clearBrowserCache");
await offlineContext.setOffline(true);
await boot(siteUrl, 20000).catch((error) => console.log(`   (离线重载警告: ${error.message})`));
const offlineBadge = await page.textContent("#backendBadge").catch(() => "离线且外壳未缓存");
check("清空 HTTP 缓存后断网重载仍能启动（外壳确实来自 SW）", offlineBadge === "WebGPU" || offlineBadge === "WebGL2（回退）", String(offlineBadge));

const offlineStl = await loadSample([sample.stl]).catch(() => null);
check("断网打开 STL", offlineStl !== null && offlineStl.models.length === 1, offlineStl === null ? "失败" : `tri=${offlineStl.models[0].triangles}`);

await boot(siteUrl, 20000);
const offlineStep = await loadSample([sample.step]).catch(() => null);
check("断网打开 STEP（CAD 引擎来自 CAD 缓存）",
  offlineStep !== null && offlineStep.models[0]?.format === "step",
  offlineStep === null ? "失败" : `tri=${offlineStep.models[0]?.triangles} toast=${((await page.textContent("#toast")) ?? "").slice(0, 60)}`);
await offlineContext.setOffline(false);

// ---------------------------------------------------------------- 6. WebGL2 fallback

await boot(`${siteUrl}?webgl=1`);
const fallbackBadge = await page.textContent("#backendBadge");
const fallbackSummary = await loadSample([sample.stl]);
const fallbackFrame = await signature();
const fallbackDiff = diffRatio(fallbackFrame, await baselineFrame());
check("?webgl=1 走 WebGL2 回退后端并渲染", fallbackBadge === "WebGL2（回退）" && fallbackDiff > 0.05,
  `${fallbackBadge} 模型占画面 ${(fallbackDiff * 100).toFixed(1)}% tri=${fallbackSummary.models[0]?.triangles}`);
check("回退路径无控制台错误", consoleErrors.length === 0 && pageErrors.length === 0, [...consoleErrors, ...pageErrors].slice(0, 3).join(" | "));

// ---------------------------------------------------------------- summary

await browser.close();
server?.kill();

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length > 0) {
  console.log("失败项：");
  for (const result of failed) {
    console.log(`  ✗ ${result.name} — ${result.detail}`);
  }
  process.exitCode = 1;
}
