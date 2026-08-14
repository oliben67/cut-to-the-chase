import "../../shared/legacy-globals";
import { $ } from "../../shared/dollar";

// PREF domain, narrowed: every field inside this dialog (highlight color,
// now-line color/style, live-track color, time window, live-tracking,
// dblclick-resume, ...) previews/persists a variable actually owned and
// consumed by another domain's rendering code (nowLineColor/nowLineStyle/
// liveTrackColor are read straight off app.js's chart-drawing hot path) --
// there's no real, independent "preferences" domain to extract them into.
// What genuinely stands on its own is this dialog's pane-switching shell,
// so that's all that moves here; every field's own wiring (and
// prefillPreferencesPane, which selectPreferencesPane below calls back
// into) stays in app.js exactly where it is.

export const dlgPreferences = $("dlg-preferences");

// Settings and Preferences, one dialog: a left-hand pane list (mac System
// Settings-style, see .mac-settings in style.css) with the selected pane's
// fields on the right -- opened via the shared data-action dispatch
// (RENDERER_ACTIONS' "open-settings"/"open-theme" entries, app.js), each
// jumping straight to its own pane.
export function selectPreferencesPane(paneId: string): void {
  for (const item of dlgPreferences.querySelectorAll(".mac-settings-item")) {
    (item as HTMLElement).dataset.active = String((item as HTMLElement).dataset.pane === paneId);
  }
  for (const pane of dlgPreferences.querySelectorAll(".mac-settings-pane")) {
    (pane as HTMLElement).hidden = pane.id !== paneId;
  }
  if (paneId === "pane-preferences") prefillPreferencesPane();
}
for (const item of dlgPreferences.querySelectorAll(".mac-settings-item")) {
  (item as HTMLElement).onclick = () => selectPreferencesPane((item as HTMLElement).dataset.pane!);
}

export function openPreferencesDialog(paneId: string): void {
  selectPreferencesPane(paneId);
  dlgPreferences.showModal();
}
export function openSettingsDialog(): void {
  openPreferencesDialog("pane-settings");
}
export function openThemeDialog(): void {
  openPreferencesDialog("pane-preferences");
}
