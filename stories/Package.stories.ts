import { useEffect, useMemo } from "storybook/preview-api";
import type { Meta, StoryObj } from "@storybook/html-vite";
import type { ParsedModel } from "../src/loaders/types";
import { disposeObject } from "../src/viewer/dispose";
import {
  ACCEPTED_EXTENSIONS,
  CAD_QUALITY_PRESETS,
  configureCadAssets,
  detectFormat,
  parseFiles,
  parseModel,
  type CadQuality as CadQualityName,
  type ModelViewer
} from "../src/lib";
import {
  describeModels,
  errorMessage,
  fetchSample,
  panel,
  SAMPLES,
  table,
  useViewer
} from "./support";

type Args = {
  sample: string;
  quality: CadQualityName;
  baseUrl: string;
};

const meta: Meta<Args> = {
  title: "Package/API",
  parameters: { layout: "fullscreen" },
  argTypes: {
    baseUrl: { control: "text" },
    sample: { control: "select", options: Object.values(SAMPLES) },
    quality: { control: "inline-radio", options: Object.keys(CAD_QUALITY_PRESETS) }
  }
};

export default meta;
type Story = StoryObj<Args>;

/** Pure API surface: no files, no GPU — useful as a quick regression check. */
export const PublicExports: Story = {
  parameters: { controls: { disable: true } },
  render: () => {
    const { root, body } = panel("公开导出与文件探测");
    body.append(table(
      ["export", "作用"],
      [
        ["parseModel", "单个文件 → ParsedModel"],
        ["parseFiles", "一组文件 + 配套文件 → ParsedModel[]"],
        ["detectFormat", "文件名 → 格式或 null"],
        ["ACCEPTED_EXTENSIONS", "全部支持的扩展名"],
        ["CAD_QUALITY_PRESETS", "fast / standard / fine"],
        ["configureCadAssets", "切换 OCCT worker/wasm 的位置"],
        ["createModelViewer", "canvas → 可嵌入的 viewer"]
      ]
    ));
    body.append(table(
      ["文件名", "detectFormat"],
      [
        ...ACCEPTED_EXTENSIONS.map((ext) => [`part${ext}`, String(detectFormat(`part${ext}`))]),
        ["part.txt", String(detectFormat("part.txt"))],
        ["README", String(detectFormat("README"))]
      ]
    ));
    return root;
  }
};

/** Headless parser feeding the embeddable viewer; the panel reports units and warnings. */
export const ParseModel: Story = {
  args: { sample: SAMPLES.step },
  parameters: { controls: { include: ["sample"] } },
  render: (args) => useViewer(`parseModel · ${args.sample}`, {
    key: args.sample,
    setup: async (viewer, ui, signal) => {
      const file = await fetchSample(args.sample, signal);
      ui.setStatus("解析中…");
      const model = await parseModel(file, {
        signal,
        onProgress: ({ label, ratio }) => {
          if (!signal.aborted) ui.setStatus(`${label}${ratio === null ? "" : ` · ${Math.round(ratio * 100)}%`}`);
        }
      });
      addParsedModel(viewer, model, file.name, signal);
      await viewer.stage.setDisplayStyle("edges");
      if (!signal.aborted) ui.setInfo(describeModels([model]));
    }
  })
};

/** OBJ + MTL + PNG passed together: companions must resolve, including the texture. */
export const ParseFilesWithCompanions: Story = {
  parameters: { controls: { disable: true } },
  render: () => useViewer("parseFiles · OBJ + MTL + 贴图", {
    setup: async (viewer, ui, signal) => {
      ui.setStatus("解析 OBJ 配套文件…");
      const files = await Promise.all([SAMPLES.obj, "obj/cube.mtl", "obj/cube-texture.png"]
        .map((path) => fetchSample(path, signal)));
      const models = await parseFiles(files, { signal });
      if (signal.aborted) {
        for (const model of models) disposeObject(model.root);
        signal.throwIfAborted();
      }
      for (const [index, model] of models.entries()) viewer.stage.addModel(model, files[index].name);
      viewer.stage.fitToActive();
      ui.setInfo(describeModels(models));
    }
  })
};

/** A curved STEP surface shows the effect of each tessellation preset. */
export const CadQuality: Story = {
  args: { quality: "standard" },
  parameters: { controls: { include: ["quality"] } },
  render: (args) => useViewer(`CAD 精度 · ${args.quality}`, {
    key: args.quality,
    setup: async (viewer, ui, signal) => {
      const file = await fetchSample(SAMPLES.stepCone, signal);
      const started = performance.now();
      const model = await parseModel(file, { quality: args.quality, signal });
      const elapsed = Math.round(performance.now() - started);
      addParsedModel(viewer, model, file.name, signal);
      await viewer.stage.setDisplayStyle("edges");
      if (!signal.aborted) ui.setInfo(`${CAD_QUALITY_PRESETS[args.quality].label} · ${elapsed}ms\n${describeModels([model])}`);
    }
  })
};

function addParsedModel(
  viewer: ModelViewer, model: ParsedModel, name: string, signal: AbortSignal
): void {
  if (signal.aborted) {
    disposeObject(model.root);
    signal.throwIfAborted();
  }
  viewer.stage.addModel(model, name);
  viewer.stage.fitToActive();
}

/** Point the worker at a different directory; an invalid base surfaces the load error. */
export const ConfigureCadAssets: Story = {
  args: { baseUrl: "/occt/" },
  parameters: { controls: { include: ["baseUrl"] } },
  render: (args) => {
    const { root, body } = useMemo(() => panel("configureCadAssets"), []);
    useEffect(() => {
      const controller = new AbortController();
      const { signal } = controller;
      body.textContent = `baseUrl=${args.baseUrl}\n解析中…`;
      configureCadAssets({ baseUrl: args.baseUrl });
      void fetchSample(SAMPLES.step, signal)
        .then((file) => parseModel(file, { signal }))
        .then((model) => {
          if (!signal.aborted) body.textContent = `baseUrl=${args.baseUrl}\n${describeModels([model])}`;
          disposeObject(model.root);
        })
        .catch((error: unknown) => {
          if (!signal.aborted) body.textContent = `baseUrl=${args.baseUrl}\n失败：${errorMessage(error)}`;
        })
        .finally(() => {
          if (!signal.aborted) configureCadAssets({ baseUrl: "/occt/" });
        });
      return () => {
        controller.abort();
        configureCadAssets({ baseUrl: "/occt/" });
      };
    }, [args.baseUrl]);
    return root;
  }
};

function createCancellationPanel() {
  const { root, body } = panel("取消与进度回调");
  const start = document.createElement("button");
  start.textContent = "开始解析 step-sample.stp";
  const cancel = document.createElement("button");
  cancel.textContent = "取消";
  cancel.disabled = true;
  const status = document.createElement("p");
  body.append(start, document.createTextNode(" "), cancel, status);
  return { root, start, cancel, status };
}

/** Aborting a CAD import terminates its worker; progress labels show it was alive. */
export const CancellationAndProgress: Story = {
  parameters: { controls: { disable: true } },
  render: () => {
    const { root, start, cancel, status } = useMemo(createCancellationPanel, []);
    useEffect(() => {
      const listeners = new AbortController();
      let controller: AbortController | null = null;
      start.addEventListener("click", () => {
        controller?.abort();
        const run = new AbortController();
        controller = run;
        const { signal } = run;
        cancel.disabled = false;
        status.textContent = "解析中…";
        void fetchSample(SAMPLES.stepAssembly, signal)
          .then((file) => parseModel(file, {
            signal,
            onProgress: ({ label }) => { if (controller === run && !signal.aborted) status.textContent = label; }
          }))
          .then((model) => {
            if (controller === run && !signal.aborted) status.textContent = `完成：${describeModels([model])}`;
            disposeObject(model.root);
          })
          .catch((error: unknown) => {
            if (controller === run) {
              status.textContent = signal.aborted ? "已取消" : `失败：${errorMessage(error)}`;
            }
          })
          .finally(() => { if (controller === run) cancel.disabled = true; });
      }, { signal: listeners.signal });
      cancel.addEventListener("click", () => controller?.abort(), { signal: listeners.signal });
      return () => {
        listeners.abort();
        controller?.abort();
        controller = null;
      };
    }, []);
    return root;
  }
};
