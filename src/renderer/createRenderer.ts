import * as THREE from "three/webgpu";

/** Which GPU backend actually produced frames this session. */
export type BackendKind = "webgpu" | "webgl2";

export type RendererHandle = {
  renderer: THREE.WebGPURenderer;
  backend: BackendKind;
};

/** `?webgl=1` forces the WebGL2 backend so the fallback path stays testable. */
export function forceWebGLFromUrl(search: string): boolean {
  return new URLSearchParams(search).get("webgl") === "1";
}

/**
 * three's WebGPURenderer silently falls back to its WebGL2 backend when
 * `navigator.gpu` is missing. We report which backend ended up in use instead of
 * claiming "WebGPU" unconditionally.
 */
export async function createRenderer(
  canvas: HTMLCanvasElement,
  forceWebGL: boolean
): Promise<RendererHandle> {
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    forceWebGL,
    alpha: false
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  await renderer.init();

  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
  return { renderer, backend: backend.isWebGPUBackend === true ? "webgpu" : "webgl2" };
}
