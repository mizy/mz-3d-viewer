import { BufferAttribute, BufferGeometry, EdgesGeometry } from "three";
import type { EdgeRequest, EdgeResponse } from "./protocol";

/** @entry Compute edge positions from local-space geometry and a crease angle. */
function extractEdges({ positions, indices, angle }: EdgeRequest): Float32Array<ArrayBuffer> {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  if (indices !== null) geometry.setIndex(new BufferAttribute(indices, 1));
  try {
    const edges = new EdgesGeometry(geometry, angle);
    const result = edges.getAttribute("position").array as Float32Array<ArrayBuffer>;
    edges.dispose();
    return result;
  } finally {
    geometry.dispose();
  }
}

self.onmessage = (event: MessageEvent<EdgeRequest>) => {
  try {
    const positions = extractEdges(event.data);
    self.postMessage({ ok: true, positions } satisfies EdgeResponse, { transfer: [positions.buffer] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ ok: false, message } satisfies EdgeResponse);
  }
};
