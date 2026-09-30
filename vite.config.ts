import { defineConfig } from "vite";

// Relative base: the site must work both at "/" (local preview) and at
// "/mz-3d-viewer/" (GitHub Pages project site) without a rebuild.
export default defineConfig({
  base: "./",
  // The edge worker imports the core build; discover it before the first mode switch.
  optimizeDeps: { include: ["three"] },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    // three's WebGPU build plus the loaders land in one ~1.3MB chunk on purpose.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].[hash].js",
        chunkFileNames: "assets/[name].[hash].js",
        assetFileNames: "assets/[name].[hash][extname]"
      }
    }
  },
  server: { port: 8899 },
  preview: { port: 8901 }
});
