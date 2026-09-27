/**
 * Service worker template. scripts/write-sw.mjs fills in the four placeholders and writes
 * the result to dist/sw.js.
 *
 * Caching rules:
 *   - hashed shell assets: cache-first (the file name changes on every build)
 *   - navigation: network-first with a revalidating request, falling back to the cached shell
 *   - the OpenCascade engine: cached into its own build-versioned cache the first time the page
 *     requests it (src/pwa/cadEngineWarm.ts drives that download, see the comment there)
 */
const BUILD = "__BUILD__";
const PRECACHE = __PRECACHE__;
const CAD_ENGINE = __CAD_ENGINE__;

const SHELL_CACHE = `shell-${BUILD}`;
const CAD_CACHE = `cad-${BUILD}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // `cache: "reload"` bypasses the HTTP cache (GitHub Pages pins max-age=600 and would
      // otherwise hand us the previous build's bytes under the new file name).
      // Stored keys are plain URL requests so lookups never depend on the fetch options used.
      for (const entry of PRECACHE) {
        const response = await fetch(new Request(entry.url, { cache: "reload" }));
        if (!response.ok) {
          throw new Error(`预缓存失败 ${entry.url}: ${response.status}`);
        }
        await cache.put(new Request(entry.url), response);
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, CAD_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});

function isCadEngine(url) {
  return CAD_ENGINE.some((path) => url.pathname.endsWith(path.replace(/^\.\//, "")));
}

async function handleNavigate(request) {
  try {
    const fresh = await fetch(new Request(request, { cache: "no-cache" }));
    if (fresh.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(new Request("./index.html"), fresh.clone());
      return fresh;
    }
  } catch (error) {
    // offline: fall through to the cached shell
  }
  const cached = (await caches.match("./index.html")) || (await caches.match(request));
  if (cached !== undefined) {
    return cached;
  }
  return new Response("离线且没有缓存外壳", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function handleAsset(request) {
  const cached = await caches.match(request);
  if (cached !== undefined) {
    return cached;
  }
  const response = await fetch(request);
  if (response.ok && request.method === "GET") {
    const cacheName = isCadEngine(new URL(request.url)) ? CAD_CACHE : SHELL_CACHE;
    const cache = await caches.open(cacheName);
    await cache.put(new Request(request.url), response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(handleNavigate(request));
    return;
  }
  event.respondWith(handleAsset(request));
});
