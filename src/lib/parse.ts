import type * as THREE from "three/webgpu";
import { ACCEPTED_EXTENSIONS, parseOne, primaryFiles } from "../loaders/openFiles";
import type { LoadProgress, ParsedModel } from "../loaders/types";
import type { CadQuality } from "../loaders/step";

/**
 * Stand-in for a renderer when parsing headlessly. glTF only asks it whether compressed KTX2
 * textures are supported; answering "no" keeps the load going and surfaces a warning instead.
 */
const NO_COMPRESSED_TEXTURES = {
  isWebGPURenderer: true,
  hasFeature: () => false
} as unknown as THREE.WebGPURenderer;

export type ParseOptions = Readonly<{
  /** Sibling files the model references: `.mtl`, `.bin`, textures. */
  companions?: readonly File[];
  /** OpenCascade tessellation quality for STEP / IGES / BREP. Defaults to "standard". */
  quality?: CadQuality;
  signal?: AbortSignal;
  onProgress?: (progress: LoadProgress & { file: File }) => void;
  /** Pass your viewer's renderer so glTF can probe KTX2 support. */
  renderer?: THREE.WebGPURenderer;
}>;

/** @entry Parse one model file into a three.js object tree, in millimetres where known. */
export async function parseModel(file: File, options: ParseOptions = {}): Promise<ParsedModel> {
  const { companions = [], quality = "standard", onProgress, renderer, signal } = options;
  return parseOne(file, [file, ...companions], {
    renderer: renderer ?? NO_COMPRESSED_TEXTURES,
    quality,
    signal: signal ?? new AbortController().signal,
    report: (progress) => onProgress?.({ ...progress, file })
  });
}

/** @entry Parse every recognised model in a dropped set, sharing the companions between them. */
export async function parseFiles(files: readonly File[], options: ParseOptions = {}): Promise<ParsedModel[]> {
  const primaries = primaryFiles([...files]);
  if (primaries.length === 0) {
    throw new Error(`没识别到模型文件，支持：${ACCEPTED_EXTENSIONS.join(" ")}`);
  }
  const models: ParsedModel[] = [];
  for (const file of primaries) {
    models.push(await parseModel(file, { ...options, companions: files }));
  }
  return models;
}
