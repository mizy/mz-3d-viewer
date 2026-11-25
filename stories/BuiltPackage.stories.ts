import type { Meta, StoryObj } from "@storybook/html-vite";
import { describeModels, fetchSample, SAMPLES, useViewer } from "./support";

type Args = {
  sample: string;
};

const meta: Meta<Args> = {
  title: "Package/Built dist-lib",
  parameters: { layout: "fullscreen" },
  args: { sample: SAMPLES.step },
  argTypes: {
    sample: { control: "select", options: Object.values(SAMPLES) }
  }
};

export default meta;
type Story = StoryObj<Args>;

async function createBuiltViewer(canvas: HTMLCanvasElement) {
  const built = (await import("mz-built-package")) as Partial<typeof import("../src/lib")>;
  if (typeof built.createModelViewer !== "function") {
    throw new Error("尚未构建 dist-lib，请运行 pnpm build:pkg 再重启 Storybook。");
  }
  // The built module has its own CAD asset configuration.
  built.configureCadAssets?.({ baseUrl: "/occt/" });
  return built.createModelViewer(canvas);
}

/** Load the built dist-lib entry as it would be bundled by an SDK consumer. */
export const PublishedArtifact: Story = {
  render: (args) => useViewer(`dist-lib · ${args.sample}`, {
    key: args.sample,
    create: createBuiltViewer,
    setup: async (viewer, ui, signal) => {
      ui.setStatus(`载入 ${args.sample}…`);
      const file = await fetchSample(args.sample, signal);
      const parsed = await viewer.load(file, { signal });
      const built = await import("mz-built-package");
      if (!signal.aborted) ui.setInfo(`dist-lib 可用导出：${Object.keys(built).length} 个\n${describeModels(parsed)}`);
    }
  })
};
