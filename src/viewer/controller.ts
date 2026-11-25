import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ArcballControls } from "three/addons/controls/ArcballControls.js";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";

export type ControllerKind = "orbit" | "arcball" | "trackball";

export const CONTROLLER_LABEL: Record<ControllerKind, string> = {
  orbit: "轨道 Orbit",
  arcball: "旋转球 Arcball",
  trackball: "轨迹球 Trackball"
};

export function isControllerKind(value: string): value is ControllerKind {
  return Object.hasOwn(CONTROLLER_LABEL, value);
}

/**
 * What the stage needs from a camera controller. All three implementations orbit a focal
 * point, which is what keeps framing, section planes, NavCube and the screenshot path
 * unchanged when the user switches mid-session.
 */
export type CameraController = {
  /** The camera navigation model behind this instance. */
  readonly kind: ControllerKind;
  /** Focal point the camera orbits and looks at. Framing writes it, the acceptance scripts read it. */
  readonly target: THREE.Vector3;
  /**
   * Moves whatever pivot bookkeeping the controller keeps of its own, after the host shifted the
   * camera and the focal point together. Only Arcball needs it; see `ControllerHost.setPivot`.
   */
  shiftAnchor(delta: THREE.Vector3): void;
  update(): void;
  /** Rotates the camera around the focal point by a screen-space delta (NavCube drag / arrow keys). */
  rotateView(horizontal: number, vertical: number): void;
  /**
   * Re-reads the camera transform after the host moved it directly (fit, standard view, or every
   * frame of a scripted transition). A no-op for controllers that derive everything from the camera.
   */
  syncCamera(): void;
  /** Applies pending inertia now, so a scripted transition starts from a settled pose. */
  settle(): void;
  /** Canvas size changed; controllers that cache screen coordinates need to know. */
  handleResize(): void;
  /** Announces a host-driven camera change to "change" listeners (NavCube). */
  notifyChange(): void;
  addEventListener(type: "change", listener: () => void): void;
  dispose(): void;
};

const _offset = new THREE.Vector3();
const _axis = new THREE.Vector3();

/**
 * Orbits the camera without a controller: azimuth around the camera's own up axis, then pitch
 * around its right axis. Unlike a Y-up spherical conversion this still behaves for the top and
 * bottom standard views, where camera.up is ±Z rather than +Y.
 */
function orbitCamera(camera: THREE.Camera, target: THREE.Vector3, horizontal: number, vertical: number): void {
  _offset.copy(camera.position).sub(target);
  if (_offset.lengthSq() < 1e-12) {
    return;
  }
  _axis.copy(camera.up).normalize();
  _offset.applyAxisAngle(_axis, -horizontal);
  _axis.crossVectors(_offset, camera.up);
  if (_axis.lengthSq() > 1e-12) {
    _offset.applyAxisAngle(_axis.normalize(), vertical);
  }
  camera.position.copy(target).add(_offset);
  camera.lookAt(target);
}

/**
 * ArcballControls keeps a cached camera matrix that only its own gestures refresh, and it declares
 * neither the cache refresh nor `target` in the shipped typings (both exist at runtime).
 */
type ArcballInternals = {
  target: THREE.Vector3;
  updateMatrixState(): void;
  _gizmos?: THREE.Object3D;
  _currentTarget?: THREE.Vector3;
};

function arcballInternals(controls: ArcballControls): ArcballInternals {
  return controls as unknown as ArcballInternals;
}

class OrbitAdapter implements CameraController {
  readonly kind = "orbit" as const;
  private readonly controls: OrbitControls;

  constructor(camera: THREE.Camera, canvas: HTMLCanvasElement) {
    this.controls = new OrbitControls(camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
  }

  get target(): THREE.Vector3 {
    return this.controls.target;
  }

  update(): void {
    this.controls.update();
  }

  shiftAnchor(): void {}

  rotateView(horizontal: number, vertical: number): void {
    this.controls.rotateLeft(horizontal);
    this.controls.rotateUp(vertical);
    this.controls.update();
  }

  /** OrbitControls re-derives its spherical coordinates from the live camera on every update. */
  syncCamera(): void {}

  settle(): void {
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = damping;
  }

  handleResize(): void {}

  notifyChange(): void {
    this.controls.dispatchEvent({ type: "change" });
  }

  addEventListener(type: "change", listener: () => void): void {
    this.controls.addEventListener(type, listener);
  }

  dispose(): void {
    this.controls.dispose();
  }
}

class ArcballAdapter implements CameraController {
  readonly kind = "arcball" as const;
  private readonly controls: ArcballControls;
  private readonly internals: ArcballInternals;
  private readonly camera: THREE.Camera;

  constructor(camera: THREE.Camera, canvas: HTMLCanvasElement, scene: THREE.Scene) {
    this.camera = camera;
    this.controls = new ArcballControls(camera, canvas, scene);
    this.internals = arcballInternals(this.controls);
    // The gizmo sphere is an interaction aid; the host renders its own grid and nav cube.
    this.controls.setGizmosVisible(false);
    // Double-click focus would move the camera outside the host's transitions; keep the three
    // models comparable: rotate, pan and zoom only.
    this.controls.enableFocus = false;
    // Frame the model by distance, not by walking near/far: the stage owns those per framing.
    this.controls.adjustNearFar = false;
  }

  get target(): THREE.Vector3 {
    return this.internals.target;
  }

  update(): void {
    this.controls.update();
  }

  /**
   * Arcball rotates around its gizmo anchor and compares `target` with a cached copy every
   * update() — a target that moved without its anchor would rebuild the gizmo geometry. Carry
   * all three along with the host's shift instead.
   */
  shiftAnchor(delta: THREE.Vector3): void {
    const gizmos = this.internals._gizmos;
    if (gizmos !== undefined) {
      gizmos.position.add(delta);
      gizmos.updateMatrix();
    }
    this.internals._currentTarget?.add(delta);
  }

  rotateView(horizontal: number, vertical: number): void {
    this.reanchor();
    orbitCamera(this.camera, this.internals.target, horizontal, vertical);
    // Without this the next arcball gesture rebuilds the pose from its stale cached matrix and
    // snaps the camera back to wherever it was before the host moved it.
    this.syncCamera();
    this.notifyChange();
  }

  syncCamera(): void {
    this.camera.updateMatrix();
    this.internals.updateMatrixState();
  }

  settle(): void {
    const animations = this.controls.enableAnimations;
    this.controls.enableAnimations = false;
    this.controls.update();
    this.controls.enableAnimations = animations;
  }

  handleResize(): void {}

  notifyChange(): void {
    this.controls.dispatchEvent({ type: "change" });
  }

  addEventListener(type: "change", listener: () => void): void {
    this.controls.addEventListener(type, listener);
  }

  dispose(): void {
    this.controls.dispose();
  }

  /**
   * Arcball pans by moving its gizmo anchor while `target` stays put, and update() looks at the
   * anchor. Re-anchoring before a NavCube rotation keeps the pivot on the visible centre.
   */
  private reanchor(): void {
    const gizmos = this.internals._gizmos;
    if (gizmos !== undefined) {
      this.internals.target.copy(gizmos.position);
    }
  }
}

class TrackballAdapter implements CameraController {
  readonly kind = "trackball" as const;
  private readonly controls: TrackballControls;
  private readonly camera: THREE.Camera;

  constructor(camera: THREE.Camera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    this.controls = new TrackballControls(camera, canvas);
    this.controls.staticMoving = false;
    this.controls.dynamicDampingFactor = 0.14;
    this.controls.rotateSpeed = 1.1;
  }

  get target(): THREE.Vector3 {
    return this.controls.target;
  }

  update(): void {
    this.controls.update();
  }

  shiftAnchor(): void {}

  rotateView(horizontal: number, vertical: number): void {
    orbitCamera(this.camera, this.controls.target, horizontal, vertical);
    this.controls.update();
  }

  /** TrackballControls rebuilds its eye vector from the live camera and re-syncs its own cache. */
  syncCamera(): void {}

  settle(): void {
    const staticMoving = this.controls.staticMoving;
    this.controls.staticMoving = true;
    this.controls.update();
    this.controls.staticMoving = staticMoving;
  }

  handleResize(): void {
    this.controls.handleResize();
  }

  notifyChange(): void {
    this.controls.dispatchEvent({ type: "change" });
  }

  addEventListener(type: "change", listener: () => void): void {
    this.controls.addEventListener(type, listener);
  }

  dispose(): void {
    this.controls.dispose();
  }
}

function createController(kind: ControllerKind, camera: THREE.Camera, canvas: HTMLCanvasElement, scene: THREE.Scene): CameraController {
  switch (kind) {
    case "arcball":
      return new ArcballAdapter(camera, canvas, scene);
    case "trackball":
      return new TrackballAdapter(camera, canvas);
    default:
      return new OrbitAdapter(camera, canvas);
  }
}

/**
 * The object the stage holds. It stays alive across controller and camera switches so NavCube's
 * single "change" subscription and `stage.controls.target` reads keep working, whichever model and
 * whichever camera is active.
 */
export class ControllerHost implements CameraController {
  private current: CameraController;
  private readonly listeners = new Set<() => void>();
  /**
   * Called with the pivot whenever a drag actually rotates about it, so the stage can show its
   * marker. Fires once per frame that rotated, not once per press.
   */
  onPivotRotate: ((pivot: THREE.Vector3) => void) | null = null;
  /** World point a drag rotates around; null means "the focal point", the classic behaviour. */
  private pivot: THREE.Vector3 | null = null;
  /** Camera orientation at the last settled frame, to recover the rotation a controller applied. */
  private readonly pivotQuaternion = new THREE.Quaternion();
  private readonly appliedRotation = new THREE.Quaternion();
  private readonly pivotOffset = new THREE.Vector3();
  private readonly pivotShift = new THREE.Vector3();

  constructor(
    private camera: THREE.Camera,
    private readonly canvas: HTMLCanvasElement,
    private readonly scene: THREE.Scene,
    kind: ControllerKind
  ) {
    this.current = createController(kind, camera, canvas, scene);
    this.bridge();
  }

  get kind(): ControllerKind {
    return this.current.kind;
  }

  get target(): THREE.Vector3 {
    return this.current.target;
  }

  /**
   * Swaps the navigation model in place. The camera pose and focal point are carried over, because
   * ArcballControls' constructor re-aims the camera at the origin via setCamera().
   */
  setKind(kind: ControllerKind): void {
    if (kind === this.current.kind) {
      return;
    }
    this.rebuild(kind, this.camera);
  }

  /** Hand the same navigation model to another camera, e.g. when the projection changes. */
  setCamera(camera: THREE.Camera): void {
    if (camera === this.camera) {
      return;
    }
    this.camera = camera;
    this.rebuild(this.current.kind, camera);
  }

  update(): void {
    this.current.update();
    this.settlePivot();
  }

  /**
   * @entry Orbit around `point` from now on, without moving the image.
   *
   * All three controllers rotate about their focal point, and that focal point is pinned to the
   * centre of the screen by their own `lookAt` — so pressing on a part cannot simply move it.
   * The host instead re-expresses whatever they rotated as a rotation about `point`: rotating
   * about the focal point T and then translating by (I − R)(P − T) is exactly a rotation about P,
   * and translating the focal point along keeps the controller's `lookAt` consistent.
   */
  setPivot(point: THREE.Vector3): void {
    this.pivot = point.clone();
    this.pivotQuaternion.copy(this.camera.quaternion);
  }

  /** Forget the cursor pivot; the next rotation is about the focal point again. */
  clearPivot(): void {
    this.pivot = null;
  }

  shiftAnchor(delta: THREE.Vector3): void {
    this.current.shiftAnchor(delta);
  }

  /** See `setPivot`. Runs after every controller update, so it sees one drag step at a time. */
  private settlePivot(): void {
    const pivot = this.pivot;
    if (pivot === null || this.pivotQuaternion.equals(this.camera.quaternion)) return;
    // Damping approaches zero without reaching it. Ignoring what the eye cannot see keeps the
    // marker's linger timer from being pushed out by the last millionth of a degree.
    const dot = Math.min(1, Math.abs(this.pivotQuaternion.dot(this.camera.quaternion)));
    if (2 * Math.acos(dot) < 1e-4) {
      this.pivotQuaternion.copy(this.camera.quaternion);
      return;
    }
    const target = this.current.target;
    this.appliedRotation.copy(this.pivotQuaternion).invert().premultiply(this.camera.quaternion);
    this.onPivotRotate?.(pivot);
    this.pivotOffset.copy(pivot).sub(target);
    this.pivotShift.copy(this.pivotOffset).applyQuaternion(this.appliedRotation).negate().add(this.pivotOffset);
    this.pivotQuaternion.copy(this.camera.quaternion);
    // A rotation can move the camera by at most 2·|P − T|, so anything past that came from a
    // programmatic pose change that slipped through without clearing the pivot.
    if (this.pivotShift.length() > this.pivotOffset.length() * 4 + 1e-6) {
      this.pivot = null;
      return;
    }
    this.camera.position.add(this.pivotShift);
    target.add(this.pivotShift);
    this.current.shiftAnchor(this.pivotShift);
    this.current.syncCamera();
  }

  rotateView(horizontal: number, vertical: number): void {
    this.current.rotateView(horizontal, vertical);
  }

  syncCamera(): void {
    this.current.syncCamera();
  }

  settle(): void {
    this.current.settle();
  }

  handleResize(): void {
    this.current.handleResize();
  }

  notifyChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  addEventListener(_type: "change", listener: () => void): void {
    this.listeners.add(listener);
  }

  dispose(): void {
    this.current.dispose();
    this.listeners.clear();
  }

  private bridge(): void {
    this.current.addEventListener("change", () => this.notifyChange());
  }

  /** A fresh controller for the given model and camera, carrying the pose and focal point over. */
  private rebuild(kind: ControllerKind, camera: THREE.Camera): void {
    this.pivot = null;
    const focal = this.current.target.clone();
    const position = camera.position.clone();
    const quaternion = camera.quaternion.clone();
    const up = camera.up.clone();
    this.current.dispose();
    this.current = createController(kind, camera, this.canvas, this.scene);
    camera.position.copy(position);
    camera.quaternion.copy(quaternion);
    camera.up.copy(up);
    this.current.target.copy(focal);
    this.current.update();
    this.current.syncCamera();
    this.bridge();
    this.notifyChange();
  }
}
