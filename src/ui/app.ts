import type { Stage, DisplayStyle, MeasurementUnit, SectionAxis, StandardView } from "../viewer/stage";
import { convertLength } from "../viewer/stage";
import { ACCEPTED_EXTENSIONS, parseOne, primaryFiles } from "../loaders/openFiles";
import { CAD_QUALITY_PRESETS, type CadQuality } from "../loaders/step";
import { describeError } from "../loaders/gltf";
import type { CancelSignal, ParsedModel } from "../loaders/types";
import type { ViewerTestHooks } from "./testHooks";
import { describeWarmState, type CadEngineWarmState } from "../pwa/cadEngineWarm";

type Backend = "webgpu" | "webgl2";
type ToastKind = "info" | "warn" | "error";

const UNIT_LABEL: Record<MeasurementUnit, string> = { mm: "mm", cm: "cm", m: "m", in: "in" };

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`缺少必需的界面元素 #${id}`);
  }
  return node as T;
}

const FORMAT_TITLES: Record<string, string> = {
  stl: "STL",
  obj: "OBJ",
  gltf: "glTF",
  step: "STEP",
  iges: "IGES",
  brep: "BREP"
};

export type AppHandle = {
  /** Called by the PWA layer as the OpenCascade engine download progresses. */
  setCadEngineState: (state: CadEngineWarmState) => void;
};

export function createApp(stage: Stage, backend: Backend, forceWebGL: boolean): AppHandle {
  const canvas = el<HTMLCanvasElement>("view");
  const backendBadge = el<HTMLSpanElement>("backendBadge");
  const openBtn = el<HTMLButtonElement>("openBtn");
  const shotBtn = el<HTMLButtonElement>("shotBtn");
  const fullscreenBtn = el<HTMLButtonElement>("fullscreenBtn");
  const sidebarToggle = el<HTMLButtonElement>("sidebarToggle");
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  const fileInput = el<HTMLInputElement>("fileInput");
  const stageEl = el<HTMLElement>("stage");
  const dropHint = el<HTMLDivElement>("dropHint");
  const dragOverlay = el<HTMLDivElement>("dragOverlay");
  const progressWrap = el<HTMLDivElement>("progressWrap");
  const progressLabel = el<HTMLDivElement>("progressLabel");
  const progressBar = el<HTMLDivElement>("progressBar");
  const cancelBtn = el<HTMLButtonElement>("cancelBtn");
  const modelList = el<HTMLUListElement>("modelList");
  const statsBox = el<HTMLDListElement>("statsBox");
  const statStatus = el<HTMLElement>("statStatus");
  const buildStamp = el<HTMLDivElement>("buildStamp");
  const cadEngineStateEl = el<HTMLDivElement>("cadEngineState");
  const toastEl = el<HTMLDivElement>("toast");
  const gridToggle = el<HTMLInputElement>("gridToggle");
  const sectionToggle = el<HTMLInputElement>("sectionToggle");
  const sectionAxisSelect = el<HTMLSelectElement>("sectionAxisSelect");
  const sectionOffset = el<HTMLInputElement>("sectionOffset");
  const unitSelect = el<HTMLSelectElement>("unitSelect");
  const edgeAngleSelect = el<HTMLSelectElement>("edgeAngleSelect");
  const cadQualitySelect = el<HTMLSelectElement>("cadQualitySelect");
  const styleSolid = el<HTMLInputElement>("styleSolid");
  const styleEdges = el<HTMLInputElement>("styleEdges");
  const styleWireframe = el<HTMLInputElement>("styleWireframe");

  let unit: MeasurementUnit = "mm";
  let cadQuality: CadQuality = "standard";
  let busy = false;
  let cancelSignal: CancelSignal | null = null;
  let toastTimer: number | null = null;
  let cadEngineState: CadEngineWarmState = { status: "idle", cachedBytes: 0, totalBytes: 0, detail: "" };

  const build = document.querySelector<HTMLMetaElement>('meta[name="x-build"]')?.content ?? "dev";
  buildStamp.textContent = `build ${build}`;
  backendBadge.textContent = backend === "webgpu" ? "WebGPU" : "WebGL2（回退）";
  backendBadge.className = `badge ${backend === "webgpu" ? "badge-ok" : "badge-fallback"}`;
  if (forceWebGL) {
    backendBadge.title = "已通过 ?webgl=1 强制走 WebGL2 后端";
  }

  // ------------------------------------------------------------------ toasts & progress

  function toast(text: string, kind: ToastKind = "info", durationMs = 4000): void {
    toastEl.textContent = text;
    toastEl.className = kind === "info" ? "toast" : `toast ${kind}`;
    toastEl.hidden = false;
    if (toastTimer !== null) {
      window.clearTimeout(toastTimer);
    }
    toastTimer = window.setTimeout(() => {
      toastEl.hidden = true;
      toastTimer = null;
    }, durationMs);
  }

  function showProgress(label: string, ratio: number | null): void {
    progressWrap.hidden = false;
    progressLabel.textContent = label;
    progressBar.style.width = ratio === null ? "35%" : `${Math.round(ratio * 100)}%`;
  }

  function hideProgress(): void {
    progressWrap.hidden = true;
    progressBar.style.width = "0%";
  }

  function setCadEngineState(state: CadEngineWarmState): void {
    cadEngineState = state;
    cadEngineStateEl.textContent = describeWarmState(state);
    cadEngineStateEl.className = state.status === "ready" ? "mono ok" : state.status === "failed" ? "mono warn" : "mono";
  }

  function setStatus(text: string): void {
    statStatus.textContent = text;
  }

  // ------------------------------------------------------------------ model list & stats

  function renderModelList(): void {
    modelList.replaceChildren();
    if (stage.modelList.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "还没有模型，把文件拖进右侧窗口";
      modelList.append(empty);
      shotBtn.disabled = true;
      return;
    }
    shotBtn.disabled = false;

    for (const handle of stage.modelList) {
      const item = document.createElement("li");
      item.className = handle.id === stage.active?.id ? "model-item active" : "model-item";

      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "name";
      pick.hidden = false;
      pick.style.background = "transparent";
      pick.style.border = "none";
      pick.style.color = "inherit";
      pick.style.textAlign = "left";
      pick.style.cursor = "pointer";
      pick.style.padding = "0";
      pick.title = "设为当前模型（剖面 / 视图以它为准）";
      const nameSpan = document.createElement("div");
      nameSpan.className = "name";
      nameSpan.textContent = handle.name;
      const subSpan = document.createElement("div");
      subSpan.className = "sub";
      subSpan.textContent = `${FORMAT_TITLES[handle.format] ?? handle.format} · ${handle.stats.triangles.toLocaleString()} 面`;
      pick.append(nameSpan, subSpan);
      pick.addEventListener("click", () => {
        stage.setActive(handle.id);
        renderModelList();
        renderStats();
      });

      const visibility = document.createElement("button");
      visibility.type = "button";
      visibility.className = "icon-btn";
      const visible = stage.isVisible(handle.id);
      visibility.textContent = visible ? "◉" : "◎";
      visibility.title = visible ? "隐藏" : "显示";
      visibility.addEventListener("click", () => {
        stage.setVisible(handle.id, !visible);
        renderModelList();
      });

      const fit = document.createElement("button");
      fit.type = "button";
      fit.className = "icon-btn";
      fit.textContent = "⤢";
      fit.title = "缩放到这个模型";
      fit.addEventListener("click", () => {
        stage.setActive(handle.id);
        stage.fitToActive();
        renderModelList();
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-btn";
      remove.textContent = "×";
      remove.title = "移除";
      remove.addEventListener("click", () => {
        stage.removeModel(handle.id);
        renderModelList();
        renderStats();
      });

      item.append(pick, visibility, fit, remove);
      modelList.append(item);
    }
  }

  function renderStats(): void {
    statsBox.replaceChildren();
    const handle = stage.active;
    if (handle === null) {
      addStat("状态", "等待文件");
      return;
    }
    const size = handle.stats.size;
    addStat("文件", handle.name);
    addStat("格式", FORMAT_TITLES[handle.format] ?? handle.format);
    addStat("顶点", handle.stats.vertices.toLocaleString());
    addStat("三角面", handle.stats.triangles.toLocaleString());
    addStat(
      `包围盒 (${UNIT_LABEL[unit]})`,
      [
        convertLength(size.x, unit).toFixed(2),
        convertLength(size.y, unit).toFixed(2),
        convertLength(size.z, unit).toFixed(2)
      ].join(" × ")
    );
    addStat("文件大小", `${(handle.bytes / 1024 / 1024).toFixed(2)} MB`);
    setStatus(`已加载 ${stage.modelList.length} 个模型`);
  }

  function addStat(label: string, value: string): void {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dd.title = value;
    statsBox.append(dt, dd);
  }

  // ------------------------------------------------------------------ opening files

  async function openFiles(files: File[]): Promise<void> {
    if (busy) {
      toast("上一个文件还在解析，稍等一下…", "warn");
      return;
    }
    const primaries = primaryFiles(files);
    if (primaries.length === 0) {
      toast(`没识别到模型文件，支持：${ACCEPTED_EXTENSIONS.join(" ")}`, "error", 7000);
      return;
    }

    busy = true;
    const signal: CancelSignal = { cancelled: false };
    cancelSignal = signal;
    setStatus("解析中…");

    try {
      let opened = 0;
      for (const file of primaries) {
        if (signal.cancelled) {
          break;
        }
        showProgress(`读取 ${file.name}`, null);
        const parsed: ParsedModel = await parseOne(file, files, {
          renderer: stage.renderer,
          quality: cadQuality,
          signal,
          report: ({ label, ratio }) => showProgress(`${file.name} · ${label}`, ratio)
        });
        if (signal.cancelled) {
          break;
        }
        const handle = stage.addModel(parsed, file.name);
        stage.setBytes(handle.id, file.size);
        stage.fitToActive();
        opened += 1;
        for (const warning of parsed.warnings) {
          toast(warning, "warn", 7000);
        }
      }

      if (signal.cancelled) {
        toast("已取消", "warn");
      } else if (opened > 0) {
        dropHint.hidden = true;
        toast(opened === 1 ? `已打开 ${primaries[0].name}` : `已打开 ${opened} 个模型`);
      }
      // Edge lines are stale as soon as the model set changes.
      if (stage.style === "edges") {
        await stage.setDisplayStyle("edges", reportEdgeProgress);
      }
    } catch (error) {
      const message = describeError(error);
      if (message !== "已取消") {
        toast(`打开失败：${message}`, "error", 9000);
        setStatus("打开失败");
      }
    } finally {
      busy = false;
      cancelSignal = null;
      hideProgress();
      renderModelList();
      renderStats();
    }
  }

  function reportEdgeProgress(done: number, total: number): void {
    showProgress(`生成边线 ${done}/${total}`, total === 0 ? null : done / total);
  }

  // ------------------------------------------------------------------ display settings

  async function applyStyle(style: DisplayStyle): Promise<void> {
    try {
      if (style === "edges") {
        showProgress("生成边线…", null);
      }
      await stage.setDisplayStyle(style, reportEdgeProgress);
    } catch (error) {
      toast(`切换显示模式失败：${describeError(error)}`, "error");
    } finally {
      hideProgress();
    }
  }

  styleSolid.addEventListener("change", () => void applyStyle("solid"));
  styleEdges.addEventListener("change", () => void applyStyle("edges"));
  styleWireframe.addEventListener("change", () => void applyStyle("wireframe"));

  gridToggle.addEventListener("change", () => {
    stage.setGridVisible(gridToggle.checked);
  });

  function applySection(): void {
    const enabled = sectionToggle.checked;
    sectionAxisSelect.disabled = !enabled;
    sectionOffset.disabled = !enabled;
    stage.setSection(enabled, sectionAxisSelect.value as SectionAxis, Number(sectionOffset.value) / 100);
  }
  sectionToggle.addEventListener("change", applySection);
  sectionAxisSelect.addEventListener("change", applySection);
  sectionOffset.addEventListener("input", applySection);

  unitSelect.addEventListener("change", () => {
    unit = unitSelect.value as MeasurementUnit;
    renderStats();
  });

  edgeAngleSelect.addEventListener("change", () => {
    stage.setEdgeAngle(Number(edgeAngleSelect.value));
    if (stage.style === "edges") {
      void applyStyle("edges");
    }
  });

  cadQualitySelect.addEventListener("change", () => {
    const value = cadQualitySelect.value as CadQuality;
    if (CAD_QUALITY_PRESETS[value] !== undefined) {
      cadQuality = value;
      toast(`CAD 精度：${CAD_QUALITY_PRESETS[value].label}（下次打开 CAD 文件生效）`);
    }
  });

  // ------------------------------------------------------------------ buttons

  openBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const files = fileInput.files === null ? [] : [...fileInput.files];
    fileInput.value = "";
    void openFiles(files);
  });

  cancelBtn.addEventListener("click", () => {
    if (cancelSignal !== null) {
      cancelSignal.cancelled = true;
    }
  });

  shotBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const dataUrl = await stage.captureNextFrame();
        const link = document.createElement("a");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        link.href = dataUrl;
        link.download = `${stripExtension(stage.active?.name ?? "model")}-${stamp}.png`;
        link.click();
      } catch (error) {
        toast(`截图失败：${describeError(error)}`, "error");
      }
    })();
  });

  fullscreenBtn.addEventListener("click", () => {
    void (async () => {
      try {
        if (document.fullscreenElement !== null) {
          await document.exitFullscreen();
        } else {
          await stageEl.requestFullscreen();
        }
      } catch (error) {
        toast(`全屏失败：${describeError(error)}`, "error");
      }
    })();
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreenBtn.textContent = document.fullscreenElement === null ? "全屏" : "退出全屏";
  });

  sidebarToggle.addEventListener("click", () => {
    sidebar?.classList.toggle("open");
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    button.addEventListener("click", () => {
      stage.setStandardView(button.dataset["view"] as StandardView);
    });
  }
  el<HTMLButtonElement>("fitBtn").addEventListener("click", () => {
    stage.fitToActive();
  });

  // ------------------------------------------------------------------ drag & drop

  let dragDepth = 0;
  stageEl.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    dragOverlay.hidden = false;
  });
  stageEl.addEventListener("dragover", (event) => {
    event.preventDefault();
  });
  stageEl.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dragOverlay.hidden = true;
    }
  });
  stageEl.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    dragOverlay.hidden = true;
    const files = event.dataTransfer === null ? [] : [...event.dataTransfer.files];
    void openFiles(files);
  });

  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
      return;
    }
    switch (event.key.toLowerCase()) {
      case "f":
        stage.fitToActive();
        return;
      case "g":
        gridToggle.checked = !gridToggle.checked;
        stage.setGridVisible(gridToggle.checked);
        return;
      case "w": {
        const next: DisplayStyle = stage.style === "solid" ? "edges" : stage.style === "edges" ? "wireframe" : "solid";
        styleSolid.checked = next === "solid";
        styleEdges.checked = next === "edges";
        styleWireframe.checked = next === "wireframe";
        void applyStyle(next);
        return;
      }
      default:
        return;
    }
  });

  // ------------------------------------------------------------------ test hooks

  const hooks: ViewerTestHooks = {
    stage,
    backend,
    capture: () => stage.captureNextFrame(),
    cadEngine: () => cadEngineState,
    summary: () => ({
      models: stage.modelList.map((handle) => ({
        id: handle.id,
        name: handle.name,
        format: handle.format,
        triangles: handle.stats.triangles,
        vertices: handle.stats.vertices,
        visible: stage.isVisible(handle.id),
        sizeMm: [handle.stats.size.x, handle.stats.size.y, handle.stats.size.z]
      })),
      activeId: stage.active?.id ?? null,
      style: stage.style,
      gridVisible: gridToggle.checked,
      sectionEnabled: sectionToggle.checked,
      backend,
      build,
      cadEngineStatus: cadEngineState.status
    })
  };
  window.__mzViewer = hooks;

  renderModelList();
  renderStats();
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  return { setCadEngineState };
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}
