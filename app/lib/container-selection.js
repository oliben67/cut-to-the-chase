"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Remembers which containers/services were actually *selected* (ticked,
// plotted) for a given Docker daemon across app restarts and across
// Set/Edit Docker Daemon sessions -- one plain JSON file per daemon,
// `~/.cttc/[user]@[gateway]-containers.json`, so "was this checked before"
// has a durable source of truth that survives a relaunch, independent of
// whatever's currently open/tracked in this one session.
//
// Distinct from gateway-registry.js (which host to connect *to*) and
// connection-config.js (the *active* connection) -- this is purely "which
// of that daemon's containers does the user actually want plotted".

function defaultDir(env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".cttc");
}

// hostKey is "local" (the embedded/local daemon) or a full
// "ssh://user@host[:port]" target (see normalizeDockerHost/
// currentDockerHost in app.js) -- turns either into a filename-safe
// "[user]@[gateway]" identity. The local daemon has no ssh user of its
// own, so this machine's OS user stands in for it.
function identityForHostKey(hostKey, osUsername = os.userInfo().username) {
  if (!hostKey || hostKey === "local") return `${osUsername}@local`;
  const m = /^ssh:\/\/(?:([^@]+)@)?([^:/]+)/.exec(hostKey);
  if (!m) return `${osUsername}@${hostKey}`;
  const [, user, host] = m;
  return `${user || osUsername}@${host}`;
}

function fileForHostKey(hostKey, { dir, osUsername } = {}) {
  const resolvedDir = dir || defaultDir(process.env);
  return path.join(resolvedDir, `${identityForHostKey(hostKey, osUsername)}-containers.json`);
}

// {containers: [], services: []} on any read failure (missing file,
// corrupt JSON, wrong shape) -- a blank slate is always a safe fallback
// here, never worth throwing over. Container/service names are kept
// separate (not one flat list) since "docker logs" vs "docker service
// logs" targets are looked up differently on the way back in.
function readSelectedContainers(hostKey, opts = {}) {
  const file = fileForHostKey(hostKey, opts);
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      containers: Array.isArray(data.containers) ? data.containers : [],
      services: Array.isArray(data.services) ? data.services : [],
    };
  } catch {
    return { containers: [], services: [] };
  }
}

function writeSelectedContainers(hostKey, { containers = [], services = [] } = {}, opts = {}) {
  const resolvedDir = opts.dir || defaultDir(process.env);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const file = fileForHostKey(hostKey, opts);
  const body = {
    containers: [...new Set(containers)].sort(),
    services: [...new Set(services)].sort(),
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
  return file;
}

// Used when a saved daemon is permanently removed (not just disconnected --
// see "Remove Docker Daemon" in app.js) -- ENOENT (already gone, or never
// had a selection file at all) is not an error here, same tolerant
// treat-as-blank-slate stance as readSelectedContainers above.
function deleteSelectedContainers(hostKey, opts = {}) {
  const file = fileForHostKey(hostKey, opts);
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

module.exports = {
  identityForHostKey,
  fileForHostKey,
  readSelectedContainers,
  writeSelectedContainers,
  deleteSelectedContainers,
};
