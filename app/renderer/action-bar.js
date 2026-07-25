"use strict";

// This window has no access to the main window's document -- every action
// button here forwards to main.js over IPC, which relays it to the main
// window's own renderer (see app.js's onRunAction listener) so Undo/Redo/
// Reload/etc. act on the main window's content, not this (empty) one.
document.getElementById("action-bar").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (btn) window.cttc.triggerAction(btn.dataset.action);
});

document.getElementById("ab-redock").addEventListener("click", () => {
  window.cttc.redockActionBar();
});
