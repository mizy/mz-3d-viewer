import * as THREE from "three/webgpu";
import type { ModelFormat, ParsedModel, ProgressReporter } from "./types";
import { createCadFaceMaterial } from "./materials";
import { assetUrl } from "../assetBase";
import { describeError } from "./gltf";

/** OpenCascade tessellation quality. Coarser settings are what keeps big assemblies usable. */
export const CAD_QUALITY_PRESETS = {
  fast: { label: "快速（大装配体）", linearDeflectionType: "absolute_value", linearDeflection: 1, angularDeflection: 1 },
  standard: { label: "标准", linearDeflectionType: "absolute_value", linearDeflection: 0.2, angularDeflection: 0.5 },
  fine: { label: "精细（小零件）", linearDeflectionType: "absolute_value", linearDeflection: 0.05, angularDeflection: 0.3 }
} as const;

export type CadQuality = keyof typeof CAD_QUALITY_PRESETS;

type WorkerMeshPayload = {
  name: string;
  position: Float32Array;
  normal: Float32Array | null;
  index: Uint32Array | null;
  color: [number, number, number];
};

type WorkerOutMessage =
  | { type: "progress"; phase: string }
  | { type: "log"; text: string }
  | { type: "error"; error: string }
  | { type: "done"; meshes: WorkerMeshPayload[] };

/**
 * STEP / IGES / BREP all run through the OpenCascade wasm build. It lives in a classic
 * worker (see public/wasm/occt/step-worker.js) because it is the only parsing path heavy
 * enough to freeze the UI: 7.6MB of wasm plus tessellation of arbitrary CAD geometry.
 */
export function loadCad(
  file: File,
  format: Extract<ModelFormat, "step" | "iges" | "brep">,
  quality: CadQuality,
  report: ProgressReporter,
  signal: AbortSignal
): Promise<ParsedModel> {
  return new Promise<ParsedModel>((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(assetUrl("wasm/occt/step-worker.js"));
    const logs: string[] = [];

    const finish = (fn: () => void): void => {
      signal.removeEventListener("abort", cancel);
      worker.terminate();
      fn();
    };
    const cancel = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", cancel, { once: true });

    worker.onerror = (event) => {
      finish(() => reject(new Error(`STEP 解析线程启动失败：${event.message}`)));
    };

    worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
      const message = event.data;
      switch (message.type) {
        case "progress":
          report({ ratio: null, label: message.phase });
          return;
        case "log":
          logs.push(message.text);
          return;
        case "error":
          finish(() => reject(new Error(message.error)));
          return;
        case "done": {
          if (signal.aborted) {
            cancel();
            return;
          }
          const warnings = collectEngineWarnings(logs);
          try {
            resolve({ format, root: buildGroup(message.meshes), warnings });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(describeError(error)));
          }
          finish(() => {});
          return;
        }
      }
    };

    report({ ratio: null, label: "读取文件…" });
    void file
      .arrayBuffer()
      .then((buffer) => {
        if (signal.aborted) {
          cancel();
          return;
        }
        report({ ratio: null, label: "OpenCascade 细分中…" });
        const params = CAD_QUALITY_PRESETS[quality];
        worker.postMessage({ format, buffer, params }, [buffer]);
      })
      .catch((error: unknown) => {
        finish(() => reject(new Error(`读取文件失败：${describeError(error)}`)));
      });
  });
}

function buildGroup(meshes: WorkerMeshPayload[]): THREE.Group {
  const group = new THREE.Group();
  for (const meshPayload of meshes) {
    if (meshPayload.position.length === 0) {
      continue;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(meshPayload.position, 3));
    if (meshPayload.normal !== null && meshPayload.normal.length === meshPayload.position.length) {
      geometry.setAttribute("normal", new THREE.BufferAttribute(meshPayload.normal, 3));
    } else {
      geometry.computeVertexNormals();
    }
    if (meshPayload.index !== null) {
      geometry.setIndex(new THREE.BufferAttribute(meshPayload.index, 1));
    }
    geometry.computeBoundingBox();

    const mesh = new THREE.Mesh(geometry, createCadFaceMaterial(meshPayload.color));
    mesh.name = meshPayload.name;
    mesh.userData["cadFace"] = true;
    group.add(mesh);
  }
  if (group.children.length === 0) {
    throw new Error("OpenCascade 没有产出任何网格（文件可能不是实体/曲面模型）");
  }
  return group;
}

/** OCCT complains about recoverable import problems on stderr; surface the first few. */
function collectEngineWarnings(logs: string[]): string[] {
  const unique = [...new Set(logs.map((line) => line.trim()).filter((line) => line.length > 0))];
  const warnings = unique.slice(0, 3).map((line) => `CAD 引擎提示：${line}`);
  if (unique.length > 3) {
    warnings.push(`CAD 引擎另有 ${unique.length - 3} 条提示（已折叠）`);
  }
  return warnings;
}
