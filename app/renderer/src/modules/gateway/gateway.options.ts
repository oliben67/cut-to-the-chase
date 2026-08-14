import type { Gateway } from "./gateway.types";

// A gateway's stable identity for a <select>'s option value -- matches
// gateway-registry.js's own host:port keying, not g.id (older/scripted
// entries may not have one). Also what saveGatewayEdit's payload.key
// expects.
export function gatewayOptionValue(g: Gateway): string {
  return `${g.host}:${g.port}`;
}

// The human-readable label for a gateway option -- label falls back to
// host, the connection target omits the port when there isn't one (the
// embedded/local gateway), and "— active" is appended for whichever one
// is currently connected.
export function gatewayOptionLabel(g: Gateway): string {
  const loc = g.port == null ? g.host : `${g.host}:${g.port}`;
  return `${g.label || g.host} (${loc})${g.active ? " — active" : ""}`;
}
