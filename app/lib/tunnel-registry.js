"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Tracks the OS process id of every ssh -N -L tunnel this client has ever
// opened (lib/ssh-tunnel.js's openSshTunnel), keyed by the local port it
// forwards. A tunnel is this process's own child, so an orderly quit
// (app.on("before-quit"), switch-gateway, uninstall -- see main.js) always
// closes it and removes its entry here. But an unclean exit (crash, force
// quit, killed by an installer overwrite/uninstall while running) leaves
// the child ssh process running with nobody left to close it: it just sits
// on 127.0.0.1:<port> forever, silently satisfying ssh-tunnel.js's own
// "something is already listening" guard on every future launch and
// blocking every reconnect attempt with no obvious cause. Recording the pid
// here lets the next launch (see main.js's app.whenReady) find and kill any
// tunnel nothing is using anymore *before* attempting a new one.

function defaultTunnelsPath(env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".cttc", "tunnels.json");
}

function readTunnels({ configPath } = {}) {
  const resolvedPath = configPath || defaultTunnelsPath(process.env);
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

function writeTunnels(list, { configPath } = {}) {
  const resolvedPath = configPath || defaultTunnelsPath(process.env);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, JSON.stringify(list, null, 2), "utf8");
}

/**
 * Upserts one tunnel entry (matched by containerPort -- only one tunnel can
 * actually own a given local port at a time) right after openSshTunnel
 * resolves.
 * @param {{pid: number, containerPort: number, sshTarget: string}} entry
 */
function recordTunnel(entry, { configPath } = {}) {
  const list = readTunnels({ configPath });
  const next = list.filter((t) => t.containerPort !== entry.containerPort);
  next.push({ ...entry, startedAt: Date.now() });
  writeTunnels(next, { configPath });
  return next;
}

/** Drops one tunnel entry (matched by containerPort). Called right after closeSshTunnel(). */
function removeTunnel(containerPort, { configPath } = {}) {
  const list = readTunnels({ configPath });
  const next = list.filter((t) => t.containerPort !== containerPort);
  writeTunnels(next, { configPath });
  return next;
}

/**
 * Best-effort kill of every tunnel recorded from a previous run, then wipes
 * the file -- called once at startup, before this session opens any tunnel
 * of its own, so a stale one left behind by an unclean exit can never block
 * a fresh connect. Tolerates pids that are already gone (the normal case:
 * most exits *are* clean) or that error for any other reason (never worth
 * failing startup over) -- onLog reports which of the two happened for
 * each, since this is exactly the step that silently fixes (or fails to
 * fix) a "tunnel never establishes" report with no error of its own.
 */
function killOrphanedTunnels({ configPath, onLog } = {}) {
  const list = readTunnels({ configPath });
  if (!list.length) {
    onLog?.("no leftover tunnels recorded from a previous session");
    return list;
  }
  onLog?.(`found ${list.length} leftover tunnel(s) recorded from a previous session`);
  for (const t of list) {
    try {
      process.kill(t.pid, "SIGTERM");
      onLog?.(`killed orphaned ssh tunnel (pid ${t.pid}, was forwarding port ${t.containerPort} to ${t.sshTarget})`);
    } catch (err) {
      onLog?.(`orphaned tunnel pid ${t.pid} (port ${t.containerPort}, ${t.sshTarget}) already gone: ${err.message}`);
    }
  }
  writeTunnels([], { configPath });
  return list;
}

module.exports = { defaultTunnelsPath, readTunnels, recordTunnel, removeTunnel, killOrphanedTunnels };
