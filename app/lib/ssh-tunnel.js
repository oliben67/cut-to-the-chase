"use strict";

const { spawn } = require("child_process");
const { waitForPortOpen } = require("./net-wait");

// Fallback transport for a remote gateway the client can't reach directly
// over HTTP (see main.js's connectRemoteGateway) -- e.g. a firewall/NAT that
// allows outbound SSH but blocks inbound HTTP to the container's published
// port. Forwards this machine's 127.0.0.1:containerPort to
// localhost:containerPort as seen *from the remote host* (the container
// port is published on its own loopback there), so the client can keep
// talking to http://127.0.0.1:containerPort exactly as it would to a local
// embedded server -- server.py itself never knows the difference.
function sshTunnelArgs({ sshTarget, sshKey, sshPort, containerPort }) {
  const args = [
    "-N", // no remote command -- just hold the forward open
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    // fails fast (instead of leaving a shell process that never forwards
    // anything) if the remote sshd refuses this specific -L for any reason
    "-o", "ExitOnForwardFailure=yes",
    "-L", `${containerPort}:localhost:${containerPort}`,
  ];
  if (sshKey) args.push("-i", sshKey, "-o", "IdentitiesOnly=yes");
  if (sshPort) args.push("-p", String(sshPort));
  args.push(sshTarget);
  return args;
}

/**
 * Opens a persistent `ssh -N -L` tunnel and waits for the local end to
 * actually come up before resolving -- a slow/misconfigured ssh can spawn
 * successfully and still take a moment (or never) to establish the forward,
 * so "the process started" alone isn't enough to call this connected.
 * @param {{sshTarget: string, sshKey: string|null, sshPort?: number, containerPort: number}} cfg
 * @returns {Promise<{proc: import("child_process").ChildProcess}>}
 */
async function openSshTunnel(cfg, { spawnFn = spawn, sshBin = "ssh", onLog } = {}) {
  // Refuse to shadow whatever's already using this port locally: the
  // readiness check below is just "is *something* listening on
  // 127.0.0.1:containerPort", which a leftover local "This machine"
  // container (same fixed container port) or an orphaned tunnel from a
  // crashed previous session would already satisfy *before* ssh even
  // starts. Without this check, that pre-existing occupant would make the
  // race below look like a successful connect, and every request would
  // silently go to the wrong server instead of this gateway (e.g. a 404 on
  // a route the stale/local one doesn't have).
  const alreadyOpen = await waitForPortOpen("127.0.0.1", cfg.containerPort, { timeoutMs: 300 }).then(
    () => true,
    () => false
  );
  if (alreadyOpen) {
    throw new Error(
      `something is already listening on 127.0.0.1:${cfg.containerPort} -- close it before connecting to this gateway ` +
        `(e.g. a local "This machine" container on the same port, or a tunnel left over from a previous session)`
    );
  }

  const args = sshTunnelArgs(cfg);
  onLog?.(`$ ${sshBin} ${args.join(" ")}`);
  const proc = spawnFn(sshBin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let exited = false;
  proc.stdout?.on("data", (d) => onLog?.(String(d)));
  proc.stderr?.on("data", (d) => {
    stderr += d;
    onLog?.(String(d));
  });

  const exitPromise = new Promise((_resolve, reject) => {
    proc.once("error", (err) => {
      exited = true;
      reject(new Error(`could not start ${sshBin}: ${err.message}`));
    });
    proc.once("exit", (code) => {
      exited = true;
      if (code !== 0) reject(new Error(`ssh tunnel exited (code ${code}): ${stderr.trim() || "no output"}`));
    });
  });

  const readyPromise = waitForPortOpen("127.0.0.1", cfg.containerPort, { timeoutMs: 15000 }).then(() => {
    if (exited) throw new Error("ssh tunnel exited before the forwarded port opened");
    return { proc };
  });

  return Promise.race([readyPromise, exitPromise]);
}

/** Kills a tunnel opened by openSshTunnel(). Safe to call with null/already-dead. */
function closeSshTunnel(handle) {
  if (handle?.proc && !handle.proc.killed) {
    try {
      handle.proc.kill();
    } catch {
      /* best-effort */
    }
  }
}

module.exports = { sshTunnelArgs, openSshTunnel, closeSshTunnel };
