import * as THREE from "three/webgpu";

export type DisplayStyle = "solid" | "edges" | "wireframe" | "xray";
export type ModelAppearance = {
  surfaces: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[];
  xray: THREE.MeshBasicMaterial;
  highlight: THREE.MeshStandardMaterial;
};

/** Capture imported materials so temporary inspection styles never replace their source. */
export function createAppearance(root: THREE.Object3D): ModelAppearance {
  const surfaces: ModelAppearance["surfaces"] = [];
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) {
      const mesh = node as THREE.Mesh;
      surfaces.push({ mesh, material: mesh.material });
    }
  });
  return {
    surfaces,
    xray: new THREE.MeshBasicMaterial({ color: 0x75dbef, transparent: true, opacity: 0.18,
      depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    highlight: new THREE.MeshStandardMaterial({ color: 0xb7fbd8, emissive: 0x2c805c,
      emissiveIntensity: 0.5, roughness: 0.4, side: THREE.DoubleSide })
  };
}

/** @entry Material overrides are per mesh; shared imported materials retain their colors. */
export function applyAppearance(appearance: ModelAppearance, style: DisplayStyle, selected: THREE.Object3D | null): void {
  appearance.highlight.wireframe = style === "wireframe";
  for (const surface of appearance.surfaces) {
    let highlighted = false;
    for (let node: THREE.Object3D | null = surface.mesh; node; node = node.parent) {
      if (node === selected) { highlighted = true; break; }
    }
    for (const material of Array.isArray(surface.material) ? surface.material : [surface.material]) {
      if ("wireframe" in material) material.wireframe = style === "wireframe";
    }
    surface.mesh.material = highlighted ? appearance.highlight : style === "xray" ? appearance.xray : surface.material;
  }
}

export function disposeAppearance(appearance: ModelAppearance): void {
  for (const surface of appearance.surfaces) surface.mesh.material = surface.material;
  appearance.xray.dispose();
  appearance.highlight.dispose();
}
