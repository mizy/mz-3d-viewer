import { DirectionalLight, HemisphereLight } from "three/webgpu";
import { materialColor, mix, positionView, uniform } from "three/tsl";

/** @entry Side lighting and a depth cue in the existing surface shader pass. */
export function createInspectionLighting() {
  const key = new DirectionalLight(0xffffff, 3);
  key.position.set(-3, 7, 6);
  const fill = new DirectionalLight(0xffffff, 0.36);
  fill.position.set(5, 1, -3);
  const ambient = new HemisphereLight(0xffffff, 0x5b5b5b, 0.48);

  const focalDepth = uniform(0);
  const inverseDepthSpan = uniform(1);
  const depth = positionView.z.negate().sub(focalDepth)
    .mul(inverseDepthSpan).add(0.5).clamp(0, 1);
  const surfaceColor = materialColor.rgb.mul(mix(1.24, 0.62, depth));

  return {
    lights: [ambient, key, fill],
    surfaceColor,
    setDepthRange(focusDistance: number, radius: number): void {
      focalDepth.value = focusDistance;
      inverseDepthSpan.value = 1 / (2 * radius);
    }
  };
}
