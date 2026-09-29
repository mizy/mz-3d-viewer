import * as THREE from "three/webgpu";
import { ControllerHost, type ControllerKind } from "./controller";
import { createStudioEnvironment } from "./environment";
import { collectParts, explodeParts, type ExplodePart } from "./explode";
import type { ParsedModel } from "../loaders/types";
import { createAppearance, applyAppearance, disposeAppearance, type ModelAppearance, type DisplayStyle } from "./appearance";
export type { DisplayStyle } from "./appearance";
export type { ControllerKind } from "./controller";
export type StandardView = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso";
export type MeasurementUnit = "mm" | "cm" | "m" | "in";
export type SectionAxis = "x" | "y" | "z";

export type ModelStats = {
  vertices: number;
  triangles: number;
  bytes: number;
  /** Bounding box size in source units (mm for CAD/STL, assumed mm for everything else). */
  size: THREE.Vector3;
};

export type ModelHandle = {
  id: string;
  name: string;
  format: string;
  root: THREE.Object3D;
  bytes: number;
  box: THREE.Box3;
  stats: ModelStats;
  edges: THREE.Group | null;
  edgeAngleUsed: number | null;
  parts: ExplodePart[];
  appearance: ModelAppearance;
  selectedPart: number | null;
  explode: number;
  /** Null until this model first uses the explode control. */
  explodeTarget: number | null;
  explodeTransition: { from: number; started: number } | null;
};

export type EdgeProgress = (done: number, total: number) => void;

const VIEW_DIRECTIONS: Record<StandardView, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, -1),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  top: new THREE.Vector3(0, 1, 0),
  bottom: new THREE.Vector3(0, -1, 0),
  iso: new THREE.Vector3(1, 0.8, 1)
};

const UNIT_SCALE: Record<MeasurementUnit, number> = { mm: 1, cm: 0.1, m: 0.001, in: 1 / 25.4 };

/** Converts a length measured in source units (assumed mm) into the unit the user reads. */
export function convertLength(valueInMm: number, unit: MeasurementUnit): number {
  return valueInMm * UNIT_SCALE[unit];
}

/**
 * Owns the three.js scene graph, camera, lights and the render loop.
 * Every public method that mutates rendering state is called from the UI layer; this class
 * never touches the DOM except for the canvas it renders into.
 */
export class Stage {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Stable across controller switches: NavCube and the acceptance scripts hold on to it. */
  readonly controls: ControllerHost;

  private readonly canvas: HTMLCanvasElement;
  private readonly grid: THREE.GridHelper;
  /** Reflections: without these, glass and bare metal have nothing to mirror. */
  private readonly environment = createStudioEnvironment();
  private environmentOn = true;
  /** ClippingGroup is the WebGPU-build way to clip: the planes live in the scene graph. */
  private readonly clippingGroup = new THREE.ClippingGroup();
  private readonly models: ModelHandle[] = [];
  private activeId: string | null = null;
  private displayStyle: DisplayStyle = "solid";
  private sectionEnabled = false;
  private sectionAxis: SectionAxis = "x";
  private sectionRatio = 0.5;
  private captureResolve: ((dataUrl: string) => void) | null = null;
  private nextModelIndex = 1;
  private viewTransition: {
    started: number;
    fromRotation: THREE.Quaternion;
    rotation: THREE.Quaternion;
    fromTarget: THREE.Vector3;
    target: THREE.Vector3;
    fromDistance: number;
    distance: number;
    up: THREE.Vector3;
  } | null = null;

  constructor(renderer: THREE.WebGPURenderer, canvas: HTMLCanvasElement) {
    this.renderer = renderer;
    this.canvas = canvas;

    this.scene.background = new THREE.Color(0x090d12);
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 1.2;
    this.scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x1b2029, 1.6));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
    keyLight.position.set(4, 7, 5);
    this.scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x9fb8ff, 1.1);
    fillLight.position.set(-5, 2, -4);
    this.scene.add(fillLight);
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.7);
    rimLight.position.set(0, -6, 0);
    this.scene.add(rimLight);

    this.grid = new THREE.GridHelper(400, 40, 0x28413c, 0x19272a);
    this.scene.add(this.grid);
    this.scene.add(this.clippingGroup);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.position.set(70, 55, 70);
    this.camera.lookAt(0, 0, 0);

    this.controls = new ControllerHost(this.camera, canvas, this.scene, "orbit");
    // Any direct canvas gesture takes over from a scripted transition, whatever controller is
    // active (OrbitControls' own "start" event has no equivalent on the other two).
    const interrupt = (): void => { this.viewTransition = null; };
    canvas.addEventListener("pointerdown", interrupt);
    canvas.addEventListener("wheel", interrupt, { passive: true });

    this.renderer.setAnimationLoop(() => this.renderFrame());
  }

  // ---------------------------------------------------------------- models

  get modelList(): readonly ModelHandle[] {
    return this.models;
  }

  get active(): ModelHandle | null {
    return this.models.find((model) => model.id === this.activeId) ?? null;
  }

  addModel(parsed: ParsedModel, fileName: string): ModelHandle {
    const handle: ModelHandle = {
      id: `model-${this.nextModelIndex++}`,
      name: fileName,
      format: parsed.format,
      root: parsed.root,
      bytes: 0,
      box: new THREE.Box3(),
      stats: { vertices: 0, triangles: 0, bytes: 0, size: new THREE.Vector3() },
      edges: null,
      edgeAngleUsed: null,
      parts: [],
      appearance: createAppearance(parsed.root),
      selectedPart: null,
      explode: 0,
      explodeTarget: null,
      explodeTransition: null
    };
    this.clippingGroup.add(handle.root);
    this.recomputeBounds(handle);
    handle.parts = collectParts(handle.root, handle.box);
    this.models.push(handle);
    this.setActive(handle.id);
    return handle;
  }

  setBytes(handleId: string, bytes: number): void {
    const handle = this.find(handleId);
    if (handle === null) {
      return;
    }
    handle.bytes = bytes;
    handle.stats.bytes = bytes;
  }

  removeModel(handleId: string): void {
    this.viewTransition = null;
    const index = this.models.findIndex((model) => model.id === handleId);
    if (index < 0) {
      return;
    }
    const handle = this.models[index];
    this.clippingGroup.remove(handle.root);
    disposeAppearance(handle.appearance);
    disposeObject(handle.root);
    if (handle.edges !== null) {
      this.clippingGroup.remove(handle.edges);
      disposeObject(handle.edges);
    }
    this.models.splice(index, 1);

    if (this.activeId === handleId) {
      const next = this.models[Math.max(0, index - 1)];
      this.activeId = next === undefined ? null : next.id;
    }
    this.applySection();
  }

  setActive(handleId: string): void {
    if (this.models.some((model) => model.id === handleId)) {
      this.viewTransition = null;
      this.activeId = handleId;
      this.applySection();
    }
  }

  setVisible(handleId: string, visible: boolean): void {
    const handle = this.find(handleId);
    if (handle === null) {
      return;
    }
    handle.root.visible = visible;
    if (handle.edges !== null) {
      handle.edges.visible = visible && this.displayStyle === "edges";
    }
  }

  isVisible(handleId: string): boolean {
    const handle = this.find(handleId);
    return handle !== null && handle.root.visible;
  }

  private find(handleId: string): ModelHandle | null {
    return this.models.find((model) => model.id === handleId) ?? null;
  }

  /** Initial assembled bounds and physical statistics, independent of explode offsets. */
  private recomputeBounds(handle: ModelHandle): void {
    const box = new THREE.Box3().setFromObject(handle.root);
    if (box.isEmpty()) {
      handle.box = new THREE.Box3();
      return;
    }
    handle.box = box;
    let vertices = 0;
    let triangles = 0;
    handle.root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh !== true) {
        return;
      }
      const position = mesh.geometry.getAttribute("position");
      const index = mesh.geometry.getIndex();
      vertices += position.count;
      triangles += index === null ? Math.floor(position.count / 3) : Math.floor(index.count / 3);
    });
    handle.stats.vertices = vertices;
    handle.stats.triangles = triangles;
    handle.stats.size = box.getSize(new THREE.Vector3());
  }

  selectPart(index: number | null): void {
    const handle = this.active;
    if (!handle || (index !== null && !handle.parts[index])) return;
    handle.selectedPart = index;
    applyAppearance(handle.appearance, this.displayStyle, index === null ? null : handle.parts[index].mesh);
  }

  setPartVisible(index: number, visible: boolean): void {
    const handle = this.active;
    if (!handle?.parts[index]) return;
    handle.parts[index].mesh.visible = visible;
    this.syncEdgeVisibility(handle);
  }

  isolatePart(index: number): void {
    const handle = this.active;
    if (!handle?.parts[index]) return;
    this.setVisible(handle.id, true);
    handle.parts.forEach((part, partIndex) => { part.mesh.visible = partIndex === index; });
    this.selectPart(index);
    this.syncEdgeVisibility(handle);
  }

  showAllParts(): void {
    const handle = this.active;
    if (!handle) return;
    this.setVisible(handle.id, true);
    for (const part of handle.parts) part.mesh.visible = true;
    this.syncEdgeVisibility(handle);
  }

  private syncEdgeVisibility(handle: ModelHandle): void {
    if (!handle.edges) return;
    const visibleMatrices = new Set(handle.appearance.surfaces.filter(({ mesh }) => {
      for (let node: THREE.Object3D | null = mesh; node && node !== handle.root; node = node.parent) {
        if (!node.visible) return false;
      }
      return mesh.visible;
    }).map(({ mesh }) => mesh.matrixWorld));
    for (const line of handle.edges.children) line.visible = visibleMatrices.has(line.matrix);
  }

  // ---------------------------------------------------------------- display style

  get style(): DisplayStyle {
    return this.displayStyle;
  }

  /**
   * Edge lines are built lazily: EdgesGeometry over a multi-million-triangle STL is slow,
   * so it only happens when the user actually asks for that mode.
   */
  async setDisplayStyle(style: DisplayStyle, onEdgeProgress?: EdgeProgress): Promise<void> {
    this.displayStyle = style;
    for (const handle of this.models) {
      applyAppearance(handle.appearance, style, handle.selectedPart === null ? null : handle.parts[handle.selectedPart].mesh);
      if (style !== "edges") {
        if (handle.edges !== null) {
          handle.edges.visible = false;
        }
        continue;
      }
      await this.ensureEdges(handle, onEdgeProgress);
      if (handle.edges !== null) {
        handle.edges.visible = handle.root.visible && this.displayStyle === "edges";
      }
    }
  }

  setEdgeAngle(angleDeg: number): void {
    for (const handle of this.models) {
      if (handle.edges !== null) {
        this.clippingGroup.remove(handle.edges);
        disposeObject(handle.edges);
        handle.edges = null;
        handle.edgeAngleUsed = null;
      }
    }
    this.currentEdgeAngle = angleDeg;
  }

  private currentEdgeAngle = 30;

  edgeAngle(): number {
    return this.currentEdgeAngle;
  }

  private async ensureEdges(handle: ModelHandle, onProgress?: EdgeProgress): Promise<void> {
    if (handle.edges !== null && handle.edgeAngleUsed === this.currentEdgeAngle) {
      return;
    }
    if (handle.edges !== null) {
      this.clippingGroup.remove(handle.edges);
      disposeObject(handle.edges);
      handle.edges = null;
    }
    const angle = this.currentEdgeAngle;
    const meshes: THREE.Mesh[] = [];
    handle.root.traverse((child) => {
      if ((child as THREE.Mesh).isMesh === true) {
        meshes.push(child as THREE.Mesh);
      }
    });

    const group = new THREE.Group();
    group.name = `${handle.name}-edges`;
    const material = new THREE.LineBasicMaterial({ color: 0x2b3644 });
    let done = 0;
    for (const mesh of meshes) {
      const edges = new THREE.EdgesGeometry(mesh.geometry, angle);
      if (edges.getAttribute("position").count > 0) {
        const lines = new THREE.LineSegments(edges, material);
        lines.matrixAutoUpdate = false;
        // Share the live source transform so edges follow exploded parts.
        lines.matrix = mesh.matrixWorld;
        group.add(lines);
      } else {
        edges.dispose();
      }
      done += 1;
      onProgress?.(done, meshes.length);
      // Yield so a big assembly does not block the frame loop.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!this.models.includes(handle) || angle !== this.currentEdgeAngle || handle.edges !== null) {
      disposeObject(group);
      return;
    }
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    handle.edges = group;
    handle.edgeAngleUsed = angle;
    this.clippingGroup.add(group);
    this.syncEdgeVisibility(handle);
  }

  /** @entry Explode only the active model; physical dimensions remain assembled dimensions. */
  setExplode(ratio: number, animate = true): void {
    const handle = this.active;
    if (handle === null || handle.parts.length < 2) return;
    const from = handle.explode;
    const target = THREE.MathUtils.clamp(ratio, 0, 1);
    const animated = animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    handle.explodeTarget = target;
    handle.explodeTransition = animated ? { from, started: performance.now() } : null;
    // Frame the destination, then restore the current pose before the next rendered frame.
    this.applyExplode(handle, target);
    this.fitToActive(animated);
    if (animated) this.applyExplode(handle, from);
  }

  private applyExplode(handle: ModelHandle, ratio: number): void {
    handle.explode = ratio;
    explodeParts(handle.parts, handle.explode);
    handle.box.setFromObject(handle.root);
    if (handle === this.active) this.applySection();
    const radius = handle.box.getBoundingSphere(new THREE.Sphere()).radius;
    this.camera.far = Math.max(this.camera.far, this.camera.position.distanceTo(this.controls.target) + radius * 20);
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- camera / section

  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
  }

  get controllerKind(): ControllerKind {
    return this.controls.kind;
  }

  /** Reflections on or off; off is the flat, purely analytic lighting the viewer started with. */
  get environmentEnabled(): boolean {
    return this.environmentOn;
  }

  setEnvironment(enabled: boolean): void {
    this.environmentOn = enabled;
    this.scene.environment = enabled ? this.environment : null;
  }

  /** Swaps the camera navigation model, keeping the current pose and focal point. */
  setController(kind: ControllerKind): void {
    if (kind === this.controls.kind) {
      return;
    }
    this.viewTransition = null;
    this.controls.settle();
    this.controls.setKind(kind);
  }

  setSection(enabled: boolean, axis: SectionAxis, ratio: number): void {
    this.sectionEnabled = enabled;
    this.sectionAxis = axis;
    this.sectionRatio = ratio;
    this.applySection();
  }

  private applySection(): void {
    const handle = this.active;
    if (!this.sectionEnabled || handle === null || handle.box.isEmpty()) {
      this.clippingGroup.clippingPlanes = [];
      return;
    }
    const cut = handle.box.min[this.sectionAxis] + (handle.box.max[this.sectionAxis] - handle.box.min[this.sectionAxis]) * this.sectionRatio;
    const normal = new THREE.Vector3(
      this.sectionAxis === "x" ? -1 : 0,
      this.sectionAxis === "y" ? -1 : 0,
      this.sectionAxis === "z" ? -1 : 0
    );
    this.clippingGroup.clippingPlanes = [new THREE.Plane(normal, cut)];
  }

  fitToActive(animate = false): void {
    const handle = this.active;
    if (handle && !handle.box.isEmpty()) this.fitBounds(handle.box, animate);
  }

  fitToPart(index: number): void {
    const part = this.active?.parts[index];
    if (!part) return;
    this.setVisible(this.active!.id, true);
    this.setPartVisible(index, true);
    this.fitBounds(new THREE.Box3().setFromObject(part.mesh), true);
  }

  private fitBounds(box: THREE.Box3, animate: boolean): void {
    this.viewTransition = null;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.001);
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const fov = Math.min(verticalFov, 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect));
    const distance = (radius / Math.sin(fov / 2)) * 1.08;
    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-9) {
      direction.copy(VIEW_DIRECTIONS.iso);
    }
    direction.normalize();

    if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.viewTransition = {
        started: performance.now(), fromRotation: this.camera.quaternion.clone(), rotation: this.camera.quaternion.clone(),
        fromTarget: this.controls.target.clone(), target: sphere.center,
        fromDistance: this.camera.position.distanceTo(this.controls.target), distance, up: this.camera.up.clone()
      };
    } else {
      this.controls.target.copy(sphere.center);
      this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
    }
    this.camera.near = Math.max(radius / 1000, 0.01);
    this.camera.far = Math.max(distance, this.viewTransition?.fromDistance ?? distance) + radius * 20;
    this.camera.updateProjectionMatrix();
    this.grid.position.set(sphere.center.x, box.min.y, sphere.center.z);
    this.controls.update();
    this.controls.syncCamera();
  }

  setStandardView(view: StandardView, animate = true): void {
    const handle = this.active;
    const target = handle === null || handle.box.isEmpty()
      ? new THREE.Vector3(0, 0, 0)
      : handle.box.getBoundingSphere(new THREE.Sphere()).center;
    const radius = handle === null || handle.box.isEmpty()
      ? 60
      : Math.max(handle.box.getBoundingSphere(new THREE.Sphere()).radius, 0.001);
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const fov = Math.min(verticalFov, 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect));
    const distance = (radius / Math.sin(fov / 2)) * 1.08;

    const up = view === "top" || view === "bottom"
      ? new THREE.Vector3(0, 0, view === "top" ? -1 : 1)
      : new THREE.Vector3(0, 1, 0);
    const direction = VIEW_DIRECTIONS[view].clone().normalize();
    const rotation = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), up)
    );
    // Drain any pending inertia before handing the camera to the transition.
    this.controls.settle();
    this.viewTransition = null;
    if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.viewTransition = {
        started: performance.now(), fromRotation: this.camera.quaternion.clone(), rotation,
        fromTarget: this.controls.target.clone(), target,
        fromDistance: this.camera.position.distanceTo(this.controls.target), distance, up
      };
    } else {
      this.camera.up.copy(up);
      this.controls.target.copy(target);
      this.camera.position.copy(target).addScaledVector(direction, distance);
      this.controls.update();
    }
    this.camera.near = Math.max(radius / 1000, 0.01);
    this.camera.far = Math.max(distance, this.viewTransition?.fromDistance ?? distance) + radius * 20;
    this.camera.updateProjectionMatrix();
    this.controls.syncCamera();
  }

  /** Direct cube dragging interrupts a pending snap at its current pose. */
  rotateView(horizontal: number, vertical: number): void {
    this.viewTransition = null;
    this.controls.rotateView(horizontal, vertical);
  }

  // ---------------------------------------------------------------- frame loop

  resize(): void {
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    const pixelRatio = Math.min(window.devicePixelRatio, window.matchMedia("(pointer: coarse)").matches ? 1.5 : 2);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.controls.handleResize();
  }

  /** Captures the very next rendered frame. Reading the canvas after the frame is what makes this reliable on WebGPU. */
  captureNextFrame(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.captureResolve = resolve;
    });
  }

  private renderFrame(): void {
    for (const handle of this.models) {
      const explosion = handle.explodeTransition;
      if (!explosion) continue;
      const t = Math.min((performance.now() - explosion.started) / 400, 1);
      this.applyExplode(handle, THREE.MathUtils.lerp(explosion.from, handle.explodeTarget!, t * t * (3 - 2 * t)));
      if (t === 1) handle.explodeTransition = null;
    }
    const transition = this.viewTransition;
    if (transition) {
      const t = Math.min((performance.now() - transition.started) / 400, 1);
      const eased = t * t * (3 - 2 * t);
      this.controls.target.lerpVectors(transition.fromTarget, transition.target, eased);
      this.camera.quaternion.slerpQuaternions(transition.fromRotation, transition.rotation, eased);
      this.camera.position.set(0, 0, THREE.MathUtils.lerp(transition.fromDistance, transition.distance, eased))
        .applyQuaternion(this.camera.quaternion).add(this.controls.target);
      this.camera.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      if (t === 1) {
        this.camera.up.copy(transition.up);
        this.viewTransition = null;
        this.controls.update();
        this.controls.syncCamera();
      } else {
        // Keep controllers that cache the camera matrix in step with the animated pose, so the
        // first drag after the transition does not rebuild it from the pre-transition pose.
        this.controls.syncCamera();
      }
      // NavCube listens to this same event during both orbit gestures and animated snaps.
      this.controls.notifyChange();
    } else this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (this.captureResolve !== null) {
      const resolve = this.captureResolve;
      this.captureResolve = null;
      resolve(this.renderer.domElement.toDataURL("image/png"));
    }
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.environment.dispose();
    for (const handle of this.models) {
      disposeAppearance(handle.appearance);
      disposeObject(handle.root);
    }
    this.controls.dispose();
  }
}

function disposeObject(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh === true || (child as THREE.LineSegments).isLineSegments === true) {
      mesh.geometry.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    }
  });
  for (const material of materials) material.dispose();
}
