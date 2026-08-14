import "../../shared/legacy-globals";
import { $ } from "../../shared/dollar";
import { exposeMutable } from "../../shared/expose-mutable";
import { renderTransformList } from "./TransformList";
import { renderDockerTargetList, clearDockerTargetList, type DockerTargetItem } from "./DockerTargetList";
import {
  dockerFormFetched,
  setDockerFormFetched,
  dockerFetchAttempted,
  setDockerFetchAttempted,
  dockerDaemonEditMode,
  setDockerDaemonEditMode,
  DEFAULT_ON_TRANSFORMS,
  selectedTargets,
  setSelectedTargets,
  loadSelectedTargets,
  saveSelectedTargets,
  dockerHostHistory,
} from "./state";
import { populateDockerHostHistory } from "./history-select";

/* ── set-sources dialog (Docker) ────────────────────────────────────────── */

export const dlg = $("dlg-set");

// names of the transform checkboxes ticked in Set Sources, in DOM order --
// sent as-is to /docker/collect, which loads and applies them server-side.
function chosenTransforms(): string[] {
  return [...dlg.querySelectorAll("#transforms-list input:checked")].map((i: HTMLInputElement) => i.value);
}

// Whether Fetch has successfully listed the host currently typed into
// Docker host -- until it has, every control it would otherwise toggle
// must stay disabled regardless, since nothing meaningful can be set until
// Fetch has shown what's actually on the host.
//
// Show activity has nothing to show until a remote target has actually
// been probed (br-DHOST-001/BUG-0067) -- but an empty Docker host is a
// complete, valid target on its own (the gateway's local daemon, nothing
// to type), so it's exempt: only a *non-empty* host with no fetch attempt
// yet counts as "not entered". Deliberately disables rather than hides --
// ui-DHOST-016 ("Show activity always visible") is about the control never
// disappearing, not about it always being clickable.
function syncActivityToggleEnabled(): void {
  const remoteNotYetTested = $("docker-host").value.trim() !== "" && !dockerFetchAttempted;
  $("activity-toggle").disabled = remoteNotYetTested;
  if (remoteNotYetTested) {
    $("activity-toggle").checked = false;
    $("docker-activity").hidden = true;
  }
}
$("docker-host").addEventListener("input", syncActivityToggleEnabled);

// Picking a previously-used Docker host here now does what a separate Edit
// Docker Host button used to, for a *disconnected* one: pre-fills whatever
// containers/services it last had selected, then immediately re-probes it
// live. Host stays editable here (unlike enterDockerHostEditMode below)
// since nothing is actually connected yet -- there's no live identity that
// needs protecting from being changed.
$("docker-host-history").onchange = async () => {
  const hostKey = $("docker-host-history").value;
  if (!hostKey) return;
  const entry = (await dockerHostHistory()).find((e) => e.hostKey === hostKey);
  if (!entry) return;
  $("docker-host").value = hostKey === "local" ? "" : hostKey.replace(/^ssh:\/\//, "");
  // Loading a *different* saved host supersedes whatever the current
  // dialog session already fetched (if anything) -- that answer was for the
  // host just replaced, not this one.
  setDockerFetchAttempted(false);
  setSelectedTargets(await loadSelectedTargets(hostKey));
  const { containers, services } = currentlyTrackedTargets(hostKey);
  renderDockerTargets(containers, services, hostKey);
  syncActivityToggleEnabled();
  await listContainers();
};

// Every control except Docker host / SSH key / Fetch starts empty and
// disabled -- there's nothing to configure until Fetch has actually shown
// what's running on the host currently typed in (see setDockerFormEnabled),
// so nothing here is populated or enabled speculatively. Always opens a
// blank create form, regardless of whatever else is already connected --
// multiple Docker hosts can be tracked at once (dlg-ok only ever closes
// sources for the *same* hostKey being submitted), so this never needs to
// disconnect anything first. No "Load Docker Host" picker here (that's
// specifically Edit Docker Host's job, see enterDockerHostEditMode) --
// picking an existing host to reconnect/reconfigure means Edit, not New.
export function openNewDockerHostDialog(): void {
  setDockerDaemonEditMode(false);
  // A fresh daemon starts with nothing preselected -- never carries over
  // some earlier, unrelated host's persisted selection.
  setSelectedTargets({ containers: new Set(), services: new Set() });
  $("docker-host").value = "";
  $("docker-host").disabled = false;
  $("dlg-set-title").textContent = "New Docker Host";
  $("btn-ps-refresh-label").textContent = "Fetch Sources";
  $("dlg-ok").textContent = "Connect Docker Host";
  clearDockerTargetList($("docker-targets"));
  renderTransformList($("transforms-list"), []);
  $("docker-error").textContent = "";
  setDockerFormEnabled(false);
  renderActivityLog(null);
  setDockerFetchAttempted(false);
  syncActivityToggleEnabled();
  // Still populates the underlying <select>'s options (some callers drive
  // it programmatically, see the Docker Host pill's openHost) -- only the
  // row itself stays hidden, since New Docker Host never shows this picker.
  // Deliberately not awaited: this function stays synchronous (showModal
  // fires immediately, same as before dockerHostHistory() became an IPC
  // round-trip) -- the unconditional hide is chained onto the same promise
  // instead, so it still always lands after populate's own async
  // row-visibility write (based on history.length), just without making
  // every caller wait on an IPC call before the dialog actually opens.
  populateDockerHostHistory().then(() => {
    $("docker-host-history-row").hidden = true;
  });
  dlg.showModal();
}
$("btn-set").onclick = openNewDockerHostDialog;

// No-op with nothing connected (ui-DHOST-025) -- there's nothing to edit
// yet; use New Docker Host instead.
export async function openEditDockerHostDialog(): Promise<void> {
  if (!hasDockerDaemon()) return;
  dlg.showModal();
  await enterDockerHostEditMode(currentDockerHost() || "local");
}
$("btn-edit-docker-host").onclick = openEditDockerHostDialog;

// Reopens the dialog pre-pointed at hostKey -- host is locked (this is
// "reconfigure/refresh what's already set", editing which containers/
// services are followed for an already-identified host, not its connection
// string itself), and Fetch becomes Refresh, since it's re-probing a known
// daemon rather than connecting to a new one. Load Docker Host stays
// visible+enabled here too (unlike before) -- picking a different saved
// host from it re-targets the checklist to that host, but never unlocks
// host: still Edit, just editing a different host's checklist now, not its
// connection string either. Submitting still goes through the same dlg-ok
// handler as the create flow, disabled inputs' .value reads normally.
export async function enterDockerHostEditMode(hostKey: string): Promise<void> {
  setDockerDaemonEditMode(true);
  await populateDockerHostHistory();
  $("docker-host").value = hostKey === "local" ? "" : hostKey.replace(/^ssh:\/\//, "");
  $("docker-host").disabled = true;
  $("dlg-set-title").textContent = "Edit Docker Host";
  $("btn-ps-refresh-label").textContent = "Refresh Sources";
  $("dlg-ok").textContent = "Update Docker Host";
  renderTransformList($("transforms-list"), []);
  $("docker-error").textContent = "";
  // The durable "what was actually selected" record for this daemon --
  // loaded before anything renders, since it (not state.track) is what
  // drives the checklist's checked defaults and "gone but was selected"
  // detection from here on (see renderDockerTargetGroup/renderDockerTargets).
  setSelectedTargets(await loadSelectedTargets(hostKey));
  // Pre-fill the checklist immediately from what's already being followed
  // for this daemon -- editing shouldn't start from a blank form while the
  // Refresh below is still in flight.
  const { containers, services } = currentlyTrackedTargets(hostKey);
  renderDockerTargets(containers, services, hostKey);
  setDockerFormEnabled(true);
  renderActivityLog(null);
  setDockerFetchAttempted(false);
  syncActivityToggleEnabled();
  // Edit Docker Host always opens onto the daemon's *actual* current
  // state, not a snapshot from whenever it was last set -- run the same
  // live probe Refresh does immediately, so a container that's since
  // disappeared is caught (and disabled in the list, see
  // renderDockerTargets' closeMissing) right away rather than only after
  // the user remembers to click Refresh themselves.
  await listContainers();
}

// Toggles every "what to collect" control except Docker host/SSH key/Fetch
// itself -- there's nothing meaningful to set until Fetch has shown what's
// actually on the host, and re-fetching (a different host, or the same one
// after it changed) means the previous answer no longer applies either.
function setDockerFormEnabled(enabled: boolean): void {
  setDockerFormFetched(enabled);
  // "unavailable" checkboxes (renderDockerTargetGroup's `missing`) stay
  // disabled regardless -- they're not something Fetch/Refresh finishing
  // should ever re-enable, since there's nothing left to actually follow.
  for (const cb of $("docker-targets").querySelectorAll("input")) {
    if (!cb.closest("label")?.classList.contains("unavailable")) cb.disabled = !enabled;
  }
  for (const cb of $("transforms-list").querySelectorAll("input")) (cb as HTMLInputElement).disabled = !enabled;
  updateDlgOkEnabled();
}

// Set/Update Docker Host submits exactly what's checked (see dlg-ok's
// onclick) -- with nothing ticked there'd be nothing to collect at all, so
// it stays disabled until at least one container/service is actually
// checked, on top of the Fetch/Refresh-gated enabling above. Re-checked
// on every checkbox change (see renderDockerTargetGroup) and every
// checklist re-render (see renderDockerTargets), not just once on Fetch.
function updateDlgOkEnabled(): void {
  const anyChecked = $("docker-targets").querySelector("input:checked:not(:disabled)") != null;
  $("dlg-ok").disabled = !dockerFormFetched || !anyChecked;
}

// Closes every open source for the currently-connected daemon and drops it
// from the auto-reconnect-on-launch list (lastDockerSessions), so it
// doesn't silently come right back next launch -- but keeps its entry in
// gateways.json's dockerHosts[] catalog, so it still shows up in Load
// Docker Host (Connect Docker Host) and Remove Docker Host. "Disconnect",
// not "forget" -- use Remove Docker Host for that.
$("btn-clear-sources").onclick = async () => {
  if (!state.sources.length) return; // nothing to clear -- no point asking
  if (!confirm(`Close all ${state.sources.length} open source${state.sources.length === 1 ? "" : "s"}? You can reconnect it later via Load Docker Host.`)) return;
  const hostKey = currentDockerHost() || "local";
  try {
    await Promise.all(state.sources.map((s) => post("/close", { id: s.id })));
    const sessions = prefs.get("lastDockerSessions", []) as Array<{ host?: string }>;
    prefs.set("lastDockerSessions", sessions.filter((s) => (s.host || "local") !== hostKey));
    await refreshAll();
  } catch (err: unknown) {
    alert(String((err as Error)?.message || err));
  } finally {
    // #dlg-set is a showModal() dialog -- it's structurally impossible to
    // reach this handler while it's open (the modal blocks the toolbar), so
    // there's nothing to close here. What's real: dockerDaemonEditMode (and
    // the host .disabled flag it drives) is set by whichever branch of
    // btn-set the dialog was *last* opened into (create mode or
    // enterDockerHostEditMode), and only ever reset when *opened*, not when
    // it's closed -- so a Cancel or successful submit out of Edit mode
    // leaves it true. Disconnect is exactly the moment that
    // staleness stops being harmless: the daemon it was tracking is gone,
    // so unconditionally clearing it here -- in a `finally`, not just after
    // a successful `await` -- guarantees the *next* open, whichever button
    // reaches it, never inherits a stale lock, even if closing a source (a
    // remote host is often disconnected precisely because it's flaky) or
    // refreshAll() itself failed (br-DHOST-001/BUG-0067, BUG-0069).
    setDockerDaemonEditMode(false);
    $("docker-host").disabled = false;
  }
};

/* ── docker host activity log (ssh:// connections) ──────────────────────── */

// The Show activity switch is always visible now (not just once there's
// something to show) -- it drives #docker-activity's visibility directly,
// independent of whether entries exist yet, so flipping it on before any
// command has run just shows an empty panel rather than a hidden control
// with nothing to reveal.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderActivityLog(entries: any[] | null): void {
  const pre = $("docker-activity");
  pre.textContent = (entries || [])
    .map((e) => `$ ${e.cmd}\n  → exit ${e.returncode} (${e.ms}ms)${e.stderr ? `\n  ${e.stderr}` : ""}`)
    .join("\n\n");
  pre.hidden = !$("activity-toggle").checked;
}

$("activity-toggle").onchange = () => {
  $("docker-activity").hidden = !$("activity-toggle").checked;
};

// Repopulates #docker-targets from a {name, image?, replicas?}[] pair --
// either a live `docker ps` result (listContainers) or, immediately on
// opening Edit Docker Host (before any Refresh), whatever's already being
// followed for this host (see enterDockerHostEditMode above). Re-renders
// are a diff against selectedTargets (the persisted record, see its own
// comment), not a blind wipe: a Refresh that finds a *selected* container
// gone (stopped/removed) marks it disabled rather than dropping it outright
// (see DockerTargetList's `missing`) -- one that was never selected
// and is now gone is simply omitted, nothing to flag; a genuinely new one
// appears unticked (nothing is preselected just for having been *found*);
// and anything still there keeps exactly whatever the user last
// checked/unchecked it to.
//
// `closeMissing: true` (only from a real live fetch, i.e. listContainers --
// never the initial no-live-data pre-fill, which has nothing to diff
// against yet) also actually closes any now-gone *selected* container/
// service's source, so it stops being tracked/plotted immediately rather
// than waiting on the user to notice and click Update Docker Host: "no
// longer available" should mean gone from the graph too, not just flagged
// in this dialog.
function renderDockerTargets(
  containers: DockerTargetItem[],
  services: DockerTargetItem[],
  hostKey: string,
  { closeMissing = false }: { closeMissing?: boolean } = {},
): void {
  const box = $("docker-targets");
  const wasChecked = new Map<string, boolean>();
  for (const cb of box.querySelectorAll("input[type=checkbox]:not(:disabled)")) {
    wasChecked.set((cb as HTMLInputElement).value, (cb as HTMLInputElement).checked);
  }
  // Only ever used here to find an *id* to close for a gone-but-selected
  // entry (see below) -- whether something is "missing" is now purely a
  // selectedTargets question, not "is a log source open for it".
  const tracked = currentlyTrackedTargets(hostKey);
  const trackedIdByName = new Map([...tracked.containers, ...tracked.services].map((t) => [t.name, t.id]));
  const containerNames = new Set(containers.map((c) => c.name));
  const serviceNames = new Set(services.map((s) => s.name));
  const missingContainers = [...selectedTargets.containers]
    .filter((name) => !containerNames.has(name))
    .map((name) => ({ name, id: trackedIdByName.get(name) }));
  const missingServices = [...selectedTargets.services]
    .filter((name) => !serviceNames.has(name))
    .map((name) => ({ name, id: trackedIdByName.get(name) }));
  // Nothing is preselected just for having been *found* -- only a name in
  // selectedTargets (persisted) starts ticked; a fresh discovery starts
  // unticked, and one already in the checklist keeps whatever the user
  // last left it at (wasChecked, carried over from the live DOM above).
  renderDockerTargetList(box, {
    services: services.map((it) => ({ ...it, checked: wasChecked.has(it.name) ? wasChecked.get(it.name)! : selectedTargets.services.has(it.name) })),
    containers: containers.map((it) => ({ ...it, checked: wasChecked.has(it.name) ? wasChecked.get(it.name)! : selectedTargets.containers.has(it.name) })),
    missingServices,
    missingContainers,
    onChange: updateDlgOkEnabled,
  });
  updateDlgOkEnabled();
  if (closeMissing) {
    // Only ones with an actual open source to close (a selected name with
    // no matching tracked source -- e.g. restored from the file but never
    // actually re-opened this session -- has nothing to close).
    const gone = [...missingContainers, ...missingServices].filter((it) => it.id);
    if (gone.length) {
      const ids = new Set(gone.map((it) => it.id));
      // Closed and removed from state.sources directly (not a full
      // refreshAll() round-trip) -- we already know exactly which ids just
      // got confirmed gone, no need to wait on and reconcile against an
      // entire fresh /sources list just to reflect that. Logged, not
      // thrown, on failure: the checklist already shows it disabled either
      // way, and a close failing here (already gone server-side too, most
      // likely) shouldn't block the rest of the dialog from working.
      Promise.all(gone.map((it) => post("/close", { id: it.id }).catch((err: unknown) => console.error("close (missing container/service) failed:", err))))
        .then(() => {
          state.sources = state.sources.filter((s) => !ids.has(s.id));
          assignColorSlots();
          syncPanels();
          renderLegend();
          drawAll();
        });
    }
  }
}

// The containers/services already being followed for `hostKey`, derived
// from currently-open log sources (no live docker ps needed) -- what
// enterDockerHostEditMode pre-fills the checklist with immediately, before
// Refresh ever runs.
function currentlyTrackedTargets(hostKey: string): { containers: DockerTargetItem[]; services: DockerTargetItem[] } {
  // hostKey itself may be a full "ssh://user@host[:port]" (its own embedded
  // slashes), so a regex expecting a single no-slash host segment would
  // wrongly stop at its first slash -- hostKey is already known exactly
  // here, so match this host's prefix directly instead (same fix as
  // currentDockerHost()'s truncation bug elsewhere in this file).
  const prefix = `docker://${hostKey}/`;
  const containers: DockerTargetItem[] = [], services: DockerTargetItem[] = [];
  for (const s of state.sources) {
    const path = s.path || "";
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest.startsWith("container/")) containers.push({ name: s.name!, id: s.id });
    else if (rest.startsWith("service/")) services.push({ name: s.name!, id: s.id });
  }
  return { containers, services };
}

// renderer-spec.js reassigns this directly to stub it (bypassing real
// /docker/ps calls) -- `export let` + exposeMutable, not a plain function
// declaration, so that reassignment actually takes (see
// shared/expose-mutable.ts).
export let listContainers = async (): Promise<void> => {
  $("docker-error").textContent = "";
  renderActivityLog(null);
  const host = normalizeDockerHost($("docker-host").value);
  // spelled out explicitly (rather than just "Connecting to <host>…") since
  // that phrasing reads as if *this browser page* opens a connection to
  // <host> -- it never does (fetch() can't even speak ssh://): the CTTC
  // server at 127.0.0.1 is the only thing this page ever talks to; it's the
  // server that then runs `docker -H ssh://user@host ...` on <host>'s behalf.
  const label = host
    ? `Asking the CTTC server (127.0.0.1:${PORT}) to reach ${host} over ssh…`
    : `Asking the CTTC server (127.0.0.1:${PORT}) for local containers…`;
  const t0 = Date.now();
  const status = $("docker-status");
  status.textContent = label;
  // ssh connections can take a while (or hang) before the server even
  // responds -- without this, "Refresh" looks identical whether it's about
  // to succeed, still connecting, or has silently wedged.
  const tick = setInterval(() => {
    status.textContent = `${label} (${Math.round((Date.now() - t0) / 1000)}s)`;
  }, 1000);
  // disabled for the whole attempt (not just the button) so the host string
  // can't be edited out from under an in-flight fetch -- re-enabled in both
  // the success and failure paths below, never left stuck disabled. Every
  // other control is disabled for the duration too (see setDockerFormEnabled)
  // and only re-enabled on success, since a stale answer for a *different*
  // host (or the same host before it changed) shouldn't stay selectable.
  $("docker-host").disabled = true;
  $("btn-ps-refresh").disabled = true;
  setDockerFormEnabled(false);
  try {
    const r = await post("/docker/ps", { host });
    clearInterval(tick);
    status.textContent = "";
    renderActivityLog(r.log);

    // Closing anything no longer wanted happens in one of two targeted
    // ways, not by wiping every previously-tracked container/service on
    // any successful fetch (that used to run here, and directly fought
    // renderDockerTargets' own diff -- it would close and refreshAll()
    // *before* the diff ever saw the pre-fetch state, so a still-selected
    // container could never be told apart from one that's actually gone):
    // dlg-ok's own submit-time `toClose` closes whatever's unticked for
    // *this* host once the user actually confirms Set/Update Docker
    // Daemon, and renderDockerTargets' `closeMissing` below closes only
    // what this live fetch just proved is actually gone from the daemon
    // itself.
    renderDockerTargets(r.containers, r.services, host || "local", { closeMissing: true });

    const t = await get("/transforms").catch(() => ({ transforms: [] }));
    const tbox = $("transforms-list");
    // A Refresh rebuilds this list from scratch (the set of installed
    // transforms could have changed) -- carry over whatever the user had
    // already ticked, same as the docker-targets checklist's own
    // wasChecked, so a Refresh never silently discards a deliberate pick.
    const wasChecked = new Map<string, boolean>();
    for (const cb of tbox.querySelectorAll("input[type=checkbox]")) wasChecked.set((cb as HTMLInputElement).value, (cb as HTMLInputElement).checked);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderTransformList(
      tbox,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t.transforms as any[]).map((tr) => ({
        name: tr.name,
        doc: tr.doc,
        // json_message and parse_level are on by default -- turning raw
        // JSON log lines and bare level tagging into something readable
        // is the common case, not an opt-in; anything else (e.g.
        // drop_healthchecks) stays opt-in as before.
        checked: wasChecked.has(tr.name) ? wasChecked.get(tr.name)! : DEFAULT_ON_TRANSFORMS.has(tr.name),
      })),
    );
    setDockerFormEnabled(true);
  } catch (err: unknown) {
    clearInterval(tick);
    status.textContent = "";
    clearDockerTargetList($("docker-targets"));
    renderActivityLog((err as { log?: unknown[] })?.log ?? null);
    // A bare network-level failure (fetch() itself rejected -- server
    // unreachable, tunnel down, connection reset with zero bytes sent) has
    // no err.serverResponded and a browser-generated message that isn't
    // useful on its own. Anything the CTTC server actually responded to
    // (err.serverResponded) means the 127.0.0.1 hop succeeded and it was
    // the server's own ssh/docker call (or an unexpected server-side bug)
    // that failed -- spelled out so it's unambiguous which of the two hops
    // broke. Deliberately NOT keyed on err.log: a plain 500 (an unhandled
    // exception, not a DockerPsError) has no log either, but the server did
    // respond.
    const e = err as { serverResponded?: boolean; message?: string };
    $("docker-error").textContent = e.serverResponded
      ? `The CTTC server reached out to ${host || "the local daemon"} and failed: ${String(e.message || err)}`
      : `Could not reach the CTTC server itself at 127.0.0.1:${PORT} (${String(e.message || err)}) — check the connection/tunnel.`;
  } finally {
    // Edit mode locked host on purpose (see enterDockerHostEditMode) -- a
    // Refresh re-probing the same daemon must leave it locked, not spring
    // back open the moment the request ends.
    if (!dockerDaemonEditMode) {
      $("docker-host").disabled = false;
    }
    $("btn-ps-refresh").disabled = false;
    // Success or failure, the attempt is done and its activity log (if any)
    // is in place above -- Show activity can unlock now regardless of which
    // branch ran (see dockerFetchAttempted/syncActivityToggleEnabled).
    setDockerFetchAttempted(true);
    syncActivityToggleEnabled();
  }
};
exposeMutable("listContainers", () => listContainers, (fn) => { listContainers = fn; });

$("btn-ps-refresh").onclick = () => listContainers();
$("docker-host").addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") {
    e.preventDefault();
    listContainers();
  }
});

// Cancelling out of Edit mode must not leave dockerDaemonEditMode stuck
// true for the *next* time the dialog opens -- btn-set already overwrites it
// unconditionally on open (both its create and edit-mode branches), so this
// is belt-and-braces consistency (see br-DHOST-001/BUG-0067), not the fix
// for a currently reachable bug on its own.
$("dlg-cancel").onclick = () => {
  dlg.close();
  setDockerDaemonEditMode(false);
};

$("dlg-ok").onclick = async () => {
  // Editing the active Docker host (never New -- that's always a
  // different/blank host, see openNewDockerHostDialog) can change/restart
  // its collection -- business rule, 2026-08-07: warn that this abandons
  // a running recording.
  if (dockerDaemonEditMode && !(await confirmAbandonRecordingIfAny("Editing this Docker host"))) return;
  const transforms = chosenTransforms();
  try {
    const host = normalizeDockerHost($("docker-host").value);
    const hostKey = host || "local";
    // Connecting/editing a host is the one funnel point for "this is what
    // the graph/snapshot/exports should show now" -- see
    // isOtherDockerHostHidden in app.js. Multiple hosts can stay collected
    // concurrently in the background; only the active one is displayed.
    state.activeDockerHost = hostKey;
    prefs.set("activeDockerHost", hostKey);
    // :not(:disabled) excludes the "no longer available" entries
    // (renderDockerTargetGroup's `missing`) -- checked=true there only to
    // show "this was selected", never meant to actually be (re-)submitted
    // for a container that doesn't exist anymore.
    const logs = [...$("docker-targets").querySelectorAll("input:checked:not(:disabled)")].map((cb: HTMLInputElement) => ({
      name: cb.value,
      type: cb.dataset.type,
    }));
    // "Set" syncs exactly to this checklist: any container/service log
    // already being followed for this host that isn't checked now gets
    // closed, not just left running alongside whatever's newly picked.
    const keep = new Set(logs.map((l) => `docker://${hostKey}/${l.type}/${l.name}`));
    // hostKey itself may be a full "ssh://user@host[:port]" (its own
    // slashes), so a capture-group regex here would wrongly stop at the
    // first slash inside it -- hostKey is already known exactly, so just
    // match this host's prefix directly instead of re-extracting it.
    const hostPrefix = `docker://${hostKey}/`;
    const toClose = state.sources.filter((s) => {
      const p = s.path || "";
      return (
        p.startsWith(hostPrefix) &&
        /^(container|service)\//.test(p.slice(hostPrefix.length)) &&
        !keep.has(p)
      );
    });
    for (const s of toClose) await post("/close", { id: s.id });

    // Telemetry (per-container docker stats and host CPU/MEM/NET) is
    // always collected once a daemon is set -- no dedicated section/toggle
    // for it in this dialog anymore, just the toolbar/Settings' own
    // Frequency field (dockerPollIntervalSecs).
    const collectReq = {
      host, stats: true, logs, transforms,
      host_stats: true,
      interval: dockerPollIntervalSecs,
    };
    await post("/docker/collect", collectReq);
    // remember this collection request so it can be restored on next launch
    const sessions = prefs.get("lastDockerSessions", []) as unknown[];
    sessions.push(collectReq);
    prefs.set("lastDockerSessions", sessions);
    // Durable catalog of every daemon ever configured -- unlike
    // lastDockerSessions (an unde-duped auto-reconnect-on-launch list that
    // Disconnect Docker Host removes entries from), this is keyed by host
    // and never touched by Disconnect, only by Remove Docker Host -- see
    // dockerHostHistory()/populateDockerHostHistory() (Load Docker Host) and
    // the retire-docker-host IPC call in remove-dialog.ts. Recorded against
    // the active gateway's own catalog in gateways.json (see
    // recordDockerHostForGateway) -- the sole store for this now (the
    // former renderer-only "savedDockerDaemons" localStorage map is gone,
    // see docker-host/state.ts); best-effort since there's nothing useful
    // to do here if it fails (the connection above already succeeded, so
    // this is purely bookkeeping).
    try {
      await window.cttc?.recordDockerHost?.({ hostKey, host, transforms });
    } catch (err) {
      console.error("could not record Docker host against the active gateway:", err);
    }
    // Every entry actually present in the checklist (checked or not, minus
    // the disabled/gone ones) gets its legend track state set explicitly to
    // match -- not just the checked ones. Only ever promoting to "sel" and
    // never demoting back to "mut" left a just-unchecked container stuck
    // showing as selected (still plotted/still in the legend's selected
    // group) even though it was no longer in `logs` at all.
    for (const cb of $("docker-targets").querySelectorAll("input[type=checkbox]:not(:disabled)")) {
      setTrack((cb as HTMLInputElement).value, (cb as HTMLInputElement).checked ? "sel" : "mut");
    }
    // ...and, separately, the durable per-daemon record consulted the next
    // time Set/Edit Docker Host opens for this host (see selectedTargets
    // / loadSelectedTargets) -- "on the way out" per the spec, on every
    // successful Set/Update, regardless of edit vs. create mode.
    setSelectedTargets({
      containers: new Set(logs.filter((l) => l.type === "container").map((l) => l.name)),
      services: new Set(logs.filter((l) => l.type === "service").map((l) => l.name)),
    });
    await saveSelectedTargets(hostKey, {
      containers: [...selectedTargets.containers],
      services: [...selectedTargets.services],
    });
    dlg.close();
    // Legend/graph must reflect the just-saved selection immediately, not
    // just after the next SSE-driven refresh -- refreshAll() re-derives
    // both from state.track (see trackStateOf/allSvcSeries) and the fresh
    // /sources list, which is also the moment a brand-new container's
    // panel/telemetry actually appears.
    refreshAll();
  } catch (err: unknown) {
    alert(String((err as Error)?.message || err));
  }
};
