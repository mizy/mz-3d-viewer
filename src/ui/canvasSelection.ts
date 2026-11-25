/** @entry Dispatch a primary-button click only when the pointer did not drag. */
export function bindCanvasClick(
  canvas: HTMLCanvasElement, click: (event: PointerEvent) => Promise<void>, signal?: AbortSignal
): void {
  let pointer: { id: number; x: number; y: number } | null = null;
  const options = { signal };
  canvas.addEventListener("pointerdown", (event) => {
    pointer = event.isPrimary && event.button === 0 ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
  }, options);
  canvas.addEventListener("pointermove", (event) => {
    if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) pointer = null;
  }, options);
  canvas.addEventListener("pointercancel", () => { pointer = null; }, options);
  canvas.addEventListener("pointerup", (event) => {
    if (pointer?.id !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5;
    pointer = null;
    if (!moved) void click(event);
  }, options);
}
