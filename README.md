# mz-3d-viewer

WebGPU-first PWA for looking at 3D models: **STL, OBJ, glTF/GLB, 3MF, STEP/IGES/BREP**.

Online: <https://mizy.github.io/mz-3d-viewer/>

Everything runs in the browser. Model files are never uploaded — there is no backend at all,
just static files, which is also what makes the offline install work.

## Run it

```bash
pnpm install
pnpm dev              # http://localhost:8899
pnpm build            # vite build + dist/sw.js (precache manifest + build hash)
pnpm serve:dist       # serve dist/ exactly like GitHub Pages (static, cache-control: max-age=600)
pnpm build:pkg        # library build: dist-lib/ (ESM + .d.ts + occt/ assets)
pnpm verify:package   # drives dist-lib through STEP / 3MF / STL in real Chrome
pnpm verify           # built-site acceptance run in real Chrome
pnpm verify:tools     # touch, NavCube and explode checks against the running dev server
pnpm verify:inspection # canvas picking, measurement, scale and clipping
pnpm verify:loading   # import resources, cancellation, edge workers and idle rendering
pnpm verify:launch    # OS file-handle launches and failure handling against a running site
pnpm samples:3mf      # regenerate the committed 3MF samples (millimetre + inch)
pnpm typecheck
```

`pnpm verify` needs a Chrome with WebGPU (macOS/Windows Chrome 113+). It serves the build at a
sub-path (`/mz-3d-viewer/`) so the GitHub Pages layout is what gets tested. Flags: `--headless`,
`--base=/`.

## Use it as a package

The same source ships two ways: the app (`pnpm build` → `dist/`) and a library (`pnpm build:pkg` →
`dist-lib/`). The library exports the parsers, an embeddable viewer, and the switch for where the
OpenCascade assets live.

```ts
import { configureCadAssets, createModelViewer } from "mz-3d-viewer";

// Optional: the default is the occt/ directory shipped next to the package entry.
configureCadAssets({ baseUrl: "/static/mz-occt/" });

const viewer = await createModelViewer(canvas, { quality: "standard", edges: true });
await viewer.load(fileInput.files[0]);   // STEP / IGES / BREP / 3MF / STL / OBJ / glTF
```

Headless, when the geometry only has to land in your own scene:

```ts
import { parseModel } from "mz-3d-viewer";

const { root, sourceUnit, warnings } = await parseModel(file, { quality: "fine" });
// sourceUnit.mmPerUnit is 1 for STEP/IGES, the declared factor for 3MF, null when unknown.
scene.add(root);
```

- `three` is a peer dependency for the viewer. The edge worker bundles the geometry code it runs
  in its own thread, and its three.js license ships in `dist-lib/LICENSE.three.txt`.
- The OpenCascade worker and wasm (7.3MB, the price of STEP/IGES/BREP) ship in the tarball under
  `occt/`. If your bundler does not serve package assets, copy that directory into your static root
  and point `configureCadAssets` at it.
- Exports: `parseModel`, `parseFiles`, `detectFormat`, `ACCEPTED_EXTENSIONS`, `CAD_QUALITY_PRESETS`,
  `configureCadAssets`, `createModelViewer`, plus the `ParsedModel`, `ProgressReporter`,
  `DisplayStyle` and `CadQuality` types.

## Open models from Finder

Install the viewer with Chrome or Edge. In Finder, select a `.stl`, `.step` or `.stp` file,
choose **Get Info → Open with → 3D 查看器 → Change All**, and confirm. Repeat for each file
type if needed. The browser may ask for permission the first time it opens a file. If the app
was installed before this support was available, update or reinstall it if it is not offered
as an opener. Safari web apps do not currently support this file-handling API.

## Viewer controls

The canvas always fills the screen, including while a panel is open. The floating dock keeps
Edges, Fit and Tools within reach. Tools opens Parts, Material, Explode, Measure or Scene Settings.
On phones, Scene Settings opens as a bottom sheet (swipe the heading down to close).

- **NavCube:** tap a face, beveled edge or corner for one of 26 view directions. Each bevel is a single target. Drag to rotate directly. Reduced-motion preferences skip the transition. Keyboard: arrows rotate, 1–6 select front/back/left/right/top/bottom, Home selects isometric.
- **Axis triad:** the cube carries the axes itself — the three edges of the corner nearest the eye turn into X/Y/Z (red/green/blue, letters at the tips) and swap corner as the camera turns. A face-on view collapses whichever axis points at you into a dot, and the cube's own white edges are what the coloured arms land on: the overlay is projected with the same CSS perspective the cube is drawn with, so they coincide exactly and no second GPU canvas is needed.
- **Projection:** use 正交 (Orthographic) or 透视 (Perspective) under the NavCube. Orthographic keeps parallel geometry parallel. The switch preserves the camera pose and the scale at the focal point, and the choice is remembered across reloads.
- **Camera model:** the sidebar picks between 轨道 Orbit (target-locked, poles clamped), 旋转球 Arcball (no polar clamp, unlimited flipping) and 轨迹球 Trackball (free rolling, closest to a traditional CAD feel). All three work in either projection and share framing, section, NavCube and screenshot behaviour; the choice is remembered too.
- **Cursor pivot:** pressing the left button on a part makes the point under the cursor the centre of the next rotation, so the part stays put while the rest swings — UVF's cursor point. Pressing empty space, the NavCube, or a framing action goes back to the framed centre. The camera is not moved when the pivot changes: the host re-expresses whatever the controller rotated as a rotation about that point, which is why a press never shifts the image. A crosshair marker (26 CSS px, DOM overlay so it stays crisp on retina) sits on the centre while you rotate and fades a moment after the last rotation.
- **Right-click menu:** fit all / fit this part, hide, isolate, hide the model, show everything, reset the view (isometric + fit), and the four display modes, on the part under the pointer. It opens on right-button release so a right-drag still pans the camera.
- **Home:** the MZ logo (top-left) clears the scene and returns to the landing state in place, without a reload; the anchor keeps its `href`, so ⌘/middle click still opens a clean copy. It carries a full 44px target with hover feedback.
- **Grid:** off on first load. The sidebar switch or `g` turns the floor grid on.
- **Environment:** a studio environment map painted in code (no HDR to download, still offline) lights the scene and gives glass, paint and chrome something to reflect. Without it a window is effectively invisible: a dielectric reflects about 4%, so the glass only shows the cabin behind it. The sidebar switch turns it off for flat, light-only shading.
- **Open files:** the picker, or a drop anywhere in the window — top bar, dock and nav cube included. A file drag is announced over the whole window, cancels the browser's own "open this file" default, and closes the workspace panel so the drop target stays visible.
- **Explode:** first opening animates to 50%. Slider changes and fully separated / reassemble use a 400ms transition with matching camera framing; reopening preserves the chosen value. Offsets belong to the active model, edge lines follow the parts, and dimensions retain their assembled values.
- **Display and material:** models open with Edges enabled. The dock's 边线 button toggles edges on and off; the 显示 button opens the four CAD modes (实体 / 边线 / 线框 / 透射), which are also in the right-click menu and cycle with `w`. Edges are
  screen-space quads (`Line2NodeMaterial`), so the width slider under 边线粗细 is real CSS pixels
  (2 by default, retina-aware: the material divides by `viewport / pixelRatio` itself) rather than
  the one-pixel hairline the GPU gives `LineBasicMaterial`; a negative polygon offset puts them in
  front of the faces they belong to instead of fighting with them. Models open in neutral gray with directional lighting and a small
  depth cue in the surface shader. Material presets apply to the active model. Choose Original to see
  the file's colors and textures.
- **Picking and framing:** hover previews the nearest visible CAD face in amber. A dedicated pick
  pass renders the scene into an id buffer once per camera or scene change; each pointer move then
  reads one pixel of it, so hover costs a fraction of a millisecond instead of a full triangle
  raycast. Clicking or measuring reuses that id and raycasts only the mesh it named, which keeps the
  measured point exact. Formats without CAD faces highlight the mesh under the pointer. Click to
  select a part or double-click to frame it. Choose Fit All in the workspace or press Shift+F to
  frame the visible scene.
- **Measurement:** use Measure for two points (distance) or three points (angle at the middle point). Enable vertex snapping to pick nearby mesh vertices. Distances follow the display unit when the model's scale is known. Orthographic views then show a scale bar.
- **Section:** enable one or more of X, Y and Z. Set each plane's position and reverse its kept side independently.
- **Background:** toggle a light background in the workspace when inspecting dark models.
- **Entities:** search parts by their imported names, select/highlight, hide/show, isolate, restore all or frame a part. The panel overlays the canvas without resizing the view.
- **Idle rendering:** scene changes and input schedule a frame. Inertia and transitions request more frames until they settle. The viewer stops drawing and updating camera controls while idle.
- **Cancellation:** cancelling a CAD import terminates its worker immediately. Edge calculations also run in a worker, share one pending task per model, and stop when the display mode or edge angle changes.
- **Parts:** independent mesh roots from the imported hierarchy. A single-mesh STL cannot be split into semantic components. No geometry is modified or guessed apart.
- **Demo:** “体验装配示例” opens an 11-part local procedural assembly.
- **Touch:** one finger rotates, two fingers pan/pinch. Mobile rendering caps pixel density at 1.5; framing accounts for narrow viewports.

`pnpm verify:tools --url=http://localhost:8901/` can also test a running production preview.
It covers four viewport sizes, actual touch events, exact reassembly under nested transforms,
edge alignment, six cube faces, single-mesh handling and console/network errors. Every camera
model gets its own pass: cube faces, the first drag after a scripted view (a controller that
rebuilds the pose from a cached matrix snaps back instead of continuing), touch rotate, pinch,
and the sidebar picks surviving a reload. Orthographic gets its own pass: the framing has to keep
its screen size, the cube faces still land exactly, and the wheel changes the zoom rather than the
camera distance. It also pins the cube's axis edges per standard view
(horizontal/vertical arms, and the axis facing the eye collapsing to a dot), checks the brand
returns to the landing state, that the floor grid starts hidden, and drops a file on the top bar,
the dock and the body to prove the browser default is cancelled everywhere.

## Architecture

| Path | Owns |
|------|------|
| `src/main.ts` | boot order: renderer → stage → UI → PWA registration |
| `src/renderer/createRenderer.ts` | WebGPU-first renderer, reports which backend actually ran, `?webgl=1` forces the WebGL2 fallback |
| `src/viewer/stage.ts` | scene graph, camera, lights, grid, display modes, section, screenshot, render loop |
| `src/viewer/environment.ts` | the procedural studio environment: glass and metal need something to reflect, and an HDR would cost an offline download |
| `src/viewer/controller.ts` | camera navigation models (orbit / arcball / trackball) behind one contract, swapped in place |
| `src/loaders/*.ts` | one parser per format family, all returning `ParsedModel { root, warnings }` |
| `src/loaders/three-mf.ts` | 3MF packages: three's loader for geometry/materials, plus the unit the package declares |
| `src/loaders/step.ts` + `public/wasm/occt/step-worker.js` | OpenCascade wasm in a classic worker (7.6MB, never on the main thread) |
| `src/viewer/explode.ts` | independent mesh discovery, original matrices and parent-local separation offsets; consumed by `Stage` |
| `src/viewer/appearance.ts` | original mesh materials, X-ray and selection overrides; owned by each stage model |
| `src/viewer/dispose.ts` | releases model geometry, materials, textures and ImageBitmaps; shared by removal and cancelled imports |
| `src/viewer/edges/` | typed worker protocol, transferable copies and edge buffers shared by repeated mesh instances |
| `src/viewer/rendering/frameScheduler.ts` | coalesces on-demand scene frames for `Stage` |
| `src/viewer/rendering/inspectionLighting.ts` | key and fill lights and a view-space depth cue for preset materials |
| `src/viewer/inspection/` | surface picking contracts and pure distance, angle and scale calculations |
| `src/viewer/picking/` | proxy id scene, cached colour-buffer pick pass, one-pixel read-back; the GPU half of hover and selection |
| `src/loaders/files.ts` | OBJ/glTF companion resolution, waiting for dependencies and releasing temporary object URLs |
| `src/lib/` | the published surface: `parseModel` / `parseFiles`, the embeddable `createModelViewer`, and the package entry |
| `src/cadAssets.ts` | where the OpenCascade worker and wasm are loaded from; the app points it at `wasm/occt/`, the package defaults to its own `occt/` |
| `src/ui/entities.ts` | named part list and inspection controls; initialized by `createApp` |
| `src/viewer/pivotGizmo.ts` | screen-space crosshair on the rotation centre; a DOM overlay because WebGPU points are one pixel and sprites would need per-frame scale math |
| `src/ui/contextMenu.ts` | right-click actions on the part under the pointer; opens on right-button release so a right-drag stays a pan |
| `src/viewer/demo.ts` | procedural sample assembly used by the empty-state demo button |
| `src/ui/navCube.ts` | camera-synced CSS cube, the X/Y/Z edges it carries (projected with the cube's own perspective), and pointer/keyboard navigation; initialized by `createApp` |
| `src/ui/app.ts` | DOM wiring only: files (picker and window-wide drops), list, settings, progress, stats, test hooks |
| `src/pwa/register.ts` | service worker registration + update reload + OS file handlers |
| `src/pwa/cadEngineWarm.ts` | page-driven download of the 7.6MB OpenCascade engine into the SW cache, verified byte-for-byte, skipped when already cached |
| `scripts/write-sw.mjs`, `scripts/sw-template.js` | build-time precache manifest (shell + decoders cached at install, engine cached on first use) |

Parsing contract: every loader returns `ParsedModel` (an `Object3D` root plus warnings). The stage
only knows how to add/remove/frame that shape — it has no per-format branches.

`window.__mzViewer` exposes `{ stage, backend, capture(), summary() }` for the acceptance run and for
debugging a live deployment.

## Verification

`pnpm verify` prints its check results; all of them run against a real Chrome and the built site served at
`/mz-3d-viewer/` (the Pages layout, relative asset paths and SW scope included). It covers: backend
detection, every file format, render output measured against a model-hidden baseline frame, edge /
wireframe / section / view / unit switches, model list operations, manifest + worker + cache contents,
and offline behaviour after `Network.clearBrowserCache` — the HTTP cache is wiped first on purpose,
because GitHub Pages' `cache-control: max-age=600` otherwise makes "offline" pass without a service
worker at all.

Run the same suite against the deployment: `node scripts/verify-site.mjs --url=https://mizy.github.io/mz-3d-viewer/`（远程模式自动把超时放宽 4 倍）。

`pnpm verify:loading --url=http://localhost:8901/` runs the import regressions against a built preview.
It checks external glTF BIN/PNG files, OBJ/glTF object URL cleanup, texture and ImageBitmap disposal,
immediate CAD worker cancellation, a 120,000-triangle STL's edge worker responsiveness, rapid edge
retargets, stable entity rows, stationary rendering and simultaneous screenshot requests. The built-site
suite also seeds another app's caches and verifies that service-worker activation preserves them.

## Format notes

- **STL** — ASCII and binary, normals taken from the file when present.
- **OBJ** — drop `.obj` + `.mtl` + textures together; companion files are resolved by basename through a
  `LoadingManager` URL modifier. Without an `.mtl` the mesh still loads and a warning says so.
- **3MF** — a ZIP/OPC package read with three's bundled fflate (no extra dependency): core geometry,
  components, base materials, textures and vertex colours, plus beam lattices. The `unit` the package
  declares (or its millimetre default) is applied to the model, because three's loader only stores
  that attribute. The source-unit label distinguishes declared, default and unreadable units.
- **glTF/GLB** — Draco and meshopt decoders ship through three's `new URL(..., import.meta.url)` assets;
  KTX2 compressed textures depend on the backend supporting them and warn instead of failing the load.
  glTF's metre coordinates are converted to millimetres for the scene and dimensions.
- **STEP / IGES / BREP** — tessellated by OpenCascade. Quality preset (快速 / 标准 / 精细) controls
  `linearDeflection`/`angularDeflection`; large assemblies want 快速. STEP/IGES output is explicitly
  millimetres. BREP has no reliable unit declaration. Import progress is only reported where it can be
  measured — file read bytes, engine download bytes, mesh marshalling — because `ReadStepFile` is one
  blocking wasm call with no progress callback: that stage shows an indeterminate sweep plus elapsed
  seconds instead of an invented percentage.

## Known limits

- glTF files that reference external `.bin`/textures by relative path only work when those files are
  opened together with the `.gltf` (there is no server directory to fetch siblings from).
- Units: STL, OBJ and BREP do not provide reliable source units. Their bounding boxes show file
  coordinates until the user sets a source unit for that model, which rescales its scene geometry
  and dimensions. The separate display-unit selector only changes the readout.
- Section view clips without capping the cut, so a hollow part shows its interior.
- The OpenCascade engine is a one-time 7.6MB download (cached per build, then available offline).
  The sidebar footer reports its state; on a slow link the first STEP file is slow, later ones are not.
- KTX2 textures on the WebGL2 fallback backend depend on `KTX2Loader.detectSupport` succeeding; the
  failure path is a visible warning, not a silent blank surface.

## Deployment

`.github/workflows/deploy.yml` builds on every push to `main`, typechecks, and publishes `dist/`
through GitHub Pages (Pages source = GitHub Actions, no build output committed). Assets use relative
URLs, so the site works from `/` and from `/<repo>/` without a rebuild. The sidebar shows the build
hash; compare it with the newest commit when investigating "I still see the old version" reports —
the service worker plus Pages' fixed `cache-control: max-age=600` are the usual suspects.
Service-worker cache names include the site's scope; activation only removes older caches with that
same scope, preserving other applications hosted on the same origin.

## License

MIT — see `LICENSE`. Bundled third-party components keep their own terms: OpenCascade Technology,
compiled through `occt-import-js` and shipped as a WebAssembly module under `occt/`, is LGPL-2.1 with
the Open CASCADE exception. Both licence texts travel with the package
(`occt/license.occt.txt`, `occt/license.occt-import-js.txt`). The module is replaceable via
`configureCadAssets`. Its corresponding source and build instructions are in
[occt-import-js 0.0.23](https://github.com/kovacsv/occt-import-js/tree/c2148e54b456b571238d35cac037d304053d64b2).
