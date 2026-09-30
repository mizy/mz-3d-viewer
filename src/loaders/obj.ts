import * as THREE from "three/webgpu";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import type { ParsedModel } from "./types";
import { createDefaultModelMaterial } from "./materials";
import { loadWithFiles, type FileBundle } from "./files";

/**
 * OBJ carries no material data by itself: the .mtl file and the textures it references
 * are separate files. We resolve every referenced path through a LoadingManager URL
 * modifier that maps basenames onto object URLs of the files the user dropped.
 * Sibling files that were not dropped show up as a warning instead of a silent blank surface.
 */
export async function loadObj(objFile: File, bundle: FileBundle): Promise<ParsedModel> {
  const warnings: string[] = [];
  return loadWithFiles(bundle, warnings, async (manager) => {
    const objText = await objFile.text();

    const objBaseName = stripExtension(objFile.name);
    const mtlFile =
      bundle.byName.get(`${objBaseName}.mtl`.toLowerCase()) ??
      (bundle.files.length === 2 ? bundle.files.find((f) => f.name.toLowerCase().endsWith(".mtl")) : undefined);

    let materials: MTLLoader.MaterialCreator | null = null;
    if (mtlFile !== undefined) {
      const mtlLoader = new MTLLoader(manager);
      materials = mtlLoader.parse(await mtlFile.text(), "");
    } else {
      warnings.push("没有找到同名 .mtl，已用默认材质显示（贴图请和 .obj / .mtl 一起拖入）");
    }

    const objLoader = new OBJLoader(manager);
    if (materials !== null) {
      objLoader.setMaterials(materials);
    }
    const root = objLoader.parse(objText);

    let meshCount = 0;
    root.traverse((child) => {
      if ((child as THREE.Mesh).isMesh !== true) {
        return;
      }
      const mesh = child as THREE.Mesh;
      meshCount += 1;
      const geometry = mesh.geometry;
      if (geometry.getAttribute("normal") === undefined) {
        geometry.computeVertexNormals();
      }
      geometry.computeBoundingBox();
      if (mesh.material === undefined || mesh.material === null) {
        mesh.material = createDefaultModelMaterial();
      }
    });

    if (meshCount === 0) {
      throw new Error(`${objFile.name} 里没有可显示的网格（需要面数据 f ...）`);
    }

    return { format: "obj", root, warnings };
  });
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}
