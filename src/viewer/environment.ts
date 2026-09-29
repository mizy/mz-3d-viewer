import * as THREE from "three/webgpu";

type Light = {
  /** Centre in equirect fractions; u wraps around the seam. */
  u: number;
  v: number;
  halfU: number;
  halfV: number;
  /** Softness of the edge, as a fraction of the map. */
  feather: number;
  /** Linear radiance. Studio lights are far brighter than the ambient around them. */
  strength: number;
};

/**
 * A few small, very bright box lights over a near-black ambient, which is how a real studio HDR is
 * built. A box rather than a blob because a crisp edge is what reads as a reflection: this is the
 * light that puts the streak along a car's shoulder line.
 */
const LIGHTS: Light[] = [
  { u: 0.7, v: 0.2, halfU: 0.1, halfV: 0.06, feather: 0.03, strength: 18 },
  { u: 0.22, v: 0.32, halfU: 0.08, halfV: 0.05, feather: 0.03, strength: 7 },
  { u: 0.45, v: 0.5, halfU: 0.34, halfV: 0.015, feather: 0.02, strength: 5 }
];

/**
 * A studio environment, generated in memory as a half-float HDR map.
 *
 * Glass and painted metal only read as such through their reflections: a dielectric has ~4% Fresnel
 * reflectance, so with nothing to reflect a window stays invisible while its transmission quietly
 * shows the cabin behind it, and paint looks like flat plastic. Shipping an HDR would break the
 * offline-first promise, so the map is painted here instead.
 *
 * The values matter as much as the shapes: an 8-bit map clamps at 1.0, which leaves lit surfaces a
 * uniform wash — the reflections need to be far brighter than the ambient to punch. Half float keeps
 * them linear and unbounded while staying filterable everywhere, and because the ambient stays dark
 * the scene keeps its dark studio look instead of washing out.
 */
export function createStudioEnvironment(): THREE.DataTexture {
  const width = 256;
  const height = 128;
  const data = new Uint16Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const sky = Math.max(0, 1 - v * 2);
    const floor = Math.max(0, v * 2 - 1);
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      // Cool ambient above, a touch warmer below, so reflections have a readable horizon.
      let r = 0.02 + sky * 0.16 + floor * 0.03;
      let g = 0.025 + sky * 0.18 + floor * 0.03;
      let b = 0.035 + sky * 0.22 + floor * 0.03;

      for (const light of LIGHTS) {
        // Distance measured from the box surface, wrapped horizontally so lights do not tear at the seam.
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
      data[index] = THREE.DataUtils.toHalfFloat(r);
      data[index + 1] = THREE.DataUtils.toHalfFloat(g);
      data[index + 2] = THREE.DataUtils.toHalfFloat(b);
      data[index + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
