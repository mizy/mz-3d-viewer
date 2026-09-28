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
pnpm verify           # built-site acceptance run in real Chrome
pnpm verify:tools     # touch, NavCube and explode checks against the running dev server
pnpm samples:3mf      # regenerate the committed 3MF samples (millimetre + inch)
pnpm typecheck
```

`pnpm verify` needs a Chrome with WebGPU (macOS/Windows Chrome 113+). It serves the build at a
sub-path (`/mz-3d-viewer/`) so the GitHub Pages layout is what gets tested. Flags: `--headless`,
`--base=/`.

## Viewer controls

The canvas fills the screen. The floating dock opens the workspace, cycles display modes,
separates assembly parts and fits the model. Advanced settings live in a native dialog;
on phones it opens as a bottom sheet (swipe the heading down to close).

- **NavCube:** tap a face for a 400ms eased camera/cube transition, or drag to take over immediately. Reduced-motion preferences skip the animation. Keyboard: arrows rotate, 1–6 select front/back/left/right/top/bottom, Home selects isometric.
- **Axis triad:** under the cube, the world X/Y/Z axes are drawn as the camera sees them — the axis pointing at you is the bright one, the axis pointing away is dimmed and painted behind, so the drawing reads as a solid object. It needs no second GPU canvas.
- **Camera model:** the sidebar picks between 轨道 Orbit (target-locked, poles clamped), 旋转球 Arcball (no polar clamp, unlimited flipping) and 轨迹球 Trackball (free rolling, closest to a traditional CAD feel). All three share framing, section, NavCube and screenshot behaviour, and the choice is remembered across reloads.
- **Open files:** the picker, or a drop anywhere in the window — top bar, dock and nav cube included. A file drag is announced over the whole window, cancels the browser's own "open this file" default, and closes the workspace panel so the drop target stays visible.
- **Explode:** first opening animates to 50%. Slider changes and fully separated / reassemble use a 400ms transition with matching camera framing; reopening preserves the chosen value. Offsets belong to the active model, edge lines follow the parts, and dimensions retain their assembled values.
- **X-ray:** a translucent cyan inspection mode; leaving it restores imported materials. Selected parts stay highlighted.
- **Entities:** search parts by their imported names, select/highlight, hide/show, isolate, restore all or frame a part. On mobile the list reserves its own space beneath the canvas.
- **Parts:** independent mesh roots from the imported hierarchy. A single-mesh STL cannot be split into semantic components. No geometry is modified or guessed apart.
- **Demo:** “体验装配示例” opens an 11-part local procedural assembly.
- **Touch:** one finger rotates, two fingers pan/pinch. Mobile rendering caps pixel density at 1.5; framing accounts for narrow viewports.

`pnpm verify:tools --url=http://localhost:8901/` can also test a running production preview.
It covers four viewport sizes, actual touch events, exact reassembly under nested transforms,
edge alignment, six cube faces, single-mesh handling and console/network errors. Every camera
model gets its own pass: cube faces, the first drag after a scripted view (a controller that
rebuilds the pose from a cached matrix snaps back instead of continuing), touch rotate, pinch,
and the sidebar pick surviving a reload. It also pins the axis triad to the projected camera
basis per standard view, and drops a file on the top bar, the dock and the body to prove the
browser default is cancelled everywhere.

## Architecture

| Path | Owns |
|------|------|
| `src/main.ts` | boot order: renderer → stage → UI → PWA registration |
| `src/renderer/createRenderer.ts` | WebGPU-first renderer, reports which backend actually ran, `?webgl=1` forces the WebGL2 fallback |
| `src/viewer/stage.ts` | scene graph, camera, lights, grid, display modes, section, screenshot, render loop |
| `src/viewer/controller.ts` | camera navigation models (orbit / arcball / trackball) behind one contract, swapped in place |
| `src/loaders/*.ts` | one parser per format family, all returning `ParsedModel { root, warnings }` |
| `src/loaders/three-mf.ts` | 3MF packages: three's loader for geometry/materials, plus the unit the package declares |
| `src/loaders/step.ts` + `public/wasm/occt/step-worker.js` | OpenCascade wasm in a classic worker (7.6MB, never on the main thread) |
| `src/viewer/explode.ts` | independent mesh discovery, original matrices and parent-local separation offsets; consumed by `Stage` |
| `src/viewer/appearance.ts` | original mesh materials, X-ray and selection overrides; owned by each stage model |
| `src/ui/entities.ts` | named part list and inspection controls; initialized by `createApp` |
| `src/viewer/demo.ts` | procedural sample assembly used by the empty-state demo button |
| `src/ui/navCube.ts` | camera-synced CSS cube plus the camera-projected axis triad, and pointer/keyboard navigation; initialized by `createApp` |
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

## Format notes

- **STL** — ASCII and binary, normals taken from the file when present.
- **OBJ** — drop `.obj` + `.mtl` + textures together; companion files are resolved by basename through a
  `LoadingManager` URL modifier. Without an `.mtl` the mesh still loads and a warning says so.
- **3MF** — a ZIP/OPC package read with three's bundled fflate (no extra dependency): core geometry,
  components, base materials, textures and vertex colours, plus beam lattices. The `unit` the package
  declares is applied to the model, because three's loader only stores that attribute — the stage
  reads every length as millimetres, so an inch file would otherwise report a 25.4× larger part.
  That folding is announced in the toast rather than done silently.
- **glTF/GLB** — Draco and meshopt decoders ship through three's `new URL(..., import.meta.url)` assets;
  KTX2 compressed textures depend on the backend supporting them and warn instead of failing the load.
- **STEP / IGES / BREP** — tessellated by OpenCascade. Quality preset (快速 / 标准 / 精细) controls
  `linearDeflection`/`angularDeflection`; large assemblies want 快速.

## Known limits

- glTF files that reference external `.bin`/textures by relative path only work when those files are
  opened together with the `.gltf` (there is no server directory to fetch siblings from).
- Units: lengths are treated as millimetres for the bounding-box readout; the unit selector converts
  the readout, it does not rescale geometry.
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
