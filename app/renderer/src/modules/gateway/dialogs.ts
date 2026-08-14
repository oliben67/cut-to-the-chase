import "../../shared/legacy-globals";
import { $ } from "../../shared/dollar";
import type { Gateway } from "./gateway.types";
import { gatewayOptionValue, gatewayOptionLabel } from "./gateway.options";
import { renderSelectOptions } from "../../shared/components/SelectOptions";

// Computed locally, not read off app.js's POPOUT_KIND -- this module's top-
// level DOM wiring runs at this bundle's own load time, before app.js has
// executed (its script tag comes first), so POPOUT_KIND doesn't exist yet
// (see shared/legacy-globals.ts). Trivially re-derivable from the URL, same
// as app.js's own POPOUT_KIND itself.
function isPopout(): boolean {
  return new URLSearchParams(location.search).get("popout") != null;
}

/* ── New Gateway / Edit Gateways ──────────────────────────────────────────
   One dialog, two modes -- ported from the old gateway-setup.html/js (a
   separate window loaded with ?mode=new or ?mode=edit): now that both live
   in this same window as an ordinary <dialog> (like Settings), the mode is
   just a JS variable set when opening rather than a URL/page reload, and
   "close" is dlgGatewaySetup.close() rather than window.close(). The
   first-run/no-local-docker wizard is unaffected -- it still runs in its
   own separate window (there's no main window yet at that point to host a
   dialog in) and still uses the original gateway-setup.html/js. */
export const dlgGatewaySetup = $("dlg-gateway-setup");
let gwMode: "new" | "edit" = "new";
let gwGateways: Gateway[] = [];

function gwSelectedGateway(): Gateway | undefined {
  return gwGateways.find((g) => gatewayOptionValue(g) === $("gw-select").value);
}

// Reads the currently-checked radio directly rather than each radio's own
// onchange toggling the others' disabled state relative to itself -- with a
// third ("keep") mode added, that pairwise approach no longer has anywhere
// to put "neither field applies" (see gwFillFormForEdit's own use of this).
function gwSyncKeyModeFields(): void {
  const checked = (document.querySelector('input[name="gw-key-mode"]:checked') as HTMLInputElement | null)?.value;
  $("gw-key-path").disabled = checked !== "path";
  $("gw-btn-browse").disabled = checked !== "path";
  $("gw-key-paste").disabled = checked !== "paste";
}
for (const radio of document.querySelectorAll('input[name="gw-key-mode"]')) {
  (radio as HTMLInputElement).onchange = gwSyncKeyModeFields;
}
for (const radio of document.querySelectorAll('input[name="gw-image-source"]')) {
  (radio as HTMLInputElement).onchange = () => {
    $("gw-image-ref-row").hidden = (radio as HTMLInputElement).value !== "registry" || !(radio as HTMLInputElement).checked;
    $("gw-image-tarball-row").hidden = (radio as HTMLInputElement).value !== "tarball" || !(radio as HTMLInputElement).checked;
  };
}
$("gw-btn-browse").onclick = async () => {
  const paths = await window.cttc!.pickFiles("Choose your SSH private key");
  if (paths.length) $("gw-key-path").value = paths[0];
};
$("gw-image-tarball-browse").onclick = async () => {
  const paths = await window.cttc!.pickFiles("Choose the server image .tar.gz");
  if (paths.length) $("gw-image-tarball-path").value = paths[0];
};
$("gw-btn-cancel").onclick = () => dlgGatewaySetup.close();
$("gw-btn-activity-toggle").onclick = () => {
  $("gw-activity-log").hidden = !$("gw-activity-log").hidden;
  $("gw-btn-activity-toggle").textContent = $("gw-activity-log").hidden ? "Show activity" : "Hide activity";
};
if (!isPopout()) {
  window.cttc?.onSetupLog?.((line: string) => {
    $("gw-activity").hidden = false;
    $("gw-activity-log").textContent += ($("gw-activity-log").textContent ? "\n" : "") + line;
    $("gw-activity-log").scrollTop = $("gw-activity-log").scrollHeight;
  });
}

// Edit mode only. Every field this touches (ssh/key + image + Connect) is
// disabled until something is actually picked from the dropdown -- rather
// than hiding the form outright, so it's obvious at a glance that there's
// more here once a gateway is chosen. "This machine" (embedded) is
// filtered out of the dropdown entirely by gwLoadGatewaysForEdit -- every
// entry reachable here is a real, editable remote or local-docker gateway,
// so isRemote below is effectively always true, but the check is left in
// place as a defensive fallback rather than assumed.
function gwFillFormForEdit(g: Gateway | undefined): void {
  $("gw-error").hidden = true;
  const sshFields = [
    $("gw-ssh-user"), $("gw-ssh-host"), $("gw-ssh-port"), $("gw-key-path"), $("gw-btn-browse"), $("gw-key-paste"),
    ...document.querySelectorAll('input[name="gw-key-mode"]'),
  ];
  const imageFields = [
    ...document.querySelectorAll('input[name="gw-image-source"]'),
    $("gw-image-ref"), $("gw-image-tarball-browse"), $("gw-image-tarball-path"),
  ];

  if (!g) {
    for (const el of [...sshFields, ...imageFields]) (el as HTMLInputElement).disabled = true;
    $("gw-btn-connect").disabled = true;
    $("gw-ssh-user").value = "";
    $("gw-ssh-host").value = "";
    $("gw-key-path").value = "";
    $("gw-key-mode-keep-row").hidden = true;
    return;
  }

  $("gw-btn-connect").disabled = false;
  for (const el of imageFields) (el as HTMLInputElement).disabled = false;
  const isRemote = g.mode !== "embedded";
  for (const el of sshFields) (el as HTMLInputElement).disabled = !isRemote;
  $("gw-btn-connect").textContent = isRemote ? "Save changes" : "Update image";
  if (isRemote) {
    const at = (g.sshTarget || "").lastIndexOf("@");
    $("gw-ssh-user").value = at === -1 ? "" : g.sshTarget!.slice(0, at);
    $("gw-ssh-host").value = at === -1 ? g.sshTarget : g.sshTarget!.slice(at + 1);
    $("gw-ssh-port").value = g.sshPort || 22;
    // "Keep the current key" only shows (and only makes sense) when there's
    // an existing vault-managed key to keep -- a literal g.sshKey (the
    // scripted/env-var deploy case) still prefills the path field exactly
    // as before, since there's a real path here to show and re-submit
    // unchanged without the user re-entering anything.
    $("gw-key-mode-keep-row").hidden = !g.hasSshKey;
    if (g.hasSshKey) {
      (document.querySelector('input[name="gw-key-mode"][value="keep"]') as HTMLInputElement).checked = true;
      $("gw-key-path").value = "";
    } else {
      (document.querySelector('input[name="gw-key-mode"][value="path"]') as HTMLInputElement).checked = true;
      $("gw-key-path").value = g.sshKey || "";
    }
    gwSyncKeyModeFields();
  } else {
    $("gw-ssh-user").value = "";
    $("gw-ssh-host").value = "";
    $("gw-key-path").value = "";
    $("gw-key-mode-keep-row").hidden = true;
  }
}

// "This machine" (the embedded/local gateway, always present -- see main.js's
// recordGateway({mode: "embedded", label: "This machine", ...})) has no
// connection settings to edit and must never be uninstalled: it isn't a
// gateway *entry* the user added, it's just always there. Filtered out here
// (a plain, stubbable function -- see the E2E spec), not from
// window.cttc.getGateways() itself, since the toolbar's gateway-switcher
// dropdown still needs to offer switching *to* it.
export function editableGateways(gateways: Gateway[]): Gateway[] {
  // retired entries (soft-deleted, see lib/gateway-registry.js) stay in
  // gateways.json for history/audit but are never selectable here.
  return gateways.filter((g) => g.mode !== "embedded" && !g.retired);
}

async function gwLoadGatewaysForEdit(): Promise<void> {
  gwGateways = editableGateways(await window.cttc!.getGateways());
  const prevKey = $("gw-select").value;
  renderSelectOptions($("gw-select"), {
    placeholder: "— Select a gateway —",
    options: gwGateways.map((g) => ({ value: gatewayOptionValue(g), label: gatewayOptionLabel(g) })),
  });
  $("gw-select").value = gwGateways.some((g) => gatewayOptionValue(g) === prevKey) ? prevKey : "";
  gwFillFormForEdit(gwSelectedGateway());
}
$("gw-select").onchange = () => gwFillFormForEdit(gwSelectedGateway());

/* ── Uninstall Gateway: its own dialog (sidebar → Gateway → Uninstall
   Gateway…), split out from Edit Gateway's old inline Uninstall button so
   picking a gateway to uninstall isn't tangled up with editing one's ssh/
   image settings. Reuses the exact same editableGateways()-filtered
   dropdown listing and window.cttc.uninstallGateway(g) call/result
   handling Edit Gateway's button used to. */
export const dlgGatewayUninstall = $("dlg-gateway-uninstall");
let gwUninstallGateways: Gateway[] = [];

function gwUninstallSelectedGateway(): Gateway | undefined {
  return gwUninstallGateways.find((g) => gatewayOptionValue(g) === $("gw-uninstall-select").value);
}

async function gwLoadGatewaysForUninstall(): Promise<void> {
  gwUninstallGateways = editableGateways(await window.cttc!.getGateways());
  const select = $("gw-uninstall-select");
  const prevKey = select.value;
  renderSelectOptions(select, {
    placeholder: "— pick a gateway to uninstall —",
    options: gwUninstallGateways.map((g) => ({ value: gatewayOptionValue(g), label: gatewayOptionLabel(g) })),
  });
  select.value = gwUninstallGateways.some((g) => gatewayOptionValue(g) === prevKey) ? prevKey : "";
  $("gw-uninstall-delete").disabled = !select.value;
  $("gw-uninstall-error").hidden = true;
  $("gw-uninstall-status").textContent = "";
}
$("gw-uninstall-select").onchange = () => {
  $("gw-uninstall-delete").disabled = !$("gw-uninstall-select").value;
};
$("gw-uninstall-close").onclick = () => dlgGatewayUninstall.close();
$("gw-uninstall-delete").onclick = async () => {
  const g = gwUninstallSelectedGateway();
  if (!g) return;
  // Business rule, 2026-08-07: uninstalling the *active* gateway abandons
  // a running recording -- warn before the normal "are you sure" below.
  if (g.active && !(await confirmAbandonRecordingIfAny("Uninstalling this gateway"))) return;
  if (!confirm(`Uninstall ${g.label || g.host}? This stops and removes its container.`)) return;
  $("gw-uninstall-error").hidden = true;
  $("gw-uninstall-select").disabled = true;
  $("gw-uninstall-delete").disabled = true;
  $("gw-uninstall-status").textContent = "Uninstalling, please wait…";
  const result = await window.cttc!.uninstallGateway(g);
  $("gw-uninstall-select").disabled = false;
  $("gw-uninstall-status").textContent = "";
  if (!result.ok) {
    $("gw-uninstall-error").textContent = result.error;
    $("gw-uninstall-error").hidden = false;
    $("gw-uninstall-delete").disabled = false;
    return;
  }
  await gwLoadGatewaysForUninstall();
};
export async function openUninstallGatewayDialog(): Promise<void> {
  await gwLoadGatewaysForUninstall();
  dlgGatewayUninstall.showModal();
}

function gwReadImageSource(): { type: string; ref?: string; path?: string } | null {
  const mode = (document.querySelector('input[name="gw-image-source"]:checked') as HTMLInputElement).value;
  if (mode === "registry") return { type: "registry", ref: $("gw-image-ref").value.trim() };
  if (mode === "tarball") return { type: "tarball", path: $("gw-image-tarball-path").value };
  return null; // "default" -- let the server side resolve its usual fallback
}

$("gw-form").onsubmit = async (e: SubmitEvent) => {
  e.preventDefault();
  const gw = gwMode === "edit" ? gwSelectedGateway() : null;
  if (gwMode === "edit" && !gw) return; // nothing picked yet -- button is disabled anyway
  // Editing the *active* gateway can change/restart its connection --
  // business rule, 2026-08-07: warn that this abandons a running recording.
  // A New Gateway (gwMode === "new") never touches the active one, and
  // editing an inactive saved gateway doesn't disturb the current
  // connection either, so neither needs this check.
  if (gwMode === "edit" && gw!.active && !(await confirmAbandonRecordingIfAny("Editing this gateway"))) return;
  const isEmbeddedEdit = gwMode === "edit" && gw!.mode === "embedded";

  $("gw-error").hidden = true;
  $("gw-activity-log").textContent = "";

  const keyMode = (document.querySelector('input[name="gw-key-mode"]:checked') as HTMLInputElement).value;
  const imageSource = gwReadImageSource();
  const payload = {
    sshUser: $("gw-ssh-user").value.trim(),
    sshHost: $("gw-ssh-host").value.trim(),
    sshPort: Number($("gw-ssh-port").value),
    keyMode,
    keyPath: keyMode === "path" ? $("gw-key-path").value : null,
    keyContents: keyMode === "paste" ? $("gw-key-paste").value : null,
    imageSource,
  };
  if (!isEmbeddedEdit && keyMode === "path" && !payload.keyPath) {
    $("gw-error").textContent = "Choose a private key file, or switch to pasting its contents.";
    $("gw-error").hidden = false;
    return;
  }
  if (!isEmbeddedEdit && keyMode === "paste" && !payload.keyContents.trim()) {
    $("gw-error").textContent = "Paste the private key's contents, or switch to a file.";
    $("gw-error").hidden = false;
    return;
  }
  if (imageSource?.type === "tarball" && !imageSource.path) {
    $("gw-error").textContent = "Choose a .tar.gz file, or switch to a registry reference / the bundled image.";
    $("gw-error").hidden = false;
    return;
  }
  if (imageSource?.type === "registry" && !imageSource.ref) {
    $("gw-error").textContent = "Enter an image reference (repo:tag), or switch to the bundled image.";
    $("gw-error").hidden = false;
    return;
  }

  $("gw-form").hidden = true;
  $("gw-wait").hidden = false;
  $("gw-btn-connect").disabled = true;

  const result =
    gwMode === "edit"
      ? await window.cttc!.saveGatewayEdit({ ...payload, key: gatewayOptionValue(gw!), mode: gw!.mode })
      : await window.cttc!.addGateway(payload);

  if (!result.ok) {
    $("gw-form").hidden = false;
    $("gw-wait").hidden = true;
    $("gw-btn-connect").disabled = false;
    $("gw-error").textContent = result.error;
    $("gw-error").hidden = false;
    return;
  }
  if (gwMode === "edit") {
    // stays open (unlike New Gateway, saving here doesn't necessarily need
    // to close anything) -- refresh so the dropdown/prefill reflect what
    // was just saved
    $("gw-form").hidden = false;
    $("gw-wait").hidden = true;
    await gwLoadGatewaysForEdit();
  } else {
    // gateway-add-submit already offered a restart on the main-process
    // side (see main.js) -- nothing left to do here but close
    dlgGatewaySetup.close();
  }
};

export function openNewGatewayDialog(): void {
  gwMode = "new";
  $("gw-title").textContent = "New Gateway";
  $("gw-intro").hidden = false;
  $("gw-select-row").hidden = true;
  $("gw-btn-connect").textContent = "Connect";
  $("gw-btn-connect").disabled = false;
  $("gw-wait-msg").textContent = "Connecting, please wait…";
  $("gw-form").hidden = false;
  $("gw-wait").hidden = true;
  $("gw-error").hidden = true;
  $("gw-activity").hidden = true;
  $("gw-activity-log").textContent = "";
  $("gw-form").reset();
  // "Keep the current key" never applies here -- a brand-new gateway has no
  // existing key to keep (gwFillFormForEdit is what shows/hides this row
  // for an actual edit, and only leftover state from a previous edit-mode
  // session could otherwise leave it visible/checked here).
  $("gw-key-mode-keep-row").hidden = true;
  gwSyncKeyModeFields();
  dlgGatewaySetup.showModal();
}

export async function openEditGatewaysDialog(): Promise<void> {
  gwMode = "edit";
  $("gw-title").textContent = "Edit Gateways";
  $("gw-intro").hidden = true;
  $("gw-select-row").hidden = false;
  $("gw-wait-msg").textContent = "Applying changes, please wait…";
  $("gw-form").hidden = false;
  $("gw-wait").hidden = true;
  $("gw-error").hidden = true;
  $("gw-activity").hidden = true;
  $("gw-activity-log").textContent = "";
  await gwLoadGatewaysForEdit();
  dlgGatewaySetup.showModal();
}
