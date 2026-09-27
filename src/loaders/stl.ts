import * as THREE from "three/webgpu";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import type { ParsedModel } from "./types";
import { createDefaultModelMaterial } from "./materials";

export function loadStl(buffer: ArrayBuffer, fileName: string): ParsedModel {
  const geometry = new STLLoader().parse(buffer);
  if (geometry.getAttribute("normal") === undefined) {
    geometry.computeVertexNormals();
  }
  geometry.computeBoundingBox();

  const mesh = new THREE.Mesh(geometry, createDefaultModelMaterial());
  mesh.name = fileName;

  return { format: "stl", root: mesh, warnings: [] };
}
