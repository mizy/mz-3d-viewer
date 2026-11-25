import type { Vector3 } from "three/webgpu";

type MeasurementMode = "distance" | "angle";
type Measurement =
  | { kind: "distance"; length: number }
  | { kind: "angle"; degrees: number | null };

/** @entry Calculate a measurement from world-space points without modifying them. */
export function measurePoints(mode: MeasurementMode, points: readonly Vector3[]): Measurement | null {
  const [a, b, c] = points;
  if (!a || !b) return null;
  if (mode === "distance") return { kind: "distance", length: a.distanceTo(b) };
  if (!c) return null;
  const ab = a.clone().sub(b);
  const cb = c.clone().sub(b);
  const degrees = ab.lengthSq() === 0 || cb.lengthSq() === 0
    ? null
    : ab.angleTo(cb) * 180 / Math.PI;
  return { kind: "angle", degrees };
}

/** @entry Pick a scale length in the caller's display units. */
export function scaleForPixels(unitsPerPixel: number, maxPixels: number): { length: number; pixels: number } | null {
  const max = unitsPerPixel * maxPixels;
  if (!Number.isFinite(max) || max <= 0) return null;
  const order = 10 ** Math.floor(Math.log10(max));
  const length = (max >= order * 5 ? 5 : max >= order * 2 ? 2 : 1) * order;
  return { length, pixels: length / unitsPerPixel };
}
