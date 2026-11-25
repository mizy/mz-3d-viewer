/**
 * Smoke test for the publishable package: serves the repository (so dist-lib, node_modules and
 * samples are reachable) and drives scripts/package-demo.html through real imports of dist-lib.
 *
 * It checks the three things a consumer would hit first: STEP through the OpenCascade worker,
 * 3MF with its declared unit, and the headless `parseModel` path.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 8897;
const base = `http://127.0.0.1:${port}`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".stl": "model/stl",
  ".stp": "application/step",
  ".step": "application/step",
  ".3mf": "model/3mf"
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", base);
  const target = path.join(root, decodeURIComponent(url.pathname));
  if (!target.startsWith(root)) {
    response.writeHead(403).end("outside root");
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      response.writeHead(404).end("not found");
      return;
    }
    const body = await readFile(target);
    response.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

const gpuArgs = ["--enable-unsafe-webgpu"];
if (process.platform === "linux") gpuArgs.push("--use-webgpu-adapter=swiftshader", "--disable-vulkan-surface");
if (process.platform === "darwin") gpuArgs.push("--use-angle=metal");
const browser = await chromium.launch({ channel: "chrome", args: gpuArgs });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", (response) => {
  const url = response.url();
  if (response.status() >= 400 && !url.endsWith("/favicon.ico")) errors.push(`${response.status()} ${url}`);
});
page.on("console", (message) => {
  // A 404 already arrives through the response listener with its URL attached.
  if (message.type() === "error" && !message.text().includes("Failed to load resource")) errors.push(message.text());
});

try {
  await page.goto(`${base}/scripts/package-demo.html`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });

  const meta = await page.evaluate(() => ({ presets: window.__pkg.presets, detect: window.__pkg.detect, backend: window.__pkg.viewer.backend }));
  assert.deepEqual(meta.presets, ["fast", "standard", "fine"], "quality presets exported");
  assert.equal(meta.detect, "step", "detectFormat exported");
  assert.equal(meta.backend, "webgpu");
  console.log(`✓ 包入口导出可用（backend=${meta.backend}）`);

  const stepFixture = ["/samples/step/conical-surface.step"];
  const step = await page.evaluate((urls) => window.__pkg.load(urls), stepFixture);
  const coarseStep = await page.evaluate((urls) => window.__pkg.load(urls, "fast"), stepFixture);
  assert(step[0].triangles > coarseStep[0].triangles, "viewer quality defaults to fine and load can override it");
  assert.equal(step[0].format, "step");
  assert.equal(step[0].mmPerUnit, 1, "STEP is millimetres");
  assert(step[0].meshes > 0, "STEP produced geometry");
  console.log(`✓ STEP 经 worker 解析（${step[0].meshes} 个网格，单位 mm）`);

  const three = await page.evaluate(() => window.__pkg.load(["/samples/3mf/inches.3mf"]));
  assert.equal(three[0].format, "3mf");
  assert.equal(three[0].mmPerUnit, 25.4, "3MF keeps its declared inch unit");
  console.log(`✓ 3MF 解析并折算声明单位（mmPerUnit=${three[0].mmPerUnit}）`);

  const headless = await page.evaluate(() => window.__pkg.parseOnly("/samples/stl/rack.stl"));
  assert.equal(headless.format, "stl");
  assert.equal(headless.mmPerUnit, null, "STL declares no unit, and the package says so");
  assert(headless.meshes > 0, "headless parse returned geometry");
  console.log(`✓ 无渲染器的 parseModel 路径（${headless.meshes} 个网格，单位未知）`);
  const gltf = await page.evaluate(() => window.__pkg.parseOnly("/samples/gltf/Duck.glb"));
  assert.equal(gltf.format, "gltf");
  assert.equal(gltf.warnings, 0, "headless glTF can check compressed texture support without a renderer");
  assert(gltf.meshes > 0);

  // Frame the STEP model and make sure the canvas actually has pixels.
  const painted = await page.evaluate(async () => {
    const url = await window.__pkg.viewer.stage.captureNextFrame();
    const image = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, 64, 48);
    const { data } = context.getImageData(0, 0, 64, 48);
    let bright = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] > 120) bright += 1;
    }
    return { bright, style: window.__pkg.style(), edges: window.__pkg.edges() };
  });
  assert(painted.bright > 20, `模型应当被渲染出来（亮像素 ${painted.bright}）`);
  assert.equal(painted.style, "edges", "默认带边线显示");
  assert.equal(painted.edges, true, "首次加载会生成边线");
  await page.screenshot({ path: path.join(tmpdir(), "mz-package-demo.png") });
  console.log(`✓ 渲染出画面（亮像素 ${painted.bright}，显示模式 ${painted.style}，边线 ${painted.edges}）`);

  const pick = await page.evaluate(async () => {
    const { viewer, load } = window.__pkg;
    viewer.clear();
    await load(["/samples/step/cube-10x10.stp"]);
    const { stage } = viewer;
    stage.setStandardView("front", false);
    await stage.captureNextFrame();
    const rect = document.getElementById("view").getBoundingClientRect();
    const hit = await stage.pick(rect.left + rect.width / 2, rect.top + rect.height / 2, { exact: true });
    const { min, max } = stage.active.box;
    const leftEdge = min.clone().set(min.x, (min.y + max.y) / 2, max.z).project(stage.camera);
    const edge = await stage.pick(rect.left + (leftEdge.x + 1) * rect.width / 2,
      rect.top + (1 - leftEdge.y) * rect.height / 2, { inspect: true });
    return {
      face: hit?.face != null && hit?.localPoint != null && Number.isFinite(hit.localPoint.z),
      edge: edge?.edge?.count === 1
    };
  });
  assert.deepEqual(pick, { face: true, edge: true }, "the built package picks both CAD faces and edges with WebGPU");

  const unavailable = await page.evaluate(async () => {
    const { createModelViewer, WebGPUUnavailableError } = await import("/dist-lib/index.js");
    Object.defineProperty(navigator, "gpu", { configurable: true, value: undefined });
    try {
      await createModelViewer(document.createElement("canvas"));
      return false;
    } catch (error) {
      return error instanceof WebGPUUnavailableError;
    } finally {
      delete navigator.gpu;
    }
  });
  assert(unavailable, "the SDK exposes an error when WebGPU is unavailable");

  assert.deepEqual(errors, [], `控制台不应有错误：${errors.join(" | ")}`);
  console.log("\n包冒烟测试通过：dist-lib 可被外部以 ESM 方式引用，OCCT 资源默认从包内解析。");
} finally {
  await browser.close();
  server.close();
}
