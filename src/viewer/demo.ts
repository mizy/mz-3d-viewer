import * as THREE from "three/webgpu";
import type { ParsedModel } from "../loaders/types";

/** @entry A local, procedural assembly for trying explode without uploading a file. */
export function createDemo(): ParsedModel {
  const root = new THREE.Group();
  const silver = new THREE.MeshStandardMaterial({ color: 0xcbd7df, metalness: 0.65, roughness: 0.3 });
  const graphite = new THREE.MeshStandardMaterial({ color: 0x35424e, metalness: 0.6, roughness: 0.32 });
  const mint = new THREE.MeshStandardMaterial({ color: 0x9bffd5, metalness: 0.35, roughness: 0.25 });
  const add = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number): void => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(x, y, z);
    root.add(mesh);
  };
  add("底座", new THREE.CylinderGeometry(30, 32, 7, 64), graphite, 0, -17, 0);
  add("定子", new THREE.CylinderGeometry(25, 25, 16, 64), silver, 0, -5, 0);
  add("顶盖", new THREE.CylinderGeometry(30, 30, 5, 64), graphite, 0, 7, 0);
  add("轴心", new THREE.CylinderGeometry(7, 7, 22, 48), silver, 0, 18, 0);
  const ring = new THREE.TorusGeometry(21, 2, 12, 64);
  ring.rotateX(Math.PI / 2);
  add("密封圈", ring, mint, 0, 11, 0);
  for (let i = 0; i < 6; i += 1) {
    const angle = i * Math.PI / 3;
    add(`紧固件 ${i + 1}`, new THREE.CylinderGeometry(2.4, 2.4, 10, 6), silver,
      Math.cos(angle) * 26, 14, Math.sin(angle) * 26);
  }
  return { format: "gltf", root, sourceUnit: { label: "毫米 mm（内置示例）", mmPerUnit: 1 }, warnings: [] };
}
