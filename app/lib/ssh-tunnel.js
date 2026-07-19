"use strict";

const net = require("net");
const { spawn } = require("child_process");

// Bind :0 to get an OS-assigned free port, then close it immediately so ssh
// can bind the same port. There's an inherent (tiny) race between the close
// and ssh's bind -- acceptable here since a lost race just means ssh fails
// to bind and startTunnel() surfaces that as a normal tunnel-start error.
function getFreeLocalPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function buildSshArgs({ localPort, remotePort, sshTarget, sshKey }) {
  const args = [
    "-N", "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    "-o", "BatchMode=yes",           // never prompt -- fail instead of hanging on a password
    "-o", "ExitOnForwardFailure=yes", // if the forward itself can't bind, exit rather than sit there
    "-o", "ConnectTimeout=10",
  ];
  if (sshKey) args.push("-i", sshKey, "-o", "IdentitiesOnly=yes");
  args.push(sshTarget);
  return args;
}

// signal lets a caller give up early (e.g. startTunnel's ssh-exited race) and
// have the retry loop actually stop instead of continuing to poll in the
// background until its own deadline -- without this, an abandoned retry
// chain's un-unref'd timers keep the process alive for the rest of timeoutMs
// even though the caller already moved on.
function waitForPortOpen(host, port, { timeoutMs = 15000, intervalMs = 150, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("waitForPortOpen aborted")); return; }
    let sockInFlight = null;
    const onAbort = () => {
      sockInFlight?.destroy();
      reject(new Error("waitForPortOpen aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const attempt = () => {
      const sock = net.connect({ host, port });
      sockInFlight = sock;
      sock.once("connect", () => {
        cleanup();
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (signal?.aborted) return; // onAbort already rejected
        if (Date.now() >= deadline) {
          cleanup();
          reject(new Error(`timed out waiting for ${host}:${port} to open`));
        } else {
          setTimeout(attempt, intervalMs).unref?.();
        }
      });
    };
    attempt();
  });
}

/**
 * Start an SSH local-port-forward to a remote server container and wait
 * until the local end is actually accepting connections. Mirrors
 * main.js's startServer() shape: resolves to {localPort, stop()}.
 *
 * @param {{sshTarget: string, sshKey: string|null, remotePort: number}} cfg
 * @param {{spawnFn?: Function, sshBin?: string, timeoutMs?: number}} [opts]
 *   spawnFn/sshBin are injectable for testing (see test/unit/ssh-tunnel.test.js).
 */
async function startTunnel(cfg, { spawnFn = spawn, sshBin = "ssh", timeoutMs = 15000 } = {}) {
  const localPort = await getFreeLocalPort();
  const args = buildSshArgs({ localPort, remotePort: cfg.remotePort, sshTarget: cfg.sshTarget, sshKey: cfg.sshKey });
  const proc = spawnFn(sshBin, args, { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  proc.stderr?.on("data", (d) => { stderr += d; });
  let exited = false;
  let exitError = null;
  const markExit = (err) => {
    exited = true;
    exitError = err;
  };
  proc.on("error", (err) => markExit(new Error(`could not start ${sshBin}: ${err.message}`)));
  proc.on("exit", (code, signal) => {
    if (!exited && code !== 0 && code !== null) {
      markExit(new Error(`ssh tunnel exited (code ${code}): ${stderr.trim() || "no output"}`));
    } else if (!exited) {
      markExit(signal ? new Error(`ssh tunnel killed by ${signal}`) : null);
    }
  });

  const abortWait = new AbortController();
  try {
    await Promise.race([
      waitForPortOpen("127.0.0.1", localPort, { timeoutMs, signal: abortWait.signal }),
      new Promise((_, reject) => {
        const check = setInterval(() => {
          if (exited) {
            clearInterval(check);
            reject(exitError || new Error("ssh tunnel exited before it was ready"));
          }
        }, 100);
        check.unref?.();
      }),
    ]);
  } catch (err) {
    if (!exited) proc.kill();
    throw err;
  } finally {
    // whichever branch won, stop any still-pending port-open retries so their
    // timers don't keep the process alive for the rest of the original timeout
    abortWait.abort();
  }

  // Note: no reconnect/keep-alive here -- if ssh dies later (network drop,
  // remote reboot) after a successful start, the caller isn't notified.
  // That's fine for phase 1 (fetches to the now-dead local port will just
  // start failing, surfaced the same way "server unreachable" is today);
  // auto-reconnect is a reasonable phase-2 addition if this proves flaky.
  return {
    localPort,
    stop() {
      if (!exited) proc.kill();
    },
  };
}

module.exports = { getFreeLocalPort, buildSshArgs, waitForPortOpen, startTunnel };
