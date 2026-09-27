import { assetUrl } from "../assetBase";
import { warmCadEngine, type CadEngineWarmState } from "./cadEngineWarm";

const CONTROLLER_RELOAD_FLAG = "mz-3d-viewer.controller-reload";

/**
 * Registers the service worker and, once the page is controlled by a *new* worker,
 * reloads once so the user never sits on a stale shell. The reload is skipped on the
 * very first install, where `clients.claim()` also fires `controllerchange`.
 *
 * Registration is not wired to the window `load` event alone: the await-heavy boot can
 * finish after `load` has already fired, which would skip registration forever.
 */
export function registerServiceWorker(onCadEngineState: (state: CadEngineWarmState) => void): void {
  if (import.meta.env.PROD !== true || !("serviceWorker" in navigator)) {
    return;
  }

  const hadController = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      return;
    }
    if (sessionStorage.getItem(CONTROLLER_RELOAD_FLAG) === "1") {
      return;
    }
    sessionStorage.setItem(CONTROLLER_RELOAD_FLAG, "1");
    location.reload();
  });

  const register = (): void => {
    void navigator.serviceWorker
      .register(assetUrl("sw.js"), { scope: "./" })
      .then(async () => {
        await navigator.serviceWorker.ready;
        // Warm the 7.6MB OpenCascade engine so STEP files also work offline. Deliberately not
        // awaited: the app must be usable while the engine downloads in the background.
        void warmCadEngine(onCadEngineState);
      })
      .catch((error: unknown) => {
        console.warn("[pwa] service worker 注册失败", error);
      });
  };

  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register, { once: true });
  }
}

/** Chrome/Edge hand OS-opened files to the PWA through launchQueue. */
export function consumeLaunchQueue(onFiles: (files: File[]) => void): void {
  const launchQueue = (
    window as unknown as {
      launchQueue?: { setConsumer: (consumer: (params: { files?: File[] }) => void) => void };
    }
  ).launchQueue;
  if (launchQueue === undefined) {
    return;
  }
  launchQueue.setConsumer((params) => {
    if (params.files !== undefined && params.files.length > 0) {
      onFiles(params.files);
    }
  });
}
