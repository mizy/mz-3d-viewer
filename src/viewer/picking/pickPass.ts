import * as THREE from "three/webgpu";
import type { PickScene } from "./pickScene";

type PickPassRequest = Readonly<{
  camera: THREE.Camera;
  ndcX: number;
  ndcY: number;
  /** Bumped whenever scene geometry, visibility or clipping changes. */
  version: number;
  prepare: (edges: boolean) => void;
  edges: boolean;
  triangle?: boolean;
  snap?: boolean;
}>;

export type PickSample = Readonly<{
  id: number;
  instanceIndex: number;
  triangleIndex: number | null;
  edgeIndex: number | null;
  ndcX: number;
  ndcY: number;
  viewZ: number;
}>;

/** @entry Sample a cached WebGPU ID buffer. The same pixel carries view depth. */
export class PickPass {
  private target: THREE.RenderTarget | null = null;
  private detailTarget: THREE.RenderTarget | null = null;
  private renderedVersion = -1;
  private renderedEdges = false;
  private frame = 0;
  private readonly worldMatrix = new THREE.Matrix4();
  private readonly projectionMatrix = new THREE.Matrix4();
  private readonly clearColor = new THREE.Color();
  private readonly size = new THREE.Vector2();

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly pickScene: PickScene
  ) {}

  async pick(request: PickPassRequest): Promise<PickSample | null> {
    this.renderer.getDrawingBufferSize(this.size);
    const width = Math.floor(this.size.x);
    const height = Math.floor(this.size.y);
    if (width < 1 || height < 1) return null;
    request.camera.updateWorldMatrix(true, false);
    const target = this.ensureTarget(width, height);
    if (this.isStale(request)) {
      request.prepare(request.edges);
      this.draw(this.pickScene.scene, request.camera, target);
      this.worldMatrix.copy(request.camera.matrixWorld);
      this.projectionMatrix.copy(request.camera.projectionMatrix);
      this.renderedVersion = request.version;
      this.renderedEdges = request.edges;
      this.frame += 1;
    }

    const frame = this.frame;
    const x = clampPixel((request.ndcX + 1) * width / 2, width);
    const y = clampPixel((1 - request.ndcY) * height / 2, height);
    const [id, instanceIndex, viewZ, triangle] = await this.read(target, x, y);
    if (id === 0 || !this.isCurrent(frame, request)) return null;

    const pixelX = (x + 0.5) * 2 / width - 1;
    const pixelY = 1 - (y + 0.5) * 2 / height;
    const edgeIndex = triangle < 0 ? -triangle - 1 : null;
    let triangleIndex = triangle > 0 ? triangle - 1 : null;
    if ((request.snap === true || request.triangle === true) && triangleIndex === null && edgeIndex === null) {
      triangleIndex = await this.pickTriangle(request.camera, { id, instanceIndex, pixelX, pixelY, width, height });
      if (!this.isCurrent(frame, request)) return null;
    }
    return { id, instanceIndex, triangleIndex, edgeIndex, ndcX: pixelX, ndcY: pixelY, viewZ };
  }

  dispose(): void {
    this.frame += 1;
    this.target?.dispose();
    this.detailTarget?.dispose();
    this.target = null;
    this.detailTarget = null;
  }

  private ensureTarget(width: number, height: number): THREE.RenderTarget {
    const current = this.target;
    if (current !== null && current.width === width && current.height === height) return current;
    current?.dispose();
    this.target = createTarget(width, height);
    this.renderedVersion = -1;
    return this.target;
  }

  private isCurrent(frame: number, request: PickPassRequest): boolean {
    request.camera.updateWorldMatrix(true, false);
    return frame === this.frame && !this.isStale(request);
  }

  private isStale({ camera, version, edges }: PickPassRequest): boolean {
    return version !== this.renderedVersion || edges !== this.renderedEdges ||
      !this.worldMatrix.equals(camera.matrixWorld) ||
      !this.projectionMatrix.equals(camera.projectionMatrix);
  }

  private async pickTriangle(camera: THREE.Camera, pixel: {
    id: number; instanceIndex: number; pixelX: number; pixelY: number; width: number; height: number;
  }): Promise<number | null> {
    const { id, instanceIndex, pixelX, pixelY, width, height } = pixel;
    if (!this.pickScene.prepareDetail(id)) return null;
    const target = this.detailTarget ??= createTarget(1, 1);
    try {
      const cropped = camera.clone();
      // Crop clip space to the same drawing-buffer pixel without changing the source camera.
      cropped.projectionMatrix.premultiply(new THREE.Matrix4().set(
        width, 0, 0, -pixelX * width,
        0, height, 0, -pixelY * height,
        0, 0, 1, 0,
        0, 0, 0, 1
      ));
      cropped.projectionMatrixInverse.copy(cropped.projectionMatrix).invert();
      this.draw(this.pickScene.detailScene, cropped, target);
    } finally {
      this.pickScene.clearDetail();
    }
    const [hitId, hitInstance, , triangle] = await this.read(target, 0, 0);
    return hitId === id && hitInstance === instanceIndex && triangle !== 0 ? triangle - 1 : null;
  }

  private async read(target: THREE.RenderTarget, x: number, y: number): Promise<Float32Array> {
    const bytes = await this.renderer.readRenderTargetPixelsAsync(target, x, y, 1, 1);
    return new Float32Array(bytes.buffer, bytes.byteOffset, 4);
  }

  private draw(scene: THREE.Scene, camera: THREE.Camera, target: THREE.RenderTarget): void {
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    renderer.getClearColor(this.clearColor);
    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      renderer.render(scene, camera);
    } finally {
      renderer.setClearColor(this.clearColor, previousAlpha);
      renderer.autoClear = previousAutoClear;
      renderer.setRenderTarget(previousTarget);
    }
  }
}

function createTarget(width: number, height: number): THREE.RenderTarget {
  return new THREE.RenderTarget(width, height, {
    type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: true, stencilBuffer: false, samples: 0
  });
}

function clampPixel(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, Math.floor(value)));
}
