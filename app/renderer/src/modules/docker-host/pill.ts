import "../../shared/legacy-globals";
import { $ } from "../../shared/dollar";
import { ctxMenu, closeCtxMenu } from "../../shared/ctx-menu";
import { formatTransformName } from "../../shared/format";
import { registerToolbarPill, syncPillPeerVisibility, CLIPBOARD_ICON_SVG } from "../../shared/toolbar-pills";
import { dockerHostHistory, populateDockerHostHistory } from "./state";
import { openNewDockerHostDialog, openEditDockerHostDialog } from "./set-dialog";

function dockerHostMenuOpen(): boolean {
  const dropdown = $("docker-host-dropdown");
  return (dropdown ? !dropdown.hidden : false) || document.getElementById("ctxmenu")?.dataset.owner === "dockerhost";
}
function dockerHostHasOverlay(): boolean {
  const popup = $("docker-host-info-popup");
  return (popup ? !popup.hidden : false) || dockerHostMenuOpen();
}
function closeDockerHostOverlay(): void {
  const popup = $("docker-host-info-popup");
  if (popup) popup.hidden = true;
  const dropdown = $("docker-host-dropdown");
  if (dropdown && !dropdown.hidden) {
    dropdown.hidden = true;
    $("docker-host-status")?.classList.remove("open");
  }
  if (document.getElementById("ctxmenu")?.dataset.owner === "dockerhost") closeCtxMenu();
}
registerToolbarPill("dockerhost", { hasOverlay: dockerHostHasOverlay, closeOverlay: closeDockerHostOverlay });

export function mountDockerHostPill(): void {
  const wrap = $("docker-host-status");
  const btn = $("docker-host-status-btn");
  const dropdown = $("docker-host-dropdown");
  if (!wrap) return;

  const close = () => {
    wrap.classList.remove("open");
    dropdown.hidden = true;
  };

  const openHost = async (hostKey: string) => {
    close();
    if (hasDockerDaemon()) {
      await $("btn-clear-sources").onclick();
      if (hasDockerDaemon()) return; // confirm declined -- leave the current host connected
    }
    // nothing connected now -- opens New Docker Host (its "Load Docker Host" select is still
    // populated even though the row itself stays hidden, see openNewDockerHostDialog -- driving
    // it programmatically here is unaffected). openNewDockerHostDialog fills that select itself,
    // but doesn't wait on it (an IPC round-trip) before returning, so it's re-populated here,
    // awaited, before its value is set below.
    openNewDockerHostDialog();
    await populateDockerHostHistory();
    $("docker-host-history").value = hostKey;
    await $("docker-host-history").onchange();
  };

  const render = async () => {
    const active = syncPill();
    dropdown.innerHTML = "";
    const history = await dockerHostHistory();
    if (!history.length) {
      const empty = document.createElement("div");
      empty.className = "gateway-empty";
      empty.textContent = "No Docker hosts yet — New Docker Host to add one.";
      dropdown.appendChild(empty);
      return;
    }
    history.forEach((entry, i) => {
      if (i > 0) {
        const sep = document.createElement("div");
        sep.className = "gateway-item-sep";
        dropdown.appendChild(sep);
      }
      const item = document.createElement("button");
      item.type = "button";
      item.className = "gateway-item";
      item.dataset.active = String(entry.hostKey === active);
      const label = document.createElement("span");
      label.className = "gateway-item-label";
      label.textContent = entry.hostKey === "local" ? "localhost" : entry.hostKey.replace(/^ssh:\/\//, "");
      item.appendChild(label);
      if (entry.hostKey !== active) item.onclick = () => openHost(entry.hostKey);
      dropdown.appendChild(item);
    });
  };

  // "Current Status" (right-click, see below): SSH connection + which
  // transforms are on for the connected host (see server/transforms/*.py
  // -- exactly these three exist today), styled like the Gateway pill's
  // own info popup (same shared CSS class) -- moved behind a click per
  // explicit user direction ("hover tag" showing nothing anymore).
  const infoPopup = $("docker-host-info-popup");
  const TRANSFORM_NAMES = ["drop_healthchecks", "json_message", "parse_level"];
  function renderInfoRow(label: string, val: string) {
    const row = document.createElement("div");
    row.className = "cip-row";
    const l = document.createElement("span");
    l.className = "cip-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "cip-val";
    v.textContent = val;
    row.append(l, v);
    return row;
  }
  async function showDockerHostStatus() {
    if (!infoPopup) return;
    const active = hasDockerDaemon() ? currentDockerHost() || "local" : null;
    infoPopup.innerHTML = "";
    if (active == null) {
      infoPopup.appendChild(renderInfoRow("Docker host", "not connected"));
    } else {
      const entry = (await dockerHostHistory()).find((e) => e.hostKey === active) as { transforms?: string[] } | undefined;
      const label = active === "local" ? "localhost" : active.replace(/^ssh:\/\//, "");
      infoPopup.appendChild(renderInfoRow("SSH Connection", label));
      const sep = document.createElement("div");
      sep.className = "cip-sep";
      infoPopup.appendChild(sep);
      for (const name of TRANSFORM_NAMES) {
        infoPopup.appendChild(renderInfoRow(formatTransformName(name), entry?.transforms?.includes(name) ? "True" : "False"));
      }
    }
    infoPopup.hidden = false;
    syncPillPeerVisibility("dockerhost");
    // Deferred to the next task: showDockerHostStatus runs synchronously
    // as part of the ctxmenu item's own click, which is still bubbling
    // when this returns -- attaching the listener before that finishes
    // would let this same click immediately count as the "outside click"
    // that closes what it just opened.
    setTimeout(() => {
      document.addEventListener("click", function onOutside(e) {
        if (!wrap.contains(e.target as Node)) infoPopup.hidden = true;
      }, { once: true });
    }, 0);
  }
  // Right-click: New/Edit/Remove Docker Host -- the same actions the action
  // bar's Docker Host group already exposes, plus Current Status.
  wrap.addEventListener("contextmenu", (e: MouseEvent) => {
    if (infoPopup) infoPopup.hidden = true; // don't show both at once
    ctxMenu(e, [
      ["New Docker Host…", () => openNewDockerHostDialog(), "#btn-set"],
      ["Edit Docker Host", () => openEditDockerHostDialog(), "#btn-edit-docker-host"],
      ["Remove Docker Host…", () => $("btn-remove-docker-daemon").click(), "#btn-remove-docker-daemon"],
      "separator",
      ["Current Status", showDockerHostStatus, CLIPBOARD_ICON_SVG],
    ], "dockerhost");
    syncPillPeerVisibility("dockerhost");
  });

  // Updates the dot alone -- cheap enough to run on every state.sources
  // refresh (see refreshDockerHostPill), unlike render()'s full dropdown
  // rebuild, which only needs to happen while it's open. Returns the
  // active hostKey (or null), since render() needs it too.
  const syncPill = () => {
    const active = hasDockerDaemon() ? currentDockerHost() || "local" : null;
    wrap.dataset.state = active ? "up" : "";
    return active;
  };
  refreshDockerHostPill = syncPill;
  syncPill(); // reflect whatever's already connected as of page load, before any click

  btn.onclick = (e: MouseEvent) => {
    e.stopPropagation();
    if (wrap.classList.contains("open")) {
      close();
      return;
    }
    if (infoPopup) infoPopup.hidden = true; // don't show both at once
    wrap.classList.add("open");
    dropdown.hidden = false;
    render();
    syncPillPeerVisibility("dockerhost");
  };
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target as Node)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}
