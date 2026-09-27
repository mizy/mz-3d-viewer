import type { Stage } from "../viewer/stage";

export type ViewerTestHooks = {
  stage: Stage;
  backend: string;
  /** Same call the 截图 button uses; tests read the PNG instead of downloading it. */
  capture: () => Promise<string>;
  summary: () => {
    models: Array<{ id: string; name: string; format: string; triangles: number; vertices: number; visible: boolean; sizeMm: [number, number, number] }>;
    activeId: string | null;
    style: string;
    gridVisible: boolean;
    sectionEnabled: boolean;
    backend: string;
    build: string;
  };
};

declare global {
  interface Window {
    __mzViewer?: ViewerTestHooks;
  }
}
