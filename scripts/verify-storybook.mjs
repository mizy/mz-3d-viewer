import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.argv.find((arg) => arg.startsWith("--url="))?.slice(6) ?? "http://127.0.0.1:6006/";
const browser = await chromium.launch({ channel: "chrome", headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1460, height: 1080 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.location().url.endsWith("/favicon.ico")) errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) errors.push(response.url());
  });

  const frame = page.frameLocator("#storybook-preview-iframe");
  const controls = page.getByRole("tabpanel", { name: "Controls" });
  const control = (name) => controls.locator(`#control-${name}`);
  const ready = () => frame.getByText("就绪", { exact: true }).waitFor();
  const info = (text) => frame.getByText(text).waitFor();
  const pickOption = (group, name) => controls.getByRole("group", { name: group, exact: true })
    .getByRole("radio", { name, exact: true }).check();
  const toggle = (name) => controls.getByRole("switch", { name, exact: true }).press("Space");

  async function openStory(id, args) {
    const url = new URL(base);
    url.searchParams.set("path", `/story/${id}`);
    if (args !== undefined) url.searchParams.set("args", args);
    await page.goto(url.href);
  }

  async function expectControls(expected) {
    const rows = controls.getByRole("row").locator(":scope > :first-child");
    const names = (await rows.allTextContents()).map((name) => name.trim()).filter((name) => name !== "Name");
    assert.deepEqual(names.sort(), [...expected].sort());
  }

  // Sample the WebGPU frame after the current redraw. Compare within one story so tags and controls
  // cannot make the screenshot look different by themselves.
  async function frameImage() {
    const canvas = frame.locator("canvas");
    await canvas.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    return canvas.screenshot();
  }

  async function expectFrameChange(previous, message) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!(await frameImage()).equals(previous)) return;
    }
    assert.fail(message);
  }

  await openStory("viewer-rendering--materials", "style:xray;axis:y;explode:1;preset:original");
  await ready();
  await expectControls(["preset", "style", "environment"]);
  await info(/preset=original · style=xray · environment=true/);
  await pickOption("style", "solid");
  await info(/preset=original · style=solid/);
  const canvas = await frame.locator("canvas").elementHandle();
  const original = await frameImage();
  await control("preset").selectOption("blue");
  await info(/preset=blue · style=solid/);
  assert(!(await frameImage()).equals(original), "the material preset repaints the model");
  await toggle("environment");
  await info(/preset=blue · style=solid · environment=false/);
  assert(await canvas.evaluate((element) => element.isConnected), "visual args reuse the canvas");
  console.log("✓ Materials URL args, material, display style and environment update the existing canvas");

  await openStory("viewer-rendering--section-cuts");
  await ready();
  await expectControls(["axis", "ratio", "reversed"]);
  const uncut = await frameImage();
  await pickOption("axis", "z");
  await control("ratio").press("End");
  await toggle("reversed");
  await info(/z @ 100% · 反向保留/);
  assert(!(await frameImage()).equals(uncut), "the section controls change the clipped model");
  console.log("✓ Section axis, ratio and flip");

  await openStory("viewer-rendering--explode");
  await ready();
  await expectControls(["style", "explode"]);
  const assembled = await frameImage();
  await control("explode").press("End");
  await info("爆炸视图 · 100%");
  assert(!(await frameImage()).equals(assembled), "the explosion control separates parts");
  await pickOption("style", "wireframe");
  console.log("✓ Explode slider and display mode");

  await openStory("viewer-rendering--camera-and-environment");
  await ready();
  await expectControls(["projection", "view", "grid", "environment", "lightBackground"]);
  const dark = await frameImage();
  await pickOption("projection", "orthographic");
  await control("view").selectOption("top");
  await toggle("grid");
  await toggle("environment");
  await toggle("lightBackground");
  await info("相机 · orthographic · top");
  await info(/projection=orthographic · grid=true · environment=false/);
  assert(!(await frameImage()).equals(dark), "camera and lighting controls change the preview");
  console.log("✓ Camera, projection, grid, environment and light background");

  await openStory("viewer-rendering--embedded-viewer");
  await ready();
  await expectControls(["sample", "edges", "background"]);
  const withEdges = await frameImage();
  await toggle("edges");
  await expectFrameChange(withEdges, "the edge control removes the edge overlay");
  const beforeBackground = await frameImage();
  await control("background").fill("#486080");
  await control("background").press("Tab");
  await expectFrameChange(beforeBackground, "the color control changes the canvas background");
  await control("sample").selectOption("step/cube-10x10.stp");
  await info(/step · 1 mesh/);
  await ready();
  console.log("✓ Embedded viewer sample, edges and background");

  await openStory("viewer-rendering--display-styles");
  await ready();
  await expectControls(["style"]);
  await pickOption("style", "wireframe");
  await info(/style=wireframe/);
  console.log("✓ Display Styles updates the selected render mode");

  await openStory("viewer-rendering--hover-and-selection");
  await ready();
  await expectControls(["sample", "edges"]);
  const pickMode = frame.getByRole("combobox", { name: "拾取模式" });
  await pickMode.selectOption("body");
  await info(/悬停或点击整个零件/);
  const defaultAssembly = await frameImage();
  await toggle("edges");
  await expectFrameChange(defaultAssembly, "the picking story can turn off visible edges");
  assert.equal(await pickMode.inputValue(), "body", "visual args preserve the chosen pick mode");
  console.log("✓ Hover example edge control preserves the in-canvas pick mode");

  await openStory("package-api--parse-model");
  await ready();
  await expectControls(["sample"]);
  await control("sample").selectOption("gltf/Duck.glb");
  await info(/gltf · \d+ mesh/);
  await ready();
  console.log("✓ Parser sample control selects a different format");

  await openStory("package-api--cad-quality");
  await ready();
  await expectControls(["quality"]);
  await pickOption("quality", "fast");
  await info(/快速.*三角形/s);
  const triangles = async () => {
    const value = (await frame.getByText(/\d+ 三角形/).textContent()).match(/(\d+) 三角形/);
    assert(value);
    return Number(value[1]);
  };
  const coarse = await triangles();
  await pickOption("quality", "fine");
  await info(/精细.*三角形/s);
  assert((await triangles()) > coarse, "fine CAD quality tessellates more triangles");
  console.log("✓ CAD quality changes the triangle count on a curved STEP face");

  await openStory("package-api--configure-cad-assets");
  await info(/step · 1 mesh/);
  await expectControls(["baseUrl"]);
  await control("baseUrl").fill("/occt");
  await info(/baseUrl=\/occt\s+step · 1 mesh/);
  console.log("✓ CAD asset base URL control");

  await openStory("package-built-dist-lib--published-artifact");
  await ready();
  await expectControls(["sample"]);
  await control("sample").selectOption("stl/cube-10x10.stl");
  await info(/stl · 1 mesh/);
  await ready();
  console.log("✓ Published Artifact sample control");

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
