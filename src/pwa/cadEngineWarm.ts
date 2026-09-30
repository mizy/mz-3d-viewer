import { assetUrl } from "../assetBase";

/** Files the STEP/IGES/BREP worker needs before it can parse anything offline. */
export const CAD_ENGINE_FILES = ["wasm/occt/occt-import-js.js", "wasm/occt/occt-import-js.wasm"];

export type CadEngineWarmState = {
  status: "idle" | "warming" | "ready" | "failed";
  cachedBytes: number;
  totalBytes: number;
  detail: string;
};

export function describeWarmState(state: CadEngineWarmState): string {
  const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  switch (state.status) {
    case "idle":
      return "STEP 引擎：等待缓存";
    case "warming":
      return `STEP 引擎：缓存中 ${mb(state.cachedBytes)} / ${mb(state.totalBytes)}`;
    case "ready":
      return `STEP 引擎：已缓存 ${mb(state.cachedBytes)}（离线可用）`;
    case "failed":
      return `STEP 引擎：离线不可用（${state.detail}）`;
  }
}

/**
 * Makes sure the OpenCascade engine is in the service worker cache, so STEP/IGES/BREP also
 * work offline later.
 *
 * Two things this deliberately does differently from the obvious implementation:
 *
 * 1. The page downloads it, not the service worker. A 7.6MB fetch started from an SW message
 *    handler is not protected by `respondWith`, so Chrome may stop the worker mid-download —
 *    measured on the live site: the 96KB glue always landed, the wasm often did not.
 *    Awaiting the body here keeps the worker's streaming `respondWith` alive to the last byte.
 * 2. A file whose cached size already equals its `Content-Length` is skipped, so reloading the
 *    page does not re-pull 7.6MB every time (it is a one-time cost per build).
 */
export async function warmCadEngine(
  onState: (state: CadEngineWarmState) => void
): Promise<CadEngineWarmState> {
  const sizes = new Map<string, number | null>();
  for (const path of CAD_ENGINE_FILES) {
    sizes.set(path, await contentLength(assetUrl(path)));
  }
  const totalBytes = [...sizes.values()].reduce<number>((sum, size) => sum + (size ?? 0), 0);
  const cachedPaths = (await readCadCache()).paths;
  const alreadyCached = CAD_ENGINE_FILES.filter((path) => {
    const expected = sizes.get(path) ?? null;
    const cached = cachedPaths.get(pathKey(path)) ?? 0;
    return expected === null ? cached > 0 : cached === expected;
  });
  if (alreadyCached.length === CAD_ENGINE_FILES.length) {
    const cache = await readCadCache();
    const bytes = cachedBytes(cache.paths);
    return report(onState, { status: "ready", cachedBytes: bytes, totalBytes: bytes, detail: "" });
  }

  onState({ status: "warming", cachedBytes: cachedBytes(cachedPaths), totalBytes, detail: "" });

  for (const path of CAD_ENGINE_FILES) {
    if (alreadyCached.includes(path)) {
      continue;
    }
    if (!(await waitForController(10000))) {
      return report(onState, { status: "failed", cachedBytes: cachedBytes(cachedPaths), totalBytes, detail: "页面还没被 Service Worker 接管" });
    }
    const url = assetUrl(path);
    const key = pathKey(path);
    let lastError = "";
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
      try {
        const response = await fetch(new Request(url, { cache: "reload" }));
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        // Draining the body is what lets the worker finish writing its cache entry.
        const body = await response.arrayBuffer();
        const stored = (await readCadCache()).paths.get(key) ?? 0;
        if (stored === body.byteLength) {
          ok = true;
        } else {
          lastError = `缓存字节数不符（下载 ${body.byteLength} / 缓存 ${stored}）`;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (!ok) {
        onState({ status: "warming", cachedBytes: cachedBytes((await readCadCache()).paths), totalBytes, detail: lastError });
      }
    }
    if (!ok) {
      return report(onState, {
        status: "failed",
        cachedBytes: cachedBytes((await readCadCache()).paths),
        totalBytes,
        detail: `${path}: ${lastError}`
      });
    }
  }

  const cache = await readCadCache();
  const bytes = cachedBytes(cache.paths);
  return report(onState, { status: "ready", cachedBytes: bytes, totalBytes: bytes, detail: "" });
}

function pathKey(path: string): string {
  return new URL(assetUrl(path)).pathname;
}

function cachedBytes(paths: Map<string, number>): number {
  let total = 0;
  for (const size of paths.values()) {
    total += size;
  }
  return total;
}

function report(onState: (state: CadEngineWarmState) => void, state: CadEngineWarmState): CadEngineWarmState {
  onState(state);
  return state;
}

type CadCacheState = { paths: Map<string, number> };

async function readCadCache(): Promise<CadCacheState> {
  const paths = new Map<string, number>();
  const scope = encodeURIComponent(new URL("./", assetUrl("sw.js")).pathname);
  for (const name of await caches.keys()) {
    if (!name.startsWith(`cad-${scope}-`)) {
      continue;
    }
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (response === undefined) {
        continue;
      }
      paths.set(new URL(request.url).pathname, (await response.blob()).size);
    }
  }
  return { paths };
}

/** `null` when the server does not report a length, in which case any cached copy counts. */
async function contentLength(url: string): Promise<number | null> {
  try {
    const response = await fetch(new Request(url, { method: "HEAD", cache: "reload" }));
    if (!response.ok) {
      return null;
    }
    const length = Number(response.headers.get("content-length") ?? "");
    return Number.isFinite(length) && length > 0 ? length : null;
  } catch {
    return null;
  }
}

function waitForController(timeoutMs: number): Promise<boolean> {
  if (navigator.serviceWorker.controller !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => done(navigator.serviceWorker.controller !== null), timeoutMs);
    const onChange = (): void => done(true);
    const done = (value: boolean): void => {
      window.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
      resolve(value);
    };
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
  });
}
