"use strict";

const net = require("net");

// signal lets a caller give up early and have the retry loop actually stop
// instead of continuing to poll in the background until its own deadline --
// without this, an abandoned retry chain's un-unref'd timers keep the
// process alive for the rest of timeoutMs even though the caller already
// moved on.
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

// Used after provisioning a remote server container (see
// lib/server-provision.js's ensureRemoteContainer): the container's port
// opening doesn't mean the FastAPI app inside it has actually finished
// starting up, so this polls GET /health (added for the renderer's own
// server-status indicator) instead of just a raw TCP connect.
function waitForHttpOk(url, { timeoutMs = 15000, intervalMs = 300, fetchFn = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const r = await fetchFn(url);
        if (r.ok) {
          resolve();
          return;
        }
        throw new Error(`${url}: ${r.status}`);
      } catch (err) {
        if (Date.now() >= deadline) {
          reject(new Error(`timed out waiting for ${url} to respond: ${err.message || err}`));
        } else {
          setTimeout(attempt, intervalMs).unref?.();
        }
      }
    };
    attempt();
  });
}

module.exports = { waitForPortOpen, waitForHttpOk };
