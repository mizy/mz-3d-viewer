/** Exercise the browser's file-handle launch contract against a running viewer. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const url = process.argv.find((arg) => arg.startsWith("--url="))?.slice(6) ?? "http://localhost:8899/";
const samples = await Promise.all(["stl/cube-10x10.stl", "step/conical-surface.step", "step/cube-10x10.stp"]
  .map(async (name) => ({ name: name.split("/").pop(), data: (await readFile(new URL(`../samples/${name}`, import.meta.url))).toString("base64") })));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ serviceWorkers: "block" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });

try {
  await page.addInitScript((first) => {
    const handle = (sample) => ({ getFile: async () => new File([Uint8Array.from(atob(sample.data), (c) => c.charCodeAt(0))], sample.name) });
    window.launchFile = (sample) => window.launchConsumer({ files: [handle(sample)] });
    Object.defineProperty(window, "launchQueue", {
      value: { setConsumer: (consumer) => { window.launchConsumer = consumer; window.launchFile(first); } },
      configurable: true
    });
  }, samples[0]);
  await page.goto(url);
  const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel="manifest"]').href)).json());
  const extensions = manifest.file_handlers.flatMap((handler) => Object.values(handler.accept).flat());
  for (const ext of [".stl", ".step", ".stp"]) assert(extensions.includes(ext), `${ext} registered`);

  for (let i = 0; i < samples.length; i++) {
    if (i > 0) await page.evaluate((sample) => window.launchFile(sample), samples[i]);
    await page.waitForFunction((count) => window.__mzViewer?.summary().models.length === count && document.getElementById("progressWrap").hidden, i + 1, { timeout: 30000 });
    const model = (await page.evaluate(() => window.__mzViewer.summary().models)).at(-1);
    assert.equal(model.name, samples[i].name);
    assert.equal(model.format, i === 0 ? "stl" : "step");
    assert(model.triangles > 0, `${model.name} contains geometry`);
    console.log(`✓ launched ${model.name}: ${model.triangles} triangles`);
  }

  await page.evaluate(() => window.launchConsumer({ files: [{ getFile: async () => { throw new Error("test read failure"); } }] }));
  await page.waitForFunction(() => document.getElementById("toast").textContent.includes("test read failure"));
  assert.equal(await page.evaluate(() => window.__mzViewer.summary().models.length), 3);
  assert.deepEqual(errors, []);
  console.log("✓ file read failure is visible, without an unhandled error");
} finally {
  await browser.close();
}
