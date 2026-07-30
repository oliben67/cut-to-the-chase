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

// Collapsible sidebar sections (Gateway/Sources/Metrics/Preferences) --
// mirrors app.js's own handling of the docked sidebar so a section left
// open/closed in one carries over to the other; same localStorage key so
// both windows read/write the identical persisted state (see prefs in
// app.js: same "cttc-" + key convention, same origin/partition).
const SIDEBAR_EXPANDED_KEY = "sidebarExpandedSections";
function getExpandedState() {
  try {
    return JSON.parse(localStorage.getItem("cttc-" + SIDEBAR_EXPANDED_KEY)) || {};
  } catch {
    return {};
  }
}
function setSidebarSectionExpanded(group, expanded) {
  const body = group.querySelector(".ab-group-body");
  if (!body) return;
  body.hidden = !expanded;
  group.dataset.expanded = String(expanded);
  const state = getExpandedState();
  state[group.dataset.section] = expanded;
  localStorage.setItem("cttc-" + SIDEBAR_EXPANDED_KEY, JSON.stringify(state));
}
const savedSidebarState = getExpandedState();
for (const group of document.querySelectorAll("#action-bar .ab-group[data-section]")) {
  const header = group.querySelector(".ab-group-header");
  if (!header) continue;
  setSidebarSectionExpanded(group, !!savedSidebarState[group.dataset.section]);
  header.onclick = () => setSidebarSectionExpanded(group, group.dataset.expanded !== "true");
}
