import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { ParsedModel } from "../loaders/types";

export type DisplayStyle = "solid" | "edges" | "wireframe";
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
  readonly controls: OrbitControls;

  private readonly canvas: HTMLCanvasElement;
  private readonly grid: THREE.GridHelper;
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

  constructor(renderer: THREE.WebGPURenderer, canvas: HTMLCanvasElement) {
    this.renderer = renderer;
    this.canvas = canvas;

    this.scene.background = new THREE.Color(0x0e1116);
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

    this.grid = new THREE.GridHelper(400, 40, 0x33507a, 0x1e2733);
    this.scene.add(this.grid);
    this.scene.add(this.clippingGroup);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.position.set(70, 55, 70);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;

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
      edgeAngleUsed: null
    };
    this.clippingGroup.add(handle.root);
    this.recomputeBounds(handle);
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
    const index = this.models.findIndex((model) => model.id === handleId);
    if (index < 0) {
      return;
    }
    const handle = this.models[index];
    this.clippingGroup.remove(handle.root);
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
    if (handle.id === this.activeId) {
      this.recomputeBounds(handle, visible);
    }
  }

  isVisible(handleId: string): boolean {
    const handle = this.find(handleId);
    return handle !== null && handle.root.visible;
  }

  private find(handleId: string): ModelHandle | null {
    return this.models.find((model) => model.id === handleId) ?? null;
  }

  /** Bounding box of the model in world space, ignoring invisible models for camera work. */
  private recomputeBounds(handle: ModelHandle, include = true): void {
    const box = new THREE.Box3().setFromObject(handle.root);
    if (box.isEmpty() && include) {
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
      setWireframe(handle.root, style === "wireframe");
      if (style !== "edges") {
        if (handle.edges !== null) {
          handle.edges.visible = false;
        }
        continue;
      }
      await this.ensureEdges(handle, onEdgeProgress);
      if (handle.edges !== null) {
        handle.edges.visible = handle.root.visible;
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
    void this.currentEdgeAngleOverride(angleDeg);
  }

  private currentEdgeAngle = 30;

  private async currentEdgeAngleOverride(angleDeg: number): Promise<void> {
    this.currentEdgeAngle = angleDeg;
    if (this.displayStyle === "edges") {
      await this.setDisplayStyle("edges");
    }
  }

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
      const edges = new THREE.EdgesGeometry(mesh.geometry, this.currentEdgeAngle);
      if (edges.getAttribute("position").count > 0) {
        const lines = new THREE.LineSegments(edges, material);
        lines.matrixAutoUpdate = false;
        lines.matrix.copy(mesh.matrixWorld);
        group.add(lines);
      } else {
        edges.dispose();
      }
      done += 1;
      onProgress?.(done, meshes.length);
      // Yield so a big assembly does not block the frame loop.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    handle.edges = group;
    handle.edgeAngleUsed = this.currentEdgeAngle;
    this.clippingGroup.add(group);
  }

  // ---------------------------------------------------------------- camera / section

  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
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

  fitToActive(): void {
    const handle = this.active;
    if (handle === null || handle.box.isEmpty()) {
      return;
    }
    const sphere = handle.box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.001);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = (radius / Math.sin(fov / 2)) * 1.15;
    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-9) {
      direction.copy(VIEW_DIRECTIONS.iso);
    }
    direction.normalize();

    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
    this.camera.near = Math.max(radius / 1000, 0.01);
    this.camera.far = distance + radius * 20;
    this.camera.updateProjectionMatrix();
    this.grid.position.set(sphere.center.x, handle.box.min.y, sphere.center.z);
    this.controls.update();
  }

  setStandardView(view: StandardView): void {
    const handle = this.active;
    const target = handle === null || handle.box.isEmpty()
      ? new THREE.Vector3(0, 0, 0)
      : handle.box.getBoundingSphere(new THREE.Sphere()).center;
    const radius = handle === null || handle.box.isEmpty()
      ? 60
      : Math.max(handle.box.getBoundingSphere(new THREE.Sphere()).radius, 0.001);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = (radius / Math.sin(fov / 2)) * 1.15;

    if (view === "top" || view === "bottom") {
      // Straight-down views need a camera up vector that is not parallel to the view direction.
      this.camera.up.set(0, 0, view === "top" ? -1 : 1);
    } else {
      this.camera.up.set(0, 1, 0);
    }
    const direction = VIEW_DIRECTIONS[view].clone().normalize();
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(direction, distance);
    this.camera.near = Math.max(radius / 1000, 0.01);
    this.camera.far = distance + radius * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  // ---------------------------------------------------------------- frame loop

  resize(): void {
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    const pixelRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Captures the very next rendered frame. Reading the canvas after the frame is what makes this reliable on WebGPU. */
  captureNextFrame(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.captureResolve = resolve;
    });
  }

  private renderFrame(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (this.captureResolve !== null) {
      const resolve = this.captureResolve;
      this.captureResolve = null;
      resolve(this.renderer.domElement.toDataURL("image/png"));
    }
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    for (const handle of this.models) {
      disposeObject(handle.root);
    }
    this.controls.dispose();
  }
}

function setWireframe(root: THREE.Object3D, wireframe: boolean): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh !== true) {
      return;
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const withWireframe = material as THREE.MeshStandardMaterial;
      withWireframe.wireframe = wireframe;
    }
  });
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh === true || (child as THREE.LineSegments).isLineSegments === true) {
      mesh.geometry.dispose();
    }
  });
}
