"use strict";

const form = document.getElementById("form");
const keyPathRow = document.getElementById("key-path-row");
const keyPasteEl = document.getElementById("key-paste");
const keyPathEl = document.getElementById("key-path");
const errorEl = document.getElementById("error");
const waitEl = document.getElementById("wait");
const btnConnect = document.getElementById("btn-connect");

for (const radio of document.querySelectorAll('input[name="key-mode"]')) {
  radio.addEventListener("change", () => {
    const paste = radio.value === "paste" && radio.checked;
    keyPathRow.hidden = paste;
    keyPasteEl.hidden = !paste;
    keyPasteEl.disabled = !paste;
  });
}

document.getElementById("btn-browse").addEventListener("click", async () => {
  const paths = await window.cttc.pickFiles("Choose your SSH private key");
  if (paths.length) keyPathEl.value = paths[0];
});

// Closing this window (however it happens) is what main.js's
// runSetupWizard() already treats as "cancelled" -- on first launch that
// falls back to using this machine directly; when reconfiguring from
// Settings it just leaves the existing connection untouched. window.close()
// triggers that same path, so this button needs no separate IPC of its own.
document.getElementById("btn-skip").addEventListener("click", () => window.close());

const activityEl = document.getElementById("activity");
const activityLogEl = document.getElementById("activity-log");
const btnActivityToggle = document.getElementById("btn-activity-toggle");

btnActivityToggle.addEventListener("click", () => {
  activityLogEl.hidden = !activityLogEl.hidden;
  btnActivityToggle.textContent = activityLogEl.hidden ? "Show activity" : "Hide activity";
});

window.cttc.onSetupLog((line) => {
  activityEl.hidden = false;
  activityLogEl.textContent += (activityLogEl.textContent ? "\n" : "") + line;
  activityLogEl.scrollTop = activityLogEl.scrollHeight;
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  activityLogEl.textContent = "";

  const keyMode = document.querySelector('input[name="key-mode"]:checked').value;
  const payload = {
    sshUser: document.getElementById("ssh-user").value.trim(),
    sshHost: document.getElementById("ssh-host").value.trim(),
    sshPort: Number(document.getElementById("ssh-port").value),
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

  form.hidden = true;
  waitEl.hidden = false;
  btnConnect.disabled = true;

  const result = await window.cttc.submitSetup(payload);
  if (!result.ok) {
    form.hidden = false;
    waitEl.hidden = true;
    btnConnect.disabled = false;
    errorEl.textContent = result.error;
    errorEl.hidden = false;
  }
  // on success the main process closes this window and opens the app itself
});
