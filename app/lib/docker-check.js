"use strict";

const { spawn } = require("child_process");

// A local Docker Desktop/Engine means embedded mode has something to sample
// (host/container telemetry); without one there's nothing for the embedded
// server to show, so main.js offers the ssh-tunnel setup wizard instead.
//
// Async on purpose: this used to be spawnSync, which blocks Node's event
// loop for up to its timeout. On Windows that loop is also the UI thread,
// so a freshly-installed app with no Docker Desktop (the exact case that
// sends the user to the setup wizard) froze the just-created splash window
// -- already constructed, but unable to paint its first frame -- for the
// whole multi-second probe. Doing this async lets the splash window's own
// paint/show events run while docker info is checked.
function hasLocalDocker() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let proc;
    try {
      proc = spawn("docker", ["info"], { stdio: "ignore" });
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      proc.kill();
      done(false);
    }, 5000);
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

// Per the client/server/docker-host model: this machine can only collapse
// the server role into the client (skip the setup wizard/tunnel entirely)
// if it has both Docker *and* ssh locally -- the server role requires ssh to
// reach whatever Docker host(s) it's asked to query (see server.py's
// docker_ps), not just a local daemon to sample.
function hasLocalSsh() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let proc;
    try {
      proc = spawn(process.env.CTTC_SSH_BIN || "ssh", ["-V"], { stdio: "ignore" });
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      proc.kill();
      done(false);
    }, 5000);
    proc.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      // `ssh -V` prints its version to stderr and exits 0 on OpenSSH: only
      // treat a clean exit as "ssh is present" (some minimal PATH shims
      // exit non-zero when they don't understand -V at all).
      done(code === 0);
    });
  });
}

module.exports = { hasLocalDocker, hasLocalSsh };
