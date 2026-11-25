import * as THREE from "three/webgpu";
import type { ModelFormat, ParsedModel, ProgressReporter } from "./types";
import { createCadFaceMaterial } from "./materials";
import { cadAssetUrl } from "../cadAssets";
import { describeError } from "./gltf";
import { registerCadFaces } from "./cadFaces";

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
  faces?: readonly { first: number; last: number }[];
  color: [number, number, number];
};

/** Stages the worker can measure itself. Tessellation has no inside view, see below. */
type CadStage = "download" | "tessellate" | "assemble";

type WorkerOutMessage =
  | { type: "progress"; stage: CadStage; ratio: number | null; label: string }
  | { type: "log"; text: string }
  | { type: "error"; error: string }
  | { type: "done"; meshes: WorkerMeshPayload[] };

type Band = readonly [start: number, end: number];

/**
 * One bar, three measurable stages. Tessellation (`ReadStepFile`) is a single blocking wasm
 * call with no progress callback, so it owns no band: the bar keeps the engine stage's end
 * while the UI animates, and the elapsed seconds below say the work is still moving.
 */
const CAD_PROGRESS_BANDS: Record<"read" | "engine" | "assemble", Band> = {
  read: [0, 0.06],
  engine: [0.06, 0.18],
  assemble: [0.9, 1]
};

/** Below this the read is instant, and reporting it only flickers the bar. */
const READ_PROGRESS_MIN_BYTES = 4 * 1024 * 1024;

/** From here on tessellation is slow enough to justify telling the user what to do about it. */
const SLOW_TESSELLATION_SECONDS = 12;

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
    const worker = new Worker(cadAssetUrl("step-worker.js"));
    const logs: string[] = [];
    let ticker: number | null = null;
    let tessellationStartedAt = 0;

    const stopTicker = (): void => {
      if (ticker !== null) {
        window.clearInterval(ticker);
        ticker = null;
      }
    };

    const finish = (fn: () => void): void => {
      stopTicker();
      signal.removeEventListener("abort", cancel);
      worker.terminate();
      fn();
    };
    const cancel = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", cancel, { once: true });

    /**
     * The worker is blocked inside wasm, so the only clock available is this one. It keeps the
     * dialog alive and nudges towards the quality preset that would actually be faster.
     */
    const startTessellationTicker = (): void => {
      if (ticker !== null) {
        return;
      }
      tessellationStartedAt = performance.now();
      ticker = window.setInterval(() => {
        const seconds = Math.max(1, Math.round((performance.now() - tessellationStartedAt) / 1000));
        const hint = seconds >= SLOW_TESSELLATION_SECONDS ? " · 复杂装配体较慢，可取消后改用「快速」精度" : "";
        report({ ratio: null, label: `OpenCascade 细分中… 已用 ${seconds}s${hint}` });
      }, 1000);
    };

    worker.onerror = (event) => {
      finish(() => reject(new Error(`STEP 解析线程启动失败：${event.message}`)));
    };

    worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
      const message = event.data;
      switch (message.type) {
        case "progress":
          if (message.stage === "tessellate") {
            startTessellationTicker();
            report({ ratio: null, label: message.label });
            return;
          }
          stopTicker();
          report({
            ratio: scaleToBand(message.ratio, message.stage === "download" ? CAD_PROGRESS_BANDS.engine : CAD_PROGRESS_BANDS.assemble),
            label: message.label
          });
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
            resolve({ format, root: buildGroup(message.meshes),
              sourceUnit: format === "brep"
                ? { label: "未知（BREP 无可靠单位）", mmPerUnit: null }
                : { label: "毫米 mm（CAD 导入器输出）", mmPerUnit: 1 }, warnings });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(describeError(error)));
          }
          finish(() => {});
          return;
        }
      }
    };

    report({ ratio: CAD_PROGRESS_BANDS.read[0], label: "读取文件…" });
    void readFileBytes(file, (ratio) => {
      report({ ratio: scaleToBand(ratio, CAD_PROGRESS_BANDS.read), label: "读取文件…" });
    })
      .then((buffer) => {
        if (signal.aborted) {
          cancel();
          return;
        }
        report({ ratio: CAD_PROGRESS_BANDS.engine[0], label: "启动 CAD 引擎…" });
        const params = format === "brep" ? CAD_QUALITY_PRESETS[quality] :
          { ...CAD_QUALITY_PRESETS[quality], linearUnit: "millimeter" };
        worker.postMessage({ format, buffer, params }, [buffer]);
      })
      .catch((error: unknown) => {
        finish(() => reject(new Error(`读取文件失败：${describeError(error)}`)));
      });
  });
}

function scaleToBand(ratio: number | null, [start, end]: Band): number | null {
  if (ratio === null) {
    return null;
  }
  return start + (end - start) * Math.min(Math.max(ratio, 0), 1);
}

/**
 * Reads a dropped file in chunks. Large STEP assemblies are hundreds of MB, and `arrayBuffer()`
 * gives no way to show how much of that has landed. Small files skip the streaming path: it
 * would only flicker a bar that is already gone.
 */
async function readFileBytes(file: File, onRatio: (ratio: number | null) => void): Promise<ArrayBuffer> {
  if (typeof file.stream !== "function" || file.size < READ_PROGRESS_MIN_BYTES) {
    const buffer = await file.arrayBuffer();
    onRatio(1);
    return buffer;
  }
  const reader = file.stream().getReader();
  // One pre-allocated buffer: a multi-hundred-MB STEP is already copied into the wasm heap, so
  // a chunk list on top of it would triple peak memory for no gain.
  let bytes = new Uint8Array(Math.max(file.size, 1));
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const end = received + value.byteLength;
      if (end > bytes.byteLength) {
        const grown = new Uint8Array(Math.max(end, bytes.byteLength * 2));
        grown.set(bytes.subarray(0, received));
        bytes = grown;
      }
      bytes.set(value, received);
      received = end;
      onRatio(file.size === 0 ? null : Math.min(received / file.size, 0.99));
    }
  } catch (error) {
    void reader.cancel();
    throw error;
  }
  onRatio(1);
  return received === bytes.byteLength ? bytes.buffer : bytes.slice(0, received).buffer;
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
    registerCadFaces(geometry, meshPayload.faces ?? []);

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
