"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

// Remembers every gateway (log-sump container) this client has actually
// connected to -- one entry per host:port, updated (never duplicated) each
// time a connect succeeds, so the "recent gateways" dropdown next to the
// main window's status pill has something to show without the user ever
// re-typing an ssh target they've already used once. Distinct from
// connection.json (lib/connection-config.js), which holds only the *active*
// connection -- this is a history, kept even while pointed elsewhere. Also
// doubles as the "ssh-tunnel-gateways" list: every entry tracks
// `connectionType` ("local" | "remote" | "remote-tunnel" -- see main.js's
// connectRemoteGateway) alongside the usual host/port/ssh fields, and
// `imageRef`, the gateway image version/ref that was last confirmed
// installed there (see lib/server-provision.js's resolveSource). Also
// carries `dockerHosts`, each gateway's own catalog of the Docker hosts
// (formerly called "daemons") actually created/used while connected to it
// (see recordDockerHostForGateway below) -- this is now the *sole*
// authoritative Docker-host list (the renderer's former gateway-agnostic
// savedDockerDaemons/dockerHostKeys localStorage maps were retired in favor
// of this, see docker-host/state.ts). As of REQ-0070/REQ-0071 (the peer-
// discovery mesh), an entry may also carry `lastContactAt`/
// `lastContactResult`/`existence` -- the same fields `POST /gateways/sync`
// returns and lib/gateway-audit.js's auditGatewayList() updates locally;
// recordGateway's existing merge-onto-existing behavior already preserves
// them across an unrelated re-record (a reconnect, a connectionType
// refresh, etc.), no special handling needed here.
//
// `id` (every gateway and every dockerHosts[] entry) is the real, sole
// identifier once an entry exists -- gatewayKey()/hostKey remain "natural"
// keys used only to decide "is this the same physical host the user just
// typed" at creation time (dedup-on-record), never as a stable reference
// afterward. Deletion is soft: retireGateway()/retireDockerHost() mark
// `retired: true` + `retiredAt` and leave the row in the file -- nothing
// here ever actually removes an entry, so the file also doubles as an
// audit trail. readGateways() backfills id/retired/retiredAt for any
// pre-migration entry (and persists the backfill immediately) so an
// upgrading user's existing file gains stable ids the first time it's
// read, not silently forever-missing them.

function defaultGatewaysPath(env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".cttc", "gateways.json");
}

function gatewayKey(entry) {
  // The embedded ("This machine") gateway's port is whatever happened to be
  // free that launch -- it's not part of its identity, unlike a remote
  // gateway's port (which is stable/meaningful). Keying on host:port here
  // would "duplicate" it into a new registry entry every single restart.
  if (entry.mode === "embedded" || entry.host === "127.0.0.1") return "embedded";
  return `${entry.host}:${entry.port}`;
}

// Mutates `list` in place, assigning id/retired/retiredAt to any gateway
// or nested dockerHosts[] row that predates this schema. Returns whether
// anything actually changed, so readGateways only persists when needed.
function backfillIds(list) {
  let changed = false;
  for (const g of list) {
    if (!g.id) {
      g.id = randomUUID();
      changed = true;
    }
    if (g.retired === undefined) {
      g.retired = false;
      changed = true;
    }
    if (g.retiredAt === undefined) {
      g.retiredAt = null;
      changed = true;
    }
    for (const h of g.dockerHosts || []) {
      if (!h.id) {
        h.id = randomUUID();
        changed = true;
      }
      if (h.retired === undefined) {
        h.retired = false;
        changed = true;
      }
      if (h.retiredAt === undefined) {
        h.retiredAt = null;
        changed = true;
      }
    }
  }
  return changed;
}

function writeGateways(resolvedPath, list) {
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, JSON.stringify(list, null, 2), "utf8");
}

function readGateways({ configPath } = {}) {
  const resolvedPath = configPath || defaultGatewaysPath(process.env);
  if (!fs.existsSync(resolvedPath)) return [];
  let raw;
  try {
    raw = fs.readFileSync(resolvedPath, "utf8");
  } catch {
    return [];
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM -- see connection-config.js
  let list;
  try {
    const parsed = JSON.parse(raw);
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // corrupt file -- treat as empty rather than blocking startup
  }
  if (backfillIds(list)) writeGateways(resolvedPath, list);
  return list;
}

/**
 * Upserts one gateway entry (matched by id when the caller has one,
 * otherwise by host:port -- see gatewayKey) and returns the full,
 * newest-first list. Called right after a connect actually succeeds --
 * never speculatively -- so every entry here is a gateway that was really
 * reached at least once. Merges onto any existing entry rather than
 * replacing it outright, so fields the caller doesn't know about (e.g.
 * dockerHosts, recorded separately -- see recordDockerHostForGateway, or
 * id/retired/retiredAt themselves) survive a routine re-record of the same
 * gateway (a reconnect, a connectionType refresh, etc).
 * @param {{id?: string, mode: "embedded"|"remote", host: string, port: number, label: string, sshTarget?: string, sshKey?: string|null, sshPort?: number, lastContactAt?: string, lastContactResult?: "ok"|"failed"|"unknown", existence?: "existing"|"absent"|"unknown"}} entry
 */
function recordGateway(entry, { configPath } = {}) {
  const resolvedPath = configPath || defaultGatewaysPath(process.env);
  const list = readGateways({ configPath: resolvedPath });
  const key = gatewayKey(entry);
  const existing = list.find((g) => (entry.id && g.id === entry.id) || gatewayKey(g) === key);
  const next = list.filter((g) => g !== existing);
  const base = { id: randomUUID(), retired: false, retiredAt: null };
  next.unshift({ ...base, ...existing, ...entry, lastUsed: Date.now() });
  writeGateways(resolvedPath, next);
  return next;
}

/**
 * Adds/updates one Docker host under the given gateway's own docker-host
 * catalog -- gateways.json's (now sole, authoritative) record of which
 * Docker hosts were actually created/used while connected to *this*
 * gateway. Upserted by id when the caller has one, otherwise by hostKey,
 * newest-first, deduped like recordGateway itself. A no-op (returns the
 * list unchanged) if gatewayIdOrKey doesn't match any known gateway --
 * there's nothing to attach it to. Called only after a connect actually
 * succeeds (see its call site), so it always revives a previously-retired
 * entry for the same id/hostKey rather than leaving it hidden from
 * dockerHostHistory() -- reconnecting to a Docker host removed earlier
 * must make it reappear in "Load Docker Host" history, the same way typing
 * a removed gateway's host:port again would.
 * @param {string} gatewayIdOrKey
 * @param {{id?: string, hostKey: string, host: string|null, sshKey?: string|null}} dockerHostEntry
 */
function recordDockerHostForGateway(gatewayIdOrKey, dockerHostEntry, { configPath } = {}) {
  const resolvedPath = configPath || defaultGatewaysPath(process.env);
  const list = readGateways({ configPath: resolvedPath });
  const gw = list.find((g) => g.id === gatewayIdOrKey || gatewayKey(g) === gatewayIdOrKey);
  if (!gw) return list;
  const existing = (gw.dockerHosts || []).find(
    (h) => (dockerHostEntry.id && h.id === dockerHostEntry.id) || h.hostKey === dockerHostEntry.hostKey
  );
  const dockerHosts = (gw.dockerHosts || []).filter((h) => h !== existing);
  const base = { id: randomUUID(), retired: false, retiredAt: null };
  dockerHosts.unshift({ ...base, ...existing, ...dockerHostEntry, retired: false, retiredAt: null, lastUsed: Date.now() });
  gw.dockerHosts = dockerHosts;
  writeGateways(resolvedPath, list);
  return list;
}

/**
 * Marks one gateway entry retired (matched by id, falling back to
 * host:port for a not-yet-migrated caller -- see gatewayKey) -- never
 * removes it. Used when a gateway is uninstalled, or when editing one
 * changes its host:port (the old key no longer applies, but the row for
 * it stays, retired, rather than vanishing).
 * @param {string} idOrKey
 */
function retireGateway(idOrKey, { configPath } = {}) {
  const resolvedPath = configPath || defaultGatewaysPath(process.env);
  const list = readGateways({ configPath: resolvedPath });
  const gw = list.find((g) => g.id === idOrKey || gatewayKey(g) === idOrKey);
  if (!gw) return list;
  gw.retired = true;
  gw.retiredAt = new Date().toISOString();
  writeGateways(resolvedPath, list);
  return list;
}

/**
 * Marks one Docker host entry (under the given gateway) retired -- never
 * removes it. Matched by id, falling back to hostKey.
 * @param {string} gatewayIdOrKey
 * @param {string} hostIdOrKey
 */
function retireDockerHost(gatewayIdOrKey, hostIdOrKey, { configPath } = {}) {
  const resolvedPath = configPath || defaultGatewaysPath(process.env);
  const list = readGateways({ configPath: resolvedPath });
  const gw = list.find((g) => g.id === gatewayIdOrKey || gatewayKey(g) === gatewayIdOrKey);
  if (!gw) return list;
  const h = (gw.dockerHosts || []).find((h) => h.id === hostIdOrKey || h.hostKey === hostIdOrKey);
  if (!h) return list;
  h.retired = true;
  h.retiredAt = new Date().toISOString();
  writeGateways(resolvedPath, list);
  return list;
}

module.exports = {
  defaultGatewaysPath,
  gatewayKey,
  readGateways,
  recordGateway,
  retireGateway,
  recordDockerHostForGateway,
  retireDockerHost,
};
