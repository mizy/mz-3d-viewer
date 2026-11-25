import { float, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";

/** Id 0 is reserved for "nothing was drawn at this pixel", so real ids start at 1. */
export const EMPTY_PICK_ID = 0;

/** Ids only need to be unique for the lifetime of the page, never across reloads. */
export function createIdAllocator(): () => number {
  let next = 1;
  return () => next++;
}

/**
 * Packs an id into three 8-bit channels.
 *
 * Render targets are not the output target, so three skips tone mapping and the sRGB conversion
 * for them (`Renderer.currentColorSpace` falls back to the working space). That is what lets the
 * bytes come back exactly as written instead of gamma-encoded.
 */
export function pickIdColor(id: number | Node<"float">) {
  const value = typeof id === "number" ? float(id) : id;
  return vec3(
    value.mod(256).div(255),
    value.div(256).floor().mod(256).div(255),
    value.div(65536).floor().mod(256).div(255)
  );
}

export function decodePickId(data: ArrayLike<number>): number {
  return data[0] + data[1] * 256 + data[2] * 65536;
}
