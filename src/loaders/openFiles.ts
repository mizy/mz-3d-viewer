import type * as THREE from "three/webgpu";
import type { FileBundle } from "./obj";
import { createFileBundle, loadObj } from "./obj";
import { loadStl } from "./stl";
import { loadGltf } from "./gltf";
import { loadThreeMf } from "./three-mf";
import { loadCad, type CadQuality } from "./step";
import type { CancelSignal, ModelFormat, ParsedModel, ProgressReporter } from "./types";

const EXTENSION_TO_FORMAT: Record<string, ModelFormat> = {
  stl: "stl",
  obj: "obj",
  gltf: "gltf",
  glb: "gltf",
  "3mf": "3mf",
  step: "step",
  stp: "step",
  iges: "iges",
  igs: "iges",
  brep: "brep"
};

export const ACCEPTED_EXTENSIONS = Object.keys(EXTENSION_TO_FORMAT).map((ext) => `.${ext}`);

export function detectFormat(fileName: string): ModelFormat | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  const ext = fileName.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_FORMAT[ext] ?? null;
}

export type OpenContext = {
  renderer: THREE.WebGPURenderer;
  quality: CadQuality;
  report: ProgressReporter;
  signal: CancelSignal;
};

/** Files the user drops that we know how to open. Companions (.mtl, textures, .bin) are not primaries. */
export function primaryFiles(files: File[]): File[] {
  return files.filter((file) => detectFormat(file.name) !== null);
}

export async function parseOne(file: File, allFiles: File[], context: OpenContext): Promise<ParsedModel> {
  const format = detectFormat(file.name);
  if (format === null) {
    throw new Error(`不支持的文件类型：${file.name}`);
  }
  const bundle: FileBundle = createFileBundle(allFiles);

  switch (format) {
    case "stl":
      return loadStl(await file.arrayBuffer(), file.name);
    case "obj":
      return loadObj(file, bundle);
    case "gltf":
      return loadGltf(await file.arrayBuffer(), file.name, context.renderer);
    case "3mf":
      return loadThreeMf(await file.arrayBuffer(), file.name);
    case "step":
    case "iges":
    case "brep":
      return loadCad(file, format, context.quality, context.report, context.signal);
  }
}
