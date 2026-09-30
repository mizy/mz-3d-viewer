import type { Stage } from "../viewer/stage";

/** @entry Non-modal part inspection stays available while orbiting the model. */
export function createEntities(stage: Stage): () => void {
  const panel = document.getElementById("entitiesPanel")!;
  const toggle = document.getElementById("entitiesBtn") as HTMLButtonElement;
  const search = document.getElementById("entitySearch") as HTMLInputElement;
  const list = document.getElementById("entityList")!;
  const isolate = document.getElementById("isolatePartBtn") as HTMLButtonElement;
  const clear = document.getElementById("clearPartBtn") as HTMLButtonElement;
  let renderedId: string | null = null;
  const empty = document.createElement("li");
  empty.className = "empty";
  const close = (): void => {
    if (panel.hidden) return;
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    const aspect = stage.viewportAspect;
    stage.resize();
    if (aspect !== stage.viewportAspect) stage.fitToActive(true);
  };

  const render = (): void => {
    const handle = stage.active;
    toggle.disabled = handle === null;
    if (!handle) close();
    document.getElementById("entityCount")!.textContent = `${handle?.parts.length ?? 0}`;
    isolate.disabled = clear.disabled = handle?.selectedPart == null;
    if (renderedId !== (handle?.id ?? null)) {
      renderedId = handle?.id ?? null;
      list.replaceChildren();
      handle?.parts.forEach((part, index) => {
        const name = part.mesh.name || `部件 ${index + 1}`;
        const item = document.createElement("li");
        item.className = "entity-row";
        const pick = document.createElement("button");
        pick.className = "entity-name";
        pick.dataset["part"] = String(index);
        pick.textContent = name;
        pick.title = name;
        pick.addEventListener("click", () => {
          stage.selectPart(index);
          render();
        });
        const visibility = document.createElement("button");
        visibility.className = "icon-btn";
        visibility.addEventListener("click", () => { stage.setPartVisible(index, !part.mesh.visible); render(); });
        const fit = document.createElement("button");
        fit.className = "icon-btn";
        fit.textContent = "⤢";
        fit.setAttribute("aria-label", `定位 ${name}`);
        fit.addEventListener("click", () => { stage.selectPart(index); stage.fitToPart(index); render(); });
        item.append(pick, visibility, fit);
        list.append(item);
      });
    }
    const query = search.value.trim().toLocaleLowerCase();
    let matches = 0;
    for (const [index, part] of (handle?.parts ?? []).entries()) {
      const item = list.children[index] as HTMLLIElement;
      const pick = item.children[0] as HTMLButtonElement;
      const visibility = item.children[1] as HTMLButtonElement;
      item.hidden = !pick.textContent!.toLocaleLowerCase().includes(query);
      if (!item.hidden) matches++;
      item.classList.toggle("selected", handle!.selectedPart === index);
      item.classList.toggle("muted", !part.mesh.visible);
      pick.setAttribute("aria-pressed", String(handle!.selectedPart === index));
      visibility.textContent = part.mesh.visible ? "◉" : "◎";
      visibility.setAttribute("aria-label", `${part.mesh.visible ? "隐藏" : "显示"} ${pick.textContent}`);
    }
    empty.textContent = handle ? "没有匹配的部件" : "请先打开模型";
    empty.hidden = matches > 0;
    if (empty.parentElement !== list) list.append(empty);
  };
  toggle.addEventListener("click", () => {
    if (!panel.hidden) { close(); return; }
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    document.getElementById("explodePanel")!.hidePopover();
    render();
    const aspect = stage.viewportAspect;
    stage.resize();
    if (aspect !== stage.viewportAspect) stage.fitToActive(true);
  });
  document.getElementById("entitiesClose")!.addEventListener("click", close);
  document.getElementById("sidebarToggle")!.addEventListener("click", close);
  document.getElementById("explodeBtn")!.addEventListener("click", close);
  search.addEventListener("input", render);
  clear.addEventListener("click", () => { stage.selectPart(null); render(); });
  isolate.addEventListener("click", () => {
    const index = stage.active?.selectedPart;
    if (index != null) { stage.isolatePart(index); render(); }
  });
  document.getElementById("showPartsBtn")!.addEventListener("click", () => { stage.showAllParts(); render(); });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { close(); toggle.focus(); }
  });
  return render;
}
