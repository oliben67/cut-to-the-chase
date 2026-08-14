"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// br-NET-004: every Docker-based deployment (a local "This machine"
// container, or a remote gateway) binds 0.0.0.0 with `network_mode: host`
// (see docker-compose.yml/Dockerfile), so it's reachable by anything that
// can reach the port at all -- the whole LAN, or further if port-forwarded.
// A random per-gateway token, generated here at provision time (the same
// trust moment the ssh key already establishes for a remote gateway) and
// required by server.py's own auth middleware on every request, closes
// that hole. Persisted separately from gateway-registry.json (which is
// only ever written *after* a connect succeeds) because
// ensureLocalContainer/ensureRemoteContainer need the token *before* that
// first connect can happen at all.

function defaultTokensPath(env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".cttc", "api-tokens.json");
}

function readTokens(configPath) {
  if (!fs.existsSync(configPath)) return {};
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return {};
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM -- see connection-config.js
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // corrupt file -- treat as empty rather than blocking startup
  }
}

/**
 * Returns the persisted API token for `key` (an "embedded" sentinel for the
 * local "This machine" gateway, or a remote gateway's resolved host),
 * generating and persisting a new random one the first time `key` is seen.
 * Reused verbatim on every later call for the same key -- unlike a
 * bind-mounted file's content, an env var that *changes* between two
 * `docker compose up -d` calls (see server-provision.js) makes docker
 * compose recreate the container, so regenerating this on every ordinary
 * reconnect would needlessly restart an already-running, already-
 * authenticated gateway (and, since Redis is this app's sole store with no
 * persistent volume, drop all its collected history in the process).
 * @param {string} key
 * @param {{configPath?: string}} [opts]
 * @returns {string}
 */
function getOrCreateApiToken(key, { configPath } = {}) {
  const resolvedPath = configPath || defaultTokensPath(process.env);
  const tokens = readTokens(resolvedPath);
  if (tokens[key]) return tokens[key];
  const token = crypto.randomBytes(32).toString("hex");
  tokens[key] = token;
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, JSON.stringify(tokens, null, 2), "utf8");
  return token;
}

/**
 * Drops a persisted token (e.g. on Uninstall, so a stale token isn't
 * silently reused if the same host is ever re-provisioned as a fresh
 * gateway later).
 * @param {string} key
 */
function forgetApiToken(key, { configPath } = {}) {
  const resolvedPath = configPath || defaultTokensPath(process.env);
  const tokens = readTokens(resolvedPath);
  if (!(key in tokens)) return;
  delete tokens[key];
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, JSON.stringify(tokens, null, 2), "utf8");
}

module.exports = { getOrCreateApiToken, forgetApiToken, defaultTokensPath };
