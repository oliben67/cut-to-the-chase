import "../../shared/legacy-globals";
import { $ } from "../../shared/dollar";
import { ctxMenu, closeCtxMenu } from "../../shared/ctx-menu";
import { registerToolbarPill, syncPillPeerVisibility, CLIPBOARD_ICON_SVG } from "../../shared/toolbar-pills";
import { openNewGatewayDialog, openEditGatewaysDialog, openUninstallGatewayDialog } from "./dialogs";

function gatewayMenuOpen(): boolean {
  const dropdown = $("gateway-dropdown");
  return (dropdown ? !dropdown.hidden : false) || document.getElementById("ctxmenu")?.dataset.owner === "gateway";
}
function gatewayHasOverlay(): boolean {
  const popup = $("connection-info-popup");
  return (popup ? !popup.hidden : false) || gatewayMenuOpen();
}
function closeGatewayOverlay(): void {
  const popup = $("connection-info-popup");
  if (popup) popup.hidden = true;
  const dropdown = $("gateway-dropdown");
  if (dropdown && !dropdown.hidden) {
    dropdown.hidden = true;
    $("server-status")?.classList.remove("open");
  }
  if (document.getElementById("ctxmenu")?.dataset.owner === "gateway") closeCtxMenu();
}
registerToolbarPill("gateway", { hasOverlay: gatewayHasOverlay, closeOverlay: closeGatewayOverlay });

// Mounts the gateway status pill: health polling, right-click menu, the
// "Current Status" popup, and the gateway-switcher dropdown. Ported as one
// function (rather than left as two top-level IIFEs like app.js had) so it
// can be called from mountGateway() once app.js's DOM/globals are ready.
export function mountGatewayPill(): void {
  mountServerStatus();
  mountGatewayDropdown();
}

/* ── server status indicator (status bar, just left of History) ──────────
   Polls /health independently of connectSSE's own stream so it still shows
   "down" if the SSE connection itself is what's wedged. Only present in the
   main window -- harmless no-op elsewhere since $() returns null. */
function mountServerStatus(): void {
  const el = $("server-status");
  if (!el) return;
  // connectionType/gateway identity/ssh info aren't in the URL's host=&port=
  // to begin with (those are just the client-facing address), so they're
  // fetched separately from main.js's connection state -- used by
  // showGatewayStatus's "Current Status" popup below.
  let connectionInfo: Record<string, string> | null = null;
  async function loadConnectionInfo() {
    if (!window.cttc?.getConnectionInfo) return;
    connectionInfo = await window.cttc!.getConnectionInfo();
  }
  loadConnectionInfo();

  const popup = $("connection-info-popup");
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
  // "Current Status" (right-click, see below): the same connection detail
  // this used to show on hover (Connection/Gateway/ssh target/port) --
  // moved behind a click per explicit user direction ("hover tag" showing
  // nothing anymore). Async (loadConnectionInfo awaits a real IPC round
  // trip) -- the popup itself only appears once that resolves, which
  // naturally lands after the triggering click has finished dispatching,
  // so the "click outside closes it" listener added at the end never sees
  // that same click as the one that should close it.
  function showGatewayStatus() {
    if (!popup) return;
    loadConnectionInfo().then(() => {
      popup.innerHTML = "";
      popup.appendChild(renderInfoRow("Connection", connectionInfo!.connectionType));
      if (connectionInfo!.connectionType !== "local") {
        popup.appendChild(renderInfoRow("Gateway", `${connectionInfo!.gatewayHost}:${connectionInfo!.gatewayPort}`));
      }
      if (connectionInfo!.connectionType === "remote-tunnel") {
        const sep = document.createElement("div");
        sep.className = "cip-sep";
        popup.appendChild(sep);
        popup.appendChild(renderInfoRow("ssh target", connectionInfo!.sshTarget));
        if (connectionInfo!.sshPort) popup.appendChild(renderInfoRow("ssh port", String(connectionInfo!.sshPort)));
        popup.appendChild(renderInfoRow("forwarded port", `localhost:${connectionInfo!.port}`));
      }
      popup.hidden = false;
      syncPillPeerVisibility("gateway");
      document.addEventListener("click", function onOutside(e) {
        if (!el.contains(e.target as Node)) popup.hidden = true;
      }, { once: true });
    });
  }
  // Right-click: New/Edit/Uninstall Gateway, the same actions the action
  // bar's Gateway group already exposes, plus Current Status (ctxMenu is
  // the shared generic context-menu helper, also used by the legend/
  // chart-time menus).
  el.addEventListener("contextmenu", (e: MouseEvent) => {
    if (popup) popup.hidden = true; // don't show both at once
    ctxMenu(e, [
      ["New Gateway…", () => openNewGatewayDialog(), '[data-action="new-gateway"]'],
      ["Edit Gateway", () => openEditGatewaysDialog(), '[data-action="edit-gateways"]'],
      ["Uninstall Gateway…", () => openUninstallGatewayDialog(), '[data-action="uninstall-gateway"]'],
      "separator",
      ["Current Status", showGatewayStatus, CLIPBOARD_ICON_SVG],
    ], "gateway");
    syncPillPeerVisibility("gateway");
  });

  const HEALTH_POLL_MS = 5000;
  // The status pill itself only ever shows a colored dot, no tooltip --
  // gateway location/connection detail is one right-click ("Current
  // Status") away instead, and failure text goes to the bottom status bar
  // (notifyEvent).
  const setState = (state: string) => {
    el.dataset.state = state;
  };
  let checking = false;
  // The last *confirmed* (up/down) state, for edge-detecting the
  // notifyEvent transition -- el.dataset.state itself gets a transient
  // "checking" flash first (below), which would otherwise erase "down"
  // before this same call learns whether it recovered.
  let lastConfirmed: string | null = null;
  const check = async () => {
    // setInterval doesn't wait for a previous call to finish -- a slow
    // /health round trip overlapping the next tick could otherwise race
    // two checks against the same dataset.state/notifyEvent, flapping the
    // down/up transition text. One in-flight check at a time.
    if (checking) return;
    checking = true;
    try {
      // Only flash "checking" when we don't already know the answer --
      // once "up", routine re-polls shouldn't flicker the dot on every
      // request.
      if (el.dataset.state !== "up") setState("checking");
      try {
        await get("/health");
        if (lastConfirmed === "down") notifyEvent("Gateway connection restored");
        lastConfirmed = "up";
        setState("up");
      } catch (err: unknown) {
        // only notify on the down transition -- not every 5s re-poll
        // while it stays down
        if (lastConfirmed !== "down") notifyEvent(`Gateway connection failed: ${(err as Error)?.message || err}`);
        lastConfirmed = "down";
        setState("down");
      }
    } finally {
      checking = false;
    }
  };
  check();
  setInterval(check, HEALTH_POLL_MS);
}

/* ── gateway dropdown (click the status pill) ─────────────────────────────
   Lists every gateway this client has ever actually connected to (see
   lib/gateway-registry.js, recorded server-side in main.js right after a
   connect succeeds) so switching back to one doesn't mean re-typing an ssh
   target from scratch. Picking a non-active one re-verifies it's still up
   (main.js's switch-gateway) before writing connection.json and offering a
   restart -- never blind-trusts a stale entry. */
function mountGatewayDropdown(): void {
  const wrap = $("server-status");
  const btn = $("server-status-btn");
  const dropdown = $("gateway-dropdown");
  if (!wrap || !window.cttc?.getGateways) return;

  const close = () => {
    wrap.classList.remove("open");
    dropdown.hidden = true;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const render = (gateways: any[]) => {
    dropdown.innerHTML = "";
    if (!gateways.length) {
      const empty = document.createElement("div");
      empty.className = "gateway-empty";
      empty.textContent = "No other gateways yet — Run Setup to add one.";
      dropdown.appendChild(empty);
      return;
    }
    gateways.forEach((g, i) => {
      if (i > 0) {
        const sep = document.createElement("div");
        sep.className = "gateway-item-sep";
        dropdown.appendChild(sep);
      }
      const item = document.createElement("button");
      item.type = "button";
      item.className = "gateway-item";
      item.dataset.active = String(!!g.active);
      const label = document.createElement("span");
      label.className = "gateway-item-label";
      label.textContent = g.label || g.host;
      const loc = document.createElement("span");
      loc.className = "gateway-item-loc";
      const locHost = g.host === "127.0.0.1" ? "localhost" : g.host;
      loc.textContent = g.port == null ? locHost : `${locHost}:${g.port}`;
      item.append(label, loc);
      if (!g.active) {
        item.onclick = async () => {
          close();
          notifyEvent(`Switching to ${g.label || g.host}…`);
          const r = await window.cttc!.switchGateway(g);
          if (!r.ok) notifyEvent(r.error);
        };
      }
      dropdown.appendChild(item);
    });
    // Passive per-item reachability, checked fresh every time the dropdown
    // opens -- purely informational (including for the active entry, if
    // it's the one that's gone down): never triggers a switch on its own,
    // just flags the item so it's visible before you try it, or notice the
    // gateway you're already on has stopped responding.
    const items = [...dropdown.querySelectorAll(".gateway-item")];
    gateways.forEach((g, i) => {
      window.cttc!.checkGateway(g).then((ok: boolean) => {
        (items[i] as HTMLElement).dataset.reachable = String(ok);
      });
    });
  };

  btn.onclick = async (e: MouseEvent) => {
    e.stopPropagation();
    if (wrap.classList.contains("open")) {
      close();
      return;
    }
    const infoPopup = $("connection-info-popup");
    if (infoPopup) infoPopup.hidden = true; // don't show both at once
    wrap.classList.add("open");
    dropdown.hidden = false;
    // retired entries (soft-deleted, see lib/gateway-registry.js) stay in
    // gateways.json for history/audit but never show as available here.
    render((await window.cttc!.getGateways()).filter((g: { retired?: boolean }) => !g.retired));
    syncPillPeerVisibility("gateway");
  };
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target as Node)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}
