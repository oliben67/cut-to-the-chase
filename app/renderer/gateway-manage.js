"use strict";

const selectEl = document.getElementById("gateway-select");
const emptyEl = document.getElementById("empty");
const form = document.getElementById("form");
const sshUserEl = document.getElementById("ssh-user");
const sshHostEl = document.getElementById("ssh-host");
const sshPortEl = document.getElementById("ssh-port");
const keyPathEl = document.getElementById("key-path");
const keyPasteEl = document.getElementById("key-paste");
const btnBrowseEl = document.getElementById("btn-browse");
const btnSave = document.getElementById("btn-save");
const btnUninstall = document.getElementById("btn-uninstall");
const errorEl = document.getElementById("error");
const waitEl = document.getElementById("wait");
const waitMsgEl = document.getElementById("wait-msg");
const activityEl = document.getElementById("activity");
const activityLogEl = document.getElementById("activity-log");
const btnActivityToggle = document.getElementById("btn-activity-toggle");

let gateways = [];

function keyOf(g) {
  return `${g.host}:${g.port}`;
}
function selected() {
  return gateways.find((g) => keyOf(g) === selectEl.value);
}

// Same "both stay visible, only one enabled" pattern as gateway-setup.js.
for (const radio of document.querySelectorAll('input[name="key-mode"]')) {
  radio.addEventListener("change", () => {
    const paste = radio.value === "paste" && radio.checked;
    keyPathEl.disabled = paste;
    btnBrowseEl.disabled = paste;
    keyPasteEl.disabled = !paste;
  });
}

btnBrowseEl.addEventListener("click", async () => {
  const paths = await window.cttc.pickFiles("Choose your SSH private key");
  if (paths.length) keyPathEl.value = paths[0];
});

btnActivityToggle.addEventListener("click", () => {
  activityLogEl.hidden = !activityLogEl.hidden;
  btnActivityToggle.textContent = activityLogEl.hidden ? "Show activity" : "Hide activity";
});
window.cttc.onSetupLog((line) => {
  activityEl.hidden = false;
  activityLogEl.textContent += (activityLogEl.textContent ? "\n" : "") + line;
  activityLogEl.scrollTop = activityLogEl.scrollHeight;
});

// "This machine" (embedded) entries have no ssh settings to edit -- the
// form fields are disabled and Save is hidden, leaving only Uninstall.
function fillForm(g) {
  errorEl.hidden = true;
  const isRemote = g.mode !== "embedded";
  const fields = [sshUserEl, sshHostEl, sshPortEl, keyPathEl, btnBrowseEl, keyPasteEl,
    ...document.querySelectorAll('input[name="key-mode"]')];
  for (const el of fields) el.disabled = !isRemote;
  btnSave.hidden = !isRemote;
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

async function loadGateways() {
  gateways = await window.cttc.getGateways();
  const prevKey = selectEl.value;
  selectEl.innerHTML = "";
  if (!gateways.length) {
    emptyEl.hidden = false;
    form.hidden = true;
    return;
  }
  emptyEl.hidden = true;
  form.hidden = false;
  for (const g of gateways) {
    const opt = document.createElement("option");
    opt.value = keyOf(g);
    opt.textContent = `${g.label || g.host} (${g.host}:${g.port})${g.active ? " — active" : ""}`;
    selectEl.appendChild(opt);
  }
  selectEl.value = gateways.some((g) => keyOf(g) === prevKey) ? prevKey : keyOf(gateways[0]);
  fillForm(selected());
}

selectEl.addEventListener("change", () => fillForm(selected()));

btnUninstall.addEventListener("click", async () => {
  const g = selected();
  if (!g) return;
  if (!confirm(`Uninstall ${g.label || g.host}? This stops and removes its container.`)) return;
  errorEl.hidden = true;
  activityLogEl.textContent = "";
  waitMsgEl.textContent = "Uninstalling, please wait…";
  form.hidden = true;
  waitEl.hidden = false;
  const result = await window.cttc.uninstallGateway(g);
  waitEl.hidden = true;
  if (!result.ok) {
    form.hidden = false;
    errorEl.textContent = result.error;
    errorEl.hidden = false;
    return;
  }
  await loadGateways();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const g = selected();
  if (!g || g.mode === "embedded") return;
  errorEl.hidden = true;
  activityLogEl.textContent = "";

  const keyMode = document.querySelector('input[name="key-mode"]:checked').value;
  const payload = {
    key: keyOf(g),
    sshUser: sshUserEl.value.trim(),
    sshHost: sshHostEl.value.trim(),
    sshPort: Number(sshPortEl.value),
    keyMode,
    keyPath: keyMode === "path" ? keyPathEl.value : null,
    keyContents: keyMode === "paste" ? keyPasteEl.value : null,
  };
  if (keyMode === "path" && !payload.keyPath) {
    errorEl.textContent = "Choose a private key file, or switch to pasting its contents.";
    errorEl.hidden = false;
    return;
  }
  if (keyMode === "paste" && !payload.keyContents.trim()) {
    errorEl.textContent = "Paste the private key's contents, or switch to a file.";
    errorEl.hidden = false;
    return;
  }

  waitMsgEl.textContent = "Applying changes, please wait…";
  form.hidden = true;
  waitEl.hidden = false;

  const result = await window.cttc.saveGatewayEdit(payload);
  waitEl.hidden = true;
  if (!result.ok) {
    form.hidden = false;
    errorEl.textContent = result.error;
    errorEl.hidden = false;
    return;
  }
  await loadGateways();
});

loadGateways();
