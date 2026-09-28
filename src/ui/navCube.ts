import { Matrix4, Quaternion } from "three/webgpu";
import type { Stage, StandardView } from "../viewer/stage";

/** @entry CSS cube shares the camera orientation, without a second GPU canvas. */
export function createNavCube(stage: Stage, element: HTMLElement): void {
  const cube = element.querySelector<HTMLElement>(".cube")!;
  const flipY = new Matrix4().makeScale(1, -1, 1);
  const rotation = new Matrix4();
  const quaternion = new Quaternion();
  const sync = (): void => {
    rotation.makeRotationFromQuaternion(quaternion.copy(stage.camera.quaternion).invert());
    rotation.premultiply(flipY).multiply(flipY);
    cube.style.transform = `matrix3d(${rotation.elements.join(",")})`;
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
