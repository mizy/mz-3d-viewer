import type { Stage, ControllerKind, Projection } from "../viewer/stage";
import type { CadEngineWarmState } from "../pwa/cadEngineWarm";

export type ViewerTestHooks = {
  stage: Stage;
  backend: string;
  /** Same call the 截图 button uses; tests read the PNG instead of downloading it. */
  capture: () => Promise<string>;
  /** Offline-readiness of the STEP/IGES/BREP engine, as reported by the warm-up. */
  cadEngine: () => CadEngineWarmState;
  /** Same path the sidebar select takes, minus the toast. */
  setController: (kind: ControllerKind) => void;
  setProjection: (projection: Projection) => void;
  summary: () => {
    models: Array<{ id: string; name: string; format: string; triangles: number; vertices: number; visible: boolean; sizeMm: [number, number, number] | null }>;
    activeId: string | null;
    style: string;
    gridVisible: boolean;
    environment: boolean;
    sectionEnabled: boolean;
    controller: ControllerKind;
    projection: Projection;
    backend: string;
    build: string;
    cadEngineStatus: CadEngineWarmState["status"];
  };
};

declare global {
  interface Window {
    __mzViewer?: ViewerTestHooks;
  }
}
