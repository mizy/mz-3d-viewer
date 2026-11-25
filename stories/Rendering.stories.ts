import { Color } from "three/webgpu";
import { useRef } from "storybook/preview-api";
import type { Meta, StoryObj } from "@storybook/html-vite";
import type { DisplayStyle, MaterialPreset, ModelViewer } from "../src/lib";
import type { Projection, Stage, StandardView } from "../src/viewer/stage";
import { createDemo } from "../src/viewer/demo";
import { bindCanvasClick } from "../src/ui/canvasSelection";
import { createInspectionHover } from "../src/ui/inspectionHover";
import { fetchSample, loadSample, SAMPLES, useViewer, type ViewerUi } from "./support";

type Args = {
  sample: string;
  edges: boolean;
  background: string;
  style: DisplayStyle;
  axis: "x" | "y" | "z";
  ratio: number;
  reversed: boolean;
  projection: Projection;
  view: StandardView;
  explode: number;
  preset: MaterialPreset;
  grid: boolean;
  environment: boolean;
  lightBackground: boolean;
};

const meta: Meta<Args> = {
  title: "Viewer/Rendering",
  parameters: { layout: "fullscreen" },
  argTypes: {
    background: { control: "color" },
    sample: { control: "select", options: Object.values(SAMPLES) },
    style: { control: "inline-radio", options: ["solid", "edges", "wireframe", "xray"] },
    axis: { control: "inline-radio", options: ["x", "y", "z"] },
    ratio: { control: { type: "range", min: 0, max: 1, step: 0.05 } },
    projection: { control: "inline-radio", options: ["perspective", "orthographic"] },
    view: { control: "select", options: ["front", "back", "left", "right", "top", "bottom", "iso"] },
    explode: { control: { type: "range", min: 0, max: 1, step: 0.05 } },
    preset: { control: "select", options: ["gray", "blue", "aluminum", "original"] }
  }
};

export default meta;
type Story = StoryObj<Args>;

/** The published embed API: one canvas, one renderer, one real sample file. */
export const EmbeddedViewer: Story = {
  args: { sample: SAMPLES.stl, edges: true, background: "#090d12" },
  parameters: { controls: { include: ["sample", "edges", "background"] } },
  render: (args) => useViewer(`createModelViewer · ${args.sample}`, {
    key: args.sample,
    viewerOptions: { edges: false },
    setup: async (viewer, ui, signal) => { await loadSample(viewer, args.sample, ui, signal); },
    update: async ({ stage }) => {
      (stage.scene.background as Color).set(args.background);
      await stage.setDisplayStyle(args.edges ? "edges" : "solid");
    }
  })
};

/** Exercise the app's hover and part-selection handlers on a real STEP assembly. */
export const HoverAndSelection: Story = {
  args: { sample: SAMPLES.stepAssembly, edges: true },
  parameters: { controls: { include: ["sample", "edges"] } },
  render: (args) => useViewer("Hover / 选中", {
    key: args.sample,
    viewerOptions: { edges: false },
    setup: async (viewer, ui, signal) => {
      await viewer.load(await fetchSample(args.sample, signal), { signal });
      signal.throwIfAborted();
      wireSelection(viewer.stage, ui, signal);
    },
    update: ({ stage }) => stage.setDisplayStyle(args.edges ? "edges" : "solid")
  })
};

function wireSelection(stage: Stage, ui: ViewerUi, signal: AbortSignal): void {
  createInspectionHover(stage, ui.canvas, () => true, signal);

  const mode = document.createElement("select");
  mode.setAttribute("aria-label", "拾取模式");
  mode.add(new Option("面 / 边", "face"));
  mode.add(new Option("体", "body"));
  mode.value = stage.pickMode;
  const control = document.createElement("label");
  control.textContent = "拾取模式 ";
  control.style.cssText = "display:block;padding:8px 12px;font-size:13px;color-scheme:dark";
  control.append(mode);
  ui.insertBefore(control, ui.canvas);
  mode.addEventListener("change", () => {
    stage.setPickMode(mode.value === "body" ? "body" : "face");
    updateSelection();
  }, { signal });

  function updateSelection(): void {
    const model = stage.active;
    const index = model?.selectedPart;
    const name = index == null ? "" : model?.parts[index]?.mesh.name.trim() || `部件 ${index + 1}`;
    const kind = model?.selectedEdge ? "边" : model?.selectedFace ? "面" : "体";
    const instruction = stage.pickMode === "face" ? "悬停或点击面与可见边线。" : "悬停或点击整个零件。";
    ui.setInfo(`${instruction} 点击空白取消。\n当前选中：${name ? `${kind} · ${name}` : "无"}`);
  }

  bindCanvasClick(ui.canvas, async ({ clientX, clientY }) => {
    const hit = await stage.pick(clientX, clientY, { inspect: true });
    if (signal.aborted) return;
    stage.selectHit(hit);
    updateSelection();
  }, signal);
  updateSelection();
}

function setupAssembly({ stage }: ModelViewer): void {
  stage.addModel(createDemo(), "procedural-assembly");
  stage.fitToActive();
}

/** The four CAD display modes, including the worker-built edge overlay. */
export const DisplayStyles: Story = {
  args: { style: "edges" },
  parameters: { controls: { include: ["style"] } },
  render: (args) => useViewer(`显示模式 · ${args.style}`, {
    setup: setupAssembly,
    update: async ({ stage }, ui, signal) => {
      await stage.setDisplayStyle(args.style);
      if (!signal.aborted) ui.setInfo(`style=${stage.style} · ${stage.active?.parts.length ?? 0} 个独立零件`);
    }
  })
};

/** Section planes with an independently reversible kept side. */
export const SectionCuts: Story = {
  args: { axis: "x", ratio: 0.5, reversed: false },
  parameters: { controls: { include: ["axis", "ratio", "reversed"] } },
  render: (args) => useViewer(`剖切 · ${args.axis.toUpperCase()}`, {
    viewerOptions: { edges: false },
    setup: setupAssembly,
    update: ({ stage }, ui) => {
      stage.setSections([{ axis: args.axis, ratio: args.ratio, reversed: args.reversed }]);
      ui.setInfo(`${args.axis} @ ${Math.round(args.ratio * 100)}% · ${args.reversed ? "反向保留" : "正向保留"}`);
    }
  })
};

/** Explode uses the imported hierarchy and keeps edge lines attached to each part. */
export const Explode: Story = {
  args: { style: "edges", explode: 0 },
  parameters: { controls: { include: ["style", "explode"] } },
  render: (args) => useViewer(`爆炸视图 · ${Math.round(args.explode * 100)}%`, {
    setup: setupAssembly,
    update: async ({ stage }, ui, signal) => {
      if ((stage.active?.explode ?? 0) !== args.explode) stage.setExplode(args.explode, false);
      await stage.setDisplayStyle(args.style);
      if (!signal.aborted) ui.setInfo(`${stage.active?.parts.length ?? 0} 个零件随层级分离`);
    }
  })
};

/** Projection, standard views, floor grid and procedural studio environment. */
export const CameraAndEnvironment: Story = {
  args: { projection: "perspective", view: "iso", grid: false, environment: true, lightBackground: false },
  parameters: { controls: { include: ["projection", "view", "grid", "environment", "lightBackground"] } },
  render: (args) => {
    const previous = useRef<{ stage: Stage; view: StandardView } | null>(null);
    return useViewer(`相机 · ${args.projection} · ${args.view}`, {
      viewerOptions: { edges: false },
      setup: setupAssembly,
      update: ({ stage }, ui) => {
        stage.setProjection(args.projection);
        if (previous.current?.stage !== stage || previous.current.view !== args.view) {
          stage.setStandardView(args.view, false);
          previous.current = { stage, view: args.view };
        }
        stage.setGridVisible(args.grid);
        stage.setEnvironment(args.environment);
        stage.setLightBackground(args.lightBackground);
        ui.setInfo(`projection=${stage.projectionKind} · grid=${args.grid} · environment=${stage.environmentEnabled}`);
      }
    });
  }
};

/** Compare presets with and without the studio environment in any display mode. */
export const Materials: Story = {
  args: { preset: "gray", style: "solid", environment: true },
  parameters: { controls: { include: ["preset", "style", "environment"] } },
  render: (args) => useViewer(`材质预设 · ${args.preset}`, {
    setup: setupAssembly,
    update: async ({ stage }, ui, signal) => {
      stage.setEnvironment(args.environment);
      stage.setActiveMaterial(args.preset);
      await stage.setDisplayStyle(args.style);
      if (!signal.aborted) {
        ui.setInfo(`preset=${stage.active?.appearance.preset} · style=${stage.style} · environment=${stage.environmentEnabled}`);
      }
    }
  })
};
