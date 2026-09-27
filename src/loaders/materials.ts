import * as THREE from "three/webgpu";

/**
 * Shared surface material for formats that carry no material data (STL, OBJ without
 * .mtl, OpenCascade meshes without color).
 *
 * polygonOffset keeps "带边线" mode readable: the edge lines are drawn exactly on the
 * facet planes, so the surface has to be pushed a hair away from the camera.
 */
export function createDefaultModelMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xb9c3d2,
    metalness: 0.08,
    roughness: 0.55,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1
  });
}

export function createCadFaceMaterial(color: [number, number, number]): THREE.MeshStandardMaterial {
  const hasColor = color[0] > 0 || color[1] > 0 || color[2] > 0;
  const material = createDefaultModelMaterial();
  material.color = hasColor ? new THREE.Color(color[0], color[1], color[2]) : new THREE.Color(0xb9c3d2);
  return material;
}
