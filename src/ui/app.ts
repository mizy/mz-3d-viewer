import type { Stage, DisplayStyle, MeasurementUnit, SectionAxis, ControllerKind, Projection } from "../viewer/stage";
import { CONTROLLER_LABEL, isControllerKind } from "../viewer/controller";
import { createEntities } from "./entities";
import { createInspection } from "./inspection";
import { createContextMenu } from "./contextMenu";
import { createNavCube } from "./navCube";
import { createDemo } from "../viewer/demo";
import { convertLength, DEFAULT_EDGE_WIDTH } from "../viewer/stage";
import type { MaterialPreset } from "../viewer/appearance";
import { ACCEPTED_EXTENSIONS, parseOne, primaryFiles } from "../loaders/openFiles";
import { CAD_QUALITY_PRESETS, type CadQuality } from "../loaders/step";
import { describeError } from "../loaders/gltf";
import type { ParsedModel } from "../loaders/types";
import { disposeObject } from "../viewer/dispose";
import type { ViewerTestHooks } from "./testHooks";
import { describeWarmState, type CadEngineWarmState } from "../pwa/cadEngineWarm";

type ToastKind = "info" | "warn" | "error";

const UNIT_LABEL: Record<MeasurementUnit, string> = { mm: "mm", cm: "cm", m: "m", in: "in" };

/** Looks up a required element by id; the caller asserts its concrete type (SVG elements included). */
function el<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`缺少必需的界面元素 #${id}`);
  }
  return node as unknown as T;
}

const FORMAT_TITLES: Record<string, string> = {
  stl: "STL",
  obj: "OBJ",
  gltf: "glTF",
  "3mf": "3MF",
  step: "STEP",
  iges: "IGES",
  brep: "BREP"
};

export type AppHandle = {
  /** Called by the PWA layer as the OpenCascade engine download progresses. */
  setCadEngineState: (state: CadEngineWarmState) => void;
  openFiles: (files: File[]) => Promise<void>;
  reportFileOpenError: (error: unknown) => void;
};

export function createApp(stage: Stage): AppHandle {
  const canvas = el<HTMLCanvasElement>("view");
  const backendBadge = el<HTMLSpanElement>("backendBadge");
  const openBtn = el<HTMLButtonElement>("openBtn");
  const shotBtn = el<HTMLButtonElement>("shotBtn");
  const fullscreenBtn = el<HTMLButtonElement>("fullscreenBtn");
  const sidebarToggle = el<HTMLButtonElement>("sidebarToggle");
  const sidebar = el<HTMLDialogElement>("settingsPanel");
  const explodeRange = el<HTMLInputElement>("explodeRange");
  const explodePanel = el<HTMLElement>("explodePanel");
  const explodeBtn = el<HTMLButtonElement>("explodeBtn");
  const styleBtn = el<HTMLButtonElement>("styleBtn");
  const pickMode = el<HTMLSelectElement>("pickMode");
  pickMode.value = stage.pickMode;
  pickMode.addEventListener("change", () => {
    stage.setPickMode(pickMode.value === "body" ? "body" : "face");
    renderModelList();
  });
  const displayBtn = el<HTMLButtonElement>("displayBtn");
  const displayMenu = el<HTMLElement>("displayMenu");
  const materialBtn = el<HTMLButtonElement>("materialBtn");
  const materialPanel = el<HTMLElement>("materialPanel");
  const materialTarget = el<HTMLParagraphElement>("materialTarget");
  const materialOptions = materialPanel.querySelectorAll<HTMLButtonElement>("[data-material]");
  const fileInput = el<HTMLInputElement>("fileInput");
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
  const environmentToggle = el<HTMLInputElement>("environmentToggle");
  const sectionToggle = el<HTMLInputElement>("sectionToggle");
  const sectionControls = (["x", "y", "z"] satisfies SectionAxis[]).map((axis) => {
    const suffix = axis.toUpperCase();
    return {
      axis,
      enabled: el<HTMLInputElement>(`section${suffix}`),
      offset: el<HTMLInputElement>(axis === "x" ? "sectionOffset" : `sectionOffset${suffix}`),
      flip: el<HTMLButtonElement>(`sectionFlip${suffix}`)
    };
  });
  const fitAllBtn = el<HTMLButtonElement>("fitAllBtn");
  const unitSelect = el<HTMLSelectElement>("unitSelect");
  const sourceUnitSelect = el<HTMLSelectElement>("sourceUnitSelect");
  const edgeAngleSelect = el<HTMLSelectElement>("edgeAngleSelect");
  const edgeWidthRange = el<HTMLInputElement>("edgeWidthRange");
  const edgeWidthValue = el<HTMLOutputElement>("edgeWidthValue");
  const cadQualitySelect = el<HTMLSelectElement>("cadQualitySelect");
  const controllerSelect = el<HTMLSelectElement>("controllerSelect");
  const projectionPerspective = el<HTMLInputElement>("projectionPerspective");
  const projectionOrthographic = el<HTMLInputElement>("projectionOrthographic");
  const styleSolid = el<HTMLInputElement>("styleSolid");
  const styleEdges = el<HTMLInputElement>("styleEdges");
  const styleWireframe = el<HTMLInputElement>("styleWireframe");
  const styleXray = el<HTMLInputElement>("styleXray");
  const renderEntities = createEntities(stage);
  fileInput.accept = ACCEPTED_EXTENSIONS.join(",");

  let unit: MeasurementUnit = "mm";
  const renderInspection = createInspection(stage, canvas, () => unit, () => {
    renderModelList();
    renderStats();
  });

  createContextMenu(stage, canvas, {
    fitAll: () => stage.fitToScene(),
    fitPart: (index) => stage.fitToPart(index),
    hidePart: (index) => {
      stage.setPartVisible(index, false);
      renderModelList();
    },
    isolatePart: (index) => {
      stage.isolatePart(index);
      renderModelList();
    },
    hideModel: (modelId) => {
      stage.setVisible(modelId, false);
      renderModelList();
    },
    showAll: () => {
      for (const handle of stage.modelList) stage.setVisible(handle.id, true);
      stage.showAllParts();
      renderModelList();
    },
    resetView: () => {
      stage.setStandardView("iso", false);
      stage.fitToScene();
    },
    setStyle: (style) => { void applyStyle(style); }
  });
  let cadQuality: CadQuality = "standard";
  let busy = false;
  let styleRequest = 0;
  let cancelController: AbortController | null = null;
  let toastTimer: number | null = null;
  let cadEngineState: CadEngineWarmState = { status: "idle", cachedBytes: 0, totalBytes: 0, detail: "" };

  const build = document.querySelector<HTMLMetaElement>('meta[name="x-build"]')?.content ?? "dev";
  buildStamp.textContent = `build ${build}`;
  backendBadge.textContent = "WebGPU";
  backendBadge.classList.add("badge-ok");

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

  function showProgress(label: string, ratio: number | null, cancellable = true): void {
    progressWrap.hidden = false;
    progressLabel.textContent = label;
    cancelBtn.hidden = !cancellable;
    // A null ratio means the work is alive but refuses to be measured (OCCT tessellation runs
    // as one blocking wasm call). Sweep the bar instead of parking a fake percentage on it.
    const indeterminate = ratio === null;
    progressBar.classList.toggle("is-indeterminate", indeterminate);
    progressBar.style.width = indeterminate ? "" : `${Math.round(ratio * 100)}%`;
  }

  function hideProgress(): void {
    progressWrap.hidden = true;
    progressBar.classList.remove("is-indeterminate");
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
    renderEntities();
    dropHint.hidden = stage.modelList.length > 0;
    const active = stage.active;
    el<HTMLElement>("activeName").textContent = active?.name ?? "";
    el<HTMLElement>("modelCaption").hidden = active === null;
    el<HTMLElement>("navigation").hidden = active === null;
    explodeBtn.disabled = active === null;
    const canExplode = active !== null && active.parts.length > 1;
    explodeRange.disabled = !canExplode;
    el<HTMLElement>("explodeHint").hidden = active === null || canExplode;
    el<HTMLButtonElement>("assembleBtn").disabled = !canExplode;
    el<HTMLButtonElement>("separateBtn").disabled = !canExplode;
    explodeBtn.title = explodeBtn.disabled ? "爆炸视图需要至少两个独立网格部件" : "分离模型部件";
    if (explodeBtn.disabled) explodePanel.hidePopover();
    explodeRange.value = String(Math.round((active?.explodeTarget ?? 0) * 100));
    el<HTMLOutputElement>("explodeValue").value = `${explodeRange.value}%`;
    el<HTMLElement>("partCount").textContent = `${active?.parts.length ?? 0} 部件`;
    explodeBtn.classList.toggle("active", (active?.explodeTarget ?? 0) > 0);
    styleBtn.disabled = active === null;
    displayBtn.disabled = active === null;
    el<HTMLElement>("pickModeControl").hidden = active === null;
    renderMaterialControls();
    renderInspection();
    fitAllBtn.disabled = !stage.modelList.some(({ root }) => root.visible);
    el<HTMLButtonElement>("fitBtn").disabled = active === null;
    if (stage.modelList.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "打开一个模型，开始探索";
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
    renderInspection();
    const handle = stage.active;
    if (handle === null) {
      sourceUnitSelect.disabled = true;
      sourceUnitSelect.options[0].textContent = "选择源单位";
      sourceUnitSelect.value = "";
      setStatus("等待文件");
      addStat("状态", "等待文件");
      return;
    }
    const size = handle.stats.size;
    const manual = handle.sourceUnit.manualUnit !== undefined;
    sourceUnitSelect.disabled = handle.sourceUnit.mmPerUnit !== null && !manual;
    sourceUnitSelect.options[0].textContent = handle.sourceUnit.mmPerUnit === null ? "选择源单位" : "文件单位已确定";
    sourceUnitSelect.options[0].disabled = manual;
    sourceUnitSelect.value = handle.sourceUnit.manualUnit ?? "";
    addStat("文件", handle.name);
    addStat("格式", FORMAT_TITLES[handle.format] ?? handle.format);
    addStat("源单位", handle.sourceUnit.label);
    addStat("顶点", handle.stats.vertices.toLocaleString());
    addStat("三角面", handle.stats.triangles.toLocaleString());
    addStat("独立网格部件", String(handle.parts.length));
    const dimensions = size.toArray().map((value) =>
      (handle.sourceUnit.mmPerUnit === null ? value : convertLength(value, unit))
        .toLocaleString("zh-CN", { maximumFractionDigits: 6 })
    ).join(" × ");
    addStat("包围盒 X × Y × Z", `${dimensions} ${handle.sourceUnit.mmPerUnit === null ? "文件坐标（单位未知）" : UNIT_LABEL[unit]}`);
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
    const controller = new AbortController();
    const signal = controller.signal;
    cancelController = controller;
    setStatus("解析中…");
    let opened = 0;

    try {
      const notes: string[] = [];
      for (const file of primaries) {
        if (signal.aborted) {
          break;
        }
        showProgress(`读取 ${file.name}`, null);
        const parsed: ParsedModel = await parseOne(file, files, {
          renderer: stage.renderer,
          quality: cadQuality,
          signal,
          report: ({ label, ratio }) => showProgress(`${file.name} · ${label}`, ratio)
        });
        if (signal.aborted) {
          disposeObject(parsed.root);
          break;
        }
        const handle = stage.addModel(parsed, file.name);
        stage.setBytes(handle.id, file.size);
        stage.fitToActive();
        opened += 1;
        notes.push(...parsed.warnings);
      }

      if (signal.aborted) {
        toast("已取消", "warn");
      } else if (opened > 0) {
        setSidebarOpen(false);
        // Loader notes ride along with the confirmation: toasting them separately let the
        // confirmation overwrite them in the same tick, so the user never saw them at all.
        const summary = opened === 1 ? `已打开 ${primaries[0].name}` : `已打开 ${opened} 个模型`;
        toast(notes.length === 0 ? summary : `${summary} · ${notes.join(" · ")}`, notes.length === 0 ? "info" : "warn", notes.length === 0 ? 4000 : 9000);
      }
    } catch (error) {
      const message = describeError(error);
      if (signal.aborted) {
        toast("已取消", "warn");
      } else {
        toast(`打开失败：${message}`, "error", 9000);
        setStatus("打开失败");
      }
    } finally {
      busy = false;
      cancelController = null;
      hideProgress();
      renderModelList();
      renderStats();
    }
    // Edge generation is a separate display task. The model remains usable during it.
    if (opened > 0 && stage.style === "edges") await applyStyle("edges");
  }

  function reportEdgeProgress(done: number, total: number): void {
    showProgress(`生成边线 ${done}/${total}`, total === 0 ? null : done / total, false);
  }

  // ------------------------------------------------------------------ display settings

  const STYLE_LABEL: Record<DisplayStyle, string> = {
    solid: "实体", edges: "边线", wireframe: "线框", xray: "透射"
  };

  function syncStyleControls(style: DisplayStyle): void {
    styleSolid.checked = style === "solid";
    styleEdges.checked = style === "edges";
    styleWireframe.checked = style === "wireframe";
    styleXray.checked = style === "xray";
    styleBtn.setAttribute("aria-pressed", String(style === "edges"));
    styleBtn.title = style === "edges" ? "关闭边线" : "显示边线";
    displayBtn.title = `显示模式：${STYLE_LABEL[style]}`;
    displayBtn.setAttribute("aria-label", `显示模式：${STYLE_LABEL[style]}`);
  }

  async function applyStyle(style: DisplayStyle): Promise<void> {
    const request = ++styleRequest;
    const canShowProgress = (): boolean => request === styleRequest && !busy;
    syncStyleControls(style);
    try {
      if (canShowProgress() && style === "edges") {
        showProgress("生成边线…", null, false);
      }
      await stage.setDisplayStyle(style, (done, total) => {
        if (canShowProgress()) reportEdgeProgress(done, total);
      });
    } catch (error) {
      if (request === styleRequest) toast(`切换显示模式失败：${describeError(error)}`, "error");
    } finally {
      if (canShowProgress()) hideProgress();
    }
  }

  styleBtn.addEventListener("click", () => {
    void applyStyle(stage.style === "edges" ? "solid" : "edges");
  });
  for (const [input, style] of [
    [styleSolid, "solid"], [styleEdges, "edges"], [styleWireframe, "wireframe"], [styleXray, "xray"]
  ] as const) {
    input.addEventListener("change", () => {
      if (displayMenu.matches(":popover-open")) displayMenu.hidePopover();
      void applyStyle(style);
    });
  }

  function renderMaterialControls(): void {
    const active = stage.active;
    materialBtn.disabled = active === null || active.appearance.surfaces.length === 0;
    if (materialBtn.disabled) materialPanel.hidePopover();
    materialTarget.textContent = active?.name ?? "";
    for (const option of materialOptions) {
      option.setAttribute("aria-pressed", String(option.dataset["material"] === active?.appearance.preset));
    }
  }

  for (const option of materialOptions) {
    option.addEventListener("click", () => {
      stage.setActiveMaterial(option.dataset["material"] as MaterialPreset);
      renderMaterialControls();
    });
  }

  gridToggle.addEventListener("change", () => {
    stage.setGridVisible(gridToggle.checked);
  });
  // The control, not the stage, owns the default: the grid starts hidden and only the user shows it.
  stage.setGridVisible(gridToggle.checked);

  environmentToggle.addEventListener("change", () => {
    stage.setEnvironment(environmentToggle.checked);
  });
  stage.setEnvironment(environmentToggle.checked);
  const lightBackground = el<HTMLInputElement>("lightBackground");
  lightBackground.addEventListener("change", () => stage.setLightBackground(lightBackground.checked));

  function applySection(): void {
    const cuts = sectionControls.flatMap(({ axis, enabled, offset, flip }) => {
      enabled.disabled = !sectionToggle.checked;
      offset.disabled = flip.disabled = enabled.disabled || !enabled.checked;
      return offset.disabled ? [] : [{ axis, ratio: offset.valueAsNumber / 100, reversed: flip.getAttribute("aria-pressed") === "true" }];
    });
    stage.setSections(cuts);
  }
  sectionToggle.addEventListener("change", applySection);
  for (const { enabled, offset, flip } of sectionControls) {
    enabled.addEventListener("change", applySection);
    offset.addEventListener("input", applySection);
    flip.addEventListener("click", () => {
      flip.setAttribute("aria-pressed", String(flip.getAttribute("aria-pressed") !== "true"));
      applySection();
    });
  }

  unitSelect.addEventListener("change", () => {
    unit = unitSelect.value as MeasurementUnit;
    renderStats();
  });

  sourceUnitSelect.addEventListener("change", () => {
    const active = stage.active;
    const chosen = sourceUnitSelect.value as MeasurementUnit;
    if (active === null || !(chosen in UNIT_LABEL)) return;
    stage.setSourceUnit(active.id, chosen);
    renderStats();
  });

  edgeAngleSelect.addEventListener("change", () => {
    stage.setEdgeAngle(Number(edgeAngleSelect.value));
    if (stage.style === "edges") {
      void applyStyle("edges");
    }
  });

  /** Edge width is a viewing preference like the controller, so it survives reloads. */
  function applyEdgeWidth(width: number, persist: boolean): void {
    edgeWidthRange.value = String(width);
    edgeWidthValue.textContent = `${width.toFixed(1)}px`;
    stage.setEdgeWidth(width);
    if (persist) storePreference(EDGE_WIDTH_STORAGE_KEY, String(width));
  }

  edgeWidthRange.addEventListener("input", () => {
    const width = Number(edgeWidthRange.value);
    if (Number.isFinite(width)) applyEdgeWidth(width, true);
  });

  cadQualitySelect.addEventListener("change", () => {
    const value = cadQualitySelect.value as CadQuality;
    if (CAD_QUALITY_PRESETS[value] !== undefined) {
      cadQuality = value;
      toast(`CAD 精度：${CAD_QUALITY_PRESETS[value].label}（下次打开 CAD 文件生效）`);
    }
  });

  // ------------------------------------------------------------------ camera controller & projection

  /** The remembered view preferences: how this person likes to look at a model, not a property of a file. */
  function applyController(kind: ControllerKind, announce: boolean): void {
    stage.setController(kind);
    controllerSelect.value = kind;
    storePreference(CONTROLLER_STORAGE_KEY, kind);
    if (announce) {
      toast(`相机控制器：${CONTROLLER_LABEL[kind]}`, "info", 2500);
    }
  }

  controllerSelect.addEventListener("change", () => {
    if (isControllerKind(controllerSelect.value)) {
      applyController(controllerSelect.value, true);
    }
  });

  function applyProjection(projection: Projection): void {
    stage.setProjection(projection);
    projectionPerspective.checked = projection === "perspective";
    projectionOrthographic.checked = projection === "orthographic";
    storePreference(PROJECTION_STORAGE_KEY, projection);
  }

  projectionPerspective.addEventListener("change", () => applyProjection("perspective"));
  projectionOrthographic.addEventListener("change", () => applyProjection("orthographic"));

  const rememberedController = readStoredController();
  if (rememberedController !== null) {
    applyController(rememberedController, false);
  }
  const rememberedProjection = readStoredProjection();
  if (rememberedProjection !== null) {
    applyProjection(rememberedProjection);
  }
  applyEdgeWidth(readStoredEdgeWidth(), false);

  // ------------------------------------------------------------------ buttons

  /**
   * The brand is the in-app way home: it clears the scene and reframes the default view without
   * reloading. The anchor keeps its href, so ⌘/middle click still opens a clean copy.
   */
  function goHome(): void {
    for (const handle of [...stage.modelList]) {
      stage.removeModel(handle.id);
    }
    stage.setStandardView("iso", false);
    renderModelList();
    renderStats();
  }

  el<HTMLAnchorElement>("brandLink").addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    goHome();
  });

  openBtn.addEventListener("click", () => fileInput.click());
  el<HTMLButtonElement>("emptyOpenBtn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const files = fileInput.files === null ? [] : [...fileInput.files];
    fileInput.value = "";
    void openFiles(files);
  });

  el<HTMLButtonElement>("demoBtn").addEventListener("click", () => {
    if (busy) return;
    stage.addModel(createDemo(), "ORBITAL · 装配示例");
    stage.setStandardView("iso", false);
    renderModelList();
    renderStats();
    void applyStyle(stage.style);
  });

  cancelBtn.addEventListener("click", () => {
    cancelController?.abort();
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
          await el<HTMLElement>("app").requestFullscreen();
        }
      } catch (error) {
        toast(`全屏失败：${describeError(error)}`, "error");
      }
    })();
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreenBtn.textContent = document.fullscreenElement === null ? "全屏" : "退出全屏";
  });

  fullscreenBtn.hidden = !document.fullscreenEnabled;
  const toolsMenu = el<HTMLElement>("toolsMenu");
  toolsMenu.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("button")) toolsMenu.hidePopover();
  }, { capture: true });

  function setSidebarOpen(open: boolean): void {
    if (open) {
      renderModelList();
      explodePanel.hidePopover();
      sidebar.showModal();
    } else sidebar.close();
    sidebarToggle.setAttribute("aria-expanded", String(open));
  }
  sidebarToggle.addEventListener("click", () => setSidebarOpen(true));
  el<HTMLButtonElement>("sidebarClose").addEventListener("click", () => setSidebarOpen(false));
  sidebar.addEventListener("close", () => {
    sidebarToggle.setAttribute("aria-expanded", "false");
    el<HTMLButtonElement>("toolsToggle").focus();
  });
  sidebar.addEventListener("click", (event) => {
    const box = sidebar.getBoundingClientRect();
    if (event.target === sidebar && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) {
      setSidebarOpen(false);
    }
  });
  const sheetHeading = sidebar.querySelector<HTMLElement>(".sidebar-heading")!;
  let sheetStartY = 0;
  sheetHeading.addEventListener("pointerdown", (event) => {
    sheetStartY = event.clientY;
    if (!(event.target as HTMLElement).closest("button")) sheetHeading.setPointerCapture(event.pointerId);
  });
  sheetHeading.addEventListener("pointerup", (event) => {
    if (event.clientY - sheetStartY > 65) setSidebarOpen(false);
  });

  createNavCube(stage, el<HTMLElement>("navCube"));
  el<HTMLButtonElement>("isoBtn").addEventListener("click", () => stage.setStandardView("iso"));
  explodeRange.addEventListener("input", () => {
    stage.setExplode(Number(explodeRange.value) / 100);
    el<HTMLOutputElement>("explodeValue").value = `${explodeRange.value}%`;
    explodeBtn.classList.toggle("active", Number(explodeRange.value) > 0);
  });
  explodePanel.addEventListener("beforetoggle", (event) => {
    if ((event as ToggleEvent).newState === "open" && stage.active?.explodeTarget === null && stage.active.parts.length > 1) {
      explodeRange.value = "50";
      explodeRange.dispatchEvent(new Event("input"));
    }
  });
  for (const [id, value] of [["assembleBtn", "0"], ["separateBtn", "100"]] as const) {
    el<HTMLButtonElement>(id).addEventListener("click", () => {
      explodeRange.value = value;
      explodeRange.dispatchEvent(new Event("input"));
    });
  }
  el<HTMLButtonElement>("fitBtn").addEventListener("click", () => {
    stage.fitToActive();
  });
  fitAllBtn.addEventListener("click", () => {
    setSidebarOpen(false);
    stage.fitToScene();
  });

  // ------------------------------------------------------------------ drag & drop

  /**
   * A dropped file loads from anywhere in the window, not just over the canvas. Without a
   * window-level preventDefault the browser's own "open this file" default takes over everywhere
   * outside #stage, which replaces the viewer with the dropped file.
   */
  let dragDepth = 0;
  const dragsFiles = (event: DragEvent): boolean =>
    event.dataTransfer !== null && [...event.dataTransfer.types].includes("Files");

  function resetDrag(): void {
    dragDepth = 0;
    dragOverlay.hidden = true;
  }

  window.addEventListener("dragenter", (event) => {
    if (!dragsFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth += 1;
    // The workspace panel lives in the top layer, so it would hide the overlay it sits behind.
    if (sidebar.open) {
      setSidebarOpen(false);
    }
    dragOverlay.hidden = false;
  });
  window.addEventListener("dragover", (event) => {
    if (!dragsFiles(event)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer !== null) {
      event.dataTransfer.dropEffect = "copy";
    }
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dragOverlay.hidden = true;
    }
  });
  window.addEventListener("drop", (event) => {
    const files = dragsFiles(event) ? [...(event.dataTransfer?.files ?? [])] : [];
    resetDrag();
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    void openFiles(files);
  });
  // A drag that leaves the window never reports its final dragleave.
  window.addEventListener("blur", resetDrag);

  window.addEventListener("keydown", (event) => {
    if (sidebar.open || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
      return;
    }
    switch (event.key.toLowerCase()) {
      case "f":
        if (event.shiftKey) stage.fitToScene();
        else stage.fitToActive();
        return;
      case "g":
        gridToggle.checked = !gridToggle.checked;
        stage.setGridVisible(gridToggle.checked);
        return;
      case "w": {
        const next: DisplayStyle = stage.style === "solid" ? "edges" : stage.style === "edges" ? "wireframe" : stage.style === "wireframe" ? "xray" : "solid";
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
    backend: "webgpu",
    capture: () => stage.captureNextFrame(),
    cadEngine: () => cadEngineState,
    setController: (kind) => applyController(kind, false),
    setProjection: applyProjection,
    summary: () => ({
      models: stage.modelList.map((handle) => ({
        id: handle.id,
        name: handle.name,
        format: handle.format,
        triangles: handle.stats.triangles,
        vertices: handle.stats.vertices,
        visible: stage.isVisible(handle.id),
        sizeMm: handle.sourceUnit.mmPerUnit === null ? null : [handle.stats.size.x, handle.stats.size.y, handle.stats.size.z]
      })),
      activeId: stage.active?.id ?? null,
      style: stage.style,
      gridVisible: gridToggle.checked,
      environment: stage.environmentEnabled,
      sectionEnabled: sectionToggle.checked,
      controller: stage.controllerKind,
      projection: stage.projectionKind,
      backend: "webgpu",
      build,
      cadEngineStatus: cadEngineState.status
    })
  };
  window.__mzViewer = hooks;

  syncStyleControls(stage.style);
  renderModelList();
  renderStats();

  return {
    setCadEngineState,
    openFiles,
    reportFileOpenError: (error) => toast(`读取文件失败：${describeError(error)}`, "error", 9000)
  };
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

const CONTROLLER_STORAGE_KEY = "mz-3d-viewer.controller";
const PROJECTION_STORAGE_KEY = "mz-3d-viewer.projection";
const EDGE_WIDTH_STORAGE_KEY = "mz-3d-viewer.edge-width";

function readStoredEdgeWidth(): number {
  const width = Number(readPreference(EDGE_WIDTH_STORAGE_KEY));
  return Number.isFinite(width) && width >= 1 && width <= 4 ? width : DEFAULT_EDGE_WIDTH;
}

function readStoredController(): ControllerKind | null {
  const value = readPreference(CONTROLLER_STORAGE_KEY);
  return value !== null && isControllerKind(value) ? value : null;
}

function readStoredProjection(): Projection | null {
  const value = readPreference(PROJECTION_STORAGE_KEY);
  return value === "perspective" || value === "orthographic" ? value : null;
}

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or a partitioned storage block: navigation still works, it just forgets.
  }
}
