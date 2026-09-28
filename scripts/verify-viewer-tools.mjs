/** Interaction acceptance: real GPU rendering, model transforms, touch and narrow layouts.
 * Usage: node scripts/verify-viewer-tools.mjs [--url=http://localhost:8899/]
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
const url = process.argv.find((arg) => arg.startsWith("--url="))?.slice(6) ?? "http://localhost:8899/";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
try {
  for (const [width, height] of [[1440, 900], [390, 844], [320, 568], [844, 390]]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: width < 900 });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.goto(url);
    await page.waitForFunction(() => window.__mzViewer !== undefined);
    await page.locator("#demoBtn").tap();
    await page.waitForFunction(() => window.__mzViewer.stage.active?.parts.length === 11);
    const assembled = await page.evaluate(() => window.__mzViewer.stage.active.parts.map((part) => part.mesh.matrix.toArray()));
    const dimensions = await page.evaluate(() => window.__mzViewer.stage.active.stats.size.toArray());
    await page.locator("#explodeBtn").tap();
    assert.equal(await page.locator("#explodeRange").inputValue(), "50", "first explosion defaults to midpoint");
    await page.waitForTimeout(120);
    assert(await page.evaluate(() => window.__mzViewer.stage.active.explode > 0 && window.__mzViewer.stage.active.explode < 0.5), "explosion has intermediate frames");
    await page.waitForFunction(() => window.__mzViewer.stage.active.explode === 0.5);
    if (width === 390) {
      await page.locator("#explodeRange").fill("85");
      await page.waitForTimeout(80);
      await page.locator("#explodeRange").fill("20");
      await page.waitForFunction(() => window.__mzViewer.stage.active.explode === 0.2);
      await page.keyboard.press("Escape");
      await page.locator("#explodeBtn").tap();
      assert.equal(await page.locator("#explodeRange").inputValue(), "20", "rapid slider retarget and reopening preserve the latest value");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.locator("#assembleBtn").tap();
      assert.equal(await page.evaluate(() => window.__mzViewer.stage.active.explode), 0, "reduced-motion explosion restores immediately");
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
    await page.locator("#separateBtn").tap();
    await page.waitForFunction(() => window.__mzViewer.stage.active.explode === 1);
    assert(await page.evaluate(() => window.__mzViewer.stage.active.parts.every((part) => !part.mesh.matrix.equals(part.matrix))), "all parts separate");
    assert.deepEqual(await page.evaluate(() => window.__mzViewer.stage.active.stats.size.toArray()), dimensions, "physical dimensions do not change");
    await page.locator("#assembleBtn").tap();
    await page.waitForFunction(() => window.__mzViewer.stage.active.explode === 0);
    assert.deepEqual(await page.evaluate(() => window.__mzViewer.stage.active.parts.map((part) => part.mesh.matrix.toArray())), assembled, "exact assembly restoration");
    await page.keyboard.press("Escape");
    await page.locator("#styleBtn").tap();
    await page.waitForFunction(() => window.__mzViewer.stage.active.edges !== null);
    await page.locator("#explodeBtn").tap();
    assert.equal(await page.locator("#explodeRange").inputValue(), "0", "reopening preserves restored position");
    await page.locator("#separateBtn").tap();
    await page.waitForFunction(() => window.__mzViewer.stage.active.explode === 1);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    assert(await page.evaluate(() => {
      const model = window.__mzViewer.stage.active;
      return model.edges.children.every((line, index) => line.matrixWorld.equals(model.parts[index].mesh.matrixWorld));
    }), "edge lines follow exploded meshes");

    await page.locator("#entitiesBtn").tap();
    assert.equal(await page.locator(".entity-name").count(), 11, "named parts listed");
    await page.locator("#entitySearch").fill("紧固件 3");
    assert.equal(await page.locator(".entity-name").count(), 1, "filter parts by source name");
    await page.locator(".entity-name").tap();
    assert(await page.evaluate(() => {
      const model = window.__mzViewer.stage.active;
      return model.parts[model.selectedPart].mesh.material === model.appearance.highlight;
    }), "selected part highlighted without changing siblings");
    await page.getByRole("button", { name: "隐藏 紧固件 3", exact: true }).tap();
    assert(await page.evaluate(() => {
      const model = window.__mzViewer.stage.active;
      const mesh = model.parts[model.selectedPart].mesh;
      return !mesh.visible && model.edges.children.filter((line) => line.matrix === mesh.matrixWorld).every((line) => !line.visible);
    }), "hidden part and its edges disappear together");
    await page.getByRole("button", { name: "定位 紧固件 3", exact: true }).tap();
    await page.locator("#isolatePartBtn").tap();
    assert.equal(await page.evaluate(() => window.__mzViewer.stage.active.parts.filter((part) => part.mesh.visible).length), 1, "isolate part");
    await page.locator("#showPartsBtn").tap();
    await page.locator("#clearPartBtn").tap();
    assert(await page.evaluate(() => {
      const model = window.__mzViewer.stage.active;
      return model.parts.every((part) => part.mesh.visible) && model.appearance.surfaces.every((surface) => surface.mesh.material === surface.material);
    }), "restore visibility and original materials");
    await page.locator("#entitiesClose").tap();
    await page.locator("#styleBtn").tap();
    await page.locator("#styleBtn").tap();
    assert(await page.evaluate(() => {
      const model = window.__mzViewer.stage.active;
      return window.__mzViewer.stage.style === "xray" && model.appearance.surfaces.every(({ mesh }) => mesh.material.transparent && !mesh.material.depthWrite && mesh.material.opacity < 0.3);
    }), "X-ray shows translucent surfaces");
    await page.locator("#entitiesBtn").tap();
    await page.locator(".entity-name").tap();
    await page.locator("#clearPartBtn").tap();
    assert(await page.evaluate(() => window.__mzViewer.stage.active.appearance.surfaces.every(({ mesh }) => mesh.material === window.__mzViewer.stage.active.appearance.xray)), "clearing X-ray selection restores X-ray");
    await page.locator("#entitiesClose").tap();
    await page.locator("#styleBtn").tap();
    assert(await page.evaluate(() => window.__mzViewer.stage.active.appearance.surfaces.every((surface) => surface.mesh.material === surface.material)), "leaving X-ray restores imported materials");
    await page.locator("#isoBtn").tap();
    await page.waitForTimeout(450);
    await page.locator("#fitBtn").tap();

    // Clicking a visible cube face and all six keyboard views must orient the real camera.
    const beforeSnap = await page.locator(".cube").getAttribute("style");
    await page.locator('#navCube [data-view="front"]').tap();
    await page.waitForTimeout(120);
    assert.notEqual(await page.locator(".cube").getAttribute("style"), beforeSnap, "cube animates with camera");
    assert(await page.evaluate(() => {
      const stage = window.__mzViewer.stage;
      const direction = stage.camera.position.clone().sub(stage.controls.target).normalize();
      return direction.z > 0.65 && direction.z < 0.999;
    }), "intermediate pose exists, rather than an instant snap");
    await page.waitForFunction(() => {
      const stage = window.__mzViewer.stage;
      return stage.camera.position.clone().sub(stage.controls.target).normalize().z > 0.99999;
    });
    assert(await page.evaluate(() => {
      const stage = window.__mzViewer.stage;
      const d = stage.camera.position.clone().sub(stage.controls.target).normalize();
      return d.z > 0.99;
    }), "tap cube face");
    for (const [key, axis, sign] of [["1", "z", 1], ["2", "z", -1], ["3", "x", -1], ["4", "x", 1], ["5", "y", 1], ["6", "y", -1]]) {
      await page.locator("#navCube").press(key);
      await page.waitForFunction(({ axis, sign }) => {
        const stage = window.__mzViewer.stage;
        return stage.camera.position.clone().sub(stage.controls.target).normalize()[axis] * sign > 0.99999;
      }, { axis, sign });
      assert(await page.evaluate(({ axis, sign }) => {
        const stage = window.__mzViewer.stage;
        return stage.camera.position.clone().sub(stage.controls.target).normalize()[axis] * sign > 0.99;
      }, { axis, sign }), `cube face ${key}`);
    }
    await page.locator("#navCube").press("2");
    await page.waitForTimeout(70);
    await page.locator("#navCube").press("4");
    await page.waitForTimeout(450);
    assert(await page.evaluate(() => {
      const stage = window.__mzViewer.stage;
      return stage.camera.position.clone().sub(stage.controls.target).normalize().x > 0.999;
    }), "rapid retarget finishes at latest requested face");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#navCube").press("3");
    assert(await page.evaluate(() => {
      const stage = window.__mzViewer.stage;
      return stage.camera.position.clone().sub(stage.controls.target).normalize().x < -0.999;
    }), "reduced motion uses immediate view switching");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#isoBtn").tap();
    const cube = await page.locator("#navCube").boundingBox();
    const beforeDrag = await page.evaluate(() => window.__mzViewer.stage.camera.position.toArray());
    await page.mouse.move(cube.x + 40, cube.y + 40);
    await page.mouse.down();
    await page.mouse.move(cube.x + 75, cube.y + 60, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    assert.notDeepEqual(await page.evaluate(() => window.__mzViewer.stage.camera.position.toArray()), beforeDrag, "cube drag rotates");
    const cubeMatrix = await page.locator(".cube").getAttribute("style");

    const cdp = await context.newCDPSession(page);
    const x = width / 2, y = height * 0.43;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 0 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 45, y: y + 20, id: 0 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(250);
    assert.notEqual(await page.locator(".cube").getAttribute("style"), cubeMatrix, "cube follows canvas touch orbit");
    const distance = await page.evaluate(() => window.__mzViewer.stage.camera.position.distanceTo(window.__mzViewer.stage.controls.target));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x - 20, y, id: 0 }, { x: x + 20, y, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 50, y, id: 0 }, { x: x + 50, y, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(150);
    assert(await page.evaluate(() => window.__mzViewer.stage.camera.position.distanceTo(window.__mzViewer.stage.controls.target)) < distance, "pinch zoom");

    await page.locator("#sidebarToggle").tap();
    await page.locator("#sectionDetails summary").tap();
    await page.locator("#sectionToggle").check();
    await page.locator("#sectionAxisSelect").selectOption("y");
    assert(await page.evaluate(() => window.__mzViewer.stage.scene.children.some((child) => child.isClippingGroup && child.clippingPlanes.length === 1)), "exploded section plane");
    await page.locator("#sectionToggle").uncheck();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#settingsPanel").isVisible(), false, "Escape closes modal");
    assert(await page.evaluate(() => [...document.querySelectorAll(".dock-btn, #openBtn")].every((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.height >= 44 && rect.bottom <= innerHeight;
    })), "touch controls fit the viewport");
    await page.locator("#sidebarToggle").tap();
    await page.locator('#modelList button[title="移除"]').tap();
    await page.locator("#sidebarClose").tap();
    assert(await page.locator("#demoBtn").isVisible(), "empty state after removal");

    if (width === 390) {
      // A nested, scaled import with a manual matrix must survive explode / reassembly.
      await page.locator("#demoBtn").tap();
      const restored = await page.evaluate(() => {
        const stage = window.__mzViewer.stage;
        const root = stage.active.root.clone(true);
        root.rotation.set(0.2, 0.7, -0.3);
        root.scale.set(1.2, 0.8, 1.4);
        const group = new root.constructor();
        group.position.set(4, 5, 6);
        group.rotation.set(0.1, -0.3, 0.2);
        group.add(root.children[0]);
        root.add(group);
        const mesh = root.children[0];
        mesh.updateMatrix();
        mesh.matrixAutoUpdate = false;
        mesh.matrix.elements[4] = 0.2;
        const model = stage.addModel({ root, format: "gltf", warnings: [] }, "nested");
        const before = model.parts.map((part) => part.mesh.matrix.toArray());
        const size = model.stats.size.toArray();
        stage.setExplode(1, false);
        const moved = model.parts.every((part) => !part.mesh.matrix.equals(part.matrix));
        stage.setExplode(0, false);
        return moved && JSON.stringify(before) === JSON.stringify(model.parts.map((part) => part.mesh.matrix.toArray())) && JSON.stringify(size) === JSON.stringify(model.stats.size.toArray());
      });
      assert(restored, "nested imports preserve exact transforms and dimensions");
      await page.reload();
      await page.waitForFunction(() => window.__mzViewer);
      await page.locator("#fileInput").setInputFiles(new URL("../samples/stl/cube-10x10.stl", import.meta.url).pathname);
      await page.waitForFunction(() => window.__mzViewer.stage.active !== null && document.getElementById("progressWrap").hidden);
      await page.locator("#explodeBtn").tap();
      assert(await page.locator("#explodeHint").isVisible(), "single mesh explanation is accessible on touch");
      assert(await page.locator("#explodeRange").isDisabled(), "single mesh cannot explode");
    }
    console.log(`✓ ${width}×${height}: animated explode, X-ray, entities, restore, edges, NavCube, touch, section, layout`);
    await context.close();
  }
  assert.deepEqual(errors, [], "console and network errors");
  console.log("✓ no console or network errors");
} finally {
  await browser.close();
}
