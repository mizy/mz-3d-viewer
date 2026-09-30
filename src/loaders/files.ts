import { LoadingManager } from "three/webgpu";

export type FileBundle = {
  byName: Map<string, File>;
  files: File[];
};

export function createFileBundle(files: File[]): FileBundle {
  return { files, byName: new Map(files.map((file) => [file.name.toLowerCase(), file])) };
}

/** @entry OBJ and glTF share local companion resolution and its temporary URL lifetime. */
export async function loadWithFiles<T>(
  bundle: FileBundle,
  warnings: string[],
  load: (manager: LoadingManager) => Promise<T>
): Promise<T> {
  const urls = new Map<File, string>();
  const manager = new LoadingManager();
  // Hold a batch item open while the parser discovers all its dependencies.
  const complete = new Promise<void>((resolve) => { manager.onLoad = resolve; });
  manager.itemStart("local-model");
  manager.setURLModifier((url) => {
    if (/^(data:|blob:)/i.test(url)) return url;
    const name = decodeURIComponent(url.split("/").pop() ?? url).toLowerCase();
    const file = bundle.byName.get(name);
    if (!file) return url;
    let local = urls.get(file);
    if (!local) { local = URL.createObjectURL(file); urls.set(file, local); }
    return local;
  });
  manager.onError = (url) => {
    const file = [...urls].find(([, local]) => local === url)?.[0];
    warnings.push(`伴随文件加载失败：${file?.name ?? decodeURIComponent(url.split("/").pop() ?? url)}`);
  };
  try {
    return await load(manager);
  } finally {
    manager.itemEnd("local-model");
    await complete;
    for (const url of urls.values()) URL.revokeObjectURL(url);
  }
}
