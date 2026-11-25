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
export type SurfaceHighlight = Readonly<{ mesh: THREE.Mesh; face: CadFaceSpan | null }>;

type SurfaceEntry = { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] };

type AppliedState = Readonly<{
  style: DisplayStyle;
  preset: MaterialPreset;
  selected: SurfaceHighlight | null;
  hovered: SurfaceHighlight | null;
}>;

type DrawGroup = THREE.BufferGeometry["groups"][number];

export type ModelAppearance = {
  surfaces: SurfaceEntry[];
  byMesh: Map<THREE.Mesh, SurfaceEntry>;
  xray: Map<THREE.Material, THREE.Material>;
  highlight: THREE.MeshStandardMaterial;
  hover: THREE.MeshStandardNodeMaterial;
  hoverXray: THREE.MeshStandardNodeMaterial;
  hoveredGeometry: THREE.BufferGeometry | null;
  originalGroups: Map<THREE.BufferGeometry, DrawGroup[]>;
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
    originalGroups: new Map(),
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

/** @entry Update only the affected mesh when a face highlight changes. */
export function applyAppearance(
  appearance: ModelAppearance, style: DisplayStyle,
  selected: SurfaceHighlight | null, hovered: SurfaceHighlight | null
): void {
  const previous = appearance.applied;
  const all = previous === null || previous.style !== style || previous.preset !== appearance.preset;
  appearance.applied = { style, preset: appearance.preset, selected, hovered };
  appearance.hoveredGeometry = null;
  if (all) {
    appearance.highlight.wireframe = style === "wireframe";
    appearance.hover.wireframe = style === "wireframe";
    if (appearance.override !== null) appearance.override.solid.wireframe = style === "wireframe";
    for (const surface of appearance.surfaces) updateSurface(appearance, surface, style, selected, hovered);
  } else {
    const affected = new Set<THREE.Mesh>();
    if (!sameSurface(previous.selected, selected)) {
      addAffectedMeshes(affected, previous.selected);
      addAffectedMeshes(affected, selected);
    }
    if (!sameSurface(previous.hovered, hovered)) {
      addAffectedMeshes(affected, previous.hovered);
      addAffectedMeshes(affected, hovered);
    }
    for (const mesh of affected) {
      const surface = appearance.byMesh.get(mesh);
      if (surface) updateSurface(appearance, surface, style, selected, hovered);
    }
    if (hovered?.face && appearance.originalGroups.has(hovered.mesh.geometry) &&
        !sameSurface(selected, hovered)) appearance.hoveredGeometry = hovered.mesh.geometry;
  }
}

function addAffectedMeshes(meshes: Set<THREE.Mesh>, target: SurfaceHighlight | null): void {
  if (target === null) return;
  if (target.face !== null) {
    meshes.add(target.mesh);
  } else {
    target.mesh.traverse((node) => {
      if (node instanceof THREE.Mesh) meshes.add(node);
    });
  }
}

function sameSurface(first: SurfaceHighlight | null, second: SurfaceHighlight | null): boolean {
  return first?.mesh === second?.mesh && first?.face?.start === second?.face?.start &&
    first?.face?.count === second?.face?.count;
}

function updateSurface(
  appearance: ModelAppearance, surface: SurfaceEntry, style: DisplayStyle,
  selected: SurfaceHighlight | null, hovered: SurfaceHighlight | null
): void {
  const { mesh } = surface;
  restoreGroups(appearance, mesh.geometry);
  if (selected?.face === null && isSelected(mesh, selected.mesh)) {
    mesh.material = appearance.highlight;
    return;
  }
  const hoverMaterial = style === "xray" ? appearance.hoverXray : appearance.hover;
  if (hovered?.face === null && isSelected(mesh, hovered.mesh)) {
    mesh.material = hoverMaterial;
    return;
  }

  const base = surfaceMaterial(appearance, surface.material, style);
  const selectedFace = selected?.mesh === mesh ? selected.face : null;
  const hoveredFace = hovered?.mesh === mesh && !sameSurface(selected, hovered) ? hovered.face : null;
  if (!selectedFace && !hoveredFace) {
    mesh.material = base;
    return;
  }

  const materials = Array.isArray(base) ? [...base] : [base];
  const spans: { face: CadFaceSpan; materialIndex: number }[] = [];
  if (selectedFace) spans.push({ face: selectedFace, materialIndex: materials.push(appearance.highlight) - 1 });
  if (hoveredFace) {
    spans.push({ face: hoveredFace, materialIndex: materials.push(hoverMaterial) - 1 });
    appearance.hoveredGeometry = mesh.geometry;
  }
  splitFaceDraw(appearance, mesh.geometry, spans, Array.isArray(base));
  mesh.material = materials;
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

/** Keep imported draw groups and reuse vertex/index buffers for the selected spans. */
function splitFaceDraw(
  appearance: ModelAppearance, geometry: THREE.BufferGeometry,
  spans: { face: CadFaceSpan; materialIndex: number }[], multipleMaterials: boolean
): void {
  const original = geometry.groups;
  appearance.originalGroups.set(geometry, original);
  geometry.groups = [];
  const total = geometry.index?.count ?? geometry.getAttribute("position").count;
  const groups = multipleMaterials ? original : [{ start: 0, count: total, materialIndex: 0 }];
  spans.sort((a, b) => a.face.start - b.face.start);
  for (const group of groups) {
    let cursor = group.start;
    const end = group.start + group.count;
    for (const { face, materialIndex } of spans) {
      const start = Math.max(cursor, face.start);
      const stop = Math.min(end, face.start + face.count);
      if (start >= stop) continue;
      if (start > cursor) geometry.addGroup(cursor, start - cursor, group.materialIndex);
      geometry.addGroup(start, stop - start, materialIndex);
      cursor = stop;
    }
    if (cursor < end) geometry.addGroup(cursor, end - cursor, group.materialIndex);
  }
}

function restoreGroups(appearance: ModelAppearance, geometry: THREE.BufferGeometry): void {
  const original = appearance.originalGroups.get(geometry);
  if (original === undefined) return;
  geometry.groups = original;
  appearance.originalGroups.delete(geometry);
}

export function disposeAppearance(appearance: ModelAppearance): void {
  for (const geometry of appearance.originalGroups.keys()) restoreGroups(appearance, geometry);
  for (const surface of appearance.surfaces) surface.mesh.material = surface.material;
  disposeMaterialOverride(appearance);
  for (const material of appearance.xray.values()) material.dispose();
  appearance.highlight.dispose();
  appearance.hover.dispose();
  appearance.hoverXray.dispose();
}
