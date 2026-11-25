import type { Meta, StoryObj } from "@storybook/html-vite";
import type { DisplayStyle, MaterialPreset } from "../src/lib";
import type { Projection, StandardView } from "../src/viewer/stage";
import { createDemo } from "../src/viewer/demo";
import { loadSample, SAMPLES, useViewer } from "./support";

type Args = {
  sample: string;
  forceWebGL: boolean;
  edges: boolean;
  background: number;
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
  args: {
    sample: SAMPLES.stl,
    forceWebGL: false,
    edges: true,
    background: 0x090d12,
    style: "edges",
    axis: "x",
    ratio: 0.5,
    reversed: false,
    projection: "perspective",
    view: "iso",
    explode: 0,
    preset: "gray",
    grid: false,
    environment: true,
    lightBackground: false
  },
  argTypes: {
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
  render: (args) => useViewer(args, `createModelViewer · ${args.sample}`, async (viewer, ui) => {
    await loadSample(viewer, args.sample, ui);
  })
};

/** Same geometry, forced WebGL2; the badge reports which backend actually initialised. */
export const WebGL2Fallback: Story = {
  args: { sample: SAMPLES.glb, forceWebGL: true },
  render: (args) => useViewer(args, "WebGL2 fallback · Duck.glb", async (viewer, ui) => {
    await loadSample(viewer, args.sample, ui);
  })
};

/** The four CAD display modes, including the worker-built edge overlay. */
export const DisplayStyles: Story = {
  render: (args) => useViewer(args, `显示模式 · ${args.style}`, async (viewer, ui) => {
    viewer.stage.addModel(createDemo(), "procedural-assembly");
    await viewer.stage.setDisplayStyle(args.style);
    viewer.stage.fitToActive();
    ui.setInfo(`style=${viewer.stage.style} · ${viewer.stage.active?.parts.length ?? 0} 个独立零件`);
  })
};

/** Section planes with an independently reversible kept side. */
export const SectionCuts: Story = {
  render: (args) => useViewer(args, `剖切 · ${args.axis.toUpperCase()}`, async (viewer, ui) => {
    viewer.stage.addModel(createDemo(), "procedural-assembly");
    await viewer.stage.setDisplayStyle("solid");
    viewer.stage.setSections([{ axis: args.axis, ratio: args.ratio, reversed: args.reversed }]);
    viewer.stage.fitToActive();
    ui.setInfo(`${args.axis} @ ${Math.round(args.ratio * 100)}% · ${args.reversed ? "反向保留" : "正向保留"}`);
  })
};

/** Explode uses the imported hierarchy and keeps edge lines attached to each part. */
export const Explode: Story = {
  render: (args) => useViewer(args, `爆炸视图 · ${Math.round(args.explode * 100)}%`, async (viewer, ui) => {
    viewer.stage.addModel(createDemo(), "procedural-assembly");
    await viewer.stage.setDisplayStyle(args.style);
    viewer.stage.setExplode(args.explode, false);
    viewer.stage.fitToScene();
    ui.setInfo(`${viewer.stage.active?.parts.length ?? 0} 个零件随层级分离`);
  })
};

/** Projection, standard views, floor grid and procedural studio environment. */
export const CameraAndEnvironment: Story = {
  render: (args) => useViewer(args, `相机 · ${args.projection} · ${args.view}`, async (viewer, ui) => {
    viewer.stage.addModel(createDemo(), "procedural-assembly");
    await viewer.stage.setDisplayStyle("solid");
    viewer.stage.setProjection(args.projection);
    viewer.stage.setStandardView(args.view, false);
    viewer.stage.setGridVisible(args.grid);
    viewer.stage.setEnvironment(args.environment);
    viewer.stage.setLightBackground(args.lightBackground);
    viewer.stage.fitToScene();
    ui.setInfo(`projection=${viewer.stage.projectionKind} · grid=${args.grid} · environment=${args.environment}`);
  })
};

/** Material presets replace only the active model's surfaces, not the file's own materials. */
export const Materials: Story = {
  render: (args) => useViewer(args, `材质预设 · ${args.preset}`, async (viewer, ui) => {
    viewer.stage.addModel(createDemo(), "procedural-assembly");
    await viewer.stage.setDisplayStyle("solid");
    viewer.stage.setEnvironment(args.environment);
    viewer.stage.setActiveMaterial(args.preset);
    viewer.stage.fitToActive();
    ui.setInfo(`preset=${args.preset} · 灯光/环境${args.environment ? "开" : "关"}`);
  })
};
