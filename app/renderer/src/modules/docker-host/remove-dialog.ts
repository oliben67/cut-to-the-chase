import "../../shared/legacy-globals";
import { $ } from "../../shared/dollar";
import { dockerHostHistory, setDockerDaemonEditMode } from "./state";
import { dockerHostLabel } from "./host-label";
import { renderSelectOptions } from "../../shared/components/SelectOptions";

/* ── Remove Docker Host: permanently forget a saved daemon ─────────────
   Distinct from Disconnect (set-dialog.ts's btn-clear-sources), which only
   stops it from auto-reconnecting -- this retires it from the active
   gateway's own catalog in gateways.json (see retireDockerHost/the
   retire-docker-host IPC call below) and its
   ~/.cttc/[user]@[gateway]-containers.json selection file on disk, per
   host, picked from a dropdown of every daemon ever saved. */

export const dlgRemoveDaemon = $("dlg-remove-daemon");

export async function populateRemoveDaemonSelect(): Promise<void> {
  const history = await dockerHostHistory();
  const select = $("remove-daemon-select");
  renderSelectOptions(select, {
    placeholder: "— pick a Docker host to remove —",
    options: history.map((entry) => ({ value: entry.hostKey, label: dockerHostLabel(entry.hostKey) })),
  });
  select.value = "";
  $("dlg-remove-daemon-delete").disabled = true;
  $("remove-daemon-status").textContent = "";
}
$("btn-remove-docker-daemon").onclick = async () => {
  await populateRemoveDaemonSelect();
  dlgRemoveDaemon.showModal();
};
$("remove-daemon-select").onchange = () => {
  $("dlg-remove-daemon-delete").disabled = !$("remove-daemon-select").value;
};
$("dlg-remove-daemon-close").onclick = () => dlgRemoveDaemon.close();
$("dlg-remove-daemon-delete").onclick = async () => {
  const hostKey = $("remove-daemon-select").value;
  if (!hostKey) return;
  // Business rule, 2026-08-07: removing the *active* Docker host abandons
  // a running recording -- warn before the normal "are you sure" below.
  // An inactive saved daemon can be safely forgotten without disturbing
  // whatever's actually being recorded from right now.
  const activeHostKey = currentDockerHost() || "local";
  if (activeHostKey === hostKey && !(await confirmAbandonRecordingIfAny("Removing this Docker host"))) return;
  if (!confirm(`Permanently forget the saved daemon "${hostKey === "local" ? "localhost" : hostKey}"? This can't be undone.`)) return;
  try {
    // If it's currently connected, close *its own* sources first -- leaving
    // them running while its saved record vanishes would be a dangling,
    // un-editable, un-reconnectable daemon. Scoped to this hostKey's own
    // `docker://${hostKey}/...` sources only (same prefix match as
    // set-dialog.ts's currentlyTrackedTargets) -- BUG-0092: this used to
    // close every open source regardless of host, silently taking down
    // unrelated file-based sources or a *different* docker host's sources
    // too, just because *some* docker host happened to be active.
    if (activeHostKey === hostKey && state.sources.length) {
      const prefix = `docker://${hostKey}/`;
      const toClose = state.sources.filter((s) => (s.path || "").startsWith(prefix));
      if (toClose.length) {
        await Promise.all(toClose.map((s) => post("/close", { id: s.id })));
        await refreshAll();
      }
    }
    // br-REDIS-017: forgets the server-side Redis registry entry too, not
    // just this client's own local catalog above -- without this, a remote
    // daemon removed here (even one not currently connected) was silently
    // re-collected forever on the gateway's own next restart (see
    // redis_log.RedisLog.known_daemons()'s replay). "local" is never
    // remembered server-side in the first place (see collect_docker), so
    // there's nothing to forget for it.
    if (hostKey !== "local") {
      try {
        await post("/docker/forget", { host: hostKey });
      } catch (err) {
        console.error("could not forget daemon on the server:", hostKey, err);
      }
    }
    // Retires it in gateways.json -- the sole authoritative Docker-host
    // catalog now (see docker-host/state.ts's dockerHostHistory()) --
    // rather than the former direct localStorage mutation here, which
    // never touched gateways.json at all.
    await window.cttc?.retireDockerHost?.(hostKey);
    const sessions = prefs.get("lastDockerSessions", []) as Array<{ host?: string }>;
    prefs.set("lastDockerSessions", sessions.filter((s) => (s.host || "local") !== hostKey));
    try {
      await window.cttc?.deleteSelectedContainers?.(hostKey);
    } catch (err) {
      console.error("could not delete saved container selection for", hostKey, err);
    }
    syncDockerDaemonButtons();
    dlgRemoveDaemon.close();
  } finally {
    // Removing the *active* host is functionally a disconnect (closes its
    // sources above) -- set-dialog.ts's own Disconnect button already
    // learned (BUG-0067/BUG-0069, see its btn-clear-sources handler) that
    // dockerDaemonEditMode/the host's .disabled flag must be unconditionally
    // cleared here, in a `finally`, not just on success -- otherwise a stale
    // Edit-mode lock (left behind by a Cancel, which only resets the flag,
    // not the DOM) survives this remove and strands the Set Docker Host
    // dialog's field disabled with nothing left to unlock it, until the app
    // is restarted. This path never had that same fix.
    setDockerDaemonEditMode(false);
    $("docker-host").disabled = false;
  }
};
