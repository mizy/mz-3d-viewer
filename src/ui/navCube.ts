import { Matrix4, Quaternion, Vector3 } from "three/webgpu";
import type { Stage, StandardView } from "../viewer/stage";

const CUBE_HALF = 28;
/** Shorter projected arms read as "this axis points at you", so they become a dot instead. */
const AXIS_MIN_ARM = 6;
const LABEL_PULLBACK = 10;
const DOT_OFFSET = 8;

type OverlayPart = { edge: SVGLineElement; dot: SVGCircleElement; label: SVGTextElement };
type Projected = { x: number; y: number; z: number };
type BoxGeometry = { size: number; originX: number; originY: number; cubeX: number; cubeY: number; perspective: number };

/** Corners are indexed by sign bits (0 = x, 1 = y, 2 = z), so the neighbour along axis a is `index ^ (1 << a)`. */
const CORNERS: [number, number, number][] = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => [
  ((index >> 0) & 1) === 1 ? CUBE_HALF : -CUBE_HALF,
  ((index >> 1) & 1) === 1 ? CUBE_HALF : -CUBE_HALF,
  ((index >> 2) & 1) === 1 ? CUBE_HALF : -CUBE_HALF
]);

function readGeometry(box: HTMLElement, cube: HTMLElement): BoxGeometry {
  return {
    size: box.clientWidth,
    originX: box.clientWidth / 2,
    originY: box.clientHeight / 2,
    cubeX: cube.offsetLeft + CUBE_HALF,
    cubeY: cube.offsetTop + CUBE_HALF,
    perspective: Number.parseFloat(getComputedStyle(box).perspective) || 500
  };
}

/**
 * The axis triad lives on the cube itself: the three edges meeting at the corner nearest the eye
 * become X/Y/Z, taking over the white edges from that corner, and the corner swaps as the camera
 * turns. Positions are projected with the very perspective the cube is rendered with
 * (`perspective`/`perspective-origin` on the navcube box), so the coloured edges land exactly on
 * the rendered ones — a plain 2D projection would drift by a couple of pixels.
 */
function createAxisOverlay(svg: SVGSVGElement, box: HTMLElement, cube: HTMLElement): (cubeRotation: Matrix4) => void {
  const parts: OverlayPart[] = (["x", "y", "z"] as const).map((axis) => ({
    edge: svg.querySelector<SVGLineElement>(`.axis-edge.axis-${axis}`)!,
    dot: svg.querySelector<SVGCircleElement>(`.axis-dot.axis-${axis}`)!,
    label: svg.querySelector<SVGTextElement>(`.axis-label.axis-${axis}`)!
  }));
  const point = new Vector3();
  const projected: Projected[] = CORNERS.map(() => ({ x: 0, y: 0, z: 0 }));
  let geometry = readGeometry(box, cube);
  window.addEventListener("resize", () => { geometry = readGeometry(box, cube); });

  return (cubeRotation: Matrix4): void => {
    svg.setAttribute("viewBox", `0 0 ${geometry.size} ${geometry.size}`);
    let nearest = 0;
    let depth = -Infinity;
    for (let index = 0; index < CORNERS.length; index += 1) {
      const corner = CORNERS[index];
      point.set(corner[0], corner[1], corner[2]).applyMatrix4(cubeRotation);
      const scale = geometry.perspective / (geometry.perspective - point.z);
      const entry = projected[index];
      entry.z = point.z;
      entry.x = geometry.originX + (geometry.cubeX + point.x - geometry.originX) * scale;
      entry.y = geometry.originY + (geometry.cubeY + point.y - geometry.originY) * scale;
      if (point.z > depth) {
        depth = point.z;
        nearest = index;
      }
    }

    const from = projected[nearest];
    for (let axis = 0; axis < parts.length; axis += 1) {
      const part = parts[axis];
      const to = projected[nearest ^ (1 << axis)];
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy);
      const pointsAtViewer = length < AXIS_MIN_ARM;
      part.edge.setAttribute("x1", from.x.toFixed(1));
      part.edge.setAttribute("y1", from.y.toFixed(1));
      part.edge.setAttribute("x2", to.x.toFixed(1));
      part.edge.setAttribute("y2", to.y.toFixed(1));
      part.edge.setAttribute("opacity", pointsAtViewer ? "0" : "1");
      part.dot.setAttribute("cx", from.x.toFixed(1));
      part.dot.setAttribute("cy", from.y.toFixed(1));
      part.dot.setAttribute("opacity", pointsAtViewer ? "1" : "0");
      const labelX = pointsAtViewer ? from.x + DOT_OFFSET : to.x - (dx / length) * LABEL_PULLBACK;
      const labelY = pointsAtViewer ? from.y + DOT_OFFSET : to.y - (dy / length) * LABEL_PULLBACK;
      part.label.setAttribute("x", labelX.toFixed(1));
      part.label.setAttribute("y", labelY.toFixed(1));
    }
  };
}

/** @entry CSS cube and the axes it carries share the camera orientation, without a second GPU canvas. */
export function createNavCube(stage: Stage, element: HTMLElement): void {
  const cube = element.querySelector<HTMLElement>(".cube")!;
  const flipY = new Matrix4().makeScale(1, -1, 1);
  const rotation = new Matrix4();
  const quaternion = new Quaternion();
  const syncAxes = createAxisOverlay(element.querySelector<SVGSVGElement>(".axis-overlay")!, element, cube);
  const sync = (): void => {
    rotation.makeRotationFromQuaternion(quaternion.copy(stage.camera.quaternion).invert());
    rotation.premultiply(flipY).multiply(flipY);
    cube.style.transform = `matrix3d(${rotation.elements.join(",")})`;
    syncAxes(rotation);
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
