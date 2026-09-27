/**
 * Directory the site is served from, with a trailing slash. Works at "/" locally
 * and at "/mz-3d-viewer/" on GitHub Pages without any build-time knowledge of the repo name.
 */
export const assetBase = new URL("./", document.baseURI).href;

export function assetUrl(relativePath: string): string {
  return new URL(relativePath.replace(/^\.?\//, ""), assetBase).href;
}
