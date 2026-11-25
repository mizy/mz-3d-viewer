import { assetBase } from "./assetBase";
import { configureCadAssets } from "./cadAssets";
import { createApp } from "./ui/app";
import { createRenderer, WebGPUUnavailableError } from "./renderer/createRenderer";
import { Stage } from "./viewer/stage";
import { consumeLaunchQueue, registerServiceWorker } from "./pwa/register";

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`缺少必需的界面元素 #${id}`);
  }
  return node as T;
}

const canvas = must<HTMLCanvasElement>("view");
canvas.dataset["assetBase"] = assetBase;
configureCadAssets({ baseUrl: `${assetBase}wasm/occt/` });

try {
  const renderer = await createRenderer(canvas);
  const stage = new Stage(renderer, canvas, must("pivotGizmo"));
  stage.resize();

  const app = createApp(stage);
  const resizeObserver = new ResizeObserver(() => stage.resize());
  resizeObserver.observe(canvas);

  consumeLaunchQueue((files) => void app.openFiles(files), app.reportFileOpenError);
  registerServiceWorker((state) => app.setCadEngineState(state));
} catch (error) {
  if (!(error instanceof WebGPUUnavailableError)) throw error;
  must("app").hidden = true;
  must("webgpuUnavailable").hidden = false;
}
