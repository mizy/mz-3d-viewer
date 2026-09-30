/** Loading, cancellation and resource lifetime regressions against a running dev or built site. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const url = process.argv.find((arg) => arg.startsWith("--url="))?.slice(6) ?? "http://localhost:8899/";
const fixtures = await mkdtemp(path.join(tmpdir(), "mz-loading-"));
const sample = (name) => new URL(`../samples/${name}`, import.meta.url).pathname;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ serviceWorkers: "block" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
await page.addInitScript(() => {
  window.liveUrls = new Set();
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob) => { const url = create(blob); window.liveUrls.add(url); return url; };
  URL.revokeObjectURL = (url) => { window.liveUrls.delete(url); revoke(url); };
  window.workers = [];
  const OriginalWorker = Worker;
  window.Worker = class extends OriginalWorker {
    constructor(url, options) {
      super(url, options);
      const entry = { url: String(url), terminated: false };
      window.workers.push(entry);
      const terminate = this.terminate.bind(this);
      this.terminate = () => { entry.terminated = true; terminate(); };
    }
  };
});

async function open(files) {
  await page.locator("#fileInput").setInputFiles(files);
  await page.waitForFunction(() => document.getElementById("progressWrap").hidden && window.__mzViewer.stage.active !== null);
}

try {
  await page.goto(url);
  await page.waitForFunction(() => window.__mzViewer !== undefined);
  await open([sample("obj/cube.obj"), sample("obj/cube.mtl"), sample("obj/cube-texture.png")]);
  assert.equal(await page.evaluate(() => window.liveUrls.size), 0, "OBJ revokes its local texture URLs after loading");

  // Observe the actual disposal events, including resources shared within a model.
  await page.evaluate(() => {
    const model = window.__mzViewer.stage.active;
    const mesh = model.appearance.surfaces[0].mesh;
    model.root.add(mesh.clone());
    window.disposed = { geometry: 0, material: 0, texture: 0 };
    mesh.geometry.addEventListener("dispose", () => window.disposed.geometry++);
    mesh.material.addEventListener("dispose", () => window.disposed.material++);
    mesh.material.map.addEventListener("dispose", () => window.disposed.texture++);
  });
  await page.locator("#brandLink").click();
  assert.deepEqual(await page.evaluate(() => window.disposed), { geometry: 1, material: 1, texture: 1 }, "shared model resources released once");
  console.log("✓ OBJ companion URLs and shared texture/material/geometry disposal");

  // Turn the committed GLB into a glTF with real external BIN and PNG companions.
  const glb = await readFile(sample("gltf/Box.glb"));
  const jsonLength = glb.readUInt32LE(12);
  const model = JSON.parse(glb.subarray(20, 20 + jsonLength).toString());
  model.buffers[0].uri = "geometry.bin";
  model.images = [{ uri: "cube-texture.png" }];
  model.textures = [{ source: 0 }];
  model.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  const binary = glb.subarray(28 + jsonLength);
  const primitive = model.meshes[0].primitives[0];
  const vertexCount = model.accessors[primitive.attributes.POSITION].count;
  const uv = Buffer.alloc(vertexCount * 8);
  for (let i = 0; i < vertexCount; i++) {
    uv.writeFloatLE(i % 2, i * 8);
    uv.writeFloatLE(Math.floor(i / 2) % 2, i * 8 + 4);
  }
  primitive.attributes.TEXCOORD_0 = model.accessors.length;
  model.accessors.push({ bufferView: model.bufferViews.length, componentType: 5126, count: vertexCount, type: "VEC2" });
  model.bufferViews.push({ buffer: 0, byteOffset: binary.length, byteLength: uv.length, target: 34962 });
  model.buffers[0].byteLength = binary.length + uv.length;
  const gltfPath = path.join(fixtures, "external.gltf");
  const binPath = path.join(fixtures, "geometry.bin");
  await writeFile(gltfPath, JSON.stringify(model));
  await writeFile(binPath, Buffer.concat([binary, uv]));
  await open([gltfPath, binPath, sample("obj/cube-texture.png")]);
  assert(await page.evaluate(() => window.__mzViewer.stage.active.appearance.surfaces.some(({ mesh }) => mesh.material.map?.image)), "glTF external PNG loaded");
  assert.equal(await page.evaluate(() => window.liveUrls.size), 0, "glTF releases its companion URLs");
  await page.evaluate(() => {
    const image = window.__mzViewer.stage.active.appearance.surfaces[0].mesh.material.map.image;
    window.bitmapClosed = 0;
    const close = image.close.bind(image);
    image.close = () => { window.bitmapClosed++; close(); };
  });
  await page.locator("#brandLink").click();
  assert.equal(await page.evaluate(() => window.bitmapClosed), 1, "glTF ImageBitmap released");
  console.log("✓ glTF external BIN/PNG, URL cleanup and ImageBitmap disposal");

  // Keep the real CAD worker's engine download pending, then cancel without waiting for it.
  let releaseEngine;
  let engineRequested;
  const engineGate = new Promise((resolve) => { releaseEngine = resolve; });
  const engineRequest = new Promise((resolve) => { engineRequested = resolve; });
  await context.route("**/occt-import-js.wasm", async (route) => { engineRequested(); await engineGate; await route.continue(); });
  await page.locator("#fileInput").setInputFiles(sample("step/conical-surface.step"));
  await engineRequest;
  await page.locator("#cancelBtn").click();
  await page.waitForFunction(() => document.getElementById("progressWrap").hidden, null, { timeout: 2000 });
  assert(await page.evaluate(() => window.workers.filter((worker) => worker.url.endsWith("step-worker.js")).every((worker) => worker.terminated)), "CAD cancellation terminates its worker");
  assert.equal(await page.evaluate(() => window.__mzViewer.stage.modelList.length), 0);
  releaseEngine();
  await context.unrouteAll({ behavior: "wait" });
  await open(sample("stl/cube-10x10.stl"));
  console.log("✓ CAD cancellation terminates the worker and permits the next import immediately");

  // A single 120k-triangle STL keeps the edge worker busy long enough to verify UI responsiveness.
  await page.locator("#brandLink").click();
  const triangleCount = 120000;
  const stl = Buffer.alloc(84 + triangleCount * 50);
  stl.writeUInt32LE(triangleCount, 80);
  for (let i = 0; i < triangleCount; i++) {
    const offset = 84 + i * 50;
    stl.writeFloatLE(1, offset + 8);
    stl.writeFloatLE(10, offset + 24);
    stl.writeFloatLE(10, offset + 40);
  }
  const stlPath = path.join(fixtures, "large.stl");
  await writeFile(stlPath, stl);
  await open(stlPath);
  const responsive = await page.evaluate(async () => {
    const stage = window.__mzViewer.stage;
    const bytes = stage.active.appearance.surfaces[0].mesh.geometry.attributes.position.array.byteLength;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const first = stage.setDisplayStyle("edges");
    const task = stage.active.edgeBuild;
    const second = stage.setDisplayStyle("edges");
    const shared = stage.active.edgeBuild === task;
    await Promise.all([first, second]);
    clearInterval(timer);
    return { ticks, shared, intact: bytes === stage.active.appearance.surfaces[0].mesh.geometry.attributes.position.array.byteLength };
  });
  assert(responsive.shared && responsive.intact && responsive.ticks > 3, JSON.stringify(responsive));
  assert(await page.evaluate(async () => {
    const stage = window.__mzViewer.stage;
    stage.setEdgeAngle(10);
    const old = stage.setDisplayStyle("edges");
    const task = stage.active.edgeBuild;
    await stage.setDisplayStyle("solid");
    await old;
    return task.abort.signal.aborted && stage.active.edges === null && stage.active.edgeBuild === null;
  }), "leaving edges cancels the pending calculation");
  assert(await page.evaluate(async () => {
    const stage = window.__mzViewer.stage;
    const old = stage.setDisplayStyle("edges");
    stage.setEdgeAngle(40);
    await Promise.all([old, stage.setDisplayStyle("edges")]);
    return stage.active.edgeAngleUsed === 40;
  }), "rapid angle changes install only the latest edges");
  await open(sample("stl/cube-10x10.stl"));
  assert(await page.evaluate(async () => {
    const stage = window.__mzViewer.stage;
    stage.setEdgeAngle(30);
    const pending = stage.setDisplayStyle("edges");
    stage.removeModel(stage.modelList[0].id);
    await pending;
    return stage.modelList.length === 1 && stage.active.edges !== null;
  }), "removing a pending model still builds edges for the remaining model");
  console.log(`✓ large single-mesh edge worker: ${responsive.ticks} UI ticks, shared task, cancellation and latest-angle result`);

  await page.locator("#brandLink").click();
  await page.locator("#demoBtn").click();
  await page.locator("#entitiesBtn").click();
  await page.evaluate(() => { window.firstEntity = document.querySelector(".entity-name"); });
  await page.locator("#entitySearch").fill("轴心");
  await page.locator(".entity-name:visible").click();
  assert.equal(await page.locator(".entity-name:visible").count(), 1);
  assert(await page.evaluate(() => window.firstEntity === document.querySelector(".entity-name")), "search and selection preserve existing rows");
  await page.locator("#entitiesClose").click();
  await page.waitForTimeout(700);
  const calls = await page.evaluate(() => window.__mzViewer.stage.renderer.info.render.calls);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__mzViewer.stage.renderer.info.render.calls), calls, "idle scene does not redraw");
  await page.keyboard.press("g");
  await page.waitForFunction((calls) => window.__mzViewer.stage.renderer.info.render.calls > calls, calls);
  await page.keyboard.press("g");
  const captures = await page.evaluate(() => Promise.all([window.__mzViewer.capture(), window.__mzViewer.capture()]));
  assert(captures.every((data) => data.startsWith("data:image/png")) && captures[0] === captures[1]);
  await page.screenshot({ path: path.join(tmpdir(), "mz-3d-viewer-fixed.png") });
  console.log("✓ stable entity rows, idle rendering, redraw after changes and concurrent screenshots");
  assert.deepEqual(errors, [], "no browser errors");
} finally {
  await browser.close();
  await rm(fixtures, { recursive: true, force: true });
}
