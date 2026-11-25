import * as THREE from "three/webgpu";
import { attribute } from "three/tsl";
import { cadFaceSpans, type CadFaceSpan } from "../../loaders/cadFaces";
import { createIdAllocator, pickIdColor } from "./pickIds";

export type PickableModel = Readonly<{
  id: string;
  parts: readonly { readonly mesh: THREE.Mesh }[];
}>;

/** What one pick id resolves to. Face is null for meshes that carry no CAD face spans. */
export type PickEntity = Readonly<{
  modelId: string;
  mesh: THREE.Mesh;
  partIndex: number;
  face: CadFaceSpan | null;
}>;

/**
 * One pick id per vertex, so the pick pass resolves the CAD face directly on the GPU. Built once
 * per geometry: rebuilding it on every scene change would cost an index-buffer walk per load, and
 * ids are stable for the page's lifetime anyway.
 */
const faceIdsByGeometry = new WeakMap<THREE.BufferGeometry, { readonly ids: readonly number[] }>();
/** Mesh-level fallback for STL/OBJ/glTF: one id for the whole mesh. */
const idsByMesh = new WeakMap<THREE.Mesh, number>();
const takeId = createIdAllocator();

function meshId(mesh: THREE.Mesh): number {
  let id = idsByMesh.get(mesh);
  if (id === undefined) {
    id = takeId();
    idsByMesh.set(mesh, id);
  }
  return id;
}

function ensureFaceIds(geometry: THREE.BufferGeometry): { readonly ids: readonly number[] } | null {
  const cached = faceIdsByGeometry.get(geometry);
  if (cached !== undefined) return cached;
  const spans = cadFaceSpans(geometry);
  if (spans === null) return null;

  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const vertices = new Float32Array(position.count);
  const ids = spans.map(() => takeId());
  spans.forEach((span, spanIndex) => {
    const id = ids[spanIndex];
    for (let offset = span.start; offset < span.start + span.count; offset += 1) {
      const vertex = index === null ? offset : index.getX(offset);
      if (vertex < vertices.length) vertices[vertex] = id;
    }
  });
  geometry.setAttribute("cadFaceId", new THREE.BufferAttribute(vertices, 1));
  const entry = { ids };
  faceIdsByGeometry.set(geometry, entry);
  return entry;
}

function createFaceMaterial(): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, toneMapped: false });
  material.colorNode = pickIdColor(attribute("cadFaceId", "float"));
  return material;
}

/**
 * @entry A second scene holding one proxy per pickable mesh. The proxies share geometry with the
 * real meshes and write a pick id instead of a shaded colour; nothing is copied per frame except
 * the world matrix.
 */
export class PickScene {
  readonly scene = new THREE.Scene();
  private readonly clipping = new THREE.ClippingGroup();
  private readonly entries: { proxy: THREE.Mesh; mesh: THREE.Mesh }[] = [];
  private readonly entities = new Map<number, PickEntity>();
  private readonly materials = new Set<THREE.Material>();
  private readonly faceMaterial = createFaceMaterial();

  constructor() {
    this.scene.add(this.clipping);
  }

  /** Rebuild after any model was added or removed. Cheap enough to redo wholesale. */
  rebuild(models: readonly PickableModel[]): void {
    this.clear();
    const claimed = new Set<THREE.BufferGeometry>();
    for (const model of models) {
      for (const [partIndex, part] of model.parts.entries()) {
        const mesh = part.mesh;
        const faces = claimed.has(mesh.geometry) ? null : ensureFaceIds(mesh.geometry);
        if (faces === null) {
          const id = meshId(mesh);
          this.entities.set(id, { modelId: model.id, mesh, partIndex, face: null });
          this.addProxy(mesh, this.meshMaterial(id));
          continue;
        }
        claimed.add(mesh.geometry);
        const spans = cadFaceSpans(mesh.geometry) ?? [];
        faces.ids.forEach((id, index) => {
          this.entities.set(id, { modelId: model.id, mesh, partIndex, face: spans[index] ?? null });
        });
        this.addProxy(mesh, this.faceMaterial);
      }
    }
  }

  /** Mirror visibility, world matrices and the section planes the real scene is showing. */
  sync(clippingPlanes: readonly THREE.Plane[]): void {
    this.clipping.clippingPlanes = clippingPlanes as THREE.Plane[];
    for (const { proxy, mesh } of this.entries) {
      mesh.updateWorldMatrix(true, false);
      proxy.matrixWorld.copy(mesh.matrixWorld);
      proxy.visible = isVisible(mesh);
    }
  }

  entity(id: number): PickEntity | null {
    return this.entities.get(id) ?? null;
  }

  dispose(): void {
    this.clear();
    this.faceMaterial.dispose();
  }

  private addProxy(mesh: THREE.Mesh, material: THREE.Material): void {
    const proxy = new THREE.Mesh(mesh.geometry, material);
    proxy.name = `pick:${mesh.name}`;
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    // Matrices are copied from the live mesh, so a bounding sphere computed at build time would
    // be a lie the moment a part explodes.
    proxy.frustumCulled = false;
    this.clipping.add(proxy);
    this.entries.push({ proxy, mesh });
  }

  private meshMaterial(id: number): THREE.Material {
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, toneMapped: false });
    material.colorNode = pickIdColor(id);
    this.materials.add(material);
    return material;
  }

  private clear(): void {
    for (const { proxy } of this.entries) this.clipping.remove(proxy);
    this.entries.length = 0;
    this.entities.clear();
    for (const material of this.materials) material.dispose();
    this.materials.clear();
  }
}

function isVisible(mesh: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = mesh; node !== null; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}
