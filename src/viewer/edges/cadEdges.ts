import type { EdgeRequest, EdgeSegments } from "./protocol";

type Boundary = { a: string; b: string; first: number; second: number; faces: number[] };

/** @entry Group tessellated boundary segments that connect the same pair of CAD faces. */
export function buildCadEdges({ positions, indices, faces }: EdgeRequest): EdgeSegments | null {
  if (faces.length === 0) return null;
  const vertexCount = indices?.length ?? positions.length / 3;
  let end = 0;
  for (const face of faces) {
    if (face.start !== end) return null;
    end += face.count;
  }
  if (end !== vertexCount) return null;
  const boundaries = new Map<string, Boundary>();
  const vertexKey = (vertex: number) => {
    const start = vertex * 3;
    return [positions[start], positions[start + 1], positions[start + 2]]
      .map((value) => Math.round(value * 10_000)).join(",");
  };
  const key = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;
  for (const [face, { start, count }] of faces.entries()) {
    const local = new Map<string, Boundary>();
    for (let offset = start; offset < start + count; offset += 3) {
      const vertices = [0, 1, 2].map((index) => indices?.[offset + index] ?? offset + index);
      const keys = vertices.map(vertexKey);
      if (new Set(keys).size !== 3) continue;
      for (let index = 0; index < 3; index++) {
        const next = (index + 1) % 3;
        const a = keys[index];
        const b = keys[next];
        const pair = key(a, b);
        if (!local.delete(pair)) local.set(pair, { a, b, first: vertices[index], second: vertices[next], faces: [face] });
      }
    }
    for (const [pair, boundary] of local) {
      const previous = boundaries.get(pair);
      if (previous === undefined) boundaries.set(pair, boundary);
      else previous.faces.push(face);
    }
  }

  const byFaces = new Map<string, Map<string, Boundary[]>>();
  for (const boundary of boundaries.values()) {
    const facePair = boundary.faces.join(",");
    let byVertex = byFaces.get(facePair);
    if (byVertex === undefined) byFaces.set(facePair, byVertex = new Map());
    for (const vertex of [boundary.a, boundary.b]) {
      const neighbors = byVertex.get(vertex);
      if (neighbors === undefined) byVertex.set(vertex, [boundary]);
      else neighbors.push(boundary);
    }
  }

  const packed = new Float32Array(boundaries.size * 6);
  const groupBySegment = new Uint32Array(boundaries.size);
  const starts = [0];
  let segment = 0;
  const visited = new Set<Boundary>();
  for (const byVertex of byFaces.values()) {
    const joints = new Set<string>();
    for (const [vertex, adjacent] of byVertex) {
      if (adjacent.length !== 2 || makesCorner(positions, vertex, adjacent[0], adjacent[1])) joints.add(vertex);
    }

    function walk(first: Boundary, start: string): void {
      let current: Boundary | undefined = first;
      let from = start;
      while (current !== undefined && !visited.has(current)) {
        visited.add(current);
        packed.set(positions.subarray(current.first * 3, current.first * 3 + 3), segment * 6);
        packed.set(positions.subarray(current.second * 3, current.second * 3 + 3), segment * 6 + 3);
        groupBySegment[segment++] = starts.length - 1;
        from = current.a === from ? current.b : current.a;
        const next = byVertex.get(from)!;
        current = joints.has(from) ? undefined : next[0] === current ? next[1] : next[0];
      }
      starts.push(segment);
    }

    for (const [vertex, adjacent] of byVertex) {
      if (!joints.has(vertex)) continue;
      for (const boundary of adjacent) if (!visited.has(boundary)) walk(boundary, vertex);
    }
    for (const [vertex, adjacent] of byVertex) {
      for (const boundary of adjacent) if (!visited.has(boundary)) walk(boundary, vertex);
    }
  }
  return { positions: packed, groups: { starts: Uint32Array.from(starts), groupBySegment } };
}


/** A sharp turn between segments on the same face boundary still marks a corner. */
function makesCorner(positions: Float32Array, vertex: string, a: Boundary, b: Boundary): boolean {
  const direction = (edge: Boundary) => {
    const from = (edge.a === vertex ? edge.first : edge.second) * 3;
    const to = (edge.a === vertex ? edge.second : edge.first) * 3;
    return [positions[to] - positions[from], positions[to + 1] - positions[from + 1],
      positions[to + 2] - positions[from + 2]];
  };
  const [ax, ay, az] = direction(a);
  const [bx, by, bz] = direction(b);
  const dot = ax * bx + ay * by + az * bz;
  return dot > -0.64 * Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz);
}
