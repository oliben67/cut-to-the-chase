"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Storage for UI-hosted events' triggered snapshot/recording bytes (see
// renderer/app.js's event engine) -- same ~/.cttc/*.json-adjacent shape as
// gateway-registry.js/connection-config.js, main-process-owned since the
// actual file writing happens there (renderer has no direct fs access).
//
// Each artifact is a plain file plus a `<name>.meta.json` sidecar carrying
// its expiry, mirroring the gateway's own default-TTL-unless-safe policy
// (see server/recording_session.py) so a UI-hosted event's output ages out
// the same way a gateway-hosted one's does.

const DEFAULT_TTL_MS = 24 * 3600 * 1000;

function defaultDir(env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".cttc", "events");
}

// Writes `bytes` as `name` under `dir` (default ~/.cttc/events), with a
// sidecar recording when it expires: `safe` + `maxKeepMs` (mirroring the
// gateway's mark_safe) keep it for `maxKeepMs` instead of `ttlMs` from now.
// Returns the artifact's full path.
function saveArtifact(name, bytes, { dir, ttlMs = DEFAULT_TTL_MS, safe = false, maxKeepMs = null } = {}) {
  const resolvedDir = dir || defaultDir(process.env);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const filePath = path.join(resolvedDir, name);
  fs.writeFileSync(filePath, Buffer.from(bytes));
  const expiresAt = Date.now() + (safe && maxKeepMs ? maxKeepMs : ttlMs);
  fs.writeFileSync(filePath + ".meta.json", JSON.stringify({ expiresAt }), "utf8");
  return filePath;
}

// [{name, path, expiresAt}] for every artifact currently on disk -- corrupt
// or missing sidecars report expiresAt: null (sweepArtifacts then leaves
// them alone rather than guessing).
function listArtifacts({ dir } = {}) {
  const resolvedDir = dir || defaultDir(process.env);
  if (!fs.existsSync(resolvedDir)) return [];
  return fs
    .readdirSync(resolvedDir)
    .filter((f) => f.endsWith(".meta.json"))
    .map((metaFile) => {
      const name = metaFile.slice(0, -".meta.json".length);
      let expiresAt = null;
      try {
        expiresAt = JSON.parse(fs.readFileSync(path.join(resolvedDir, metaFile), "utf8")).expiresAt;
      } catch {
        expiresAt = null;
      }
      return { name, path: path.join(resolvedDir, name), expiresAt };
    });
}

// Deletes every artifact (+ its sidecar) whose expiresAt has passed as of
// `now`. Returns the names removed. Meant to be called periodically from
// main.js, same idea as the gateway's own tick()-driven TTL sweep.
function sweepArtifacts({ dir, now = Date.now() } = {}) {
  const removed = [];
  for (const a of listArtifacts({ dir })) {
    if (a.expiresAt != null && now > a.expiresAt) {
      try {
        fs.unlinkSync(a.path);
      } catch {
        /* already gone */
      }
      try {
        fs.unlinkSync(a.path + ".meta.json");
      } catch {
        /* already gone */
      }
      removed.push(a.name);
    }
  }
  return removed;
}

module.exports = { DEFAULT_TTL_MS, defaultDir, saveArtifact, listArtifacts, sweepArtifacts };
