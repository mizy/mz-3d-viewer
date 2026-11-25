/**
 * Classic worker that runs the OpenCascade wasm build (occt-import-js) off the main thread.
 *
 * Protocol (structured clone, typed arrays transferred):
 *   in : { format: "step" | "iges" | "brep", buffer: ArrayBuffer, params: object }
 *   out: { type: "progress", stage: "download" | "tessellate" | "assemble",
 *          ratio: number | null, label: string }
 *        { type: "log", text: string }
 *        { type: "error", error: string }
 *        { type: "done", meshes: [{ name, position: Float32Array, normal: Float32Array|null,
 *                                   index: Uint32Array|null, color: [r,g,b],
 *                                   faces: [{ first, last }] }] }
 *
 * Progress honesty: ReadStepFile is one blocking call into wasm with no progress callback, and
 * this worker is frozen for its entire duration, so tessellation cannot report a ratio at all.
 * The stages around it can: the engine download is streamed here (bytes measured) and mesh
 * marshalling counts meshes. `ratio: null` therefore means "alive but unmeasurable", which the
 * UI renders as an indeterminate bar.
 *
 * This file is intentionally plain JS in public/: it uses importScripts, which module
 * workers cannot, and living in public/ keeps dev and build behaviour identical.
 */

/* global occtimportjs */

let enginePromise = null;

function post(message, transfer) {
  if (transfer === undefined) {
    self.postMessage(message);
    return;
  }
  self.postMessage(message, transfer);
}

function progress(stage, ratio, label) {
  post({ type: "progress", stage, ratio, label });
}

function megabytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}

/**
 * Pulls the 7.6MB wasm here instead of letting the glue fetch it, so the download has real
 * byte progress. The bytes are handed to the module as `wasmBinary`; a failed fetch falls back
 * to the glue's own locateFile path so an unusual cache or MIME setup cannot break importing.
 */
async function fetchEngineBytes() {
  const url = new URL("occt-import-js.wasm", self.location.href).href;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }
  const total = Number(response.headers.get("content-length") || 0);
  if (response.body === null) {
    const buffer = await response.arrayBuffer();
    progress("download", null, "加载 OpenCascade 引擎 " + megabytes(buffer.byteLength));
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    received += value.byteLength;
    if (total > 0) {
      progress("download", Math.min(received / total, 0.99), "加载 OpenCascade 引擎 " + megabytes(received) + " / " + megabytes(total));
    } else {
      progress("download", null, "加载 OpenCascade 引擎 " + megabytes(received));
    }
  }
  progress("download", 1, "加载 OpenCascade 引擎 " + megabytes(received));
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function loadEngine() {
  if (enginePromise !== null) {
    return enginePromise;
  }
  progress("download", null, "加载 OpenCascade 引擎（首次约 7.6MB）…");
  importScripts("occt-import-js.js");
  const logs = [];
  const options = {
    locateFile: (fileName) => new URL(fileName, self.location.href).href,
    print: () => {},
    printErr: (text) => {
      logs.push(String(text));
      if (logs.length > 40) {
        logs.shift();
      }
    }
  };
  enginePromise = fetchEngineBytes()
    .then((wasmBinary) => occtimportjs({ ...options, wasmBinary }))
    .catch(() => occtimportjs(options))
    .then((engine) => ({ engine, logs }));
  return enginePromise;
}

self.onmessage = async (event) => {
  const { format, buffer, params } = event.data;
  let engine;
  let logs;
  try {
    const loaded = await loadEngine();
    engine = loaded.engine;
    logs = loaded.logs;
  } catch (error) {
    post({ type: "error", error: "OpenCascade 引擎加载失败：" + describe(error) });
    return;
  }

  progress("tessellate", null, "OpenCascade 细分中…");
  let result;
  try {
    const bytes = new Uint8Array(buffer);
    if (format === "step") {
      result = engine.ReadStepFile(bytes, params);
    } else if (format === "iges") {
      result = engine.ReadIgesFile(bytes, params);
    } else if (format === "brep") {
      result = engine.ReadBrepFile(bytes, params);
    } else {
      post({ type: "error", error: "未知 CAD 格式：" + String(format) });
      return;
    }
  } catch (error) {
    post({ type: "error", error: "CAD 解析失败：" + describe(error) });
    return;
  }

  if (!result || result.success !== true) {
    post({ type: "error", error: "CAD 解析失败：引擎返回 success=false" });
    return;
  }

  for (const text of logs.splice(0, logs.length)) {
    post({ type: "log", text });
  }

  const meshes = [];
  const transfer = [];
  const total = result.meshes.length;
  let processed = 0;
  for (const raw of result.meshes) {
    processed += 1;
    if (processed % 50 === 0) {
      progress("assemble", total === 0 ? null : processed / total, "整理网格 " + processed + " / " + total);
    }
    const position = raw.attributes.position.array;
    if (position.length === 0) {
      continue;
    }
    const positionArray = toFloat32(position);
    const normalArray = raw.attributes.normal === undefined ? null : toFloat32(raw.attributes.normal.array);
    const indexArray = raw.index === undefined || raw.index === null ? null : toUint32(raw.index.array);

    meshes.push({
      name: String(raw.name || "face"),
      position: positionArray,
      normal: normalArray,
      index: indexArray,
      faces: (raw.brep_faces ?? []).map(({ first, last }) => ({ first, last })),
      color: Array.isArray(raw.color) && raw.color.length >= 3 ? [raw.color[0], raw.color[1], raw.color[2]] : [0, 0, 0]
    });
    transfer.push(positionArray.buffer);
    if (normalArray !== null) {
      transfer.push(normalArray.buffer);
    }
    if (indexArray !== null) {
      transfer.push(indexArray.buffer);
    }
  }

  post({ type: "done", meshes }, transfer);
};

function toFloat32(source) {
  return source instanceof Float32Array ? source : Float32Array.from(source);
}

function toUint32(source) {
  return source instanceof Uint32Array ? source : Uint32Array.from(source);
}

function describe(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
