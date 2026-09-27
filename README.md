# mz-3d-viewer

WebGPU-first PWA for looking at 3D models: **STL, OBJ, glTF/GLB, STEP/IGES/BREP**.

Online: <https://mizy.github.io/mz-3d-viewer/>

Everything runs in the browser. Model files are never uploaded — there is no backend at all,
just static files, which is also what makes the offline install work.

## Run it

```bash
pnpm install
pnpm dev              # http://localhost:8899
pnpm build            # vite build + dist/sw.js (precache manifest + build hash)
pnpm serve:dist       # serve dist/ exactly like GitHub Pages (static, cache-control: max-age=600)
pnpm verify           # 33-check acceptance run in real Chrome
pnpm typecheck
```

`pnpm verify` needs a Chrome with WebGPU (macOS/Windows Chrome 113+). It serves the build at a
sub-path (`/mz-3d-viewer/`) so the GitHub Pages layout is what gets tested. Flags: `--headless`,
`--base=/`.

## Architecture

| Path | Owns |
|------|------|
| `src/main.ts` | boot order: renderer → stage → UI → PWA registration |
| `src/renderer/createRenderer.ts` | WebGPU-first renderer, reports which backend actually ran, `?webgl=1` forces the WebGL2 fallback |
| `src/viewer/stage.ts` | scene graph, camera, lights, grid, display modes, section, screenshot, render loop |
| `src/loaders/*.ts` | one parser per format family, all returning `ParsedModel { root, warnings }` |
| `src/loaders/step.ts` + `public/wasm/occt/step-worker.js` | OpenCascade wasm in a classic worker (7.6MB, never on the main thread) |
| `src/ui/app.ts` | DOM wiring only: files, list, settings, progress, stats, test hooks |
| `src/pwa/register.ts` | service worker registration + update reload + OS file handlers |
| `scripts/write-sw.mjs`, `scripts/sw-template.js` | build-time precache manifest; shell cached eagerly, CAD engine warmed after install |

Parsing contract: every loader returns `ParsedModel` (an `Object3D` root plus warnings). The stage
only knows how to add/remove/frame that shape — it has no per-format branches.

`window.__mzViewer` exposes `{ stage, backend, capture(), summary() }` for the acceptance run and for
debugging a live deployment.

## Format notes

- **STL** — ASCII and binary, normals taken from the file when present.
- **OBJ** — drop `.obj` + `.mtl` + textures together; companion files are resolved by basename through a
  `LoadingManager` URL modifier. Without an `.mtl` the mesh still loads and a warning says so.
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
- KTX2 textures on the WebGL2 fallback backend depend on `KTX2Loader.detectSupport` succeeding; the
  failure path is a visible warning, not a silent blank surface.

## Deployment

`.github/workflows/deploy.yml` builds on every push to `main`, typechecks, and publishes `dist/`
through GitHub Pages (Pages source = GitHub Actions, no build output committed). Assets use relative
URLs, so the site works from `/` and from `/<repo>/` without a rebuild. The sidebar shows the build
hash; compare it with the newest commit when investigating "I still see the old version" reports —
the service worker plus Pages' fixed `cache-control: max-age=600` are the usual suspects.
