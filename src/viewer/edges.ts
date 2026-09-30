import * as THREE from "three/webgpu";
import { disposeObject } from "./dispose";

/** @entry Build edge lines off-thread; aborting terminates even a single large STL calculation. */
export async function createEdges(
  root: THREE.Object3D,
  angle: number,
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void
): Promise<THREE.Group> {
  const meshes: THREE.Mesh[] = [];
  root.traverse((node) => { if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh); });
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  const material = new THREE.LineBasicMaterial({ color: 0x2b3644 });
  const worker = new Worker(new URL("./edges.worker.ts", import.meta.url), { type: "module" });
  try {
    for (const [index, mesh] of meshes.entries()) {
      signal.throwIfAborted();
      const attribute = mesh.geometry.getAttribute("position");
      const position = new Float32Array(attribute.count * 3);
      if (attribute instanceof THREE.BufferAttribute && attribute.itemSize === 3 && !attribute.normalized) {
        position.set(attribute.array);
      } else {
        for (let i = 0; i < attribute.count; i++) {
          position.set([attribute.getX(i), attribute.getY(i), attribute.getZ(i)], i * 3);
        }
      }
      const indices = mesh.geometry.index ? new Uint32Array(mesh.geometry.index.array) : null;
      const result = await new Promise<Float32Array>((resolve, reject) => {
        const abort = (): void => { worker.terminate(); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        const finish = (): void => signal.removeEventListener("abort", abort);
        worker.onerror = (event) => { finish(); reject(new Error(event.message)); };
        worker.onmessage = (event: MessageEvent<{ position: Float32Array; error?: string }>) => {
          finish();
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.position);
        };
        worker.postMessage({ position, index: indices, angle }, indices ? [position.buffer, indices.buffer] : [position.buffer]);
      });
      signal.throwIfAborted();
      if (result.length) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(result, 3));
        const lines = new THREE.LineSegments(geometry, material);
        lines.matrixAutoUpdate = false;
        lines.matrix = mesh.matrixWorld;
        group.add(lines);
      }
      onProgress?.(index + 1, meshes.length);
    }
    if (!group.children.length) material.dispose();
    return group;
  } catch (error) {
    disposeObject(group);
    if (!group.children.length) material.dispose();
    throw error;
  } finally {
    worker.terminate();
  }
}
