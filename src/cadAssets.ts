/**
 * Where the OpenCascade worker and wasm live.
 *
 * The app points this at `<document base>/wasm/occt/`. A package consumer can leave the default —
 * which resolves next to the published module, where `npm pack` puts the same three files — or
 * point it at a CDN or a copied static directory with `configureCadAssets`.
 */
/** Held in a variable so bundlers do not try to resolve the directory at build time. */
const DEFAULT_CAD_DIRECTORY = "occt/";
let cadBaseUrl = new URL(DEFAULT_CAD_DIRECTORY, import.meta.url).href;

export type CadAssetOptions = Readonly<{
  /** Directory holding `step-worker.js`, `occt-import-js.js` and `occt-import-js.wasm`. */
  baseUrl: string;
}>;

export function configureCadAssets(options: CadAssetOptions): void {
  const base = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
  const documentBase = typeof location === "undefined" ? import.meta.url : location.href;
  cadBaseUrl = new URL(base, documentBase).href;
}

export function cadAssetUrl(fileName: string): string {
  return new URL(fileName, cadBaseUrl).href;
}
