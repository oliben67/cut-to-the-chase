import { store } from "../../shared/store";
import { historyPopupOpenAtom } from "./status-bar.state";
import { initStatusBarVisibility, setStatusBarVisible, toggleHistoryPopup, closeHistoryPopup, clearStatusHistory } from "./status-bar.actions";

export {
  notifyEvent,
  notifyEventWithCap,
  flashStatus,
  setStatusBarVisible,
  isStatusBarVisible,
  clearStatusMessage,
} from "./status-bar.actions";
export { statusBarHistory } from "./status-bar.state";

function isPopout(): boolean {
  return new URLSearchParams(location.search).get("popout") != null;
}

// Wires up everything this module owns in the existing #app-status-bar
// markup. History list content renders through Preact (see
// status-bar.actions' renderHistoryList), driven imperatively rather than
// via a reactive hook subscription -- see status-bar.state's comment on
// statusBarHistory for why. The visibility toggle and history
// button/popup/clear stay plain DOM wiring calling back into this module's
// actions, same shape as the original code, which had no popout guard on
// any of this except the initial visibility sync (popouts start with
// #app-status-bar statically hidden in index.html and never call
// syncStatusBarVisibility to un-hide it).
export function mountStatusBar(): void {
  if (!isPopout()) initStatusBarVisibility();

  const toggle = document.getElementById("theme-status-bar-toggle") as HTMLInputElement | null;
  if (toggle) {
    toggle.onchange = (e) => setStatusBarVisible((e.target as HTMLInputElement).checked);
  }

  const btn = document.getElementById("status-bar-history-btn");
  const popup = document.getElementById("status-bar-history-popup") as HTMLElement | null;
  const clearBtn = document.getElementById("status-bar-history-clear");
  if (btn) btn.onclick = () => toggleHistoryPopup();
  if (clearBtn) clearBtn.onclick = () => clearStatusHistory();

  if (popup) {
    store.sub(historyPopupOpenAtom, () => {
      popup.hidden = !store.get(historyPopupOpenAtom);
    });
    document.addEventListener("click", (e) => {
      if (popup.hidden) return;
      const target = e.target as Node;
      if (!popup.contains(target) && target !== btn && !btn?.contains(target)) closeHistoryPopup();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeHistoryPopup();
  });
}
