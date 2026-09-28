import { Matrix4, Quaternion, Vector3, type Camera } from "three/webgpu";
import type { Stage, StandardView } from "../viewer/stage";

const GIZMO_CENTER = 22;
const GIZMO_ARM = 12.5;
const GIZMO_LABEL = 17;

type AxisPart = { arm: SVGLineElement; label: SVGTextElement; world: Vector3; depth: number };

/**
 * The conventional CAD axis triad: world X/Y/Z projected through the camera's own basis, so the
 * orientation reads the same way here as it does in the model's own coordinates. Drawn in SVG
 * rather than a second GPU canvas.
 */
function createAxisSync(svg: SVGSVGElement, camera: Camera): () => void {
  const parts: AxisPart[] = (["x", "y", "z"] as const).map((axis) => ({
    arm: svg.querySelector<SVGLineElement>(`.axis-arm.axis-${axis}`)!,
    label: svg.querySelector<SVGTextElement>(`.axis-label.axis-${axis}`)!,
    world: new Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0),
    depth: 0
  }));
  const view = new Vector3();
  const toView = new Quaternion();
  return () => {
    toView.copy(camera.quaternion).invert();
    for (const part of parts) {
      view.copy(part.world).applyQuaternion(toView);
      part.depth = view.z;
      // Screen space is Y-down, so view-space Y is negated.
      part.arm.setAttribute("x2", (GIZMO_CENTER + view.x * GIZMO_ARM).toFixed(2));
      part.arm.setAttribute("y2", (GIZMO_CENTER - view.y * GIZMO_ARM).toFixed(2));
      part.label.setAttribute("x", (GIZMO_CENTER + view.x * GIZMO_LABEL).toFixed(2));
      part.label.setAttribute("y", (GIZMO_CENTER - view.y * GIZMO_LABEL).toFixed(2));
      // View-space +Z points back at the eye: that axis is the bright, unoccluded one.
      const opacity = (0.4 + 0.6 * ((view.z + 1) / 2)).toFixed(2);
      part.arm.setAttribute("opacity", opacity);
      part.label.setAttribute("opacity", opacity);
    }
    // Paint the axis nearest the camera last so the triad reads as a solid object.
    for (const part of [...parts].sort((a, b) => a.depth - b.depth)) {
      svg.append(part.arm, part.label);
    }
  };
}

/** @entry CSS cube and axis triad share the camera orientation, without a second GPU canvas. */
export function createNavCube(stage: Stage, element: HTMLElement, axisGizmo: SVGSVGElement): void {
  const cube = element.querySelector<HTMLElement>(".cube")!;
  const flipY = new Matrix4().makeScale(1, -1, 1);
  const rotation = new Matrix4();
  const quaternion = new Quaternion();
  const syncAxes = createAxisSync(axisGizmo, stage.camera);
  const sync = (): void => {
    rotation.makeRotationFromQuaternion(quaternion.copy(stage.camera.quaternion).invert());
    rotation.premultiply(flipY).multiply(flipY);
    cube.style.transform = `matrix3d(${rotation.elements.join(",")})`;
    syncAxes();
  };
  stage.controls.addEventListener("change", sync);
  sync();

  let suppressClick = false;
  let pointer: { id: number; x: number; y: number; moved: boolean } | null = null;
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || pointer !== null) return;
    suppressClick = false;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  });
  element.addEventListener("pointermove", (event) => {
    if (pointer === null || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (!pointer.moved && Math.hypot(dx, dy) < 5) return;
    element.setPointerCapture(event.pointerId);
    pointer.moved = true;
    stage.rotateView(dx * 0.012, dy * 0.012);
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  });
  element.addEventListener("pointercancel", () => { pointer = null; });
  element.addEventListener("click", (event) => {
    if (suppressClick) { suppressClick = false; return; }
    const face = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-view]");
    if (face) stage.setStandardView(face.dataset["view"] as StandardView);
    element.focus({ preventScroll: true });
  });
  element.addEventListener("keydown", (event) => {
    const views: Record<string, StandardView> = { "1": "front", "2": "back", "3": "left", "4": "right", "5": "top", "6": "bottom", Home: "iso" };
    if (views[event.key]) stage.setStandardView(views[event.key]);
    else if (event.key.startsWith("Arrow")) {
      stage.rotateView(
        event.key === "ArrowLeft" ? 0.2 : event.key === "ArrowRight" ? -0.2 : 0,
        event.key === "ArrowUp" ? 0.2 : event.key === "ArrowDown" ? -0.2 : 0
      );
    } else return;
    event.preventDefault();
  });
  window.addEventListener("pointerup", () => {
    suppressClick = pointer?.moved ?? false;
    pointer = null;
  });
}
