import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/html-vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtEntry = path.join(root, "dist-lib", "index.js");
/**
 * The built-package story resolves through this alias so Vite rewrites the bare `three`
 * imports in dist-lib/index.js. When `pnpm build:pkg` has not run, it resolves to a stub and
 * the story shows the build hint instead of breaking the whole Storybook preview.
 */
const builtPackage = existsSync(builtEntry)
  ? builtEntry
  : path.join(root, ".storybook", "built-missing.ts");

const config: StorybookConfig = {
  stories: ["../stories/**/*.stories.ts"],
  addons: [],
  framework: { name: "@storybook/html-vite", options: {} },
  staticDirs: [
    { from: "../samples", to: "samples" },
    { from: "../public/wasm/occt", to: "occt" }
  ],
  viteFinal: async (vite) => {
    // The app build uses a relative base for GitHub Pages; Storybook serves from "/".
    vite.base = "/";
    vite.resolve ??= {};
    const current = vite.resolve.alias;
    const aliases = Array.isArray(current)
      ? [...current]
      : current === undefined
        ? []
        : Object.entries(current).map(([find, replacement]) => ({ find, replacement }));
    aliases.push({ find: "mz-built-package", replacement: builtPackage });
    vite.resolve.alias = aliases;
    return vite;
  }
};

export default config;
