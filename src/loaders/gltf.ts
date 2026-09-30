import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { ParsedModel } from "./types";
import { loadWithFiles, type FileBundle } from "./files";

export async function loadGltf(
  buffer: ArrayBuffer,
  fileName: string,
  renderer: THREE.WebGPURenderer,
  bundle: FileBundle
): Promise<ParsedModel> {
  const warnings: string[] = [];

  // three r186 ships the Draco / KTX2 decoders through `new URL(..., import.meta.url)`, so
  // the bundler emits and hashes them for us. Overriding the paths here would only add a
  // second, unhashed copy of the same 1.4MB to the deployment.
  const dracoLoader = new DRACOLoader();
  const ktx2Loader = new KTX2Loader();
  try {
    // KTX2Loader only knows how to ask a WebGLRenderer about compressed-texture
    // support. If the WebGPU backend rejects the question we keep going without the
    // detector instead of failing the whole load.
    type DetectSupportTarget = Parameters<KTX2Loader["detectSupport"]>[0];
    ktx2Loader.detectSupport(renderer as unknown as DetectSupportTarget);
  } catch (error) {
    warnings.push(`KTX2 检测失败，压缩贴图可能不显示：${describeError(error)}`);
  }

  return loadWithFiles(bundle, warnings, async (manager) => {
    const loader = new GLTFLoader(manager);
    loader.setDRACOLoader(dracoLoader);
    loader.setKTX2Loader(ktx2Loader);
    loader.setMeshoptDecoder(MeshoptDecoder);

    try {
      const gltf = await loader.parseAsync(buffer, "");
      let meshCount = 0;
      gltf.scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh === true) {
          meshCount += 1;
          (child as THREE.Mesh).geometry.computeBoundingBox();
        }
      });
      if (meshCount === 0) {
        warnings.push(`${fileName} 里没有网格（可能只有相机/灯光/动画）`);
      }
      // glTF 2.0 defines linear distances in metres; Stage measures in millimetres.
      gltf.scene.scale.multiplyScalar(1000);
      return { format: "gltf", root: gltf.scene, sourceUnit: { label: "米 m（glTF 规范）", mmPerUnit: 1000 }, warnings };
    } finally {
      dracoLoader.dispose();
      ktx2Loader.dispose();
    }
  });
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
