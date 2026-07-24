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
// connection -- this is a history, kept even while pointed elsewhere.

function defaultGatewaysPath(env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".cttc", "gateways.json");
}

function gatewayKey(entry) {
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
 * reached at least once.
 * @param {{mode: "embedded"|"remote", host: string, port: number, label: string, sshTarget?: string, sshKey?: string|null, sshPort?: number}} entry
 */
function recordGateway(entry, { configPath } = {}) {
  const resolvedPath = configPath || defaultGatewaysPath(process.env);
  const list = readGateways({ configPath: resolvedPath });
  const key = gatewayKey(entry);
  const next = list.filter((g) => gatewayKey(g) !== key);
  next.unshift({ ...entry, lastUsed: Date.now() });
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

module.exports = { defaultGatewaysPath, gatewayKey, readGateways, recordGateway };
