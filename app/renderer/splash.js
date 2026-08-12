"use strict";

// Mirrors whatever main.js is doing right now (docker checks, ssh
// provisioning, tunnel setup, ...) so the splash window is never just a
// spinner with no indication of what it's waiting on. Deliberately a
// separate, curated "splash-status" channel (see main.js's narrate()) --
// NOT the main window's "main-log" firehose, which also carries raw
// command echoes and unfiltered subprocess stdout/stderr that would read as
// garbled noise squeezed into this window's single status line.
const statusEl = document.getElementById("status");

window.cttc.onSplashStatus((text) => {
  statusEl.textContent = text;
  statusEl.title = text; // full text on hover -- the line is truncated to fit this window's width
});

// The full-detail counterpart to the single status line above -- same
// "main-log" stream the main window's own activity log shows (main.js's
// mainLog()/mainError(), already broadcast to every open window, splash
// included, per user direction: more detail under the status line, not
// just the latest curated sentence). Accumulates rather than replacing, so
// the history of everything that's happened so far stays visible.
const detailsEl = document.getElementById("details");
window.cttc.onMainLog(({ text }) => {
  detailsEl.textContent += (detailsEl.textContent ? "\n" : "") + text;
  detailsEl.scrollTop = detailsEl.scrollHeight;
});
