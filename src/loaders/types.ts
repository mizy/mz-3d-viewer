import type * as THREE from "three/webgpu";

/** File formats this viewer can parse. `step`/`iges`/`brep` all go through OpenCascade. */
export type ModelFormat = "stl" | "obj" | "gltf" | "3mf" | "step" | "iges" | "brep";

export type ParsedModel = {
  format: ModelFormat;
  /** The object tree to add to the scene. Owns its own materials. */
  root: THREE.Object3D;
  /** Non-fatal notes shown to the user (missing textures, unsupported extensions…). */
  warnings: string[];
};

export type LoadProgress = {
  /** 0..1, or null when the step has no measurable progress. */
  ratio: number | null;
  label: string;
};

export type ProgressReporter = (progress: LoadProgress) => void;
