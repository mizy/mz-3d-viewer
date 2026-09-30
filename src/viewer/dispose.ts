import * as THREE from "three/webgpu";

/** @entry Release resources owned by an imported root, including shared textures only once. */
export function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const bitmaps = new Set<ImageBitmap>();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh || (child as THREE.LineSegments).isLineSegments || (child as THREE.Points).isPoints) {
      geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    }
  });
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) textures.add(value);
    }
    material.dispose();
  }
  for (const texture of textures) {
    const images = Array.isArray(texture.image) ? texture.image : [texture.image];
    for (const image of images) {
      if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) bitmaps.add(image);
    }
    texture.dispose();
  }
  for (const bitmap of bitmaps) bitmap.close();
  for (const geometry of geometries) geometry.dispose();
}
