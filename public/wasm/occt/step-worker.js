/**
 * Classic worker that runs the OpenCascade wasm build (occt-import-js) off the main thread.
 *
 * Protocol (structured clone, typed arrays transferred):
 *   in : { format: "step" | "iges" | "brep", buffer: ArrayBuffer, params: object }
 *   out: { type: "progress", phase: string }
 *        { type: "log", text: string }
 *        { type: "error", error: string }
 *        { type: "done", meshes: [{ name, position: Float32Array, normal: Float32Array|null,
 *                                   index: Uint32Array|null, color: [r,g,b] }] }
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

function loadEngine() {
  if (enginePromise !== null) {
    return enginePromise;
  }
  post({ type: "progress", phase: "加载 OpenCascade 引擎（首次约 7.6MB）…" });
  importScripts("occt-import-js.js");
  const logs = [];
  enginePromise = occtimportjs({
    locateFile: (fileName) => new URL(fileName, self.location.href).href,
    print: () => {},
    printErr: (text) => {
      logs.push(String(text));
      if (logs.length > 40) {
        logs.shift();
      }
    }
  }).then((engine) => ({ engine, logs }));
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

  post({ type: "progress", phase: "OpenCascade 细分中…" });
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
  for (const raw of result.meshes) {
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
