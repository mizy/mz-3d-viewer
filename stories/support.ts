import { useEffect, useMemo } from "storybook/preview-api";
import { createModelViewer, type ModelViewer, type ViewerOptions } from "../src/lib";
import type { ParsedModel } from "../src/loaders/types";

/** Sample paths are relative to Storybook's `/samples/` static directory. */
export const SAMPLES = {
  stl: "stl/cube-10x10.stl",
  rack: "stl/rack.stl",
  obj: "obj/cube.obj",
  glb: "gltf/Duck.glb",
  threeMf: "3mf/cube-10x10.3mf",
  step: "step/cube-10x10.stp",
  stepCone: "step/conical-surface.step",
  stepAssembly: "step-sample.stp",
  iges: "iges/cube-10x10.igs",
  brep: "brep/as1_pe_203.brep"
} as const;

/** The mounted node itself, with the canvas and status helpers attached for stories. */
export type ViewerUi = HTMLDivElement & Readonly<{
  canvas: HTMLCanvasElement;
  setTitle: (text: string) => void;
  setStatus: (text: string) => void;
  setInfo: (text: string) => void;
  setBackend: (text: string) => void;
}>;

type ViewerSetup = (viewer: ModelViewer, ui: ViewerUi, signal: AbortSignal) => Promise<void> | void;
type ViewerStoryOptions = Readonly<{
  /** Change this only for model or import settings that require remounting the canvas. */
  key?: string;
  setup: ViewerSetup;
  update?: ViewerSetup;
  create?: typeof createModelViewer;
  viewerOptions?: ViewerOptions;
}>;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sampleUrl(path: string): string {
  return `/samples/${path}`;
}

export async function fetchSample(path: string, signal?: AbortSignal): Promise<File> {
  const response = await fetch(sampleUrl(path), { signal });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const blob = await response.blob();
  return new File([blob], path.split("/").pop() ?? path, { type: blob.type });
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Dark, fixed-height shell so a canvas always has a measurable size inside Storybook. */
function createViewerUi(label: string, height = 480): ViewerUi {
  const root = element("div", {
    background: "#0b1016", border: "1px solid #253444", borderRadius: "10px",
    color: "#dbe7f2", fontFamily: "system-ui, sans-serif", overflow: "hidden", width: "100%"
  });
  const bar = element("div", {
    alignItems: "center", background: "#101925", borderBottom: "1px solid #253444",
    display: "flex", fontSize: "13px", justifyContent: "space-between", padding: "8px 12px"
  });
  const title = element("span", { fontWeight: "600" }, label);
  const backend = element("span", { color: "#7fd9b0", fontFamily: "monospace", fontSize: "12px" }, "backend: …");
  bar.append(title, backend);
  const canvas = element("canvas", { background: "#090d12", display: "block", height: `${height}px`, width: "100%" });
  const status = element("div", { borderTop: "1px solid #253444", fontSize: "12px", padding: "7px 12px" }, "准备中…");
  const info = element("div", { fontSize: "12px", lineHeight: "1.5", padding: "0 12px 10px", whiteSpace: "pre-wrap" });
  root.append(bar, canvas, status, info);
  return Object.assign(root, {
    canvas,
    setTitle: (text: string) => { title.textContent = text; },
    setStatus: (text: string) => { status.textContent = text; },
    setInfo: (text: string) => { info.textContent = text; },
    setBackend: (text: string) => { backend.textContent = `backend: ${text}`; }
  });
}

/** @entry Mount one viewer per sample and apply visual Controls to its existing stage. */
export function useViewer(label: string, { key, setup, update, create = createModelViewer, viewerOptions }: ViewerStoryOptions): ViewerUi {
  const session = useMemo(() => ({ ui: createViewerUi(label), ready: null as Promise<ModelViewer> | null }), [key]);
  const { ui } = session;
  ui.setTitle(label);
  useEffect(() => {
    const lifetime = new AbortController();
    const { signal } = lifetime;
    let viewer: ModelViewer | null = null;
    ui.setStatus("初始化渲染器…");
    session.ready = create(ui.canvas, viewerOptions).then(async (created) => {
      if (signal.aborted) {
        created.dispose();
        signal.throwIfAborted();
      }
      viewer = created;
      ui.setBackend(created.backend);
      await setup(created, ui, signal);
      signal.throwIfAborted();
      if (update === undefined) ui.setStatus("就绪");
      return created;
    });
    void session.ready.catch((error: unknown) => showViewerError(ui, signal, error));
    return () => {
      lifetime.abort();
      viewer?.dispose();
    };
  }, [session]);

  useEffect(() => {
    if (update === undefined) return;
    const pending = new AbortController();
    const { signal } = pending;
    void session.ready?.then(async (viewer) => {
      if (signal.aborted) return;
      await update(viewer, ui, signal);
      if (!signal.aborted) ui.setStatus("就绪");
    }).catch((error: unknown) => showViewerError(ui, signal, error));
    return () => pending.abort();
  }, [session, update]);
  return ui;
}

function showViewerError(ui: ViewerUi, signal: AbortSignal, error: unknown): void {
  if (!signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
    ui.setStatus(`失败：${errorMessage(error)}`);
  }
}

/** Parsed-model summary shared by the rendering and package stories. */
export function describeModels(models: readonly ParsedModel[]): string {
  return models.map((model) => {
    let meshes = 0;
    let vertices = 0;
    let triangles = 0;
    model.root.traverse((node) => {
      const geometry = (node as { geometry?: { index?: { count: number } | null; attributes?: { position?: { count: number } } } }).geometry;
      if (geometry?.attributes?.position === undefined) return;
      meshes += 1;
      vertices += geometry.attributes.position.count;
      triangles += Math.floor((geometry.index?.count ?? geometry.attributes.position.count) / 3);
    });
    const unit = model.sourceUnit.mmPerUnit;
    return `${model.format} · ${meshes} mesh · ${vertices} 顶点 · ${triangles} 三角形 · ${unit === null ? "单位未知" : `${unit} mm/unit`}`
      + (model.warnings.length > 0 ? `\n提示：${model.warnings.join("；")}` : "");
  }).join("\n");
}

/** Loads a committed sample through the public viewer API and displays its summary. */
export async function loadSample(viewer: ModelViewer, path: string, ui: ViewerUi, signal: AbortSignal): Promise<ParsedModel[]> {
  ui.setStatus(`载入 ${path}…`);
  const models = await viewer.load(await fetchSample(path, signal), { signal });
  signal.throwIfAborted();
  ui.setInfo(describeModels(models));
  return models;
}

export function panel(title: string): { root: HTMLDivElement; body: HTMLDivElement } {
  const root = element("div", {
    background: "#0b1016", border: "1px solid #253444", borderRadius: "10px",
    color: "#dbe7f2", fontFamily: "system-ui, sans-serif", padding: "14px", width: "100%"
  });
  root.append(element("h2", { fontSize: "15px", margin: "0 0 10px" }, title));
  const body = element("div", { fontSize: "13px", lineHeight: "1.6" });
  root.append(body);
  return { root, body };
}

export function table(header: readonly string[], rows: readonly (readonly string[])[]): HTMLTableElement {
  const result = element("table", { borderCollapse: "collapse", fontFamily: "monospace", fontSize: "12px" });
  const thead = element("thead", {});
  const head = element("tr", {});
  for (const label of header) {
    head.append(element("th", { borderBottom: "1px solid #40546a", padding: "5px 14px 5px 0", textAlign: "left" }, label));
  }
  thead.append(head);
  result.append(thead);
  const tbody = element("tbody", {});
  for (const row of rows) {
    const tr = element("tr", {});
    for (const cell of row) {
      tr.append(element("td", { borderBottom: "1px solid #1e2b38", padding: "4px 14px 4px 0" }, cell));
    }
    tbody.append(tr);
  }
  result.append(tbody);
  return result;
}
