import * as THREE from "three/webgpu";

/** Original transforms belong to each imported model, never to the UI slider. */
export type ExplodePart = {
  mesh: THREE.Mesh;
  matrix: THREE.Matrix4;
  autoUpdate: boolean;
  offset: THREE.Vector3;
};

/** @entry Find independent mesh roots and compute parent-local separation vectors. */
export function collectParts(root: THREE.Object3D, bounds: THREE.Box3): ExplodePart[] {
  root.updateWorldMatrix(true, true);
  const meshes: THREE.Mesh[] = [];
  const visit = (node: THREE.Object3D): void => {
    if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh);
    else node.children.forEach(visit);
  };
  visit(root);
  const center = bounds.getCenter(new THREE.Vector3());
  const distance = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.65, 0.001);
  return meshes.map((mesh, index) => {
    const partCenter = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    const direction = partCenter.clone().sub(center);
    if (direction.lengthSq() < distance * distance * 1e-8) {
      // Concentric components still need distinct, deterministic separation directions.
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      direction.set(Math.cos(angle), (index % 3) - 1, Math.sin(angle));
    }
    direction.multiplyScalar(1.8).addScaledVector(direction.clone().normalize(), distance * 0.35);
    const parentInverse = new THREE.Matrix4().copy(mesh.parent?.matrixWorld ?? new THREE.Matrix4()).invert();
    const offset = partCenter.clone().add(direction).applyMatrix4(parentInverse)
      .sub(partCenter.applyMatrix4(parentInverse));
    return { mesh, matrix: mesh.matrix.clone(), autoUpdate: mesh.matrixAutoUpdate, offset };
  });
}

/** Restore the exact local matrix at zero, including imported scale, rotation and shear. */
export function explodeParts(parts: ExplodePart[], ratio: number): void {
  for (const part of parts) {
    part.mesh.matrix.copy(part.matrix);
    part.mesh.matrixAutoUpdate = ratio === 0 ? part.autoUpdate : false;
    part.mesh.matrix.elements[12] += part.offset.x * ratio;
    part.mesh.matrix.elements[13] += part.offset.y * ratio;
    part.mesh.matrix.elements[14] += part.offset.z * ratio;
    part.mesh.matrixWorldNeedsUpdate = true;
  }
}
