import * as THREE from "three/webgpu";
import { cadFaceAt, type CadFaceSpan } from "../../loaders/cadFaces";

type PickableModel = Readonly<{
  id: string;
  root: THREE.Object3D;
  box: THREE.Box3;
  parts: readonly { readonly mesh: THREE.Mesh }[];
}>;

type PickSurfaceInput = Readonly<{
  models: readonly PickableModel[];
  camera: THREE.Camera;
  viewport: DOMRectReadOnly;
  planes: readonly THREE.Plane[];
  clientX: number;
  clientY: number;
  snap: boolean;
  /** The mesh the GPU pick already resolved; when set, the raycast only touches this one. */
  only?: THREE.Mesh | null;
}>;

export type SurfaceHit = Readonly<{
  modelId: string;
  mesh: THREE.Mesh;
  partIndex: number;
  triangleIndex: number | null;
  /** Local-space point on the mesh; null when the caller only needed the part. */
  localPoint: THREE.Vector3 | null;
  /** Original CAD face under the pointer, when the geometry was tessellated from one. */
  face: CadFaceSpan | null;
}>;

/** @entry Raycast the rendered model meshes, using the same clip half-spaces as the renderer. */
export function pickSurface(input: PickSurfaceInput): SurfaceHit | null {
  const { models, camera, viewport, planes, clientX, clientY, snap, only } = input;
  const x = (clientX - viewport.left) / viewport.width * 2 - 1;
  const y = 1 - (clientY - viewport.top) / viewport.height * 2;
  if (Math.abs(x) > 1 || Math.abs(y) > 1 || !viewport.width || !viewport.height) return null;
  const raycaster = new THREE.Raycaster();
  camera.updateMatrixWorld();
  raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
  const projected = new THREE.Vector3();
  function insideView(point: THREE.Vector3): boolean {
    const depth = projected.copy(point).project(camera).z;
    return depth >= -1 && depth <= 1 && planes.every((plane) => plane.distanceToPoint(point) >= -1e-7);
  }

  let closest: THREE.Intersection | undefined;
  let modelHit: PickableModel | undefined;
  for (const model of models) {
    if (!model.root.visible || !raycaster.ray.intersectsBox(model.box)) continue;
    const meshes: THREE.Mesh[] = [];
    if (only != null) {
      meshes.push(only);
    } else {
      model.root.traverseVisible((object) => {
        if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
      });
    }
    const hit = raycaster.intersectObjects(meshes, false).find(({ point }) => insideView(point));
    if (hit !== undefined && (closest === undefined || hit.distance < closest.distance)) {
      closest = hit;
      modelHit = model;
    }
  }
  if (closest === undefined || modelHit === undefined) return null;
  const mesh = closest.object as THREE.Mesh;
  let part: THREE.Object3D | null = mesh;
  let partIndex = -1;
  while (part !== null && partIndex === -1) {
    partIndex = modelHit.parts.findIndex(({ mesh: candidate }) => candidate === part);
    part = part.parent;
  }
  const localPoint = mesh.worldToLocal(closest.point.clone());
  if (snap && closest.face) {
    let tolerance = 12 ** 2;
    for (const index of [closest.face.a, closest.face.b, closest.face.c]) {
      const vertex = mesh.getVertexPosition(index, new THREE.Vector3());
      const world = mesh.localToWorld(vertex.clone());
      if (!insideView(world)) continue;
      const distance = ((projected.x - x) * viewport.width / 2) ** 2 + ((projected.y - y) * viewport.height / 2) ** 2;
      if (distance < tolerance) {
        localPoint.copy(vertex);
        tolerance = distance;
      }
    }
  }
  const triangleIndex = closest.faceIndex ?? null;
  return {
    modelId: modelHit.id, mesh, partIndex, localPoint, triangleIndex,
    face: cadFaceAt(mesh.geometry, triangleIndex)
  };
}
