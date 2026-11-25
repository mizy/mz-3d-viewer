/** Exercise picking, real measurements, scale and clipping against a running viewer. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { openTool } from "./viewerUi.mjs";

const url = process.argv.find((arg) => arg.startsWith("--url="))?.slice(6) ?? "http://127.0.0.1:8899/";
const cube = new URL("../samples/step/cube-10x10.stp", import.meta.url).pathname;
const browser = await chromium.launch({ channel: "chrome", headless: true });

async function facePixels(page, points) {
  return page.evaluate(async (points) => {
    const viewer = window.__mzViewer;
    const image = new Image();
    image.src = await viewer.capture();
    await image.decode();
    const frame = document.createElement("canvas");
    frame.width = image.width;
    frame.height = image.height;
    const ctx = frame.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const point = viewer.stage.camera.position.clone();
    return points.map(([x, y, z]) => {
      const clip = point.set(x, y, z).project(viewer.stage.camera);
      const pixel = ctx.getImageData((clip.x + 1) * frame.width / 2, (1 - clip.y) * frame.height / 2, 1, 1);
      return [...pixel.data].slice(0, 3);
    });
  }, points);
}

async function hoverWorldPoint(page, coordinates) {
  const { x, y } = await page.evaluate((coordinates) => {
    const { stage } = window.__mzViewer;
    const point = stage.camera.position.clone().set(...coordinates).project(stage.camera);
    const view = document.getElementById("view").getBoundingClientRect();
    return { x: view.left + (point.x + 1) * view.width / 2, y: view.top + (1 - point.y) * view.height / 2 };
  }, coordinates);
  await page.mouse.move(x, y);
}

/** Wait for a predicate, but report the assertion's own message instead of a generic timeout. */
async function expectSoon(page, predicate, message, argument = null) {
  try {
    await page.waitForFunction(predicate, argument, { timeout: 5000 });
  } catch {
    assert.fail(message);
  }
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400) errors.push(response.url()); });
  page.on("requestfailed", (request) => errors.push(request.url()));
  await page.goto(url);
  await page.waitForFunction(() => window.__mzViewer !== undefined);
  await page.locator("#fileInput").setInputFiles(cube);
  await page.waitForFunction(() => window.__mzViewer.stage.active?.format === "step" && document.getElementById("progressWrap").hidden);
  const edge = page.getByRole("button", { name: "边线", exact: true });
  assert.equal(await edge.getAttribute("aria-pressed"), "true", "edges start enabled");
  await page.waitForFunction(() => window.__mzViewer.stage.active.edges?.visible &&
    window.__mzViewer.stage.active.edges.children.length > 0);
  await edge.click();
  const faceCenters = await page.evaluate(() => {
    const { stage } = window.__mzViewer;
    stage.setStandardView("iso", false);
    const { min, max } = stage.active.box;
    return ["x", "y", "z"].map((axis) => {
      const point = min.clone().lerp(max, 0.5);
      point[axis] = max[axis];
      return point.toArray();
    });
  });
  const originalPixels = await facePixels(page, faceCenters);
  const faces = originalPixels.map((pixel) => pixel[1]).sort((a, b) => a - b);
  assert(faces[1] - faces[0] >= 12 && faces[2] - faces[1] >= 12, `STEP face contrast: ${faces}`);
  await hoverWorldPoint(page, faceCenters[1]);
  await page.waitForFunction(() => window.__mzViewer.stage.active.appearance.hoveredGeometry !== null);
  const topHover = await facePixels(page, faceCenters);
  assert.deepEqual([topHover[0], topHover[2]], [originalPixels[0], originalPixels[2]]);
  assert(topHover[1][0] - originalPixels[1][0] > 25, "only the pointed CAD face changes color");
  await hoverWorldPoint(page, faceCenters[2]);
  await page.waitForFunction(async (point) => {
    const { stage } = window.__mzViewer;
    const p = stage.camera.position.clone().set(...point).project(stage.camera);
    const view = document.getElementById("view").getBoundingClientRect();
    const hit = await stage.pick(view.left + (p.x + 1) * view.width / 2, view.top + (1 - p.y) * view.height / 2);
    return Boolean(hit && hit.face !== null && hit.mesh.geometry.groups.some(({ start, count, materialIndex }) =>
      materialIndex === 1 && start <= hit.face.start && start + count >= hit.face.start + hit.face.count));
  }, faceCenters[2]);
  const frontHover = await facePixels(page, faceCenters);
  assert.deepEqual(frontHover[1], originalPixels[1], "leaving a face restores it");
  assert(frontHover[2][0] - originalPixels[2][0] > 25);
  await page.mouse.move(200, 120);
  await page.waitForFunction(() => window.__mzViewer.stage.active.appearance.hoveredGeometry === null);
  assert.deepEqual(await facePixels(page, faceCenters), originalPixels);
  console.log("✓ STEP hover highlights only the hit CAD face and restores it on leave");
  await edge.click();
  await page.waitForFunction(() => window.__mzViewer.stage.active.edges?.visible &&
    window.__mzViewer.stage.active.edges.children.length > 0);
  await page.locator(".projection-switch label:has(#projectionOrthographic)").click();
  await page.evaluate(async () => {
    const { stage } = window.__mzViewer;
    stage.setStandardView("front", false);
    await window.__mzViewer.capture();
  });
  assert(await page.evaluate(() => window.__mzViewer.stage.camera.isOrthographicCamera &&
    window.__mzViewer.stage.active.edges.visible));

  const directions = await page.locator(".cube-region").evaluateAll((buttons) => {
    const byKind = { face: new Set(), edge: new Set(), corner: new Set() };
    for (const button of buttons) {
      const kind = ["face", "edge", "corner"].find((kind) => button.classList.contains(kind + "-region"));
      byKind[kind].add(button.dataset.direction);
    }
    return Object.values(byKind).map((directions) => directions.size);
  });
  assert.deepEqual(directions, [6, 12, 8]);
  assert.equal(await page.locator(".cube-region").count(), 26, "each direction has exactly one hit target");
  for (const direction of ["0,1,1", "1,1,1"]) {
    await page.evaluate(() => window.__mzViewer.stage.setStandardView("front", false));
    await page.locator(`.cube-region[data-direction="${direction}"]`).click();
    await page.waitForFunction((expected) => {
      const { stage } = window.__mzViewer;
      const actual = stage.camera.position.clone().sub(stage.controls.target).normalize();
      const direction = actual.clone().set(...expected).normalize();
      return actual.distanceTo(direction) < 1e-5;
    }, direction.split(",").map(Number));
  }
  await page.evaluate(async () => {
    window.__mzViewer.stage.setStandardView("front", false);
    await window.__mzViewer.capture();
  });
  console.log("✓ NavCube offers all 26 directions and clicks snap to edges and corners");

  // The 10 mm STEP cube's front face sits perpendicular to the orthographic camera.
  async function facePoint(u, v) {
    return page.evaluate(([u, v]) => {
      const { stage } = window.__mzViewer;
      const box = stage.active.box;
      const point = box.min.clone().lerp(box.max, 0.5);
      point.x = box.min.x + (box.max.x - box.min.x) * u;
      point.y = box.min.y + (box.max.y - box.min.y) * v;
      point.z = box.max.z;
      point.project(stage.camera);
      const rect = document.getElementById("view").getBoundingClientRect();
      return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
    }, [u, v]);
  }
  async function clickFace(u, v) {
    const { x, y } = await facePoint(u, v);
    await page.mouse.click(x, y);
  }

  const faceCenter = await facePoint(0.5, 0.5);
  await page.mouse.move(faceCenter.x, faceCenter.y);
  await page.waitForFunction(() => {
    const model = window.__mzViewer.stage.active;
    return model.selectedPart === null && model.appearance.hoveredGeometry?.groups.some(
      ({ materialIndex, count }) => materialIndex === 1 && count === 6
    );
  });
  await page.mouse.move(360, 125);
  await page.waitForFunction(() => {
    const { appearance } = window.__mzViewer.stage.active;
    return appearance.surfaces[0].mesh.material === appearance.override.solid;
  });
  await clickFace(0.5, 0.5);
  await expectSoon(page, () => {
    const model = window.__mzViewer.stage.active;
    const mesh = model.parts[0].mesh;
    return model.selectedFace?.count === 6 && model.selectedEdge === null &&
      Array.isArray(mesh.material) && mesh.geometry.groups.some(({ materialIndex, count }) =>
        mesh.material[materialIndex] === model.appearance.highlight && count === 6);
  }, "face selection highlights only the picked CAD face");

  const edgePoint = await facePoint(0, 0.5);
  await page.mouse.move(edgePoint.x, edgePoint.y);
  await expectSoon(page, () => Boolean(window.__mzViewer.stage.hoveredSurface?.edge),
    "a visible edge takes priority over faces");
  await page.mouse.click(edgePoint.x, edgePoint.y);
  await expectSoon(page, () => {
    const { stage } = window.__mzViewer;
    const model = stage.active;
    return model.selectedEdge?.count === 1 && model.selectedFace === null &&
      stage.selectedEdges.get(model.id)?.line?.visible === true &&
      stage.hoveredEdge.line === null && !Array.isArray(model.parts[0].mesh.material);
  }, "edge selection retains the line overlay without highlighting either face");
  await page.mouse.click(360, 125);
  await expectSoon(page, () => window.__mzViewer.stage.active.selectedEdge === null,
    "clicking blank space clears the edge selection");
  console.log("✓ face mode picks a single CAD face or visible edge");

  await page.selectOption("#pickMode", "body");
  await page.mouse.move(faceCenter.x, faceCenter.y);
  await expectSoon(page, () => {
    const model = window.__mzViewer.stage.active;
    return model.parts[0].mesh.material === model.appearance.hover &&
      model.parts[0].mesh.geometry.groups.length === 0;
  }, "body hover paints the whole mesh");
  await clickFace(0.5, 0.5);
  // Picking is answered by the GPU, so a click settles a frame later than the pointerup event.
  await page.waitForFunction(() => window.__mzViewer.stage.active.selectedPart === 0);
  await page.mouse.move(faceCenter.x + 5, faceCenter.y);
  await expectSoon(page, () => {
    const { appearance } = window.__mzViewer.stage.active;
    return appearance.surfaces[0].mesh.material === appearance.highlight;
  }, "selection stays highlighted when hovered again");
  await page.mouse.click(360, 125);
  await page.waitForFunction(() => window.__mzViewer.stage.active.selectedPart === null);
  await openTool(page, "#measureBtn");
  await page.mouse.move(faceCenter.x, faceCenter.y);
  await expectSoon(page, () => {
    const { appearance } = window.__mzViewer.stage.active;
    return appearance.surfaces[0].mesh.material === appearance.override.solid && appearance.hoveredGeometry === null;
  }, "measurement suppresses hover");
  await clickFace(0.01, 0.01);
  await clickFace(0.99, 0.01);
  await page.waitForFunction(() => document.getElementById("measureValue").textContent === "10 mm");
  assert(await page.isVisible("#measureOverlay"));
  await page.selectOption("#measureMode", "angle");
  await clickFace(0.99, 0.01);
  await clickFace(0.01, 0.01);
  await clickFace(0.01, 0.99);
  await page.waitForFunction(() => document.getElementById("measureValue").textContent === "90°");
  await page.click("#measureReset");
  assert(await page.isHidden("#measureOverlay"));
  assert.match(await page.textContent("#scaleBar"), /\d mm/);
  await page.click("#measureClose");
  console.log("✓ hover, selection priority, snapped 10 mm ruler, 90° angle and scale");

  await openTool(page, "#sidebarToggle");
  await page.locator("#sectionDetails > summary").click();
  await page.check("#sectionToggle");
  await page.check("#sectionY");
  await page.click("#sectionFlipY");
  await page.click("#sidebarClose");
  async function canPick(u, v) {
    const { x, y } = await facePoint(u, v);
    return page.evaluate(async ({ x, y }) => (await window.__mzViewer.stage.pick(x, y)) !== null, { x, y });
  }
  assert.equal(await canPick(0.25, 0.75), true);
  assert.equal(await canPick(0.75, 0.75), false);
  assert.equal(await canPick(0.25, 0.25), false);
  console.log("✓ X + reversed Y clipping is respected by canvas picking");

  await page.locator("#fileInput").setInputFiles(new URL("../samples/stl/rack.stl", import.meta.url).pathname);
  await page.waitForFunction(() => window.__mzViewer.stage.modelList.length === 2 && document.getElementById("progressWrap").hidden);
  await openTool(page, "#sidebarToggle");
  await page.uncheck("#sectionToggle");
  await page.check("#lightBackground");
  await page.click("#fitAllBtn");
  assert(await page.evaluate(() => {
    const { stage } = window.__mzViewer;
    const bounds = stage.modelList[0].box.clone().union(stage.modelList[1].box);
    return bounds.getCenter(bounds.min.clone()).distanceTo(stage.controls.target) < 1e-6 &&
      stage.active === stage.modelList[1] && stage.scene.background.getHex() === 0xc4cbd0;
  }), "fit all frames the scene without changing selection");
  assert(await page.isHidden("#scaleBar"), "unknown STL units do not display a physical scale");
  await page.locator(".projection-switch label:has(#projectionPerspective)").click();
  assert(await page.evaluate(() => window.__mzViewer.stage.camera.isPerspectiveCamera &&
    window.__mzViewer.stage.active.edges.visible));
  await edge.click();
  assert(await page.evaluate(() => !window.__mzViewer.stage.active.edges.visible));
  console.log("✓ fit all, light background and scale limited to known units");

  // Two faces have the same surface normal and material. Their depth alone must change the tone.
  await page.click("#brandLink");
  await page.locator("#fileInput").setInputFiles({
    name: "depth-steps.obj",
    mimeType: "model/obj",
    buffer: Buffer.from("v -3 -1 2\nv -1 -1 2\nv -1 1 2\nv -3 1 2\nv 1 -1 -2\nv 3 -1 -2\nv 3 1 -2\nv 1 1 -2\nf 1 2 3 4\nf 5 6 7 8\n")
  });
  await page.waitForFunction(() => window.__mzViewer.stage.active?.format === "obj" && document.getElementById("progressWrap").hidden);
  await page.locator(".projection-switch label:has(#projectionOrthographic)").click();
  await page.evaluate(() => window.__mzViewer.stage.setStandardView("front", false));
  const [near, far] = (await facePixels(page, [[-2, 0, 2], [2, 0, -2]])).map((pixel) => pixel[1]);
  assert(near - far >= 12 && far > 30, `parallel face depth cue: ${near} / ${far}`);
  // Cursor pivot: a left press on geometry marks the rotation centre under the pointer.
  await page.evaluate(async () => {
    window.__mzViewer.stage.setStandardView("front", false);
    await window.__mzViewer.capture();
  });
  const pivotPoint = await facePoint(0.25, 0.5);
  await page.mouse.move(pivotPoint.x, pivotPoint.y);
  await page.mouse.down();
  await page.mouse.move(pivotPoint.x + 70, pivotPoint.y + 24, { steps: 6 });
  await page.waitForTimeout(120);
  const marker = await page.evaluate(({ x, y }) => {
    const element = document.getElementById("pivotGizmo");
    const rect = element.getBoundingClientRect();
    return {
      visible: element.hidden === false && element.classList.contains("is-visible"),
      sizePx: Math.round(rect.width),
      offsetPx: Number(Math.hypot(rect.left + rect.width / 2 - x, rect.top + rect.height / 2 - y).toFixed(1))
    };
  }, pivotPoint);
  await page.mouse.up();
  assert(marker.visible, "a left press shows the rotation-centre marker");
  assert.equal(marker.sizePx, 26, "the marker is a constant 26 CSS pixels");
  assert(marker.offsetPx < 2, `the marker sits on the pressed point (${marker.offsetPx}px)`);
  await page.waitForFunction(() => document.getElementById("pivotGizmo").hidden === true, null, { timeout: 5000 });
  console.log("✓ cursor pivot marker follows the press and fades out on its own");

  await page.click("#brandLink");
  await page.locator("#fileInput").setInputFiles(indexedInstances());
  await page.waitForFunction(() => window.__mzViewer.stage.active?.format === "gltf" &&
    document.getElementById("progressWrap").hidden);
  const instances = await page.evaluate(async () => {
    const { stage, capture } = window.__mzViewer;
    stage.setStandardView("front", false);
    await capture();
    const mesh = stage.active.parts[0].mesh;
    const rect = stage.renderer.domElement.getBoundingClientRect();
    const hitAt = (x, y, snap) => {
      const point = mesh.position.clone().set(x, y, 0).applyMatrix4(mesh.matrixWorld).project(stage.camera);
      return stage.pick(rect.left + (point.x + 1) * rect.width / 2,
        rect.top + (1 - point.y) * rect.height / 2, { exact: true, snap });
    };
    const left = await hitAt(-2, 0, false);
    const empty = await hitAt(0, 0, false);
    const right = await hitAt(2, 0, false);
    // Two CSS pixels or less from the indexed triangle's top vertex.
    const snapped = await hitAt(2, 0.49, true);
    return {
      leftX: left?.localPoint?.x, rightX: right?.localPoint?.x, empty: empty === null,
      index: snapped?.triangleIndex, vertex: snapped?.localPoint?.toArray()
    };
  });
  assert(instances.leftX < -1.99 && instances.rightX > 1.99 && instances.empty, JSON.stringify(instances));
  assert.equal(instances.index, 0, "the indexed snap pass returns the hit triangle");
  assert.deepEqual(instances.vertex, [2, 0.5, 0], "snap preserves the selected instance transform");
  console.log("✓ glTF indexed instances use their visible positions, including the snapped vertex");

  await page.click("#brandLink");
  await page.evaluate(() => window.__mzViewer.stage.setDisplayStyle("edges"));
  await page.locator("#fileInput").setInputFiles(new URL("../samples/step/conical-surface.step", import.meta.url).pathname);
  await page.waitForFunction(() => window.__mzViewer.stage.active?.edges?.visible);
  await page.selectOption("#pickMode", "face");
  const curve = await page.evaluate(async () => {
    const { stage, capture } = window.__mzViewer;
    stage.setStandardView("iso", false);
    await capture();
    const rect = stage.renderer.domElement.getBoundingClientRect();
    for (const line of stage.active.edges.children) {
      const start = line.geometry.getAttribute("instanceStart");
      const end = line.geometry.getAttribute("instanceEnd");
      const point = stage.controls.target.clone();
      for (let i = 0; i < start.count; i += Math.max(1, Math.floor(start.count / 50))) {
        point.set((start.getX(i) + end.getX(i)) / 2, (start.getY(i) + end.getY(i)) / 2,
          (start.getZ(i) + end.getZ(i)) / 2).applyMatrix4(line.matrixWorld).project(stage.camera);
        const x = rect.left + (point.x + 1) * rect.width / 2;
        const y = rect.top + (1 - point.y) * rect.height / 2;
        const hit = await stage.pick(x, y, { inspect: true });
        if (hit?.edge?.count > 1) return { x, y, count: hit.edge.count };
      }
    }
    return null;
  });
  assert(curve !== null, "the conical STEP fixture has a pickable multi-segment edge");
  await page.mouse.click(curve.x, curve.y);
  await expectSoon(page, (count) => window.__mzViewer.stage.active.selectedEdge?.count === count,
    "clicking a curved edge selects all of its segments", curve.count);
  console.log(`✓ curved CAD edge selects all ${curve.count} tessellated segments`);

  assert.deepEqual(errors, []);
  console.log(`✓ gray shading: STEP face tones ${faces.join(" / ")}; parallel faces ${near} / ${far}`);
} finally {
  await browser.close();
}


function indexedInstances() {
  const positions = Float32Array.of(-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0);
  const translations = Float32Array.of(-2, 0, 0, 2, 0, 0);
  const indices = Uint16Array.of(0, 1, 2);
  const buffer = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(translations.buffer), Buffer.from(indices.buffer)]);
  const document = {
    asset: { version: "2.0" },
    extensionsUsed: ["EXT_mesh_gpu_instancing"],
    extensionsRequired: ["EXT_mesh_gpu_instancing"],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } } }],
    meshes: [{ primitives: [{ indices: 2, attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: buffer.length, uri: `data:application/octet-stream;base64,${buffer.toString("base64")}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: translations.byteLength },
      { buffer: 0, byteOffset: positions.byteLength + translations.byteLength, byteLength: indices.byteLength }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] },
      { bufferView: 1, componentType: 5126, count: 2, type: "VEC3", min: [-2, 0, 0], max: [2, 0, 0] },
      { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" }
    ]
  };
  return { name: "indexed-instances.gltf", mimeType: "model/gltf+json", buffer: Buffer.from(JSON.stringify(document)) };
}
