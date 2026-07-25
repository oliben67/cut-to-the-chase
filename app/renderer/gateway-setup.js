"use strict";

// One screen, two modes -- main.js loads this with ?mode=new (File > Gateways
// > New Gateway, and the first-launch/no-local-docker fallback) or
// ?mode=edit (File > Gateways > Edit Gateways). Which mode decides what's
// shown (the create intro vs. the gateway dropdown) and what the primary
// button does (Connect a new one vs. Save changes to an existing one) --
// everything else (ssh fields, key mode, image source) is shared.
const MODE = new URLSearchParams(location.search).get("mode") === "edit" ? "edit" : "new";

const newIntroEl = document.getElementById("new-intro");
const gatewaySelectRowEl = document.getElementById("gateway-select-row");
const selectEl = document.getElementById("gateway-select");
const form = document.getElementById("form");
const sshUserEl = document.getElementById("ssh-user");
const sshHostEl = document.getElementById("ssh-host");
const sshPortEl = document.getElementById("ssh-port");
const keyPathEl = document.getElementById("key-path");
const keyPasteEl = document.getElementById("key-paste");
const btnBrowseEl = document.getElementById("btn-browse");
const imageRadios = [...document.querySelectorAll('input[name="image-source"]')];
const imageRefRow = document.getElementById("image-ref-row");
const imageTarballRow = document.getElementById("image-tarball-row");
const imageRefEl = document.getElementById("image-ref");
const imageTarballBrowseEl = document.getElementById("image-tarball-browse");
const imageTarballPathEl = document.getElementById("image-tarball-path");
const errorEl = document.getElementById("error");
const waitEl = document.getElementById("wait");
const waitMsgEl = document.getElementById("wait-msg");
const btnSkip = document.getElementById("btn-skip");
const btnUninstall = document.getElementById("btn-uninstall");
const btnConnect = document.getElementById("btn-connect");
const activityEl = document.getElementById("activity");
const activityLogEl = document.getElementById("activity-log");
const btnActivityToggle = document.getElementById("btn-activity-toggle");

let gateways = [];

function keyOf(g) {
  return `${g.host}:${g.port}`;
}
function selectedGateway() {
  return gateways.find((g) => keyOf(g) === selectEl.value);
}

if (MODE === "edit") {
  newIntroEl.hidden = true;
  gatewaySelectRowEl.hidden = false;
  btnSkip.hidden = true;
  btnUninstall.hidden = false;
  btnConnect.textContent = "Save changes"; // overwritten per-gateway once one's picked (fillFormForEdit)
  waitMsgEl.textContent = "Applying changes, please wait…";
}

// Both control groups stay visible at all times -- only one is ever enabled,
// so it's clear at a glance which input the connect/save step will actually
// use instead of one silently disappearing on radio change.
for (const radio of document.querySelectorAll('input[name="key-mode"]')) {
  radio.addEventListener("change", () => {
    const paste = radio.value === "paste" && radio.checked;
    keyPathEl.disabled = paste;
    btnBrowseEl.disabled = paste;
    keyPasteEl.disabled = !paste;
  });
}

for (const radio of imageRadios) {
  radio.addEventListener("change", () => {
    imageRefRow.hidden = radio.value !== "registry" || !radio.checked;
    imageTarballRow.hidden = radio.value !== "tarball" || !radio.checked;
  });
}

document.getElementById("btn-browse").addEventListener("click", async () => {
  const paths = await window.cttc.pickFiles("Choose your SSH private key");
  if (paths.length) keyPathEl.value = paths[0];
});

imageTarballBrowseEl.addEventListener("click", async () => {
  const paths = await window.cttc.pickFiles("Choose the server image .tar.gz");
  if (paths.length) imageTarballPathEl.value = paths[0];
});

// Closing this window (however it happens) is what main.js's
// runSetupWizard() already treats as "cancelled" -- on first launch that
// falls back to using this machine directly; when reconfiguring from the
// File menu it just leaves the existing connection untouched. window.close()
// triggers that same path, so this button needs no separate IPC of its own.
btnSkip.addEventListener("click", () => window.close());

btnActivityToggle.addEventListener("click", () => {
  activityLogEl.hidden = !activityLogEl.hidden;
  btnActivityToggle.textContent = activityLogEl.hidden ? "Show activity" : "Hide activity";
});
window.cttc.onSetupLog((line) => {
  activityEl.hidden = false;
  activityLogEl.textContent += (activityLogEl.textContent ? "\n" : "") + line;
  activityLogEl.scrollTop = activityLogEl.scrollHeight;
});

// Edit mode only. Every field this touches (ssh/key + image + Save/
// Uninstall) is disabled until something is actually picked from the
// dropdown -- rather than hiding the form outright, so it's obvious at a
// glance that there's more here once a gateway is chosen, not that the
// screen is broken/empty. "This machine" (embedded) has no ssh settings to
// edit -- those fields stay disabled, but Save/Update (still enabled)
// re-provisions the local container with the chosen image instead. Image
// settings always start back at "default" -- there's no stored "last image
// used" per gateway, and defaulting there is the safest no-op either way.
function fillFormForEdit(g) {
  errorEl.hidden = true;
  const sshFields = [sshUserEl, sshHostEl, sshPortEl, keyPathEl, btnBrowseEl, keyPasteEl,
    ...document.querySelectorAll('input[name="key-mode"]')];
  const imageFields = [...imageRadios, imageRefEl, imageTarballBrowseEl, imageTarballPathEl];

  if (!g) {
    for (const el of [...sshFields, ...imageFields]) el.disabled = true;
    btnConnect.disabled = true;
    btnUninstall.disabled = true;
    sshUserEl.value = "";
    sshHostEl.value = "";
    keyPathEl.value = "";
    return;
  }

  btnConnect.disabled = false;
  btnUninstall.disabled = false;
  for (const el of imageFields) el.disabled = false;
  const isRemote = g.mode !== "embedded";
  for (const el of sshFields) el.disabled = !isRemote;
  btnConnect.textContent = isRemote ? "Save changes" : "Update image";
  if (isRemote) {
    const at = g.sshTarget.lastIndexOf("@");
    sshUserEl.value = at === -1 ? "" : g.sshTarget.slice(0, at);
    sshHostEl.value = at === -1 ? g.sshTarget : g.sshTarget.slice(at + 1);
    sshPortEl.value = g.sshPort || 22;
    // sshKey is always a resolved file path by this point (writeKeyFile()
    // already turned a pasted key into one) -- "path" mode with it prefilled
    // is the right default; the user can still switch to paste a new one.
    document.querySelector('input[name="key-mode"][value="path"]').checked = true;
    keyPasteEl.disabled = true;
    keyPathEl.value = g.sshKey || "";
  } else {
    sshUserEl.value = "";
    sshHostEl.value = "";
    keyPathEl.value = "";
  }
}

async function loadGatewaysForEdit() {
  gateways = await window.cttc.getGateways();
  const prevKey = selectEl.value;
  selectEl.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "— Select a gateway —";
  selectEl.appendChild(placeholder);
  for (const g of gateways) {
    const opt = document.createElement("option");
    opt.value = keyOf(g);
    const loc = g.port == null ? g.host : `${g.host}:${g.port}`;
    opt.textContent = `${g.label || g.host} (${loc})${g.active ? " — active" : ""}`;
    selectEl.appendChild(opt);
  }
  // keeps the same gateway selected across a reload (e.g. right after
  // Save/Uninstall) instead of dropping back to "nothing picked"
  selectEl.value = gateways.some((g) => keyOf(g) === prevKey) ? prevKey : "";
  fillFormForEdit(selectedGateway());
}

if (MODE === "edit") {
  selectEl.addEventListener("change", () => fillFormForEdit(selectedGateway()));

  btnUninstall.addEventListener("click", async () => {
    const g = selectedGateway();
    if (!g) return;
    if (!confirm(`Uninstall ${g.label || g.host}? This stops and removes its container.`)) return;
    errorEl.hidden = true;
    activityLogEl.textContent = "";
    waitMsgEl.textContent = "Uninstalling, please wait…";
    form.hidden = true;
    waitEl.hidden = false;
    const result = await window.cttc.uninstallGateway(g);
    waitEl.hidden = true;
    form.hidden = false;
    waitMsgEl.textContent = "Applying changes, please wait…";
    if (!result.ok) {
      errorEl.textContent = result.error;
      errorEl.hidden = false;
      return;
    }
    await loadGatewaysForEdit();
  });

  loadGatewaysForEdit();
}

function readImageSource() {
  const mode = document.querySelector('input[name="image-source"]:checked').value;
  if (mode === "registry") return { type: "registry", ref: imageRefEl.value.trim() };
  if (mode === "tarball") return { type: "tarball", path: imageTarballPathEl.value };
  return null; // "default" -- let the server side resolve its usual fallback
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const gw = MODE === "edit" ? selectedGateway() : null;
  if (MODE === "edit" && !gw) return; // nothing picked yet -- button is disabled anyway
  const isEmbeddedEdit = MODE === "edit" && gw.mode === "embedded";

  errorEl.hidden = true;
  activityLogEl.textContent = "";

  const keyMode = document.querySelector('input[name="key-mode"]:checked').value;
  const imageSource = readImageSource();
  const payload = {
    sshUser: sshUserEl.value.trim(),
    sshHost: sshHostEl.value.trim(),
    sshPort: Number(sshPortEl.value),
    keyMode,
    keyPath: keyMode === "path" ? keyPathEl.value : null,
    keyContents: keyMode === "paste" ? keyPasteEl.value : null,
    imageSource,
  };
  // "This machine" has no ssh settings at all -- Save/Update here only ever
  // touches the image (see main.js's gateway-manage-save), so none of the
  // ssh-field validation below applies.
  if (!isEmbeddedEdit && keyMode === "path" && !payload.keyPath) {
    errorEl.textContent = "Choose a private key file, or switch to pasting its contents.";
    errorEl.hidden = false;
    return;
  }
  if (!isEmbeddedEdit && keyMode === "paste" && !payload.keyContents.trim()) {
    errorEl.textContent = "Paste the private key's contents, or switch to a file.";
    errorEl.hidden = false;
    return;
  }
  if (imageSource?.type === "tarball" && !imageSource.path) {
    errorEl.textContent = "Choose a .tar.gz file, or switch to a registry reference / the bundled image.";
    errorEl.hidden = false;
    return;
  }
  if (imageSource?.type === "registry" && !imageSource.ref) {
    errorEl.textContent = "Enter an image reference (repo:tag), or switch to the bundled image.";
    errorEl.hidden = false;
    return;
  }

  form.hidden = true;
  waitEl.hidden = false;
  btnConnect.disabled = true;

  const result =
    MODE === "edit"
      ? await window.cttc.saveGatewayEdit({ ...payload, key: keyOf(gw), mode: gw.mode })
      : await window.cttc.submitSetup(payload);

  if (!result.ok) {
    form.hidden = false;
    waitEl.hidden = true;
    btnConnect.disabled = false;
    errorEl.textContent = result.error;
    errorEl.hidden = false;
    return;
  }
  if (MODE === "edit") {
    // stays open (this window doesn't gate app startup the way New Gateway
    // does) -- refresh so the dropdown/prefill reflect what was just saved
    form.hidden = false;
    waitEl.hidden = true;
    await loadGatewaysForEdit();
  }
  // "new" mode success: main.js closes this window and opens the app itself
});
