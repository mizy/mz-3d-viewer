import { useEffect } from "storybook/preview-api";
import type { Meta, StoryObj } from "@storybook/html-vite";
import type { ModelViewer } from "../src/lib";
import { createViewerUi, describeModels, errorMessage, fetchSample, SAMPLES } from "./support";

type Args = {
  sample: string;
  forceWebGL: boolean;
};

const meta: Meta<Args> = {
  title: "Package/Built dist-lib",
  parameters: { layout: "fullscreen" },
  args: { sample: SAMPLES.step, forceWebGL: false },
  argTypes: {
    sample: { control: "select", options: Object.values(SAMPLES) }
  }
};

export default meta;
type Story = StoryObj<Args>;

/**
 * Loads the actual published entry (dist-lib/index.js) through Vite so its bare `three`
 * specifiers resolve like a consumer's bundle. Run `pnpm build:pkg` first; the alias in
 * .storybook/main.ts falls back to a stub and this story prints the hint when it is missing.
 */
export const PublishedArtifact: Story = {
  render: (args) => {
    const ui = createViewerUi(`dist-lib · ${args.sample}`);
    useEffect(() => {
      let cancelled = false;
      let viewer: ModelViewer | null = null;
      void (async () => {
        try {
          const built = (await import("mz-built-package")) as Partial<typeof import("../src/lib")>;
          if (typeof built.createModelViewer !== "function") {
            ui.setStatus("尚未构建 dist-lib：请先运行 pnpm build:pkg，再重启 Storybook。");
            return;
          }
          // The built module has its own asset configuration state, separate from the source API.
          built.configureCadAssets?.({ baseUrl: "/occt/" });
          ui.setStatus("初始化 dist-lib 渲染器…");
          const created = await built.createModelViewer(ui.canvas, { forceWebGL: args.forceWebGL });
          if (cancelled) {
            created.dispose();
            return;
          }
          viewer = created;
          ui.setBackend(created.backend);
          ui.setStatus(`载入 ${args.sample}…`);
          const file = await fetchSample(args.sample);
          const parsed = await created.load(file);
          ui.setInfo(`dist-lib 可用导出：${Object.keys(built).length} 个\n${describeModels(parsed)}`);
          ui.setStatus("就绪");
        } catch (error: unknown) {
          if (!cancelled) ui.setStatus(`失败：${errorMessage(error)}`);
        }
      })();
      return () => {
        cancelled = true;
        viewer?.dispose();
      };
    }, [args.sample, args.forceWebGL]);
    return ui;
  }
};
