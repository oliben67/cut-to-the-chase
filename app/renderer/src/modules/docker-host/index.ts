import { mountDockerHostPill } from "./pill";

export { openNewDockerHostDialog, openEditDockerHostDialog, enterDockerHostEditMode, renderActivityLog, listContainers, dlg } from "./set-dialog";
export { populateRemoveDaemonSelect, dlgRemoveDaemon } from "./remove-dialog";
export { dockerDaemonEditMode, loadSelectedTargets, saveSelectedTargets, dockerHostHistory } from "./state";
export { populateDockerHostHistory } from "./history-select";
export { mountDockerHostPill } from "./pill";

// Called back in from app.js's own boot sequence (see entry.ts) -- this
// bundle's script tag runs before app.js's, so hasDockerDaemon/
// currentDockerHost/ctxMenu/get/notifyEvent (mountDockerHostPill) don't
// exist yet at this module's own load time.
export function mountDockerHost(): void {
  mountDockerHostPill();
}
