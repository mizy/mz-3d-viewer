import * as THREE from "three/webgpu";
import { LineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { disposeObject } from "../dispose";
import type { EdgeRequest, EdgeResponse } from "./protocol";

/** Dark enough to read on the grey default material, light enough not to vanish on dark presets. */
const EDGE_COLOR = 0x2b3644;

export type EdgeOptions = Readonly<{
  angle: number;
  /**
   * Line width in CSS pixels. `Line2NodeMaterial` divides the offset by
   * `viewport.w / renderer.getPixelRatio()`, so it already accounts for the device pixel ratio —
   * multiply by the DPR here and a retina display draws twice as thick.
   */
  width: number;
  signal: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}>;

function copyGeometry(geometry: THREE.BufferGeometry, angle: number): EdgeRequest {
  const attribute = geometry.getAttribute("position");
  const positions = new Float32Array(attribute.count * 3);
  if (attribute instanceof THREE.BufferAttribute && attribute.itemSize === 3 && !attribute.normalized) {
    positions.set(attribute.array);
  } else {
    for (let i = 0; i < attribute.count; i++) {
      positions[i * 3] = attribute.getX(i);
      positions[i * 3 + 1] = attribute.getY(i);
      positions[i * 3 + 2] = attribute.getZ(i);
    }
  }
  const indices = geometry.index === null ? null : new Uint32Array(geometry.index.array);
  return { positions, indices, angle };
}

function requestEdges(worker: Worker, input: EdgeRequest, signal: AbortSignal): Promise<Float32Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { worker.terminate(); reject(signal.reason); };
    const finish = (): void => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => { finish(); reject(new Error(event.message)); };
    worker.onmessageerror = () => { finish(); reject(new Error("无法读取边线计算结果")); };
    worker.onmessage = ({ data }: MessageEvent<EdgeResponse>) => {
      finish();
      if (data.ok) resolve(data.positions);
      else reject(new Error(data.message));
    };
    try {
      const transfer = [input.positions.buffer];
      if (input.indices !== null) transfer.push(input.indices.buffer);
      worker.postMessage(input, transfer);
    } catch (error) {
      finish();
      reject(error);
    }
  });
}

/**
 * Fat lines instead of `LineBasicMaterial`.
 *
 * `LineBasicMaterial` is stuck at one device pixel — the GPU ignores `linewidth` — and its
 * fragments land exactly on the facet plane, which is where the z-fighting came from. The
 * screen-space quads of `Line2NodeMaterial` give a real width with analytic anti-aliasing, and
 * because they are triangles the pipeline can carry a negative polygon offset, pulling the line
 * towards the camera so it wins the depth test against the surface it belongs to.
 */
function createEdgeMaterial(width: number): THREE.Line2NodeMaterial {
  const material = new THREE.Line2NodeMaterial({
    color: EDGE_COLOR,
    linewidth: width,
    worldUnits: false,
    alphaToCoverage: true
  });
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -4;
  return material;
}

/** @entry Compute each shared geometry once and keep a live transform per mesh instance. */
export async function createEdges(root: THREE.Object3D, options: EdgeOptions): Promise<THREE.Group> {
  const { angle, width, signal, onProgress } = options;
  signal.throwIfAborted();
  const meshes: THREE.Mesh[] = [];
  root.traverse((node) => { if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh); });
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  if (meshes.length === 0) return group;
  const worker = new Worker(new URL("./edges.worker.ts", import.meta.url), { type: "module" });
  const material = createEdgeMaterial(width);
  const buffers = new Map<THREE.BufferGeometry, LineSegmentsGeometry | null>();
  try {
    for (const [index, mesh] of meshes.entries()) {
      signal.throwIfAborted();
      let buffer = buffers.get(mesh.geometry);
      if (buffer === undefined) {
        const positions = await requestEdges(worker, copyGeometry(mesh.geometry, angle), signal);
        signal.throwIfAborted();
        if (positions.length === 0) {
          buffer = null;
        } else {
          buffer = new LineSegmentsGeometry();
          buffer.setPositions(positions);
        }
        buffers.set(mesh.geometry, buffer);
      }
      if (buffer !== null) {
        const lines = new LineSegments2(buffer, material);
        // The line shares the mesh's matrix instances, so exploded parts carry their edges along
        // without anything being rebuilt or re-uploaded.
        lines.matrixAutoUpdate = false;
        lines.matrixWorldAutoUpdate = false;
        lines.matrix = mesh.matrixWorld;
        lines.matrixWorld = mesh.matrixWorld;
        group.add(lines);
      }
      onProgress?.(index + 1, meshes.length);
    }
    return group;
  } catch (error) {
    disposeObject(group);
    throw error;
  } finally {
    if (group.children.length === 0) material.dispose();
    worker.terminate();
  }
}
