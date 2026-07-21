"use strict";

const { spawnSync } = require("child_process");

// A local Docker Desktop/Engine means embedded mode has something to sample
// (host/container telemetry); without one there's nothing for the embedded
// server to show, so main.js offers the ssh-tunnel setup wizard instead.
function hasLocalDocker() {
  try {
    const r = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

module.exports = { hasLocalDocker };
