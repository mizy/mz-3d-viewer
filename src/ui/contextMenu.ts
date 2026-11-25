import type { DisplayStyle } from "../viewer/appearance";
import type { Stage } from "../viewer/stage";

export type ContextMenuActions = Readonly<{
  fitAll: () => void;
  fitPart: (index: number) => void;
  hidePart: (index: number) => void;
  isolatePart: (index: number) => void;
  hideModel: (modelId: string) => void;
  showAll: () => void;
  resetView: () => void;
  setStyle: (style: DisplayStyle) => void;
}>;

type MenuItem = Readonly<{ label: string; run: () => void }> | "separator";

const STYLES: readonly { style: DisplayStyle; label: string }[] = [
  { style: "edges", label: "边线" },
  { style: "solid", label: "实体" },
  { style: "wireframe", label: "线框" },
  { style: "xray", label: "X 光" }
];

/** A right press that travels further than this was a pan gesture, not a menu request. */
const PAN_TOLERANCE_PX = 4;

/**
 * @entry Right-click menu for the actions that were previously only reachable through the
 * sidebar: fit, hide, isolate, show everything and reset the view.
 *
 * The menu opens on right pointer-up rather than on `contextmenu`, because the right button also
 * pans the camera; a drag has to stay a drag. `contextmenu` is still cancelled so the browser's
 * own menu never covers it.
 */
export function createContextMenu(stage: Stage, canvas: HTMLCanvasElement, actions: ContextMenuActions): () => void {
  const menu = document.getElementById("contextMenu");
  if (menu === null) return () => {};

  let token = 0;
  let pressed: { x: number; y: number } | null = null;

  function close(): void {
    token += 1;
    pressed = null;
    menu!.hidden = true;
    menu!.replaceChildren();
  }

  function open(clientX: number, clientY: number): void {
    const request = ++token;
    void build(clientX, clientY, request);
  }

  async function build(clientX: number, clientY: number, request: number): Promise<void> {
    const hit = await stage.pick(clientX, clientY);
    if (request !== token || stage.modelList.length === 0) return;
    const active = stage.active;
    const ownPart = hit !== null && active !== null && hit.modelId === active.id ? hit.partIndex : null;
    const partIndex = ownPart !== null && ownPart >= 0 ? ownPart : null;

    menu!.replaceChildren();
    const title = document.createElement("div");
    title.className = "context-menu-title";
    title.textContent = describeTarget(hit, partIndex);
    menu!.append(title);

    const items: MenuItem[] = [{ label: "适应视图", run: actions.fitAll }];
    if (partIndex !== null) {
      items.push({ label: "适应此部件", run: () => actions.fitPart(partIndex) });
    }
    items.push("separator");
    if (partIndex !== null) {
      items.push({ label: "隐藏此部件", run: () => actions.hidePart(partIndex) });
      items.push({ label: "只显示此部件", run: () => actions.isolatePart(partIndex) });
    }
    if (hit !== null) {
      const modelId = hit.modelId;
      items.push({ label: "隐藏此模型", run: () => actions.hideModel(modelId) });
    }
    items.push({ label: "显示全部", run: actions.showAll });
    items.push("separator");
    items.push({ label: "重置视图（等轴测）", run: actions.resetView });

    for (const item of items) {
      menu!.append(item === "separator" ? separator() : itemButton(item.label, item.run));
    }
    menu!.append(styleRow(actions.setStyle));

    menu!.hidden = false;
    menu!.style.left = "0px";
    menu!.style.top = "0px";
    const bounds = menu!.getBoundingClientRect();
    const left = Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8));
    const top = Math.max(8, Math.min(clientY, window.innerHeight - bounds.height - 8));
    menu!.style.left = `${Math.round(left)}px`;
    menu!.style.top = `${Math.round(top)}px`;
    menu!.querySelector<HTMLButtonElement>(".context-menu-item")?.focus({ preventScroll: true });
  }

  function describeTarget(hit: { modelId: string; partIndex: number } | null, partIndex: number | null): string {
    const active = stage.active;
    if (hit === null) return "空白处";
    if (partIndex !== null && active !== null) {
      const name = active.parts[partIndex]?.mesh.name.trim();
      return name && name.length > 0 ? name : `部件 ${partIndex + 1}`;
    }
    return stage.modelList.find((model) => model.id === hit.modelId)?.name ?? "模型";
  }

  function separator(): HTMLElement {
    const line = document.createElement("div");
    line.className = "context-menu-sep";
    return line;
  }

  function itemButton(label: string, run: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-menu-item";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.addEventListener("click", () => {
      close();
      run();
    });
    return button;
  }

  function styleRow(setStyle: (style: DisplayStyle) => void): HTMLElement {
    const row = document.createElement("div");
    row.className = "context-menu-styles";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "显示模式");
    for (const entry of STYLES) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = entry.label;
      button.setAttribute("aria-pressed", String(stage.style === entry.style));
      button.addEventListener("click", () => {
        close();
        setStyle(entry.style);
      });
      row.append(button);
    }
    return row;
  }

  function onPointerDown(event: PointerEvent): void {
    if (!menu!.hidden && !menu!.contains(event.target as Node)) close();
    pressed = event.button === 2 ? { x: event.clientX, y: event.clientY } : null;
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.button !== 2 || pressed === null) return;
    const distance = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y);
    pressed = null;
    if (distance <= PAN_TOLERANCE_PX) {
      event.preventDefault();
      open(event.clientX, event.clientY);
    }
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (menu!.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      canvas.focus({ preventScroll: true });
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const buttons = [...menu!.querySelectorAll<HTMLButtonElement>("button")];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? buttons.length - 1
        : event.key === "ArrowDown" ? (current + 1) % buttons.length
          : (current - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  }

  canvas.addEventListener("contextmenu", onContextMenu);
  // Capture on the window: it sees the canvas press before any controller starts a gesture.
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);
  canvas.addEventListener("wheel", close, { passive: true });
  menu.addEventListener("contextmenu", onContextMenu);

  return () => {
    close();
    canvas.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", close);
    window.removeEventListener("blur", close);
    canvas.removeEventListener("wheel", close);
    menu.removeEventListener("contextmenu", onContextMenu);
  };
}
