import * as THREE from "three/webgpu";
import { ControllerHost, type ControllerKind } from "./controller";
import { createStudioEnvironment } from "./environment";
import { collectParts, explodeParts, type ExplodePart } from "./explode";
import { createEdges } from "./edges/buildEdges";
import { disposeObject } from "./dispose";
import type { ParsedModel } from "../loaders/types";
import { createAppearance, applyAppearance, disposeAppearance, setMaterialPreset, type MaterialPreset, type ModelAppearance, type DisplayStyle, type SurfaceHover } from "./appearance";
import { pickSurface, type SurfaceHit } from "./inspection/pickSurface";
import { PivotGizmo } from "./pivotGizmo";
import { PickPass } from "./picking/pickPass";
import { PickScene } from "./picking/pickScene";
import { createFrameScheduler } from "./rendering/frameScheduler";
import { createInspectionLighting } from "./rendering/inspectionLighting";
export type { DisplayStyle } from "./appearance";
export type { ControllerKind } from "./controller";
export type StandardView = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso";
export type ViewDirection = readonly [x: number, y: number, z: number];
export type MeasurementUnit = "mm" | "cm" | "m" | "in";
export type SectionAxis = "x" | "y" | "z";
export type SectionCut = { axis: SectionAxis; ratio: number; reversed: boolean };
/** `exact` resolves the 3D point too; hover only needs the part and the CAD face. */
export type PickOptions = Readonly<{ snap?: boolean; exact?: boolean }>;

export type ModelStats = {
  vertices: number;
  triangles: number;
  bytes: number;
  /** Assembled bounding box in mm when source units are known, otherwise file coordinates. */
  size: THREE.Vector3;
};

export type ModelHandle = {
  id: string;
  name: string;
  format: string;
  sourceUnit: ParsedModel["sourceUnit"];
  root: THREE.Object3D;
  bytes: number;
  box: THREE.Box3;
  stats: ModelStats;
  edges: THREE.Group | null;
  edgeAngleUsed: number | null;
  edgeBuild: { abort: AbortController; promise: Promise<void> } | null;
  parts: ExplodePart[];
  appearance: ModelAppearance;
  selectedPart: number | null;
  explode: number;
  /** Null until this model first uses the explode control. */
  explodeTarget: number | null;
  explodeTransition: { from: number; started: number } | null;
};

export type EdgeProgress = (done: number, total: number) => void;
type HoverTarget = SurfaceHover & Readonly<{ modelId: string }>;

const VIEW_DIRECTIONS: Record<StandardView, ViewDirection> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  iso: [1, 0.8, 1]
};

const UNIT_SCALE: Record<MeasurementUnit, number> = { mm: 1, cm: 0.1, m: 0.001, in: 1 / 25.4 };

/** Converts a millimetre length into the unit the user reads. */
export function convertLength(valueInMm: number, unit: MeasurementUnit): number {
  return valueInMm * UNIT_SCALE[unit];
}

/**
 * Owns the three.js scene graph, camera, lights and the render loop.
 * Every public method that mutates rendering state is called from the UI layer; this class
 * never touches the DOM except for the canvas it renders into.
 */
export type Projection = "perspective" | "orthographic";
/** The viewer's vertical field of view; also converts between a perspective distance and an ortho zoom. */
const PERSPECTIVE_FOV = 45;
const _pickSize = new THREE.Vector2();

export class Stage {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  /** The camera currently rendering: perspective by default, orthographic when asked for. */
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  /** Stable across controller and projection switches: NavCube and the acceptance scripts hold on. */
  readonly controls: ControllerHost;

  private readonly canvas: HTMLCanvasElement;
  private readonly grid: THREE.GridHelper;
  /** Reflections: without these, glass and bare metal have nothing to mirror. */
  private readonly environment = createStudioEnvironment();
  private readonly lighting = createInspectionLighting();
  private environmentOn = true;
  /**
   * The orthographic camera keeps a unit frustum and expresses size through `zoom`, so framing it is
   * one number and the controls' own dolly (which adjusts `zoom` for ortho) needs no special case.
   */
  private readonly perspectiveCamera: THREE.PerspectiveCamera;
  private readonly orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  private projection: Projection = "perspective";
  /** ClippingGroup is the WebGPU-build way to clip: the planes live in the scene graph. */
  private readonly clippingGroup = new THREE.ClippingGroup();
  private readonly models: ModelHandle[] = [];
  private activeId: string | null = null;
  private hoveredSurface: HoverTarget | null = null;
  private displayStyle: DisplayStyle = "edges";
  private sectionCuts: readonly SectionCut[] = [];
  /** Crosshair on the point the next drag orbits around. */
  private readonly pivotGizmo: PivotGizmo;
  /** Proxy scene and cached id buffer behind every hover and click. */
  private readonly pickScene = new PickScene();
  private readonly pickPass: PickPass;
  /** Bumped whenever the pick buffer would be stale: geometry, visibility, section, explode. */
  private pickVersion = 0;
  /** The UI projects measurements and scale after camera and model matrices settle. */
  onRender: (() => void) | null = null;
  private readonly captures: ((dataUrl: string) => void)[] = [];
  private needsRender = true;
  private readonly frames = createFrameScheduler(() => this.renderFrame());
  private readonly gestures = new AbortController();
  private nextModelIndex = 1;
  private viewTransition: {
    started: number;
    fromRotation: THREE.Quaternion;
    rotation: THREE.Quaternion;
    fromTarget: THREE.Vector3;
    target: THREE.Vector3;
    fromDistance: number;
    distance: number;
    /** Orthographic size is a zoom, not a distance, so it interpolates separately. */
    fromZoom: number;
    zoom: number;
    up: THREE.Vector3;
  } | null = null;

  constructor(renderer: THREE.WebGPURenderer, canvas: HTMLCanvasElement, pivotMarker: HTMLElement | null) {
    this.renderer = renderer;
    this.canvas = canvas;
    this.pickPass = new PickPass(renderer, this.pickScene);
    this.pivotGizmo = new PivotGizmo(pivotMarker, canvas);

    this.scene.background = new THREE.Color(0x090d12);
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 0.5;
    this.scene.add(...this.lighting.lights);

    this.grid = new THREE.GridHelper(400, 40, 0x28413c, 0x19272a);
    this.scene.add(this.grid);
    this.scene.add(this.clippingGroup);

    this.perspectiveCamera = new THREE.PerspectiveCamera(PERSPECTIVE_FOV, 1, 0.1, 5000);
    this.perspectiveCamera.position.set(70, 55, 70);
    this.perspectiveCamera.lookAt(0, 0, 0);
    this.camera = this.perspectiveCamera;

    this.controls = new ControllerHost(this.camera, canvas, this.scene, "orbit");
    this.controls.onPivotRotate = (point) => this.pivotGizmo.showAt(point);
    this.controls.addEventListener("change", () => this.invalidate());
    // Any direct canvas gesture takes over from a scripted transition, whatever controller is
    // active (OrbitControls' own "start" event has no equivalent on the other two).
    const gestureOptions = { passive: true, signal: this.gestures.signal };
    const interrupt = (): void => {
      this.viewTransition = null;
      this.frames.request();
    };
    canvas.addEventListener("pointerdown", interrupt, gestureOptions);
    canvas.addEventListener("wheel", interrupt, gestureOptions);
    // Trackball queues drag deltas until update() runs and emits its first change event.
    canvas.addEventListener("pointermove", (event) => {
      if (event.buttons !== 0 || event.pointerType === "touch") this.frames.request();
    }, gestureOptions);
    /**
     * UVF-style cursor pivot: the surface under a left press becomes the next orbit centre.
     * `setPivot` moves the eye with the focal point, so a pick that lands mid-drag never shifts
     * the image — it only changes what the rest of the drag rotates around.
     */
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.pointerType === "touch" || this.models.length === 0) return;
      void this.pivotFromPointer(event.clientX, event.clientY);
    }, gestureOptions);
    this.invalidate();
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
      sourceUnit: parsed.sourceUnit,
      root: parsed.root,
      bytes: 0,
      box: new THREE.Box3(),
      stats: { vertices: 0, triangles: 0, bytes: 0, size: new THREE.Vector3() },
      edges: null,
      edgeAngleUsed: null,
      edgeBuild: null,
      parts: [],
      appearance: createAppearance(parsed.root, this.lighting.surfaceColor),
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
    this.updateAppearance(handle);
    this.rebuildPicking();
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

  /** @entry Assign a missing file unit and update both scene scale and assembled dimensions. */
  setSourceUnit(handleId: string, unit: MeasurementUnit): void {
    const handle = this.find(handleId);
    if (handle === null || (handle.sourceUnit.mmPerUnit !== null && !handle.sourceUnit.manualUnit)) return;
    const mmPerUnit = 1 / UNIT_SCALE[unit];
    const previous = handle.sourceUnit.mmPerUnit ?? 1;
    const explode = handle.explodeTarget ?? 0;
    explodeParts(handle.parts, 0);
    handle.root.scale.multiplyScalar(mmPerUnit / previous);
    handle.root.updateMatrixWorld(true);
    handle.sourceUnit = { label: `${unit}（手动指定）`, mmPerUnit, manualUnit: unit };
    this.recomputeBounds(handle);
    handle.parts = collectParts(handle.root, handle.box);
    handle.explodeTransition = null;
    this.applyExplode(handle, explode);
    this.rebuildPicking();
    this.fitToActive();
  }

  removeModel(handleId: string): void {
    this.viewTransition = null;
    const index = this.models.findIndex((model) => model.id === handleId);
    if (index < 0) {
      return;
    }
    const handle = this.models[index];
    if (this.hoveredSurface?.modelId === handleId) this.hoveredSurface = null;
    handle.edgeBuild?.abort.abort();
    this.clippingGroup.remove(handle.root);
    disposeAppearance(handle.appearance);
    disposeObject(handle.root);
    if (handle.edges !== null) {
      this.clippingGroup.remove(handle.edges);
      disposeObject(handle.edges);
    }
    this.models.splice(index, 1);
    this.rebuildPicking();

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
    if (!visible && this.hoveredSurface?.modelId === handleId) this.setHoveredSurface(null);
    this.invalidate();
    this.invalidatePick();
    if (handle.edges !== null) {
      handle.edges.visible = visible && this.displayStyle === "edges";
    }
  }

  isVisible(handleId: string): boolean {
    const handle = this.find(handleId);
    return handle !== null && handle.root.visible;
  }

  private rebuildPicking(): void {
    this.pickScene.rebuild(this.models);
    this.pickVersion += 1;
  }

  /** A change the cached id buffer cannot survive: visibility, section planes, part transforms. */
  private invalidatePick(): void {
    this.pickVersion += 1;
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
    this.updateAppearance(handle);
  }

  /** @entry Preview the nearest visible face or mesh without changing selection. */
  setHoveredSurface(hit: SurfaceHit | null): void {
    const previous = this.hoveredSurface;
    const nextModel = hit === null ? null : this.find(hit.modelId);
    const next: HoverTarget | null = hit !== null && nextModel !== null
      ? { modelId: hit.modelId, mesh: hit.mesh, face: hit.face }
      : null;
    if (previous?.mesh === next?.mesh && previous?.face === next?.face) return;
    this.hoveredSurface = next;
    const previousModel = previous === null ? null : this.find(previous.modelId);
    if (previousModel !== null && previousModel !== nextModel) this.updateAppearance(previousModel);
    if (nextModel !== null) this.updateAppearance(nextModel);
  }

  /** @entry Change the active model's material without changing its display mode. */
  setActiveMaterial(preset: MaterialPreset): void {
    const handle = this.active;
    if (handle === null) return;
    setMaterialPreset(handle.appearance, preset, this.lighting.surfaceColor);
    this.updateAppearance(handle);
  }

  private updateAppearance(handle: ModelHandle): void {
    this.invalidate();
    const selected = handle.selectedPart === null ? null : handle.parts[handle.selectedPart].mesh;
    const hovered = this.hoveredSurface?.modelId === handle.id ? this.hoveredSurface : null;
    applyAppearance(handle.appearance, this.displayStyle, selected, hovered);
  }

  /**
   * @entry Resolve what the pointer is over.
   *
   * The GPU pick pass resolves the part (and the CAD face) from a cached id buffer, so hover does
   * not walk triangles. `exact` additionally raycasts that single mesh for the hit point, which
   * measurement needs and hover does not.
   */
  async pick(clientX: number, clientY: number, options: PickOptions = {}): Promise<SurfaceHit | null> {
    const viewport = this.canvas.getBoundingClientRect();
    if (viewport.width < 1 || viewport.height < 1) return null;
    const ndcX = (clientX - viewport.left) / viewport.width * 2 - 1;
    const ndcY = 1 - (clientY - viewport.top) / viewport.height * 2;
    if (Math.abs(ndcX) > 1 || Math.abs(ndcY) > 1) return null;

    const id = await this.pickPass.pick({
      camera: this.camera, ndcX, ndcY, version: this.pickVersion,
      prepare: () => this.pickScene.sync(this.clippingGroup.clippingPlanes)
    });
    const entity = this.pickScene.entity(id);
    if (entity === null) return null;
    if (options.exact !== true) {
      return { ...entity, triangleIndex: null, localPoint: null };
    }
    const model = this.find(entity.modelId);
    // Ray at the centre of the pixel the GPU picked: at a silhouette the pointer itself can sit a
    // fraction of a pixel outside the triangle that coloured that pixel.
    const point = this.pickPixelCentre(clientX, clientY, viewport);
    const exact = model === null ? null : pickSurface({
      models: [model], camera: this.camera, viewport, planes: this.clippingGroup.clippingPlanes,
      clientX: point.x, clientY: point.y, snap: options.snap === true, only: entity.mesh
    });
    return exact ?? { ...entity, triangleIndex: null, localPoint: null };
  }

  /** Client-space centre of the drawing-buffer pixel `PickPass` reads for this pointer position. */
  private pickPixelCentre(clientX: number, clientY: number, viewport: DOMRectReadOnly): { x: number; y: number } {
    const size = this.renderer.getDrawingBufferSize(_pickSize);
    const column = Math.min(size.x - 1, Math.max(0, Math.floor((clientX - viewport.left) / viewport.width * size.x)));
    const row = Math.min(size.y - 1, Math.max(0, Math.floor((clientY - viewport.top) / viewport.height * size.y)));
    return {
      x: viewport.left + ((column + 0.5) / size.x) * viewport.width,
      y: viewport.top + ((row + 0.5) / size.y) * viewport.height
    };
  }

  /** @entry Make the surface point under a left press the point the next drag orbits around. */
  private async pivotFromPointer(clientX: number, clientY: number): Promise<void> {
    const hit = await this.pick(clientX, clientY, { exact: true });
    // Empty space goes back to orbiting the framed centre, like any viewer without a pivot.
    if (hit === null || hit.localPoint === null) {
      this.setPivot(null);
      return;
    }
    this.setPivot(hit.mesh.localToWorld(hit.localPoint.clone()));
  }

  /** Move the cursor pivot, or clear it, and keep its marker in step. */
  private setPivot(point: THREE.Vector3 | null): void {
    if (point === null) {
      this.controls.clearPivot();
      this.pivotGizmo.hide();
      return;
    }
    this.controls.setPivot(point);
  }

  projectVisiblePoint(world: THREE.Vector3): THREE.Vector3 | null {
    if (this.clippingGroup.clippingPlanes.some((plane) => plane.distanceToPoint(world) < -1e-7)) return null;
    const point = world.clone().project(this.camera);
    return point.z >= -1 && point.z <= 1 ? point : null;
  }

  setPartVisible(index: number, visible: boolean): void {
    const handle = this.active;
    if (!handle?.parts[index]) return;
    handle.parts[index].mesh.visible = visible;
    if (!visible) this.setHoveredSurface(null);
    this.invalidate();
    this.invalidatePick();
    this.syncEdgeVisibility(handle);
  }

  isolatePart(index: number): void {
    const handle = this.active;
    if (!handle?.parts[index]) return;
    this.setHoveredSurface(null);
    this.setVisible(handle.id, true);
    handle.parts.forEach((part, partIndex) => { part.mesh.visible = partIndex === index; });
    this.invalidate();
    this.invalidatePick();
    this.selectPart(index);
    this.syncEdgeVisibility(handle);
  }

  showAllParts(): void {
    const handle = this.active;
    if (!handle) return;
    this.setVisible(handle.id, true);
    for (const part of handle.parts) part.mesh.visible = true;
    this.invalidate();
    this.invalidatePick();
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
    this.invalidate();
    // Apply every surface immediately, before awaiting any edge calculation.
    for (const handle of this.models) {
      this.updateAppearance(handle);
      if (style !== "edges") {
        handle.edgeBuild?.abort.abort();
        if (handle.edges !== null) {
          handle.edges.visible = false;
        }
      }
    }
    if (style !== "edges") return;
    for (const handle of [...this.models]) {
      if (this.displayStyle !== "edges") break;
      if (!this.models.includes(handle)) continue;
      await this.ensureEdges(handle, onEdgeProgress);
      if (handle.edges !== null) {
        handle.edges.visible = handle.root.visible && this.displayStyle === "edges";
        this.invalidate();
      }
    }
  }

  setEdgeAngle(angleDeg: number): void {
    for (const handle of this.models) {
      handle.edgeBuild?.abort.abort();
      if (handle.edges !== null) {
        this.clippingGroup.remove(handle.edges);
        disposeObject(handle.edges);
        handle.edges = null;
        handle.edgeAngleUsed = null;
      }
    }
    this.currentEdgeAngle = angleDeg;
    this.invalidate();
  }

  private currentEdgeAngle = 30;
  /** Edge width in CSS pixels; the slider in the sidebar owns this. */
  private edgeWidth = 2;

  edgeAngle(): number {
    return this.currentEdgeAngle;
  }

  /** @entry Change the line width on every existing edge set without rebuilding geometry. */
  setEdgeWidth(width: number): void {
    const next = THREE.MathUtils.clamp(width, 1, 4);
    if (next === this.edgeWidth) return;
    this.edgeWidth = next;
    for (const handle of this.models) {
      for (const line of handle.edges?.children ?? []) {
        const material = (line as THREE.Mesh).material;
        if (material instanceof THREE.Line2NodeMaterial) material.linewidth = next;
      }
    }
    this.invalidate();
  }

  private async ensureEdges(handle: ModelHandle, onProgress?: EdgeProgress): Promise<void> {
    if (handle.edges !== null && handle.edgeAngleUsed === this.currentEdgeAngle) {
      return;
    }
    if (handle.edgeBuild && !handle.edgeBuild.abort.signal.aborted) return handle.edgeBuild.promise;
    const angle = this.currentEdgeAngle;
    const abort = new AbortController();
    const promise = createEdges(handle.root, {
      angle, width: this.edgeWidth, signal: abort.signal, onProgress
    }).then((group) => {
      if (abort.signal.aborted || !this.models.includes(handle)) { disposeObject(group); return; }
      group.name = `${handle.name}-edges`;
      handle.edges = group;
      handle.edgeAngleUsed = angle;
      this.clippingGroup.add(group);
      this.syncEdgeVisibility(handle);
      this.invalidate();
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) throw error;
    }).finally(() => {
      if (handle.edgeBuild?.abort === abort) handle.edgeBuild = null;
    });
    handle.edgeBuild = { abort, promise };
    return promise;
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
    this.invalidate();
    this.invalidatePick();
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
    this.invalidate();
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
    this.invalidate();
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

  setSections(cuts: readonly SectionCut[]): void {
    this.setHoveredSurface(null);
    this.sectionCuts = cuts;
    this.applySection();
  }

  private applySection(): void {
    this.invalidate();
    this.invalidatePick();
    const handle = this.active;
    if (this.sectionCuts.length === 0 || handle === null || handle.box.isEmpty()) {
      this.clippingGroup.clippingPlanes = [];
      return;
    }
    this.clippingGroup.clippingPlanes = this.sectionCuts.map(({ axis, ratio, reversed }) => {
      const offset = THREE.MathUtils.lerp(handle.box.min[axis], handle.box.max[axis], ratio);
      const normal = new THREE.Vector3();
      normal[axis] = reversed ? 1 : -1;
      return new THREE.Plane(normal, -normal[axis] * offset);
    });
  }

  fitToActive(animate = false): void {
    const handle = this.active;
    if (handle && !handle.box.isEmpty()) this.fitBounds(handle.box, animate);
  }

  /** @entry Frame all visible geometry, without changing the active model. */
  fitToScene(): void {
    const bounds = new THREE.Box3();
    const box = new THREE.Box3();
    for (const model of this.models) {
      model.root.updateWorldMatrix(true, true);
      model.root.traverseVisible((object) => {
        if ((object as THREE.Mesh).isMesh) bounds.union(box.setFromObject(object));
      });
    }
    if (!bounds.isEmpty()) this.fitBounds(bounds, true);
  }

  setLightBackground(light: boolean): void {
    (this.scene.background as THREE.Color).setHex(light ? 0xc4cbd0 : 0x090d12);
    this.invalidate();
  }

  get orthographicUnitsPerPixel(): number | null {
    return this.projection === "orthographic" ? this.visibleHeight() / Math.max(this.canvas.clientHeight, 1) : null;
  }

  fitToPart(index: number): void {
    const part = this.active?.parts[index];
    if (!part) return;
    this.setVisible(this.active!.id, true);
    this.setPartVisible(index, true);
    this.fitBounds(new THREE.Box3().setFromObject(part.mesh), true);
  }

  private fitBounds(box: THREE.Box3, animate: boolean): void {
    this.invalidate();
    this.viewTransition = null;
    this.setPivot(null);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.001);
    const distance = this.fitDistance(radius);
    const zoom = this.fitZoom(radius);
    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-9) {
      direction.set(...VIEW_DIRECTIONS.iso);
    }
    direction.normalize();
    const fromDistance = this.camera.position.distanceTo(this.controls.target);

    if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.viewTransition = {
        started: performance.now(), fromRotation: this.camera.quaternion.clone(), rotation: this.camera.quaternion.clone(),
        fromTarget: this.controls.target.clone(), target: sphere.center,
        fromDistance, distance, fromZoom: this.currentZoom(), zoom, up: this.camera.up.clone()
      };
    } else {
      this.controls.target.copy(sphere.center);
      this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
      this.applyZoom(zoom);
    }
    this.camera.near = Math.max(radius / 1000, 0.01);
    this.camera.far = Math.max(distance, fromDistance) + radius * 20;
    this.camera.updateProjectionMatrix();
    this.grid.position.set(sphere.center.x, box.min.y, sphere.center.z);
    this.controls.update();
    this.controls.syncCamera();
  }

  setStandardView(view: StandardView, animate = true): void {
    this.setViewDirection(VIEW_DIRECTIONS[view], animate);
  }

  /** @entry Frame the active model from a face, edge or corner direction. */
  setViewDirection([x, y, z]: ViewDirection, animate = true): void {
    this.invalidate();
    this.setPivot(null);
    const handle = this.active;
    const target = handle === null || handle.box.isEmpty()
      ? new THREE.Vector3(0, 0, 0)
      : handle.box.getBoundingSphere(new THREE.Sphere()).center;
    const radius = handle === null || handle.box.isEmpty()
      ? 60
      : Math.max(handle.box.getBoundingSphere(new THREE.Sphere()).radius, 0.001);
    const distance = this.fitDistance(radius);
    const zoom = this.fitZoom(radius);

    const up = x === 0 && z === 0
      ? new THREE.Vector3(0, 0, -Math.sign(y))
      : new THREE.Vector3(0, 1, 0);
    const direction = new THREE.Vector3(x, y, z).normalize();
    const rotation = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), up)
    );
    // Drain any pending inertia before handing the camera to the transition.
    this.controls.settle();
    this.viewTransition = null;
    const fromDistance = this.camera.position.distanceTo(this.controls.target);
    if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.viewTransition = {
        started: performance.now(), fromRotation: this.camera.quaternion.clone(), rotation,
        fromTarget: this.controls.target.clone(), target,
        fromDistance, distance, fromZoom: this.currentZoom(), zoom, up
      };
    } else {
      this.camera.up.copy(up);
      this.controls.target.copy(target);
      this.camera.position.copy(target).addScaledVector(direction, distance);
      this.applyZoom(zoom);
      this.controls.update();
    }
    this.camera.near = Math.max(radius / 1000, 0.01);
    this.camera.far = Math.max(distance, fromDistance) + radius * 20;
    this.camera.updateProjectionMatrix();
    this.controls.syncCamera();
  }

  // ---------------------------------------------------------------- projection

  get projectionKind(): Projection {
    return this.projection;
  }

  /**
   * Switches between a perspective and an orthographic camera, carrying the pose and the *apparent
   * size* across so the model does not jump: a perspective camera's framing is a distance, an
   * orthographic one's is a zoom over a unit frustum, and the two convert through the field of view.
   */
  setProjection(projection: Projection): void {
    if (projection === this.projection) {
      return;
    }
    this.viewTransition = null;
    this.controls.settle();
    const height = this.visibleHeight();
    const next = projection === "orthographic" ? this.orthographicCamera : this.perspectiveCamera;
    next.position.copy(this.camera.position);
    next.quaternion.copy(this.camera.quaternion);
    next.up.copy(this.camera.up);

    if (isOrthographic(next)) {
      const aspect = this.viewportAspect;
      next.left = -aspect;
      next.right = aspect;
      next.top = 1;
      next.bottom = -1;
      next.zoom = 2 / height;
    } else {
      next.aspect = this.viewportAspect;
      const direction = this.camera.position.clone().sub(this.controls.target);
      if (direction.lengthSq() < 1e-9) {
        direction.set(...VIEW_DIRECTIONS.iso);
      }
      const distance = height / (2 * Math.tan(THREE.MathUtils.degToRad(PERSPECTIVE_FOV) / 2));
      next.position.copy(this.controls.target).addScaledVector(direction.normalize(), distance);
    }

    const radius = this.viewRadius();
    next.near = Math.max(radius / 1000, 0.01);
    next.far = next.position.distanceTo(this.controls.target) + radius * 20;
    next.updateProjectionMatrix();

    this.projection = projection;
    this.invalidate();
    this.camera = next;
    this.controls.setCamera(next);
    this.controls.update();
  }

  /** A sphere containing everything worth framing; the fallback matches the empty scene's grid. */
  private viewRadius(): number {
    const handle = this.active;
    if (handle !== null && !handle.box.isEmpty()) {
      return Math.max(handle.box.min.distanceTo(handle.box.max) / 2, 0.001);
    }
    return 60;
  }

  /** Canvas aspect; framing needs it for either projection, and the entity panel resizes around it. */
  get viewportAspect(): number {
    return Math.max(this.canvas.clientWidth, 1) / Math.max(this.canvas.clientHeight, 1);
  }

  /** Perspective framing is a distance from the focal point; the limiting half-angle accounts for the viewport. */
  private fitDistance(radius: number): number {
    const verticalFov = THREE.MathUtils.degToRad(PERSPECTIVE_FOV);
    const fov = Math.min(verticalFov, 2 * Math.atan(Math.tan(verticalFov / 2) * this.viewportAspect));
    return (radius / Math.sin(fov / 2)) * 1.08;
  }

  /** The orthographic equivalent: a unit frustum scaled by zoom, so fit is a single number. */
  private fitZoom(radius: number): number {
    return Math.min(1, this.viewportAspect) / (radius * 1.08);
  }

  /** World height the camera shows across the focal plane, whichever projection is active. */
  private visibleHeight(): number {
    if (isOrthographic(this.camera)) {
      return 2 / this.camera.zoom;
    }
    return 2 * Math.tan(THREE.MathUtils.degToRad(PERSPECTIVE_FOV) / 2) * this.camera.position.distanceTo(this.controls.target);
  }

  private currentZoom(): number {
    return isOrthographic(this.camera) ? this.camera.zoom : 1;
  }

  private applyZoom(zoom: number): void {
    if (isOrthographic(this.camera)) {
      this.camera.zoom = zoom;
    }
  }

  /** Direct cube dragging interrupts a pending snap at its current pose. */
  rotateView(horizontal: number, vertical: number): void {
    this.viewTransition = null;
    // The NavCube rotates about the framed centre, not about wherever the last press landed.
    this.setPivot(null);
    this.controls.rotateView(horizontal, vertical);
  }

  // ---------------------------------------------------------------- frame loop

  private invalidate(): void {
    this.needsRender = true;
    this.frames.request();
  }

  resize(): void {
    this.invalidate();
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    const pixelRatio = Math.min(window.devicePixelRatio, window.matchMedia("(pointer: coarse)").matches ? 1.5 : 2);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    if (isOrthographic(this.camera)) {
      // The unit frustum is the vertical extent; width follows the viewport. Size stays in zoom.
      this.camera.left = -(width / height);
      this.camera.right = width / height;
    } else {
      this.camera.aspect = width / height;
    }
    this.camera.updateProjectionMatrix();
    this.controls.handleResize();
  }

  /** Captures the very next rendered frame. Reading the canvas after the frame is what makes this reliable on WebGPU. */
  captureNextFrame(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.captures.push(resolve);
      this.frames.request();
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
      this.needsRender = true;
      const t = Math.min((performance.now() - transition.started) / 400, 1);
      const eased = t * t * (3 - 2 * t);
      this.controls.target.lerpVectors(transition.fromTarget, transition.target, eased);
      this.camera.quaternion.slerpQuaternions(transition.fromRotation, transition.rotation, eased);
      this.camera.position.set(0, 0, THREE.MathUtils.lerp(transition.fromDistance, transition.distance, eased))
        .applyQuaternion(this.camera.quaternion).add(this.controls.target);
      this.camera.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      if (isOrthographic(this.camera)) {
        // Orthographic framing lives in the zoom, so the size interpolates separately from the pose.
        this.camera.zoom = THREE.MathUtils.lerp(transition.fromZoom, transition.zoom, eased);
        this.camera.updateProjectionMatrix();
      }
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
    if (!this.needsRender && !this.captures.length) return;
    this.needsRender = false;
    this.lighting.setDepthRange(this.camera.position.distanceTo(this.controls.target), this.viewRadius());
    this.renderer.render(this.scene, this.camera);
    this.pivotGizmo.sync(this.camera);
    this.onRender?.();
    if (this.captures.length) {
      const dataUrl = this.renderer.domElement.toDataURL("image/png");
      for (const resolve of this.captures.splice(0)) resolve(dataUrl);
    }
  }

  dispose(): void {
    this.gestures.abort();
    this.frames.dispose();
    this.onRender = null;
    this.environment.dispose();
    for (const handle of [...this.models]) this.removeModel(handle.id);
    this.pickPass.dispose();
    this.pickScene.dispose();
    this.pivotGizmo.dispose();
    disposeObject(this.grid);
    this.controls.dispose();
    this.renderer.dispose();
  }
}

/**
 * three marks cameras with runtime flags, but its typings declare them as plain booleans, so they
 * cannot narrow a union on their own.
 */
function isOrthographic(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): camera is THREE.OrthographicCamera {
  return (camera as { isOrthographicCamera?: boolean }).isOrthographicCamera === true;
}
