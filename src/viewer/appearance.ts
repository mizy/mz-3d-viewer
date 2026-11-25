import * as THREE from "three/webgpu";
import type { CadFaceSpan } from "../loaders/cadFaces";

export type DisplayStyle = "solid" | "edges" | "wireframe" | "xray";
export const MATERIAL_PRESETS = {
  gray: { color: 0x696969, roughness: 0.76, metalness: 0 },
  blue: { color: 0x326ca5, roughness: 0.82, metalness: 0 },
  aluminum: { color: 0x98a4ad, roughness: 0.34, metalness: 0.75 }
} as const;
export type MaterialPreset = keyof typeof MATERIAL_PRESETS | "original";
type SurfaceColor = THREE.MeshStandardNodeMaterial["colorNode"];
export type SurfaceHover = Readonly<{ mesh: THREE.Mesh; face: CadFaceSpan | null }>;

type SurfaceEntry = { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] };

/** What the meshes currently show, so a hover can undo only the mesh it touched. */
type AppliedState = Readonly<{
  style: DisplayStyle;
  preset: MaterialPreset;
  selected: THREE.Object3D | null;
  hoveredMesh: THREE.Mesh | null;
  face: CadFaceSpan | null;
}>;

export type ModelAppearance = {
  surfaces: SurfaceEntry[];
  byMesh: Map<THREE.Mesh, SurfaceEntry>;
  xray: Map<THREE.Material, THREE.Material>;
  highlight: THREE.MeshStandardMaterial;
  hover: THREE.MeshStandardNodeMaterial;
  hoverXray: THREE.MeshStandardNodeMaterial;
  hoveredGeometry: THREE.BufferGeometry | null;
  preset: MaterialPreset;
  override: { solid: THREE.MeshStandardNodeMaterial; xray: THREE.MeshStandardNodeMaterial } | null;
  applied: AppliedState | null;
};

/** Capture imported materials so temporary inspection styles never replace their source. */
export function createAppearance(root: THREE.Object3D, surfaceColor: SurfaceColor): ModelAppearance {
  const surfaces: ModelAppearance["surfaces"] = [];
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) {
      const mesh = node as THREE.Mesh;
      surfaces.push({ mesh, material: mesh.material });
    }
  });
  const xray = new Map<THREE.Material, THREE.Material>();
  for (const { material } of surfaces) {
    for (const original of Array.isArray(material) ? material : [material]) {
      if (xray.has(original)) continue;
      const transparent = original.clone();
      transparent.transparent = true;
      transparent.opacity *= 0.3;
      transparent.depthWrite = false;
      transparent.side = THREE.DoubleSide;
      xray.set(original, transparent);
    }
  }
  const hover = new THREE.MeshStandardNodeMaterial({
    color: 0xc58c36, emissive: 0x834a12, emissiveIntensity: 0.17, roughness: 0.68,
    side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4
  });
  hover.colorNode = surfaceColor;
  const hoverXray = hover.clone();
  hoverXray.transparent = true;
  hoverXray.opacity = 0.3;
  hoverXray.depthWrite = false;
  const appearance: ModelAppearance = {
    surfaces,
    byMesh: new Map(surfaces.map((surface) => [surface.mesh, surface])),
    xray,
    preset: "original",
    override: null,
    hover,
    hoverXray,
    hoveredGeometry: null,
    highlight: new THREE.MeshStandardMaterial({ color: 0xb7fbd8, emissive: 0x2c805c,
      emissiveIntensity: 0.5, roughness: 0.4, side: THREE.DoubleSide }),
    applied: null
  };
  setMaterialPreset(appearance, "gray", surfaceColor);
  return appearance;
}

/** @entry Apply a uniform material to one model while retaining its imported surfaces. */
export function setMaterialPreset(appearance: ModelAppearance, preset: MaterialPreset, surfaceColor: SurfaceColor): void {
  appearance.preset = preset;
  if (preset === "original") {
    disposeMaterialOverride(appearance);
    return;
  }
  if (appearance.override === null) {
    const solid = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4
    });
    solid.colorNode = surfaceColor;
    const xray = solid.clone();
    xray.transparent = true;
    xray.opacity = 0.3;
    xray.depthWrite = false;
    appearance.override = { solid, xray };
  }
  const settings = MATERIAL_PRESETS[preset];
  for (const material of [appearance.override.solid, appearance.override.xray]) {
    material.color.set(settings.color);
    material.roughness = settings.roughness;
    material.metalness = settings.metalness;
  }
}

function disposeMaterialOverride(appearance: ModelAppearance): void {
  appearance.override?.solid.dispose();
  appearance.override?.xray.dispose();
  appearance.override = null;
}

/**
 * @entry Material overrides are per mesh; shared imported materials retain their colors.
 *
 * Hover is the hot path now that the pointer is resolved on the GPU: moving between two meshes
 * reassigns two materials instead of walking every surface of the model. Selection, style and
 * preset changes still take the full pass, which is fine — they happen on clicks, not per move.
 */
export function applyAppearance(
  appearance: ModelAppearance, style: DisplayStyle,
  selected: THREE.Object3D | null, hovered: SurfaceHover | null
): void {
  const previous = appearance.applied;
  const hoveredMesh = hovered?.mesh ?? null;
  const face = hovered?.face ?? null;
  const structural = previous === null || previous.style !== style ||
    previous.preset !== appearance.preset || previous.selected !== selected;

  if (structural) {
    clearFaceHover(appearance);
    appearance.highlight.wireframe = style === "wireframe";
    appearance.hover.wireframe = style === "wireframe";
    if (appearance.override !== null) appearance.override.solid.wireframe = style === "wireframe";
    for (const surface of appearance.surfaces) {
      surface.mesh.material = materialFor(appearance, surface, style, selected, hovered);
    }
  } else if (previous.hoveredMesh !== hoveredMesh || previous.face !== face) {
    clearFaceHover(appearance);
    const previousSurface = previous.hoveredMesh === null ? undefined : appearance.byMesh.get(previous.hoveredMesh);
    if (previousSurface !== undefined) {
      previousSurface.mesh.material = materialFor(appearance, previousSurface, style, selected, null);
    }
    if (hovered !== null) {
      const surface = appearance.byMesh.get(hovered.mesh);
      if (surface !== undefined) surface.mesh.material = materialFor(appearance, surface, style, selected, hovered);
    }
  }
  appearance.applied = { style, preset: appearance.preset, selected, hoveredMesh, face };
}

function materialFor(
  appearance: ModelAppearance, surface: SurfaceEntry, style: DisplayStyle,
  selected: THREE.Object3D | null, hovered: SurfaceHover | null
): THREE.Material | THREE.Material[] {
  if (isSelected(surface.mesh, selected)) return appearance.highlight;
  const base = surfaceMaterial(appearance, surface.material, style);
  if (hovered === null || hovered.mesh !== surface.mesh) return base;
  const hoverMaterial = style === "xray" ? appearance.hoverXray : appearance.hover;
  if (hovered.face !== null && !Array.isArray(base) && surface.mesh.geometry.groups.length === 0) {
    splitFaceDraw(surface.mesh.geometry, hovered.face);
    appearance.hoveredGeometry = surface.mesh.geometry;
    return [base, hoverMaterial];
  }
  return hoverMaterial;
}

function isSelected(mesh: THREE.Mesh, selected: THREE.Object3D | null): boolean {
  if (selected === null) return false;
  for (let node: THREE.Object3D | null = mesh; node; node = node.parent) {
    if (node === selected) return true;
  }
  return false;
}

function surfaceMaterial(
  appearance: ModelAppearance, source: THREE.Material | THREE.Material[], style: DisplayStyle
): THREE.Material | THREE.Material[] {
  const override = appearance.override;
  if (override !== null) return style === "xray" ? override.xray : override.solid;
  for (const material of Array.isArray(source) ? source : [source]) {
    if ("wireframe" in material) material.wireframe = style === "wireframe";
  }
  if (style !== "xray") return source;
  return Array.isArray(source)
    ? source.map((material) => appearance.xray.get(material)!)
    : appearance.xray.get(source)!;
}

/** Render the hovered CAD span using the original vertex/index buffers. */
function splitFaceDraw(geometry: THREE.BufferGeometry, { start, count }: CadFaceSpan): void {
  const end = start + count;
  const total = geometry.index?.count ?? geometry.getAttribute("position").count;
  if (start > 0) geometry.addGroup(0, start, 0);
  geometry.addGroup(start, count, 1);
  if (end < total) geometry.addGroup(end, total - end, 0);
}

function clearFaceHover(appearance: ModelAppearance): void {
  appearance.hoveredGeometry?.clearGroups();
  appearance.hoveredGeometry = null;
}

export function disposeAppearance(appearance: ModelAppearance): void {
  clearFaceHover(appearance);
  for (const surface of appearance.surfaces) surface.mesh.material = surface.material;
  disposeMaterialOverride(appearance);
  for (const material of appearance.xray.values()) material.dispose();
  appearance.highlight.dispose();
  appearance.hover.dispose();
  appearance.hoverXray.dispose();
}
