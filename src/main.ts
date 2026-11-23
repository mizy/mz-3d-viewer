import { assetBase } from "./assetBase";
import { createApp } from "./ui/app";
import { createRenderer, forceWebGLFromUrl } from "./renderer/createRenderer";
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

const forceWebGL = forceWebGLFromUrl(location.search);
const { renderer, backend } = await createRenderer(canvas, forceWebGL);
const stage = new Stage(renderer, canvas);
stage.resize();

const app = createApp(stage, backend, forceWebGL);

const resizeObserver = new ResizeObserver(() => stage.resize());
resizeObserver.observe(canvas);

consumeLaunchQueue((files) => void app.openFiles(files), app.reportFileOpenError);

registerServiceWorker((state) => app.setCadEngineState(state));
