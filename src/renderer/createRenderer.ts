import * as THREE from "three/webgpu";

// WebGPURenderer installs a fallback internally. Use its WebGPU backend and standard
// node library directly, with the same renderer interface for the viewer and loaders.
class ViewerRenderer extends THREE.Renderer {
  override library = new THREE.StandardNodeLibrary();
  readonly isWebGPURenderer = true;

  constructor(canvas: HTMLCanvasElement) {
    const options = { canvas, antialias: true, alpha: false };
    super(new THREE.WebGPUBackend(options), options);
  }
}

export class WebGPUUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("WebGPU is unavailable. Use a WebGPU-capable browser with graphics acceleration enabled.", { cause });
    this.name = "WebGPUUnavailableError";
  }
}

/** @entry Create a viewer renderer using the WebGPU backend. */
export async function createRenderer(canvas: HTMLCanvasElement): Promise<THREE.WebGPURenderer> {
  if (globalThis.navigator?.gpu === undefined) throw new WebGPUUnavailableError();
  const renderer = new ViewerRenderer(canvas);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  try {
    await renderer.init();
    return renderer;
  } catch (error) {
    throw new WebGPUUnavailableError(error);
  }
}
