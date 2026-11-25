type FrameScheduler = {
  request: () => void;
  dispose: () => void;
};

/** @entry Coalesce invalidations and let active animation request its next frame. */
export function createFrameScheduler(render: () => void): FrameScheduler {
  let pending: number | null = null;
  let disposed = false;

  return {
    request() {
      if (disposed || pending !== null) return;
      pending = requestAnimationFrame(() => {
        pending = null;
        render();
      });
    },
    dispose() {
      disposed = true;
      if (pending !== null) cancelAnimationFrame(pending);
      pending = null;
    }
  };
}
