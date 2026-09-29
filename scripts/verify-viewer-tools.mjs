/** Interaction acceptance: real GPU rendering, model transforms, touch and narrow layouts.
 * Usage: node scripts/verify-viewer-tools.mjs [--url=http://localhost:8899/]
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
const url = process.argv.find((arg) => arg.startsWith("--url="))?.slice(6) ?? "http://localhost:8899/";
const stlBase64 = readFileSync(new URL("../samples/stl/cube-10x10.stl", import.meta.url)).toString("base64");
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

    // The floor grid starts hidden; the sidebar switch and `g` are the only ways to show it.
    assert.equal(await page.evaluate(() => window.__mzViewer.summary().gridVisible), false, "floor grid starts hidden");
    await page.keyboard.press("g");
    assert.equal(await page.evaluate(() => window.__mzViewer.summary().gridVisible), true, "g shows the floor grid");
    await page.keyboard.press("g");
    assert.equal(await page.evaluate(() => window.__mzViewer.summary().gridVisible), false, "g hides it again");

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
      return window.__mzViewer.stage.style === "xray" && model.appearance.surfaces.every(({ mesh }) => mesh.material.transparent && !mesh.material.depthWrite && mesh.material.opacity <= 0.3);
    }), "X-ray shows translucent surfaces");
    await page.locator("#entitiesBtn").tap();
    await page.locator(".entity-name").tap();
    await page.locator("#clearPartBtn").tap();
    // X-ray materials are per imported material (colors are preserved), so the restored material
    // is the one looked up in `appearance.xray` rather than a single shared material.
    assert(await page.evaluate(() => {
      const appearance = window.__mzViewer.stage.active.appearance;
      return appearance.surfaces.every(({ mesh, material }) => (Array.isArray(material) ? material : [material])
        .every((original, index) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material])[index] === appearance.xray.get(original)));
    }), "clearing X-ray selection restores X-ray");
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

    // The triad rides on the cube: the three edges of the corner nearest the eye are the axes, so a
    // face-on view collapses whichever axis points at the viewer into a dot.
    const axisArm = (axis) => page.evaluate((axis) => {
      const overlay = document.querySelector("#navCube .axis-overlay");
      const edge = overlay.querySelector(`.axis-edge.axis-${axis}`);
      const dot = overlay.querySelector(`.axis-dot.axis-${axis}`);
      return {
        dx: Number(edge.getAttribute("x2")) - Number(edge.getAttribute("x1")),
        dy: Number(edge.getAttribute("y2")) - Number(edge.getAttribute("y1")),
        shown: edge.getAttribute("opacity") !== "0",
        dot: dot.getAttribute("opacity") === "1"
      };
    }, axis);
    const horizontal = (arm) => arm.shown && Math.abs(arm.dy) < 2 && Math.abs(arm.dx) > 20;
    const vertical = (arm) => arm.shown && Math.abs(arm.dx) < 2 && Math.abs(arm.dy) > 20;
    assert(await page.evaluate(() => document.getElementById("axisGizmo") === null && document.querySelector("#navCube .axis-overlay") !== null), "the triad is merged into the cube");
    await page.locator("#navCube").press("1");
    await page.waitForTimeout(60);
    const frontArms = { x: await axisArm("x"), y: await axisArm("y"), z: await axisArm("z") };
    assert(horizontal(frontArms.x) && vertical(frontArms.y), "front view runs X and Y along the square's edges");
    assert(!frontArms.z.shown && frontArms.z.dot, "front view collapses the Z axis into a dot");
    await page.locator("#navCube").press("5");
    await page.waitForTimeout(60);
    const topArms = { x: await axisArm("x"), y: await axisArm("y"), z: await axisArm("z") };
    assert(horizontal(topArms.x) && vertical(topArms.z), "top view runs X and Z along the square's edges");
    assert(!topArms.y.shown && topArms.y.dot, "top view collapses the Y axis into a dot");
    console.log("  ✓ the cube's corner edges carry the axes");
    await page.locator("#navCube").press("3");

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

    // Every controller must honour the same framing, NavCube and gesture contract.
    if (width === 1440) {
      const direction = () => page.evaluate(() => {
        const stage = window.__mzViewer.stage;
        return stage.camera.position.clone().sub(stage.controls.target).normalize().toArray();
      });
      for (const kind of ["arcball", "trackball"]) {
        await page.evaluate((value) => window.__mzViewer.setController(value), kind);
        assert.equal(await page.evaluate(() => window.__mzViewer.summary().controller), kind, `${kind} is the active controller`);

        for (const [key, axis, sign] of [["1", "z", 1], ["2", "z", -1], ["3", "x", -1], ["4", "x", 1], ["5", "y", 1], ["6", "y", -1]]) {
          await page.locator("#navCube").press(key);
          await page.waitForFunction(({ axis, sign }) => {
            const stage = window.__mzViewer.stage;
            return stage.camera.position.clone().sub(stage.controls.target).normalize()[axis] * sign > 0.99999;
          }, { axis, sign });
          const face = await direction();
          assert(face[["x", "y", "z"].indexOf(axis)] * sign > 0.99, `${kind} cube face ${key}`);
        }

        // The first drag after a scripted view must continue from that view. A controller that
        // rebuilds the pose from a cached matrix instead snaps back to the pre-script pose, which
        // here would be the bottom view rather than the front one.
        await page.locator("#navCube").press("1");
        await page.waitForFunction(() => {
          const stage = window.__mzViewer.stage;
          return stage.camera.position.clone().sub(stage.controls.target).normalize().z > 0.99999;
        });
        const canvasBox = await page.locator("#view").boundingBox();
        const originX = canvasBox.x + canvasBox.width / 2, originY = canvasBox.y + canvasBox.height / 2;
        await page.mouse.move(originX, originY);
        await page.mouse.down();
        await page.mouse.move(originX + 34, originY + 14, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(350);
        const dragged = await direction();
        assert(dragged[2] > 0.9, `${kind} drag continues from the scripted view, not a stale cached pose`);
        assert(dragged[2] < 0.9999, `${kind} drag rotates the camera`);

        const beforeTouch = await page.evaluate(() => window.__mzViewer.stage.camera.position.toArray());
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: width / 2, y: height * 0.43, id: 0 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: width / 2 + 60, y: height * 0.43 + 25, id: 0 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(250);
        assert.notDeepEqual(await page.evaluate(() => window.__mzViewer.stage.camera.position.toArray()), beforeTouch, `${kind} single finger rotate`);

        const radius = await page.evaluate(() => window.__mzViewer.stage.camera.position.distanceTo(window.__mzViewer.stage.controls.target));
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: width / 2 - 20, y: height * 0.43, id: 0 }, { x: width / 2 + 20, y: height * 0.43, id: 1 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: width / 2 - 60, y: height * 0.43, id: 0 }, { x: width / 2 + 60, y: height * 0.43, id: 1 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(250);
        assert(await page.evaluate(() => window.__mzViewer.stage.camera.position.distanceTo(window.__mzViewer.stage.controls.target)) < radius, `${kind} pinch zoom`);
        console.log(`  ✓ ${kind}: cube faces, post-script drag, touch rotate, pinch`);
      }
      await page.evaluate(() => window.__mzViewer.setController("orbit"));
    }

    await page.locator("#sidebarToggle").tap();
    await page.locator("#sectionDetails summary").tap();
    await page.locator("#sectionToggle").check();
    await page.locator("#sectionAxisSelect").selectOption("y");
    assert(await page.evaluate(() => window.__mzViewer.stage.scene.children.some((child) => child.isClippingGroup && child.clippingPlanes.length === 1)), "exploded section plane");
    await page.locator("#sectionToggle").uncheck();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#settingsPanel").isVisible(), false, "Escape closes modal");
    assert(await page.evaluate(() => [...document.querySelectorAll(".dock-btn, #openBtn, .brand")].every((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.height >= 44 && rect.bottom <= innerHeight;
    })), "touch controls fit the viewport");
    await page.locator("#sidebarToggle").tap();
    await page.locator('#modelList button[title="移除"]').tap();
    await page.locator("#sidebarClose").tap();
    assert(await page.locator("#demoBtn").isVisible(), "empty state after removal");

    if (width === 1440) {
      // A file dropped anywhere in the window has to load: without a window-level preventDefault
      // the browser's own "open this file" default replaces the viewer instead.
      const dragDispatch = (selector, types) => page.evaluate(({ selector, types, b64 }) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([Uint8Array.from(atob(b64), (character) => character.charCodeAt(0))], "cube-10x10.stl", { type: "model/stl" }));
        const target = selector === "window" ? window : document.querySelector(selector);
        return types.map((type) => {
          const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
          target.dispatchEvent(event);
          return event.defaultPrevented;
        });
      }, { selector, types, b64: stlBase64 });

      await page.locator("#sidebarToggle").tap();
      await dragDispatch("window", ["dragenter"]);
      await page.waitForTimeout(80);
      assert.equal(await page.locator("#settingsPanel").isVisible(), false, "dragging files in closes the workspace panel");
      assert.equal(await page.locator("#dragOverlay").isVisible(), true, "the drop target covers the whole window");
      await dragDispatch("window", ["dragleave"]);
      await page.waitForTimeout(80);
      assert.equal(await page.locator("#dragOverlay").isVisible(), false, "leaving the window clears the drop target");

      for (const selector of ["header", ".tool-dock", "body"]) {
        const before = await page.evaluate(() => window.__mzViewer.stage.modelList.length);
        const prevented = await dragDispatch(selector, ["dragenter", "dragover", "drop"]);
        assert(prevented.every(Boolean), `a drop on ${selector} cancels the browser default`);
        await page.waitForFunction((count) => window.__mzViewer.stage.modelList.length > count, before);
        await page.waitForFunction(() => document.getElementById("progressWrap").hidden);
      }
      assert.equal(await page.evaluate(() => window.__mzViewer.stage.modelList.length), 3, "drops outside the canvas load the file");
      console.log("  ✓ dropping a file anywhere in the window loads it");

      // The picker is the real UI path, and the choice is meant to outlive a reload.
      await page.locator("#sidebarToggle").tap();
      await page.locator("#cameraDetails summary").tap();
      await page.locator("#controllerSelect").selectOption("arcball");
      assert.equal(await page.evaluate(() => window.__mzViewer.summary().controller), "arcball", "sidebar pick switches the controller");
      await page.keyboard.press("Escape");
      await page.reload();
      await page.waitForFunction(() => window.__mzViewer !== undefined);
      assert.equal(await page.evaluate(() => window.__mzViewer.summary().controller), "arcball", "controller choice survives a reload");
      await page.locator("#sidebarToggle").tap();
      await page.locator("#cameraDetails summary").tap();
      assert.equal(await page.locator("#controllerSelect").inputValue(), "arcball", "select reflects the remembered controller");
      await page.locator("#controllerSelect").selectOption("orbit");
      await page.keyboard.press("Escape");
      console.log("  ✓ controller pick is remembered across a reload");

      // The brand is the in-app way home: no reload, and the model does not need re-opening.
      await page.locator("#demoBtn").tap();
      await page.waitForFunction(() => window.__mzViewer.stage.active?.parts.length === 11);
      await page.locator("#entitiesBtn").tap();
      assert.equal(await page.locator("#entitiesPanel").isVisible(), true, "part panel is open before going home");
      await page.locator(".brand").tap();
      assert.equal(await page.evaluate(() => window.__mzViewer.stage.modelList.length), 0, "brand clears the scene");
      assert.equal(await page.locator("#dropHint").isVisible(), true, "brand returns to the landing state");
      assert.equal(await page.locator("#navigation").isVisible(), false, "navigation hides with no model");
      assert.equal(await page.locator("#entitiesPanel").isVisible(), false, "part panel closes with no model");
      assert.equal(await page.locator("#openBtn").isVisible(), true, "opening works again from the landing state");
      console.log("  ✓ brand returns to the landing state");
    }

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

      // A phone swaps the controller too, after the viewport has already been resized.
      await page.evaluate(() => window.__mzViewer.setController("arcball"));
      const phoneBefore = await page.evaluate(() => window.__mzViewer.stage.camera.position.toArray());
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: width / 2, y: height * 0.43, id: 0 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: width / 2 + 44, y: height * 0.43 + 30, id: 0 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(250);
      assert.notDeepEqual(await page.evaluate(() => window.__mzViewer.stage.camera.position.toArray()), phoneBefore, "narrow viewport rotates with the arcball controller");
      await page.evaluate(() => window.__mzViewer.setController("orbit"));
    }
    console.log(`✓ ${width}×${height}: animated explode, X-ray, entities, restore, edges, NavCube, touch, section, layout`);
    await context.close();
  }
  assert.deepEqual(errors, [], "console and network errors");
  console.log("✓ no console or network errors");
} finally {
  await browser.close();
}
