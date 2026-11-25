import { convertLength, type MeasurementUnit, type Stage } from "../viewer/stage";
import type { Object3D, Vector3 } from "three/webgpu";
import type { SurfaceHit } from "../viewer/picking/surfaceHit";
import { measurePoints, scaleForPixels } from "../viewer/inspection/measurement";
import { createInspectionHover } from "./inspectionHover";
import { bindCanvasClick } from "./canvasSelection";

/** @entry Wire canvas picking, measurement annotations and the orthographic scale. */
export function createInspection(
  stage: Stage, canvas: HTMLCanvasElement, readUnit: () => MeasurementUnit, onSelect: () => void
): () => void {
  const panel = document.getElementById("measurePanel")!;
  const clearHover = createInspectionHover(stage, canvas, () => panel.hidden === true);
  const button = document.getElementById("measureBtn") as HTMLButtonElement;
  const mode = document.getElementById("measureMode") as HTMLSelectElement;
  const snap = document.getElementById("measureSnap") as HTMLInputElement;
  const reset = document.getElementById("measureReset") as HTMLButtonElement;
  const prompt = document.getElementById("measurePrompt")!;
  const value = document.getElementById("measureValue")!;
  const overlay = document.getElementById("measureOverlay")!;
  const markers = overlay.querySelectorAll("circle");
  const line = document.getElementById("measureLine")!;
  const scale = document.getElementById("scaleBar")!;
  const scaleLabel = scale.querySelector("span")!;
  const format = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 5 });
  const anchors: (SurfaceHit & { localPoint: Vector3 })[] = [];
  let modelId: string | null = null;

  function showMeasurement(open: boolean): void {
    if (open) clearHover();
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (!open) anchors.length = 0;
    render();
  }

  function lengthLabel(length: number): string {
    if (stage.active?.sourceUnit.mmPerUnit == null) return `${format.format(length)}（文件单位未知）`;
    const unit = readUnit();
    return `${format.format(convertLength(length, unit))} ${unit}`;
  }

  function updateScale(): void {
    const unitsPerPixel = stage.orthographicUnitsPerPixel;
    const unit = readUnit();
    const bar = unitsPerPixel === null || stage.active?.sourceUnit.mmPerUnit == null
      ? null
      : scaleForPixels(convertLength(unitsPerPixel, unit), 105);
    scale.toggleAttribute("hidden", bar === null);
    if (bar === null) return;
    const width = `${bar.pixels}px`;
    const label = `${format.format(bar.length)} ${unit}`;
    if (scaleLabel.style.width !== width) scaleLabel.style.width = width;
    if (scaleLabel.textContent !== label) scaleLabel.textContent = label;
  }

  function render(): void {
    updateScale();
    if (panel.hidden || anchors.length === 0) {
      overlay.setAttribute("hidden", "");
      value.textContent = "";
      prompt.textContent = mode.value === "angle" ? "点击模型上的三个点，中间点为顶点" : "点击模型上的两个点";
      reset.disabled = true;
      return;
    }
    reset.disabled = false;
    const worldPoints = anchors.map(({ mesh, localPoint }) => mesh.localToWorld(localPoint.clone()));
    const measurement = measurePoints(mode.value === "angle" ? "angle" : "distance", worldPoints);
    let result = "";
    if (measurement?.kind === "distance") result = lengthLabel(measurement.length);
    if (measurement?.kind === "angle") {
      result = measurement.degrees === null ? "角度未定义" : `${format.format(measurement.degrees)}°`;
    }
    if (value.textContent !== result) value.textContent = result;
    prompt.textContent = result ? "清除后可以重新测量"
      : mode.value === "angle" && anchors.length === 2 ? "选择第三个点" : "选择第二个点";
    const points = worldPoints.map((point, index) => {
      for (let node: Object3D | null = anchors[index].mesh; node; node = node.parent) {
        if (!node.visible) return null;
      }
      return stage.projectVisiblePoint(point);
    });
    overlay.toggleAttribute("hidden", points.some((point) => point === null));
    if (overlay.hasAttribute("hidden")) return;
    const positions = points.map((point) => [(point!.x + 1) * canvas.clientWidth / 2, (1 - point!.y) * canvas.clientHeight / 2]);
    line.setAttribute("points", positions.map((point) => point.join(",")).join(" "));
    markers.forEach((marker, index) => {
      const position = positions[index];
      marker.style.display = position ? "" : "none";
      if (position) {
        marker.setAttribute("cx", String(position[0]));
        marker.setAttribute("cy", String(position[1]));
      }
    });
  }

  function clearMeasurement(): void {
    anchors.length = 0;
    render();
  }

  button.addEventListener("click", () => showMeasurement(panel.hasAttribute("hidden")));
  document.getElementById("measureClose")!.addEventListener("click", () => showMeasurement(false));
  for (const id of ["entitiesBtn", "sidebarToggle", "explodeBtn", "materialBtn"]) {
    document.getElementById(id)!.addEventListener("click", () => {
      if (!panel.hidden) showMeasurement(false);
    });
  }
  reset.addEventListener("click", clearMeasurement);
  mode.addEventListener("change", clearMeasurement);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) showMeasurement(false);
  });

  bindCanvasClick(canvas, selectAt);

  async function selectAt(event: PointerEvent): Promise<void> {
    const activeId = stage.active?.id ?? null;
    if (activeId === null) return;
    const measuring = !panel.hidden;
    if (measuring && anchors.length === (mode.value === "distance" ? 2 : 3)) return;
    // The pick is asynchronous: the model can be closed or replaced while the GPU answers.
    // Measuring needs the exact surface point; plain selection only needs the part.
    const hit = await stage.pick(event.clientX, event.clientY, {
      snap: measuring && snap.checked, exact: measuring, inspect: !measuring
    });
    if (stage.active?.id !== activeId) return;
    if (measuring) {
      const point = hit?.localPoint ?? null;
      if (hit === null || point === null || hit.modelId !== activeId) {
        prompt.textContent = "请在当前模型的可见表面取点";
        return;
      }
      anchors.push({ ...hit, localPoint: point });
      render();
    } else {
      stage.selectHit(hit);
      onSelect();
    }
  }
  canvas.addEventListener("dblclick", () => {
    const selected = stage.active?.selectedPart;
    if (panel.hidden && selected != null) stage.fitToPart(selected);
  });
  stage.onRender = render;
  return () => {
    const active = stage.active;
    button.disabled = active === null;
    if (active === null && !panel.hidden) showMeasurement(false);
    if ((active?.id ?? null) !== modelId) {
      modelId = active?.id ?? null;
      anchors.length = 0;
    }
    render();
  };
}
