import "../../shared/legacy-globals";
import { $ } from "../../shared/dollar";
import { exposeMutable } from "../../shared/expose-mutable";

// SSH key actually used for each docker host reached via "Set Sources" --
// keyed the same way as source paths (host string, or "local"). Populated
// when a host is (re)connected from the dialog; follow-up /docker/collect
// calls for that same host (startTracking, exportSample) that don't go
// through the dialog reuse it instead of silently dropping back to null.
// Persisted via prefs (not just an in-memory Map): without this, restarting
// the app forgot every remote host's ssh key even though its docker
// collection itself is restored on launch, so "Edit Docker Host" ->
// Refresh silently fell back to no key at all and failed for any host that
// actually needs one.
export class PersistedMap extends Map<string, string> {
  prefKey: string;
  constructor(prefKey: string) {
    super(Object.entries(prefs.get(prefKey, {}) as Record<string, string>));
    this.prefKey = prefKey;
  }
  set(k: string, v: string): this {
    super.set(k, v);
    prefs.set(this.prefKey, Object.fromEntries(this));
    return this;
  }
  delete(k: string): boolean {
    const had = super.delete(k);
    if (had) prefs.set(this.prefKey, Object.fromEntries(this));
    return had;
  }
}
// Lazily constructed (see initDockerHostState, called from mountDockerHost
// once app.js has actually run) rather than eagerly at this const's own
// declaration -- the constructor reads `prefs`, which doesn't exist yet at
// this bundle's own module-load time (its script tag runs before app.js's,
// see shared/legacy-globals.ts). Other files in this module import this
// directly (a live ES module binding, always current) -- but app.js's own
// sidebar "start tracking" flow (~L880/1222) reads it as a bare identifier,
// which resolves through window instead (app.js has no lexical binding for
// it). A plain Object.assign(window, ...) copies the value once, at entry.ts's
// own load time -- before initDockerHostState has run, while this is still
// undefined -- and never observes the later reassignment. exposeMutable
// keeps window.dockerHostKeys pointed at whatever this binding currently is.
export let dockerHostKeys: PersistedMap;
export function initDockerHostState(): void {
  dockerHostKeys = new PersistedMap("dockerHostKeys");
}
exposeMutable("dockerHostKeys", () => dockerHostKeys, (v) => { dockerHostKeys = v; });

// Whether Fetch has successfully listed the host currently typed into
// Docker host -- until it has, every control it would otherwise toggle
// must stay disabled regardless, since nothing meaningful can be set until
// Fetch has shown what's actually on the host.
export let dockerFormFetched = false;
export function setDockerFormFetched(v: boolean): void {
  dockerFormFetched = v;
}

// Whether a Fetch/Refresh attempt has completed at least once for the
// *current* dialog session, success or failure -- unlike dockerFormFetched
// (success only, gates the checklist), this gates Show activity: a failed
// attempt still has an activity log worth seeing (arguably more worth
// seeing than a successful one), so it shouldn't stay locked out just
// because the connection didn't work. Reset on every dialog open (see
// btn-set's create and edit-mode branches), set in listContainers()'s finally.
export let dockerFetchAttempted = false;
export function setDockerFetchAttempted(v: boolean): void {
  dockerFetchAttempted = v;
}

// Whether the dialog is currently in "Edit Docker Host" mode -- listContainers()'s
// finally-block needs this so a Refresh doesn't unlock the host/ssh-key
// fields that Edit mode deliberately locked (see enterDockerHostEditMode
// below): Fetch (create mode) and Refresh (edit mode) share the exact same
// listContainers() function, so the difference has to be tracked here
// rather than duplicated per-caller.
export let dockerDaemonEditMode = false;
export function setDockerDaemonEditMode(v: boolean): void {
  dockerDaemonEditMode = v;
}
// renderer-spec.js reassigns this directly (`dockerDaemonEditMode = true`)
// -- see shared/expose-mutable.ts for why a plain Object.assign snapshot
// isn't enough here.
exposeMutable("dockerDaemonEditMode", () => dockerDaemonEditMode, setDockerDaemonEditMode);

// Transform names (see server/transforms/*.py) ticked by default in the
// transforms checklist -- see listContainers()'s Fetch/Refresh handler.
export const DEFAULT_ON_TRANSFORMS = new Set(["json_message", "parse_level"]);

export interface SelectedTargets {
  containers: Set<string>;
  services: Set<string>;
}

// The durable "which containers/services were actually selected" record
// for whatever host is currently open in the dialog -- read from
// ~/.cttc/[user]@[gateway]-containers.json (see lib/container-selection.js)
// the moment Edit Docker Host opens, and what the checklist's checked
// defaults/missing-detection are driven by from then on (not state.track,
// which is a this-session-only, in-memory legend concern). Reset to empty
// by Connect Docker Host -- a fresh daemon starts with nothing preselected,
// never carrying over a stale file from some earlier, unrelated session.
export let selectedTargets: SelectedTargets = { containers: new Set(), services: new Set() };
export function setSelectedTargets(v: SelectedTargets): void {
  selectedTargets = v;
}

// Thin, individually stubbable wrappers around the IPC calls (see
// preload.js) -- kept as plain reassignable `let` functions, same
// reasoning as openSeriesPopout/openLogPopout/reloadApp in app.js, so the
// E2E spec can stub the actual file I/O without writing to a real
// ~/.cttc/ directory (see shared/expose-mutable.ts).
export let loadSelectedTargets = async (hostKey: string): Promise<SelectedTargets> => {
  try {
    const r = await window.cttc?.getSelectedContainers?.(hostKey);
    return { containers: new Set(r?.containers || []), services: new Set(r?.services || []) };
  } catch (err) {
    console.error("loading selected containers failed:", err);
    return { containers: new Set(), services: new Set() };
  }
};
exposeMutable("loadSelectedTargets", () => loadSelectedTargets, (fn) => { loadSelectedTargets = fn; });

export let saveSelectedTargets = async (hostKey: string, { containers, services }: { containers: string[]; services: string[] }): Promise<void> => {
  try {
    await window.cttc?.setSelectedContainers?.(hostKey, { containers, services });
  } catch (err) {
    console.error("saving selected containers failed:", err);
  }
};
exposeMutable("saveSelectedTargets", () => saveSelectedTargets, (fn) => { saveSelectedTargets = fn; });

// Every daemon ever successfully Set/Updated (see savedDockerDaemons' write
// site in set-dialog.ts), newest-used first -- backs both the "Load Docker
// Host" dropdown and the Remove Docker Host picker.
type DockerHostHistoryEntry = { hostKey: string; lastUsed?: number; [k: string]: unknown };
export function dockerHostHistory(): DockerHostHistoryEntry[] {
  const saved = prefs.get("savedDockerDaemons", {}) as Record<string, Record<string, unknown>>;
  const entries: DockerHostHistoryEntry[] = Object.entries(saved).map(([hostKey, entry]) => ({ hostKey, ...entry }));
  return entries.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
}

// Fills the Connect Docker Host dialog's "Load Docker Host" dropdown --
// hidden entirely (rather than just empty) when there's no history yet, so
// a first-time user isn't shown a picker with nothing useful in it.
export function populateDockerHostHistory(): void {
  const history = dockerHostHistory();
  $("docker-host-history-row").hidden = history.length === 0;
  const select = $("docker-host-history");
  select.innerHTML = '<option value="">— pick a previously used Docker host —</option>';
  for (const entry of history) {
    const opt = document.createElement("option");
    opt.value = entry.hostKey;
    opt.textContent = entry.hostKey === "local" ? "localhost" : entry.hostKey.replace(/^ssh:\/\//, "");
    select.appendChild(opt);
  }
  select.value = "";
}
