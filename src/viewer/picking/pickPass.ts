import * as THREE from "three/webgpu";
import type { PickScene } from "./pickScene";
import { EMPTY_PICK_ID, decodePickId } from "./pickIds";

export type PickPassRequest = Readonly<{
  camera: THREE.Camera;
  /** Normalised device coordinates, -1..1 with +Y up. */
  ndcX: number;
  ndcY: number;
  /** Bumped whenever the scene graph, visibility or the section planes change. */
  version: number;
  /** Runs before the pick render, so the proxies can copy the current matrices and planes. */
  prepare: () => void;
}>;

/**
 * @entry One colour-buffer render of the pick scene, then a single-pixel read-back.
 *
 * The expensive half (drawing every triangle again) only happens when the camera or the scene
 * changed. A hover that arrives after the last camera move is one 4-byte copy, which is why the
 * pointer stops feeling laggy on large models: no raycast, no per-triangle work on the CPU.
 */
export class PickPass {
  private target: THREE.RenderTarget | null = null;
  private renderedVersion = -1;
  private readonly worldMatrix = new THREE.Matrix4();
  private readonly projectionMatrix = new THREE.Matrix4();
  private readonly clearColor = new THREE.Color();
  private readonly size = new THREE.Vector2();

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly pickScene: PickScene
  ) {}

  async pick(request: PickPassRequest): Promise<number> {
    this.renderer.getDrawingBufferSize(this.size);
    const width = Math.floor(this.size.x);
    const height = Math.floor(this.size.y);
    if (width < 1 || height < 1) return EMPTY_PICK_ID;
    const target = this.ensureTarget(width, height);
    if (this.isStale(request)) this.render(request);
    const x = clampPixel((request.ndcX * 0.5 + 0.5) * width, width);
    const y = clampPixel((1 - (request.ndcY * 0.5 + 0.5)) * height, height);
    const pixel = await this.renderer.readRenderTargetPixelsAsync(target, x, y, 1, 1);
    return decodePickId(pixel);
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
  }

  private ensureTarget(width: number, height: number): THREE.RenderTarget {
    const current = this.target;
    if (current !== null && current.width === width && current.height === height) return current;
    current?.dispose();
    const target = new THREE.RenderTarget(width, height, {
      depthBuffer: true,
      stencilBuffer: false,
      // No MSAA: one pixel per object, and coverage would only blend ids together.
      samples: 0
    });
    target.texture.minFilter = THREE.NearestFilter;
    target.texture.magFilter = THREE.NearestFilter;
    target.texture.generateMipmaps = false;
    this.target = target;
    this.renderedVersion = -1;
    return target;
  }

  private isStale({ camera, version }: PickPassRequest): boolean {
    return version !== this.renderedVersion ||
      !this.worldMatrix.equals(camera.matrixWorld) ||
      !this.projectionMatrix.equals(camera.projectionMatrix);
  }

  private render({ camera, version, prepare }: PickPassRequest): void {
    const target = this.target;
    if (target === null) return;
    prepare();
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    renderer.getClearColor(this.clearColor);
    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      renderer.render(this.pickScene.scene, camera);
    } finally {
      renderer.setClearColor(this.clearColor, previousAlpha);
      renderer.autoClear = previousAutoClear;
      renderer.setRenderTarget(previousTarget);
    }
    this.renderedVersion = version;
    this.worldMatrix.copy(camera.matrixWorld);
    this.projectionMatrix.copy(camera.projectionMatrix);
  }
}

function clampPixel(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, Math.floor(value)));
}
