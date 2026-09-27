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
 * Downloads the OpenCascade engine through the page so the service worker stores it.
 *
 * Why not let the service worker download it in the background: a 7.6MB fetch started from a
 * message handler is not protected by `respondWith`, so Chrome is free to stop the worker
 * mid-download (observed: the JS landed, the wasm silently never did). Here the page awaits the
 * response body, which keeps the service worker's streaming `respondWith` alive to the last byte,
 * and the result is verified against the cache instead of assumed.
 */
export async function warmCadEngine(
  onState: (state: CadEngineWarmState) => void
): Promise<CadEngineWarmState> {
  const cached = await readCadCache();
  const totalBytes = cached.totalBytes + (await remainingBytes(cached.paths));

  const state: CadEngineWarmState = { status: "warming", cachedBytes: cached.totalBytes, totalBytes, detail: "" };
  onState(state);

  if (!(await waitForController(10000))) {
    const failed: CadEngineWarmState = { ...state, status: "failed", detail: "页面还没被 Service Worker 接管" };
    onState(failed);
    return failed;
  }

  for (const path of CAD_ENGINE_FILES) {
    const url = assetUrl(path);
    const key = new URL(url).pathname;
    let ok = false;
    let lastError = "";
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
        onState({ ...state, cachedBytes: (await readCadCache()).totalBytes, detail: lastError });
      }
    }
    if (!ok) {
      const failed: CadEngineWarmState = {
        status: "failed",
        cachedBytes: (await readCadCache()).totalBytes,
        totalBytes,
        detail: `${path}: ${lastError}`
      };
      onState(failed);
      return failed;
    }
  }

  const finalCache = await readCadCache();
  onState({ status: "ready", cachedBytes: finalCache.totalBytes, totalBytes: finalCache.totalBytes, detail: "" });
  return { status: "ready", cachedBytes: finalCache.totalBytes, totalBytes: finalCache.totalBytes, detail: "" };
}

type CadCacheState = { paths: Map<string, number>; totalBytes: number };

async function readCadCache(): Promise<CadCacheState> {
  const paths = new Map<string, number>();
  let totalBytes = 0;
  for (const name of await caches.keys()) {
    if (!name.startsWith("cad-")) {
      continue;
    }
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (response === undefined) {
        continue;
      }
      const size = (await response.blob()).size;
      paths.set(new URL(request.url).pathname, size);
      totalBytes += size;
    }
  }
  return { paths, totalBytes };
}

/** Expected total size, read from the network when the cache is incomplete. */
async function remainingBytes(cached: Map<string, number>): Promise<number> {
  let remaining = 0;
  for (const path of CAD_ENGINE_FILES) {
    const key = new URL(assetUrl(path)).pathname;
    if (cached.has(key)) {
      continue;
    }
    try {
      const response = await fetch(new Request(assetUrl(path), { method: "HEAD" }));
      const length = Number(response.headers.get("content-length") ?? "0");
      remaining += Number.isFinite(length) ? length : 0;
    } catch {
      remaining += 0;
    }
  }
  return remaining;
}

function waitForController(timeoutMs: number): Promise<boolean> {
  if (navigator.serviceWorker.controller !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const done = (value: boolean): void => {
      window.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
      resolve(value);
    };
    const onChange = (): void => done(true);
    const timer = window.setTimeout(() => done(navigator.serviceWorker.controller !== null), timeoutMs);
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
  });
}
