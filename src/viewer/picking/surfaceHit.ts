import * as THREE from "three/webgpu";
import { cadFaceAt, type CadFaceSpan } from "../../loaders/cadFaces";
import type { EdgeHit } from "../edges/buildEdges";
import type { PickSample } from "./pickPass";
import type { PickEntity } from "./pickScene";

export type SurfaceHit = PickEntity & Readonly<{
  triangleIndex: number | null;
  /** Mesh-local point, including any instance transform. */
  localPoint: THREE.Vector3 | null;
  face: CadFaceSpan | null;
  edge: EdgeHit | null;
}>;

type SurfaceHitOptions = Readonly<{
  camera: THREE.Camera;
  viewport: DOMRectReadOnly;
  planes: readonly THREE.Plane[];
  exact: boolean;
  snap: boolean;
  faceMode: boolean;
  edge: EdgeHit | null;
}>;

/** @entry Resolve the GPU hit and optionally snap to one of its triangle's three vertices. */
export function resolveSurfaceHit(entity: PickEntity, sample: PickSample, options: SurfaceHitOptions): SurfaceHit {
  let localPoint: THREE.Vector3 | null = null;
  if (options.exact) {
    const snapped = options.snap && sample.triangleIndex !== null
      ? snapVertex(entity.mesh, sample, sample.triangleIndex, options) : null;
    localPoint = entity.mesh.worldToLocal(snapped ?? unprojectDepth(sample, options.camera));
  }
  const triangle = sample.triangleIndex;
  const face = cadFaceAt(entity.mesh.geometry, triangle) ??
    (options.faceMode && triangle !== null ? { start: triangle * 3, count: 3 } : null);
  return {
    ...entity,
    triangleIndex: sample.triangleIndex,
    face,
    edge: options.edge,
    localPoint
  };
}

function snapVertex(
  mesh: THREE.Mesh, sample: PickSample, triangle: number, { camera, viewport, planes }: SurfaceHitOptions
): THREE.Vector3 | null {
  const geometry = mesh.geometry;
  const index = geometry.getIndex();
  const world = mesh.matrixWorld.clone();
  if (mesh instanceof THREE.InstancedMesh) {
    const instance = new THREE.Matrix4();
    mesh.getMatrixAt(sample.instanceIndex, instance);
    world.multiply(instance);
  }
  const candidate = new THREE.Vector3();
  const projected = new THREE.Vector3();
  let best: THREE.Vector3 | null = null;
  let distance = 12 ** 2;
  for (let offset = triangle * 3; offset < triangle * 3 + 3; offset++) {
    mesh.getVertexPosition(index === null ? offset : index.getX(offset), candidate).applyMatrix4(world);
    projected.copy(candidate).project(camera);
    if (projected.z < 0 || projected.z > 1 || planes.some((plane) => plane.distanceToPoint(candidate) < -1e-7)) continue;
    const pixels = ((projected.x - sample.ndcX) * viewport.width / 2) ** 2 + ((projected.y - sample.ndcY) * viewport.height / 2) ** 2;
    if (pixels >= distance) continue;
    best = candidate.clone();
    distance = pixels;
  }
  return best;
}


/** Intersect the pixel's view-space line with the sampled view Z for either camera projection. */
function unprojectDepth({ ndcX, ndcY, viewZ }: PickSample, camera: THREE.Camera): THREE.Vector3 {
  const near = new THREE.Vector3(ndcX, ndcY, 0).applyMatrix4(camera.projectionMatrixInverse);
  const inside = new THREE.Vector3(ndcX, ndcY, 0.5).applyMatrix4(camera.projectionMatrixInverse);
  const fraction = (viewZ - near.z) / (inside.z - near.z);
  return near.lerp(inside, fraction).applyMatrix4(camera.matrixWorld);
}
