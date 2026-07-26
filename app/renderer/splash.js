"use strict";

// Mirrors whatever main.js is doing right now (docker checks, ssh
// provisioning, tunnel setup, ...) so the splash window is never just a
// spinner with no indication of what it's waiting on -- same "main-log"
// stream the main window's own activity log already uses (see app.js),
// just rendered as a single latest-line status instead of a scrollback.
const statusEl = document.getElementById("status");

window.cttc.onMainLog(({ level, text }) => {
  if (level !== "log") return; // errors surface via the dialog that follows a failed startup, not here
  statusEl.textContent = text;
  statusEl.title = text; // full text on hover -- the line is truncated to fit this window's width
});
