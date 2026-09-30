import type * as THREE from "three/webgpu";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { strFromU8, unzipSync } from "three/addons/libs/fflate.module.js";
import type { ParsedModel } from "./types";

/**
 * 3MF declares its own unit on `<model unit="…">`, but three's loader only stores that attribute:
 * the geometry arrives in file units. The stage reads every length as millimetres, so the declared
 * unit has to be applied here or an inch file would report a 25.4× larger part.
 */
const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000
};

const MODEL_PART = "3D/3dmodel.model";

export async function loadThreeMf(buffer: ArrayBuffer, fileName: string): Promise<ParsedModel> {
  const warnings: string[] = [];
  const source = declaredUnit(buffer);
  const scale = source === null ? undefined : UNIT_TO_MM[source.name];
  if (scale === undefined) {
    warnings.push(`${fileName} 的源单位无法确认，尺寸按文件坐标显示`);
  } else if (scale !== 1) {
    warnings.push(`${fileName} 声明单位 ${source?.name}，尺寸已折算为毫米（×${scale}）`);
  }

  const root = new ThreeMFLoader().parse(buffer);
  let meshes = 0;
  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh === true) {
      meshes += 1;
    }
  });
  if (meshes === 0) {
    warnings.push(`${fileName} 里没有网格（3MF 可能只包含组建或晶格）`);
  }

  if (scale !== undefined && scale !== 1) {
    root.scale.setScalar(scale);
    root.updateMatrixWorld(true);
  }
  const label = scale === undefined ? "未知（无法读取 3MF 单位）" :
    `${source?.name}（3MF ${source?.declared ? "声明" : "默认"}）`;
  return { format: "3mf", root, sourceUnit: { label, mmPerUnit: scale ?? null }, warnings };
}

/**
 * Reads the declared unit straight out of the package. fflate's filter keeps the work on the
 * central directory plus the one XML part instead of inflating every mesh in the archive.
 */
function declaredUnit(buffer: ArrayBuffer): { name: string; declared: boolean } | null {
  try {
    const part = unzipSync(new Uint8Array(buffer), { filter: (entry) => entry.name === MODEL_PART })[MODEL_PART];
    if (part === undefined) {
      return null;
    }
    // The unit lives in the root element, so the head is enough for anything written by a real
    // exporter; a pathological prologue falls back to decoding the whole part.
    const head = strFromU8(part.subarray(0, 2048));
    const modelTag = /<model\b[^>]*>/.exec(head)?.[0] ?? /<model\b[^>]*>/.exec(strFromU8(part))?.[0];
    if (modelTag === undefined) return null;
    const name = parseUnit(modelTag);
    return { name: name ?? "millimeter", declared: name !== null };
  } catch {
    return null;
  }
}

function parseUnit(xml: string): string | null {
  return /<model\b[^>]*\bunit\s*=\s*["']([^"']+)["']/.exec(xml)?.[1] ?? null;
}
