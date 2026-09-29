import * as THREE from "three/webgpu";

type Light = {
  /** Centre in equirect fractions; u wraps around the seam. */
  u: number;
  v: number;
  halfU: number;
  halfV: number;
  /** Softness of the edge, as a fraction of the map. */
  feather: number;
  strength: number;
};

/**
 * Boxy lights rather than round blobs: a crisp edge is what reads as a reflection on glass or paint.
 * A key above the horizon, a weaker fill behind it, and a thin bright horizon band that gives every
 * glazed and painted surface a visible beltline.
 */
const LIGHTS: Light[] = [
  { u: 0.7, v: 0.22, halfU: 0.1, halfV: 0.06, feather: 0.035, strength: 1 },
  { u: 0.22, v: 0.34, halfU: 0.07, halfV: 0.05, feather: 0.035, strength: 0.42 },
  { u: 0.45, v: 0.5, halfU: 0.34, halfV: 0.02, feather: 0.025, strength: 0.5 }
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

      for (const light of LIGHTS) {
        // Distance in equirect space, measured from the box surface and wrapped horizontally so the
        // light does not tear at the seam.
        const raw = Math.abs(u - light.u);
        const du = Math.max(0, Math.min(raw, 1 - raw) - light.halfU) / light.feather;
        const dv = Math.max(0, Math.abs(v - light.v) - light.halfV) / light.feather;
        const distance = Math.sqrt(du * du + dv * dv);
        if (distance >= 1) {
          continue;
        }
        const falloff = (1 - distance) ** 2 * light.strength;
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
