/**
 * Public surface of `mz-3d-viewer`: parse STEP / IGES / BREP / 3MF / STL / OBJ / glTF locally and
 * either embed the viewer or hand the parsed three.js tree to your own scene.
 *
 * The heavy parts are already inside: OpenCascade runs in a classic worker, and the worker plus its
 * wasm are the three files next to this module (`occt/`). Nothing is uploaded anywhere.
 */
export { configureCadAssets, type CadAssetOptions } from "../cadAssets";

export { ACCEPTED_EXTENSIONS, detectFormat } from "../loaders/openFiles";
export { CAD_QUALITY_PRESETS, type CadQuality } from "../loaders/step";
export type { LoadProgress, ModelFormat, ParsedModel, ProgressReporter } from "../loaders/types";
export type { DisplayStyle, MaterialPreset } from "../viewer/appearance";
export type { SectionCut, StandardView } from "../viewer/stage";

export { parseFiles, parseModel, type ParseOptions } from "./parse";
export { createModelViewer, type ModelViewer, type ViewerOptions } from "./viewer";
