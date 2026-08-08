import { mountGatewayPill } from "./pill";

export { openNewGatewayDialog, openEditGatewaysDialog, openUninstallGatewayDialog, editableGateways, dlgGatewaySetup, dlgGatewayUninstall } from "./dialogs";
export { mountGatewayPill } from "./pill";

// Called back in from app.js's own boot sequence (see entry.ts) -- this
// bundle's script tag runs before app.js's, so hasDockerDaemon/ctxMenu/get/
// notifyEvent (all read inside mountGatewayPill) don't exist yet at this
// module's own load time.
export function mountGateway(): void {
  mountGatewayPill();
}
