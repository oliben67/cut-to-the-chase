"use strict";

const { spawn } = require("child_process");

// Async on purpose: this used to be spawnSync, which blocks Node's event
// loop for up to its timeout. On Windows that loop is also the UI thread,
// so a freshly-installed app with no Docker Desktop (the exact case that
// sends the user to the setup wizard) froze the just-created splash window
// -- already constructed, but unable to paint its first frame -- for the
// whole multi-second probe. Doing this async lets the splash window's own
// paint/show events run while the probe is in flight.
//
// spawnFn is injectable for testing (see test/unit/docker-check.test.js).
function probe(bin, args, { spawnFn = spawn, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let proc;
    try {
      proc = spawnFn(bin, args, { stdio: "ignore" });
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      proc.kill();
      done(false);
    }, timeoutMs);
    proc.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

// A local Docker Desktop/Engine means embedded mode has something to sample
// (host/container telemetry); without one there's nothing for the embedded
// server to show, so main.js offers the remote-server setup wizard instead.
function hasLocalDocker(opts) {
  return probe("docker", ["info"], opts);
}

// Per the client/server/docker-host model: this machine can only collapse
// the server role into the client (skip the setup wizard/tunnel entirely)
// if it has both Docker *and* ssh locally -- the server role requires ssh to
// reach whatever Docker host(s) it's asked to query (see server.py's
// docker_ps), not just a local daemon to sample.
//
// `ssh -V` prints its version to stderr and exits 0 on OpenSSH: a clean exit
// is the signal, not the output (some minimal PATH shims exit non-zero when
// they don't understand -V at all).
function hasLocalSsh(opts) {
  return probe(process.env.CTTC_SSH_BIN || "ssh", ["-V"], opts);
}

// See canBeServerLocally in main.js for why both are required, not either.
async function canBeServerLocally(opts) {
  const [docker, ssh] = await Promise.all([hasLocalDocker(opts), hasLocalSsh(opts)]);
  return docker && ssh;
}

module.exports = { hasLocalDocker, hasLocalSsh, canBeServerLocally };
