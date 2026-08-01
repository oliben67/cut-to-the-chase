"use strict";

// Shared by main.js's stopServer(): POSTs a graceful /shutdown to the
// embedded server, then force-kills the process if it hasn't actually exited
// within killGraceMs -- extracted into its own module (main.js itself can't
// be required outside a real Electron process, so this is the only piece of
// that sequencing that's unit-testable) after br-EMBED-002: the fallback
// kill used to live on an uncoordinated `setTimeout` that the app's own
// before-quit handler could (and did) race straight past, force-quitting the
// whole app before the 1500ms timer ever got a chance to run and leaking an
// orphaned server (and its redis-server child) behind. Callers must now
// `await` the returned promise before actually quitting, so the fallback is
// guaranteed to either run to completion or never be needed (the process
// already exited gracefully) before the app tears down for real.
async function gracefulStop(proc, { stopUrl, fetchFn = fetch, killGraceMs = 1500, onLog } = {}) {
  if (!proc) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    proc.once("exit", finish);
    try {
      fetchFn(stopUrl, { method: "POST" }).catch((err) => onLog?.(`graceful shutdown POST failed: ${err.message}`));
    } catch (err) {
      onLog?.(`graceful shutdown POST failed: ${err.message}`);
    }
    setTimeout(() => {
      if (settled) return;
      onLog?.(`server did not exit within ${killGraceMs}ms of the graceful shutdown request -- killing it`);
      proc.kill();
      finish();
    }, killGraceMs);
  });
}

module.exports = { gracefulStop };
