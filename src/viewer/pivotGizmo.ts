import * as THREE from "three/webgpu";

const FADE_MS = 240;
/** The marker lingers this long after the last rotation, so the centre stays readable. */
const LINGER_MS = 1200;

/**
 * @entry Screen-space crosshair on the point the next drag rotates around — the visible half of
 * the cursor pivot, the way UVF marks its rotation anchor.
 *
 * It is a DOM overlay rather than a 3D sprite for two reasons: `Points` is limited to one-pixel
 * point primitives on WebGPU, and a constant-size marker in a perspective *and* orthographic view
 * would otherwise need the sprite scale re-derived from the viewport every frame. Projecting one
 * point into CSS pixels does the same job, stays crisp on a retina display and costs nothing when
 * the camera is idle.
 */
export class PivotGizmo {
  private readonly element: HTMLElement | null;
  private readonly canvas: HTMLCanvasElement;
  private readonly world = new THREE.Vector3();
  private readonly projected = new THREE.Vector3();
  private readonly viewSpace = new THREE.Vector3();
  private visible = false;
  private hideTimer: number | null = null;

  /** A null element turns the marker off, which is what an embedded viewer without app chrome wants. */
  constructor(element: HTMLElement | null, canvas: HTMLCanvasElement) {
    this.element = element;
    this.canvas = canvas;
  }

  /**
   * Move the marker and bring it back to full strength. Every rotation frame calls this, which
   * also pushes the fade out again: the marker disappears a moment after the drag stops, not
   * while inertia is still turning the camera.
   */
  showAt(point: THREE.Vector3): void {
    this.clearTimer();
    this.world.copy(point);
    this.visible = true;
    const element = this.element;
    if (element === null) return;
    element.hidden = false;
    element.style.visibility = "";
    element.classList.add("is-visible");
    this.fadeOut(LINGER_MS);
  }

  /** Start fading after `delayMs`, so the centre stays readable once the drag ends. */
  fadeOut(delayMs: number): void {
    const element = this.element;
    if (!this.visible || element === null) return;
    this.clearTimer();
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      element.classList.remove("is-visible");
      this.hideTimer = window.setTimeout(() => this.hide(), FADE_MS);
    }, delayMs);
  }

  hide(): void {
    this.clearTimer();
    this.visible = false;
    if (this.element === null) return;
    this.element.hidden = true;
    this.element.classList.remove("is-visible");
  }

  /**
   * Place the marker over its world point. Called once per rendered frame, so it also covers
   * camera moves the stage never hears about — orbit damping included.
   */
  sync(camera: THREE.Camera): void {
    const element = this.element;
    if (!this.visible || element === null) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    camera.updateMatrixWorld();
    // Behind the camera projects to a mirrored point; NDC `z` alone would still look on-screen.
    this.viewSpace.copy(this.world).applyMatrix4(camera.matrixWorldInverse);
    this.projected.copy(this.world).project(camera);
    const onScreen = this.viewSpace.z < 0 && this.projected.z >= -1 && this.projected.z <= 1;
    // Only the transform lives here: the fade owns `.is-visible`, or every frame would undo it.
    element.style.visibility = onScreen ? "" : "hidden";
    if (!onScreen) return;
    const x = (this.projected.x + 1) / 2 * rect.width;
    const y = (1 - this.projected.y) / 2 * rect.height;
    element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  dispose(): void {
    this.hide();
  }

  private clearTimer(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }
}
