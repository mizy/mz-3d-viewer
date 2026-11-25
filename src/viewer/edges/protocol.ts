import type { CadFaceSpan } from "../../loaders/cadFaces";

/** Copies of local-space geometry. The worker owns the transferred buffers. */
export type EdgeRequest = Readonly<{
  positions: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer> | null;
  angle: number;
  faces: readonly CadFaceSpan[];
}>;

export type EdgeGroups = Readonly<{
  /** Segment offsets of successive edges, including the final end offset. */
  starts: Uint32Array<ArrayBuffer>;
  groupBySegment: Uint32Array<ArrayBuffer>;
}>;

export type EdgeSegments = Readonly<{
  positions: Float32Array<ArrayBuffer>;
  groups: EdgeGroups | null;
}>;

export type EdgeResponse =
  | ({ ok: true } & EdgeSegments)
  | { ok: false; message: string };
