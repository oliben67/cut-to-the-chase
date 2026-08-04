"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Remembers every gateway (cttc-gateway container) this client has actually
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
// (see recordDockerHostForGateway below) -- distinct from and additional
// to the renderer's own gateway-agnostic savedDockerDaemons list.

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
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return []; // corrupt file -- treat as empty rather than blocking startup
  }
}

/**
 * Upserts one gateway entry (matched by host:port) and returns the full,
 * newest-first list. Called right after a connect actually succeeds --
 * never speculatively -- so every entry here is a gateway that was really
 * reached at least once. Merges onto any existing entry for that key
 * rather than replacing it outright, so fields the caller doesn't know
 * about (e.g. dockerHosts, recorded separately -- see
 * recordDockerHostForGateway) survive a routine re-record of the same
 * gateway (a reconnect, a connectionType refresh, etc).
 * @param {{mode: "embedded"|"remote", host: string, port: number, label: string, sshTarget?: string, sshKey?: string|null, sshPort?: number}} entry
 */
function recordGateway(entry, { configPath } = {}) {
  const resolvedPath = configPath || defaultGatewaysPath(process.env);
  const list = readGateways({ configPath: resolvedPath });
  const key = gatewayKey(entry);
  const existing = list.find((g) => gatewayKey(g) === key);
  const next = list.filter((g) => gatewayKey(g) !== key);
  next.unshift({ ...existing, ...entry, lastUsed: Date.now() });
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * Adds/updates one Docker host under the gateway identified by
 * gatewayKeyStr's own docker-host catalog -- gateways.json's record of
 * which Docker hosts were actually created/used while connected to *this*
 * gateway (distinct from the renderer's own gateway-agnostic
 * savedDockerDaemons, which this supplements, not replaces). Upserted by
 * hostKey, newest-first, deduped like recordGateway itself. A no-op
 * (returns the list unchanged) if gatewayKeyStr doesn't match any known
 * gateway -- there's nothing to attach it to.
 * @param {string} gatewayKeyStr
 * @param {{hostKey: string, host: string|null, sshKey?: string|null}} dockerHostEntry
 */
function recordDockerHostForGateway(gatewayKeyStr, dockerHostEntry, { configPath } = {}) {
  const resolvedPath = configPath || defaultGatewaysPath(process.env);
  const list = readGateways({ configPath: resolvedPath });
  const gw = list.find((g) => gatewayKey(g) === gatewayKeyStr);
  if (!gw) return list;
  const dockerHosts = (gw.dockerHosts || []).filter((h) => h.hostKey !== dockerHostEntry.hostKey);
  dockerHosts.unshift({ ...dockerHostEntry, lastUsed: Date.now() });
  gw.dockerHosts = dockerHosts;
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, JSON.stringify(list, null, 2), "utf8");
  return list;
}

/**
 * Drops one gateway entry (matched by "host:port", see gatewayKey) and
 * returns the remaining list. Used when a gateway is uninstalled, or when
 * editing one changes its host:port (the old key no longer applies).
 * @param {string} key
 */
function removeGateway(key, { configPath } = {}) {
  const resolvedPath = configPath || defaultGatewaysPath(process.env);
  const list = readGateways({ configPath: resolvedPath });
  const next = list.filter((g) => gatewayKey(g) !== key);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

module.exports = {
  defaultGatewaysPath,
  gatewayKey,
  readGateways,
  recordGateway,
  removeGateway,
  recordDockerHostForGateway,
};
