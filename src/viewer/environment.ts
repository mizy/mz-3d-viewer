import * as THREE from "three/webgpu";

type SoftBox = { u: number; v: number; radius: number; strength: number };

/**
 * Soft boxes placed in equirect space: one bright key above the horizon, one weaker fill behind it.
 * `radius` is the horizontal half width; the vertical falloff reuses it scaled by 1.6.
 */
const SOFT_BOXES: SoftBox[] = [
  { u: 0.7, v: 0.2, radius: 0.13, strength: 1 },
  { u: 0.22, v: 0.3, radius: 0.1, strength: 0.45 }
];

/**
 * A small procedural studio environment, generated in memory.
 *
 * Glass and bare metal only read as such through their reflections: a dielectric has ~4% Fresnel
 * reflectance, so with nothing to reflect a window stays invisible while its transmission quietly
 * shows whatever sits behind it. Shipping an HDR would break the offline-first promise (and add
 * megabytes), so the equirect map is painted here instead — a sky-to-floor gradient plus two soft
 * boxes, which is enough for glass highlights, paint depth and chrome contrast.
 */
export function createStudioEnvironment(): THREE.DataTexture {
  const width = 256;
  const height = 128;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const sky = Math.max(0, 1 - v * 2);
    const floor = Math.max(0, v * 2 - 1);
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      // A bright cool sky, a dark horizon band and a dim floor: the contrast between them is what
      // gives glass and paint a readable reflection.
      let r = 0.1 + sky * 0.75 + floor * 0.12;
      let g = 0.12 + sky * 0.8 + floor * 0.11;
      let b = 0.16 + sky * 0.9 + floor * 0.1;

      for (const box of SOFT_BOXES) {
        // Distance in equirect space, with the horizontal axis wrapped so the box does not tear.
        const raw = Math.abs(u - box.u);
        const du = Math.min(raw, 1 - raw) / box.radius;
        const dv = (v - box.v) / (box.radius * 1.6);
        const distance = Math.sqrt(du * du + dv * dv);
        if (distance >= 1) {
          continue;
        }
        const falloff = (1 - distance) ** 2 * box.strength;
        r += falloff;
        g += falloff * 0.98;
        b += falloff * 0.94;
      }

      const index = (y * width + x) * 4;
      data[index] = Math.min(1, r) * 255;
      data[index + 1] = Math.min(1, g) * 255;
      data[index + 2] = Math.min(1, b) * 255;
      data[index + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, width, height);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
