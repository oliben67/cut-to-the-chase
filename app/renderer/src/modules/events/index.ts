export {
  loadUiEvents,
  saveUiEvents,
  dlgEventForm,
  dlgEventList,
  editingEvent,
  openEventCreateDialog,
  openEventEditForm,
  openEventListDialog,
  refreshEventsList,
  buildEventConditions,
  buildEventAction,
} from "./dialogs";
export { checkUiConditions, checkUiMetricCondition, uiEventTick } from "./engine";

import { startUiEventLoop } from "./engine";

// Called back in from app.js's own boot sequence (see entry.ts) -- this
// bundle's script tag runs before app.js's, so prefs/state/get/post/
// notifyEvent (all read inside the event loop) don't exist yet at this
// module's own load time.
export function mountEvents(): void {
  startUiEventLoop();
}
