import { BufferAttribute, BufferGeometry, EdgesGeometry } from "three";
import type { EdgeRequest, EdgeResponse, EdgeSegments } from "./protocol";
import { buildCadEdges } from "./cadEdges";

/** @entry Compute edge positions from local-space geometry and a crease angle. */
function extractEdges(request: EdgeRequest): EdgeSegments {
  const cad = buildCadEdges(request);
  if (cad !== null) return cad;
  const { positions, indices, angle } = request;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  if (indices !== null) geometry.setIndex(new BufferAttribute(indices, 1));
  try {
    const edges = new EdgesGeometry(geometry, angle);
    const result = edges.getAttribute("position").array as Float32Array<ArrayBuffer>;
    edges.dispose();
    return { positions: result, groups: null };
  } finally {
    geometry.dispose();
  }
}

self.onmessage = (event: MessageEvent<EdgeRequest>) => {
  try {
    const result = extractEdges(event.data);
    const transfer = [result.positions.buffer];
    if (result.groups !== null) transfer.push(result.groups.starts.buffer, result.groups.groupBySegment.buffer);
    self.postMessage({ ok: true, ...result } satisfies EdgeResponse, { transfer });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ ok: false, message } satisfies EdgeResponse);
  }
};
