import type { Stage } from "../viewer/stage";

/**
 * @entry Hover preview driven by the cached pick buffer.
 *
 * There is no artificial settle delay any more: a pick is one pixel read from a buffer the GPU
 * already drew, so it can run on every pointer move. Only the newest position matters — a read in
 * flight never lets older positions queue up behind it.
 */
export function createInspectionHover(
  stage: Stage, canvas: HTMLCanvasElement, canHover: () => boolean
): () => void {
  let generation = 0;
  let pending: { x: number; y: number } | null = null;
  let running = false;

  function clear(): void {
    generation += 1;
    pending = null;
    stage.setHoveredSurface(null);
  }

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    const start = generation;
    try {
      while (pending !== null && generation === start) {
        const point = pending;
        pending = null;
        const hit = canHover() && document.elementFromPoint(point.x, point.y) === canvas
          ? await stage.pick(point.x, point.y)
          : null;
        if (generation !== start) return;
        stage.setHoveredSurface(hit);
      }
    } finally {
      running = false;
    }
  }

  canvas.addEventListener("pointermove", ({ pointerType, buttons, clientX, clientY }) => {
    if (pointerType !== "mouse" || buttons !== 0 || stage.active === null || !canHover()) {
      clear();
      return;
    }
    pending = { x: clientX, y: clientY };
    void drain();
  });
  for (const event of ["pointerleave", "pointerdown", "pointercancel", "wheel"]) {
    canvas.addEventListener(event, clear, { passive: true });
  }
  window.addEventListener("blur", clear);
  stage.controls.addEventListener("change", clear);
  return clear;
}
