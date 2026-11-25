import { Matrix4, Vector3 } from "three/webgpu";
import type { StandardView, ViewDirection } from "../../viewer/stage";

export const CUBE_HALF = 28;
const BEVEL = 8;
const INNER_HALF = CUBE_HALF - BEVEL;
export const CUBE_CORNER = CUBE_HALF - 2 * BEVEL / 3;
const BEVEL_WIDTH = Math.SQRT2 * BEVEL;

const FACES: Record<string, [Exclude<StandardView, "iso">, string]> = {
  "0,0,1": ["front", "前"], "0,0,-1": ["back", "后"],
  "1,0,0": ["right", "右"], "-1,0,0": ["left", "左"],
  "0,1,0": ["top", "顶"], "0,-1,0": ["bottom", "底"]
};

type Facet = { width: number; height: number; transform: Matrix4 };

function facet(center: Vector3, normal: Vector3, size: [number, number], right: Vector3): Facet {
  const down = new Vector3().crossVectors(normal, right);
  return {
    width: size[0], height: size[1],
    transform: new Matrix4().makeBasis(right, down, normal).setPosition(center)
  };
}

function bevelFacet([x, y, z]: ViewDirection, kind: "face" | "edge" | "corner"): Facet {
  const signs = new Vector3(x, -y, z);
  const normal = signs.clone().normalize();
  if (kind === "face") {
    const right = new Vector3().crossVectors(normal, new Vector3(0, -1, 0));
    if (right.lengthSq() === 0) right.set(1, 0, 0);
    return facet(signs.multiplyScalar(CUBE_HALF), normal, [2 * INNER_HALF, 2 * INNER_HALF], right);
  }
  if (kind === "edge") {
    const axis = x === 0 ? 0 : y === 0 ? 1 : 2;
    const center = signs.multiplyScalar(CUBE_HALF - BEVEL / 2);
    return facet(center, normal, [2 * INNER_HALF, BEVEL_WIDTH], new Vector3().setComponent(axis, 1));
  }

  const apex = new Vector3(x * INNER_HALF, -y * CUBE_HALF, z * INNER_HALF);
  const base = signs.clone().multiplyScalar(CUBE_HALF - BEVEL / 2);
  base.y = -y * INNER_HALF;
  const down = base.sub(apex).normalize();
  const right = new Vector3().crossVectors(down, normal);
  const height = BEVEL_WIDTH * Math.sqrt(3) / 2;
  // The CSS triangle has its centroid below the center of its bounding rectangle.
  const center = signs.multiplyScalar(CUBE_CORNER).addScaledVector(down, -height / 6);
  return facet(center, normal, [BEVEL_WIDTH, height], right);
}

function directionLabel([x, y, z]: ViewDirection): string {
  return (x === 0 ? "" : x > 0 ? "右" : "左") +
    (y === 0 ? "" : y > 0 ? "顶" : "底") +
    (z === 0 ? "" : z > 0 ? "前" : "后");
}

/** @entry Build one physical hit target per face, edge and corner. */
export function createCubeRegions(cube: HTMLElement): ReadonlyMap<HTMLButtonElement, ViewDirection> {
  const directions = new Map<HTMLButtonElement, ViewDirection>();
  for (const x of [-1, 0, 1]) {
    for (const y of [-1, 0, 1]) {
      for (const z of [-1, 0, 1]) {
        const direction: ViewDirection = [x, y, z];
        const axes = Math.abs(x) + Math.abs(y) + Math.abs(z);
        if (axes === 0) continue;
        const kind = axes === 1 ? "face" : axes === 2 ? "edge" : "corner";
        const { width, height, transform } = bevelFacet(direction, kind);
        const key = direction.join(",");
        const button = document.createElement("button");
        button.type = "button";
        button.tabIndex = -1;
        button.className = `cube-region ${kind}-region`;
        button.dataset.direction = key;
        button.style.width = `${width}px`;
        button.style.height = `${height}px`;
        button.style.marginLeft = `${-width / 2}px`;
        button.style.marginTop = `${-height / 2}px`;
        button.style.transform = `matrix3d(${transform.elements.join(",")})`;
        if (kind === "face") {
          const [view, label] = FACES[key];
          button.dataset.view = view;
          button.textContent = label;
        }
        const suffix = kind === "corner" ? "角" : kind === "edge" ? "棱" : "";
        const label = `${directionLabel(direction)}${suffix}视图`;
        button.setAttribute("aria-label", label);
        button.title = label;
        directions.set(button, direction);
        cube.append(button);
      }
    }
  }
  return directions;
}
