import { render } from "preact";
import { store, StoreProvider } from "../../shared/store";
import {
  statusBarHistory,
  statusBarVisibleAtom,
  historyPopupOpenAtom,
  STATUS_BAR_HISTORY_MAX,
  DEFAULT_STATUS_BAR_VISIBLE,
} from "./status-bar.state";
import { HistoryList } from "./HistoryList";
import "../../shared/legacy-globals";

function messageEl(): HTMLElement | null {
  return document.getElementById("app-status-bar-text");
}

let clearTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleClear(shown: string): void {
  if (clearTimer != null) clearTimeout(clearTimer);
  const secs = statusBarClearSecs;
  clearTimer = setTimeout(() => {
    const el = messageEl();
    if (el && el.textContent === shown) el.textContent = "";
  }, secs * 1000);
}

// Cancels any pending auto-clear and blanks the message immediately --
// used by LIVE's setLiveHidden (out of scope this kickoff) when leaving
// analysis mode, so a stale analysis-mode notification doesn't linger into
// the live view it's switching back to. #status-bar-recording-text is a
// separate element, untouched by this.
export function clearStatusMessage(): void {
  if (clearTimer != null) clearTimeout(clearTimer);
  const el = messageEl();
  if (el) el.textContent = "";
}

function recordStatusBarHistory(text: string): void {
  statusBarHistory.push({ ts: Date.now(), text });
  if (statusBarHistory.length > STATUS_BAR_HISTORY_MAX) statusBarHistory.shift();
  if (store.get(historyPopupOpenAtom)) renderHistoryList();
}

// Every transient status/error (server connectivity, export/save results,
// recording lifecycle, ...) shown in exactly one place, the bottom status
// bar. Recording (out of scope this kickoff, read off the legacy global)
// keeps capturing regardless of analysis mode, so a new notification while
// recording/paused must not blow away whatever's already shown -- append
// it after a bar separator instead of replacing outright.
export function notifyEvent(text: string): void {
  const entry = `${new Date().toLocaleTimeString()} — ${text}`;
  const el = messageEl();
  const recStatus = recording.status;
  const nextMessage =
    (recStatus === "recording" || recStatus === "paused") && el?.textContent
      ? `${el.textContent} | ${entry}`
      : entry;
  if (el) el.textContent = nextMessage;
  recordStatusBarHistory(text);
  scheduleClear(nextMessage);
}

// Same as notifyEvent, but force-clears after `ms` unless something else
// has already overwritten it by then -- used for "application starting" so
// a quiet boot with nothing else to report doesn't linger indefinitely.
export function notifyEventWithCap(text: string, ms: number): void {
  notifyEvent(text);
  const shown = messageEl()?.textContent ?? "";
  setTimeout(() => {
    const el = messageEl();
    if (el && el.textContent === shown) el.textContent = "";
  }, ms);
}

// Shows a message for a fixed duration, then reverts it -- unlike
// notifyEvent's normal callers (one-off background events), this one
// expires on its own. Only reverts if nothing else has since overwritten
// it. Used by LIVE's live-track-resume countdown (out of scope this
// kickoff), which calls this by bare identifier (see entry.ts).
export function flashStatus(msg: string, ms: number): void {
  const el = messageEl();
  if (el) el.textContent = msg;
  recordStatusBarHistory(msg);
  setTimeout(() => {
    const el2 = messageEl();
    if (el2 && el2.textContent === msg) el2.textContent = "";
  }, ms);
}

function renderHistoryList(): void {
  const popup = document.getElementById("status-bar-history-popup");
  const listNode = document.getElementById("status-bar-history-list");
  if (!popup || !listNode) return;
  render(
    <StoreProvider>
      <HistoryList history={statusBarHistory} />
    </StoreProvider>,
    popup,
    listNode,
  );
}

export function toggleHistoryPopup(): void {
  const next = !store.get(historyPopupOpenAtom);
  store.set(historyPopupOpenAtom, next);
  if (next) renderHistoryList();
}

export function closeHistoryPopup(): void {
  store.set(historyPopupOpenAtom, false);
}

export function clearStatusHistory(): void {
  statusBarHistory.length = 0;
  renderHistoryList();
}

export function isStatusBarVisible(): boolean {
  return store.get(statusBarVisibleAtom);
}

// Applies the current visibility atom to the shared #app-status-bar
// container's hidden attribute -- that container also hosts the recording
// dot, live/record mode icon, and gateway/docker-host pills (not owned by
// this module), so this toggles the whole bar exactly as it does today.
export function syncStatusBarVisibility(): void {
  const el = document.getElementById("app-status-bar") as HTMLElement | null;
  if (el) el.hidden = !store.get(statusBarVisibleAtom);
}

export function setStatusBarVisible(visible: boolean): void {
  store.set(statusBarVisibleAtom, visible);
  prefs.set("statusBarVisible", visible);
  syncStatusBarVisibility();
}

// Called back in from app.js's own boot sequence (via window.mountStatusBar,
// see entry.ts/index.tsx), not at this bundle's own top level -- this
// bundle's script tag runs before app.js's, so `prefs` doesn't exist yet
// at module-init time (see status-bar.actions.tsx and shared/legacy-globals.ts).
export function initStatusBarVisibility(): void {
  const visible = prefs.get("statusBarVisible", DEFAULT_STATUS_BAR_VISIBLE) as boolean;
  store.set(statusBarVisibleAtom, visible);
  syncStatusBarVisibility();
}
