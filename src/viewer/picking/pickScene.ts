import * as THREE from "three/webgpu";
import { float, instanceIndex, positionView, reference, uint, vec4, vertexIndex } from "three/tsl";
import { LineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";
import { edgeSourceMesh } from "../edges/buildEdges";
import { cadFaceSpans } from "../../loaders/cadFaces";

type PickableModel = Readonly<{
  id: string;
  edges: THREE.Group | null;
  parts: readonly { readonly mesh: THREE.Mesh }[];
}>;

export type PickEntity = Readonly<{
  modelId: string;
  mesh: THREE.Mesh;
  partIndex: number;
}>;

type PickEntry = {
  proxy: THREE.Mesh;
  entity: PickEntity;
};

/** Keep the shader identical across parts. The ID is a per-object uniform. */
function createPickMaterial(triangles: boolean): THREE.NodeMaterial {
  const material = new THREE.NodeMaterial();
  material.side = THREE.DoubleSide;
  material.blending = THREE.NoBlending;
  material.toneMapped = false;
  material.outputNode = vec4(
    reference("userData.pickId", "float", null),
    float(instanceIndex),
    positionView.z,
    triangles ? float(vertexIndex.div(uint(3)).add(uint(1))) : float(0)
  );
  return material;
}

/** Draw a slightly wider ID line, depth-tested against the same clipped surfaces. */
function createPickEdgeMaterial(): THREE.Line2NodeMaterial {
  const material = new THREE.Line2NodeMaterial({
    linewidth: 8, worldUnits: false, alphaToCoverage: false,
    toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4
  });
  material.outputNode = vec4(
    reference("userData.pickId", "float", null),
    float(0), positionView.z, float(instanceIndex.add(uint(1))).negate()
  );
  return material;
}

/** @entry Own pick proxies, sharing source geometry except where a triangle ID is needed. */
export class PickScene {
  readonly scene = new THREE.Scene();
  readonly detailScene = new THREE.Scene();
  private readonly clipping = new THREE.ClippingGroup();
  private readonly detailClipping = new THREE.ClippingGroup();
  private readonly entries = new Map<number, PickEntry>();
  private readonly edgeProxies = new Map<LineSegments2, LineSegments2>();
  private readonly edgesById = new Map<number, LineSegments2>();
  private readonly edgeClipping = new THREE.ClippingGroup();
  private readonly edgeMaterial = createPickEdgeMaterial();
  private readonly triangleGeometry = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  private readonly meshMaterial = createPickMaterial(false);
  private readonly triangleMaterial = createPickMaterial(true);
  private models: readonly PickableModel[] = [];
  private dirty = false;

  constructor() {
    this.scene.add(this.clipping, this.edgeClipping);
    this.detailScene.add(this.detailClipping);
  }

  setModels(models: readonly PickableModel[]): void {
    this.models = models;
    this.dirty = true;
    this.pruneEdges();
    // Prune immediately so a removed model can release its source and derived buffers.
    const liveMeshes = new Set(models.flatMap((model) => model.parts.map((part) => part.mesh)));
    const liveGeometry = new Set([...liveMeshes].map((mesh) => mesh.geometry));
    for (const [id, { proxy, entity }] of this.entries) {
      if (liveMeshes.has(entity.mesh)) continue;
      this.clipping.remove(proxy);
      this.entries.delete(id);
    }
    for (const [source, geometry] of this.triangleGeometry) {
      if (liveGeometry.has(source)) continue;
      geometry.dispose();
      this.triangleGeometry.delete(source);
    }
  }

  /** Reconcile on the first pick after a model change, outside the first visible frame. */
  private registerMeshes(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const existing = new Map([...this.entries.values()].map((entry) => [entry.entity.mesh, entry]));
    let id = 0;
    this.entries.clear();
    for (const model of this.models) {
      for (const [partIndex, { mesh }] of model.parts.entries()) {
        id++;
        const withTriangles = mesh.geometry.index === null || cadFaceSpans(mesh.geometry) !== null;
        const proxy = existing.get(mesh)?.proxy ?? this.createProxy(
          mesh, withTriangles ? this.triangles(mesh.geometry) : mesh.geometry,
          withTriangles ? this.triangleMaterial : this.meshMaterial
        );
        proxy.userData["pickId"] = id;
        if (proxy.parent === null) this.clipping.add(proxy);
        this.entries.set(id, { proxy, entity: { modelId: model.id, mesh, partIndex } });
      }
    }
  }

  sync(clippingPlanes: THREE.Plane[], includeEdges: boolean): void {
    this.registerMeshes();
    this.clipping.clippingPlanes = clippingPlanes;
    for (const { proxy, entity: { mesh } } of this.entries.values()) {
      mesh.updateWorldMatrix(true, false);
      proxy.visible = isVisible(mesh);
      this.syncProxy(proxy, mesh);
    }
    this.edgeClipping.visible = includeEdges;
    if (includeEdges) this.syncEdges(clippingPlanes);
  }

  private pruneEdges(): void {
    const live = new Set(this.models.flatMap((model) => model.edges?.children ?? []));
    for (const [line, proxy] of this.edgeProxies) {
      if (live.has(line)) continue;
      this.edgeClipping.remove(proxy);
      this.edgeProxies.delete(line);
    }
    this.edgesById.clear();
  }

  private syncEdges(planes: THREE.Plane[]): void {
    this.edgeClipping.clippingPlanes = planes;
    const ids = new Map([...this.entries].map(([id, { entity }]) => [entity.mesh, id]));
    this.edgesById.clear();
    for (const { edges } of this.models) {
      for (const line of edges?.children ?? []) {
        if (!(line instanceof LineSegments2)) continue;
        const mesh = edgeSourceMesh(line);
        const id = mesh === undefined ? undefined : ids.get(mesh);
        if (id === undefined) continue;
        const proxy = this.edgeProxies.get(line) ?? this.createEdgeProxy(line);
        proxy.visible = isVisible(line);
        proxy.userData["pickId"] = id;
        this.edgesById.set(id, line);
      }
    }
  }

  private createEdgeProxy(line: LineSegments2): LineSegments2 {
    const proxy = new LineSegments2(line.geometry, this.edgeMaterial);
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    proxy.matrixWorld = line.matrixWorld;
    proxy.renderOrder = 1;
    this.edgeClipping.add(proxy);
    this.edgeProxies.set(line, proxy);
    return proxy;
  }

  edgeLine(id: number): LineSegments2 | undefined {
    return this.edgesById.get(id);
  }

  entity(id: number): PickEntity | undefined {
    return this.entries.get(id)?.entity;
  }

  /** Indexed non-CAD surfaces only expand for a snap request on that mesh. */
  prepareDetail(id: number): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined || !entry.proxy.visible) return false;
    const { entity: { mesh } } = entry;
    const detail = this.createProxy(mesh, this.triangles(mesh.geometry), this.triangleMaterial);
    detail.userData["pickId"] = id;
    this.syncProxy(detail, mesh);
    this.detailClipping.clippingPlanes = this.clipping.clippingPlanes;
    this.detailClipping.add(detail);
    return true;
  }

  clearDetail(): void {
    this.detailClipping.clear();
  }

  dispose(): void {
    this.clearDetail();
    this.setModels([]);
    this.meshMaterial.dispose();
    this.triangleMaterial.dispose();
    this.edgeMaterial.dispose();
  }

  private triangles(source: THREE.BufferGeometry): THREE.BufferGeometry {
    if (source.index === null) return source;
    const cached = this.triangleGeometry.get(source);
    if (cached !== undefined) return cached;
    // Only expand attributes needed to move the vertices. Keep normals, UVs and colors shared
    // with the visible pass, where they are used for shading.
    const indexed = new THREE.BufferGeometry();
    indexed.setIndex(source.index);
    for (const name of ["position", "skinIndex", "skinWeight"]) {
      const attribute = source.getAttribute(name);
      if (attribute !== undefined) indexed.setAttribute(name, attribute);
    }
    if (source.morphAttributes.position !== undefined) {
      indexed.morphAttributes.position = source.morphAttributes.position;
    }
    indexed.morphTargetsRelative = source.morphTargetsRelative;
    const geometry = indexed.toNonIndexed();
    geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
    this.triangleGeometry.set(source, geometry);
    return geometry;
  }

  private createProxy(mesh: THREE.Mesh, geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
    const proxy = mesh instanceof THREE.InstancedMesh
      ? new THREE.InstancedMesh(geometry, material, 0)
      : mesh.clone(false);
    proxy.geometry = geometry;
    proxy.material = material;
    proxy.castShadow = false;
    proxy.receiveShadow = false;
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    return proxy;
  }

  private syncProxy(proxy: THREE.Mesh, mesh: THREE.Mesh): void {
    proxy.matrixWorld.copy(mesh.matrixWorld);
    proxy.morphTargetInfluences = mesh.morphTargetInfluences;
    if (proxy instanceof THREE.InstancedMesh && mesh instanceof THREE.InstancedMesh) {
      proxy.count = mesh.count;
      proxy.instanceMatrix = mesh.instanceMatrix;
      proxy.boundingSphere = mesh.boundingSphere;
      proxy.morphTexture = mesh.morphTexture;
    }
    if (proxy instanceof THREE.SkinnedMesh && mesh instanceof THREE.SkinnedMesh) {
      proxy.bindMatrixInverse.copy(mesh.bindMatrixInverse);
    }
  }
}

function isVisible(mesh: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = mesh; node !== null; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}
