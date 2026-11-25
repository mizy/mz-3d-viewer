import * as THREE from "three/webgpu";
import { createRenderer } from "../renderer/createRenderer";
import { Stage } from "../viewer/stage";
import { ACCEPTED_EXTENSIONS, primaryFiles } from "../loaders/openFiles";
import type { ParsedModel } from "../loaders/types";
import type { CadQuality } from "../loaders/step";
import { parseModel, type ParseOptions } from "./parse";

export type ViewerOptions = Readonly<{
  /** OpenCascade tessellation quality for CAD imports. Defaults to "standard". */
  quality?: CadQuality;
  /** Force the WebGL2 backend instead of WebGPU. */
  forceWebGL?: boolean;
  /** Canvas clear colour. Defaults to the app's near-black. */
  background?: number;
  /** Start with the edge overlay on (default true). */
  edges?: boolean;
}>;

export type ModelViewer = Readonly<{
  /** The underlying stage: camera, section planes, display modes, picking. */
  stage: Stage;
  /** Which backend actually produced frames. */
  backend: "webgpu" | "webgl2";
  load: (input: File | readonly File[], options?: ParseOptions) => Promise<ParsedModel[]>;
  clear: () => void;
  resize: () => void;
  dispose: () => void;
}>;

/**
 * @entry A canvas, a renderer and the viewer stage, with import and framing wired up.
 *
 * This is the smallest useful embedding of the project: parse STEP/3MF/STL/…, show it with the
 * CAD display modes, and keep the camera, section and picking behaviour of the app. The app's
 * own chrome — dock, panels, pivot marker — is deliberately not part of it.
 */
export async function createModelViewer(canvas: HTMLCanvasElement, options: ViewerOptions = {}): Promise<ModelViewer> {
  const { renderer, backend } = await createRenderer(canvas, options.forceWebGL === true);
  const stage = new Stage(renderer, canvas, null);
  if (options.background !== undefined) {
    stage.scene.background = new THREE.Color(options.background);
  }
  stage.resize();
  if (options.edges === false) await stage.setDisplayStyle("solid");
  const observer = new ResizeObserver(() => stage.resize());
  observer.observe(canvas);

  async function load(input: File | readonly File[], parseOptions: ParseOptions = {}): Promise<ParsedModel[]> {
    const files = Array.isArray(input) ? [...input] : [input as File];
    const primaries = primaryFiles(files);
    if (primaries.length === 0) {
      throw new Error(`没识别到模型文件，支持：${ACCEPTED_EXTENSIONS.join(" ")}`);
    }
    const parsed: ParsedModel[] = [];
    for (const file of primaries) {
      const model = await parseModel(file, { ...parseOptions, companions: files, renderer: parseOptions.renderer ?? renderer });
      const handle = stage.addModel(model, file.name);
      stage.setBytes(handle.id, file.size);
      stage.fitToActive();
      parsed.push(model);
    }
    // Edges are built lazily, so the first load has to ask for them once.
    if (stage.style === "edges") await stage.setDisplayStyle("edges");
    return parsed;
  }

  function clear(): void {
    for (const handle of [...stage.modelList]) stage.removeModel(handle.id);
  }

  return {
    stage,
    backend,
    load,
    clear,
    resize: () => stage.resize(),
    dispose: () => {
      observer.disconnect();
      stage.dispose();
    }
  };
}
