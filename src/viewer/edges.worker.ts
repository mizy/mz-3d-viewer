import { BufferAttribute, BufferGeometry, EdgesGeometry } from "three";

/** The original geometry stays on the page; only copied attributes cross the worker boundary. */
self.onmessage = (event: MessageEvent<{ position: Float32Array; index: Uint32Array | null; angle: number }>) => {
  const { position, index, angle } = event.data;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  if (index) geometry.setIndex(new BufferAttribute(index, 1));
  try {
    const edges = new EdgesGeometry(geometry, angle);
    const result = edges.getAttribute("position").array as Float32Array;
    self.postMessage({ position: result }, { transfer: [result.buffer] });
    edges.dispose();
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    geometry.dispose();
  }
};
