import type { BufferGeometry } from "three/webgpu";

/** Original CAD face span, expressed as offsets into the geometry's index buffer. */
export type CadFaceSpan = Readonly<{ start: number; count: number }>;
type TessellatedFace = Readonly<{ first: number; last: number }>;

const facesByGeometry = new WeakMap<BufferGeometry, readonly CadFaceSpan[]>();

/** Register sorted, non-overlapping ranges supplied by the CAD tessellator. */
export function registerCadFaces(geometry: BufferGeometry, faces: readonly TessellatedFace[]): void {
  const triangles = (geometry.index?.count ?? geometry.getAttribute("position").count) / 3;
  const spans: CadFaceSpan[] = [];
  let previous = -1;
  for (const { first, last } of faces) {
    if (!Number.isInteger(first) || !Number.isInteger(last) ||
        first <= previous || last < first || last >= triangles) continue;
    spans.push({ start: first * 3, count: (last - first + 1) * 3 });
    previous = last;
  }
  if (spans.length) facesByGeometry.set(geometry, spans);
}

/** Sorted spans the tessellator declared for this geometry, or null when it is not a CAD mesh. */
export function cadFaceSpans(geometry: BufferGeometry): readonly CadFaceSpan[] | null {
  return facesByGeometry.get(geometry) ?? null;
}

/** @entry Look up an original CAD face from a renderer triangle index. */
export function cadFaceAt(geometry: BufferGeometry, triangle: number | null): CadFaceSpan | null {
  const faces = facesByGeometry.get(geometry);
  if (faces === undefined || triangle === null) return null;
  const offset = triangle * 3;
  let low = 0;
  let high = faces.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const span = faces[middle];
    if (offset < span.start) high = middle - 1;
    else if (offset >= span.start + span.count) low = middle + 1;
    else return span;
  }
  return null;
}
