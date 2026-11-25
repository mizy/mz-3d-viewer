/** Copies of local-space geometry. The worker owns the transferred buffers. */
export type EdgeRequest = Readonly<{
  positions: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer> | null;
  angle: number;
}>;

export type EdgeResponse =
  | { ok: true; positions: Float32Array<ArrayBuffer> }
  | { ok: false; message: string };
