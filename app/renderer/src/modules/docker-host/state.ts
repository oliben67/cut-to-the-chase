import "../../shared/legacy-globals";
import { exposeMutable } from "../../shared/expose-mutable";

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

// Every daemon ever successfully Set/Updated, newest-used first -- backs
// both the "Load Docker Host" dropdown and the Remove Docker Host picker.
// Sourced from the active gateway's own dockerHosts[] catalog in
// gateways.json (see main.js's "get-docker-hosts", lib/gateway-registry.js)
// -- the sole authoritative Docker-host list as of this change. Used to be
// backed by a separate, renderer-only localStorage map
// ("savedDockerDaemons"); that and gateways.json's dockerHosts[] were two
// independent, unreconciled stores, and Remove Docker Host only ever wrote
// to the localStorage one -- the actual root of "remove can't find the
// just-disconnected host" (three stores, none of them authoritative).
type DockerHostHistoryEntry = { hostKey: string; lastUsed?: number; [k: string]: unknown };
export async function dockerHostHistory(): Promise<DockerHostHistoryEntry[]> {
  const hosts = ((await window.cttc?.getDockerHosts?.()) || []) as DockerHostHistoryEntry[];
  return [...hosts].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
}
