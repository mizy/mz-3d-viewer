import { useEffect } from "storybook/preview-api";
import type { Meta, StoryObj } from "@storybook/html-vite";
import {
  ACCEPTED_EXTENSIONS,
  CAD_QUALITY_PRESETS,
  configureCadAssets,
  detectFormat,
  parseFiles,
  parseModel,
  type CadQuality as CadQualityName
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
  args: {
    sample: SAMPLES.step,
    quality: "standard",
    baseUrl: "/occt/"
  },
  argTypes: {
    sample: { control: "select", options: Object.values(SAMPLES) },
    quality: { control: "inline-radio", options: Object.keys(CAD_QUALITY_PRESETS) }
  }
};

export default meta;
type Story = StoryObj<Args>;

/** Pure API surface: no files, no GPU — useful as a quick regression check. */
export const PublicExports: Story = {
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
  render: (args) => useViewer(args, `parseModel · ${args.sample} · ${args.quality}`, async (viewer, ui) => {
    const file = await fetchSample(args.sample);
    ui.setStatus("解析中…");
    const model = await parseModel(file, {
      quality: args.quality,
      onProgress: (progress) => ui.setStatus(
        `${progress.label}${progress.ratio === null ? "" : ` · ${Math.round(progress.ratio * 100)}%`}`
      )
    });
    viewer.stage.addModel(model, file.name);
    await viewer.stage.setDisplayStyle("edges");
    viewer.stage.fitToActive();
    ui.setInfo(describeModels([model]));
  })
};

/** OBJ + MTL + PNG passed together: companions must resolve, including the texture. */
export const ParseFilesWithCompanions: Story = {
  render: (args) => useViewer(args, "parseFiles · OBJ + MTL + 贴图", async (viewer, ui) => {
    ui.setStatus("解析 OBJ 配套文件…");
    const files = await Promise.all([fetchSample(SAMPLES.obj), fetchSample("obj/cube.mtl"), fetchSample("obj/cube-texture.png")]);
    const models = await parseFiles(files);
    for (const [index, model] of models.entries()) viewer.stage.addModel(model, files[index].name);
    viewer.stage.fitToActive();
    ui.setInfo(describeModels(models));
  })
};

/** OpenCascade tessellation quality changes the triangle budget for the same STEP file. */
export const CadQuality: Story = {
  render: (args) => useViewer(args, `CAD 精度 · ${args.quality}`, async (viewer, ui) => {
    const file = await fetchSample(SAMPLES.step);
    const started = performance.now();
    const model = await parseModel(file, { quality: args.quality });
    const elapsed = Math.round(performance.now() - started);
    viewer.stage.addModel(model, file.name);
    await viewer.stage.setDisplayStyle("edges");
    viewer.stage.fitToActive();
    ui.setInfo(`${CAD_QUALITY_PRESETS[args.quality].label} · ${elapsed}ms\n${describeModels([model])}`);
  })
};

/** Point the worker at a different directory; an invalid base surfaces the load error. */
export const ConfigureCadAssets: Story = {
  args: { baseUrl: "/occt/" },
  render: (args) => {
    const { root, body } = panel("configureCadAssets");
    useEffect(() => {
      let cancelled = false;
      body.textContent = `baseUrl=${args.baseUrl}\n解析中…`;
      configureCadAssets({ baseUrl: args.baseUrl });
      void fetchSample(SAMPLES.step)
        .then((file) => parseModel(file))
        .then((model) => {
          if (!cancelled) body.textContent = `baseUrl=${args.baseUrl}\n${describeModels([model])}`;
        })
        .catch((error: unknown) => {
          if (!cancelled) body.textContent = `baseUrl=${args.baseUrl}\n失败：${errorMessage(error)}`;
        })
        .finally(() => configureCadAssets({ baseUrl: "/occt/" }));
      return () => {
        cancelled = true;
        configureCadAssets({ baseUrl: "/occt/" });
      };
    }, [args.baseUrl]);
    return root;
  }
};

/** Aborting a CAD import terminates its worker; progress labels show it was alive. */
export const CancellationAndProgress: Story = {
  render: () => {
    const { root, body } = panel("取消与进度回调");
    const start = document.createElement("button");
    start.textContent = "开始解析 step-sample.stp";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    cancel.disabled = true;
    const status = document.createElement("p");
    body.append(start, document.createTextNode(" "), cancel, status);
    useEffect(() => {
      let controller: AbortController | null = null;
      start.addEventListener("click", () => {
        controller?.abort();
        controller = new AbortController();
        cancel.disabled = false;
        status.textContent = "解析中…";
        void fetchSample(SAMPLES.stepAssembly)
          .then((file) => parseModel(file, {
            signal: controller?.signal,
            onProgress: (progress: { label: string }) => { status.textContent = progress.label; }
          }))
          .then((model) => { status.textContent = `完成：${describeModels([model])}`; })
          .catch((error: unknown) => {
            status.textContent = controller?.signal.aborted === true ? "已取消（worker 已终止）" : `失败：${errorMessage(error)}`;
          })
          .finally(() => { cancel.disabled = true; });
      });
      cancel.addEventListener("click", () => controller?.abort());
      return () => controller?.abort();
    }, []);
    return root;
  }
};

