import { defineConfig } from "vite";

/**
 * Library build, kept separate from the app build.
 *
 * `three` stays external: a package that bundles its own copy gives every consumer two three.js
 * instances (and two WebGPU renderers' worth of state). The app build inlines it as usual.
 *
 * The OCCT worker and wasm are not imported by the bundle — they are copied next to the entry by
 * `scripts/build-package.mjs`, which is what `configureCadAssets` resolves against by default.
 */
export default defineConfig({
  // Relative base: the worker chunk must resolve next to the entry wherever the package is served
  // (node_modules, a CDN, a copied directory), not from the server root.
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist-lib",
    emptyOutDir: true,
    // public/ belongs to the app (icons, manifest, the wasm copy it serves); the package ships
    // only its entry, types and the occt/ directory build-package.mjs copies beside them.
    copyPublicDir: false,
    // public/ belongs to the app (icons, manifest, the wasm copy it serves); the package ships
    // only its entry, types and the occt/ directory build-package.mjs copies beside them.
    copyPublicDir: false,
    minify: false,
    sourcemap: true,
    lib: {
      entry: "src/lib/index.ts",
      formats: ["es"],
      fileName: () => "index.js"
    },
    rollupOptions: {
      external: ["three", /^three\//]
    }
  }
});
