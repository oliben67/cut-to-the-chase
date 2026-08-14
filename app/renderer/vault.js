"use strict";

// Passphrase prompt for the gateway-key vault's fallback scheme (see
// lib/key-vault.js) -- only ever shown when safeStorage.isEncryptionAvailable()
// is false (e.g. Linux without a keyring backend). Two modes, decided by
// main.js (openVaultWindow) and passed via the query string: "setup" (no
// passphrase chosen yet) asks for one twice; "unlock" (already set up, just
// locked this session) asks for it once.
const mode = new URLSearchParams(location.search).get("mode") === "setup" ? "setup" : "unlock";

const titleEl = document.getElementById("vault-title");
const explainerEl = document.getElementById("vault-explainer");
const confirmRowEl = document.getElementById("vault-confirm-row");
const passphraseEl = document.getElementById("vault-passphrase");
const confirmEl = document.getElementById("vault-confirm");
const errorEl = document.getElementById("error");
const submitBtn = document.getElementById("btn-submit");
const form = document.getElementById("form");

if (mode === "setup") {
  titleEl.textContent = "Set Up Secure Storage";
  explainerEl.textContent =
    "Your system's secure storage isn't available, so CTTC will encrypt gateway keys with a passphrase instead. " +
    "You'll need it again the next time CTTC starts.";
  confirmRowEl.hidden = false;
  submitBtn.textContent = "Set Up";
} else {
  titleEl.textContent = "Unlock Secure Storage";
  explainerEl.textContent = "Enter your passphrase to unlock gateway keys for this session.";
  submitBtn.textContent = "Unlock";
}

passphraseEl.focus();

// Closing this window without having unlocked/set up -- the OS close
// control, Escape (if this window ever grows that binding), or Cancel --
// must report a cancellation, or the caller waiting on ensureVaultUnlocked()
// would hang forever instead of seeing a clean rejection. Cleared right
// before a *successful* close so that one doesn't also report a cancel.
let cancelOnClose = true;
window.addEventListener("beforeunload", () => {
  if (cancelOnClose) window.cttc.vaultCancel();
});
document.getElementById("btn-cancel").addEventListener("click", () => {
  cancelOnClose = false;
  window.cttc.vaultCancel();
  window.close();
});

let submitting = false;
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (submitting) return;
  submitting = true;
  errorEl.hidden = true;
  submitBtn.disabled = true;
  try {
    const result =
      mode === "setup"
        ? await window.cttc.vaultSetup(passphraseEl.value, confirmEl.value)
        : await window.cttc.vaultUnlock(passphraseEl.value);
    if (result.ok) {
      cancelOnClose = false; // already resolved -- don't also report a cancel on close
      window.close(); // main.js already closes this window from the handler; harmless fallback
      return;
    }
    errorEl.textContent = result.error;
    errorEl.hidden = false;
    passphraseEl.select();
  } finally {
    submitting = false;
    submitBtn.disabled = false;
  }
});
