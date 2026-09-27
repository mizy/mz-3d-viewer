/** Static server for dist/ with a configurable base path, used by scripts/verify-site.mjs. */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "dist");
const baseDir = process.argv[2] ?? "/";
const port = Number(process.argv[3] ?? 8898);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".stl": "model/stl",
  ".stp": "application/step"
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (!pathname.startsWith(baseDir)) {
    res.writeHead(404).end("outside base");
    return;
  }
  pathname = pathname.slice(baseDir.length);
  const target = pathname === "" || pathname.endsWith("/") ? path.join(root, pathname, "index.html") : path.join(root, pathname);
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
      // Mirrors GitHub Pages, which pins max-age=600 on every response.
      "cache-control": "max-age=600",
      "service-worker-allowed": baseDir
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`dist served at http://127.0.0.1:${port}${baseDir}`);
});
