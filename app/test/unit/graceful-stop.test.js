"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { gracefulStop } = require("../../lib/graceful-stop");

function fakeProc() {
  const p = new EventEmitter();
  p.killed = false;
  p.kill = () => {
    p.killed = true;
    p.emit("exit", 0, "SIGTERM");
  };
  return p;
}

test("gracefulStop resolves immediately when there is no process to stop", async () => {
  await gracefulStop(null, { stopUrl: "http://x/shutdown" });
  await gracefulStop(undefined, { stopUrl: "http://x/shutdown" });
});

test("gracefulStop resolves once the process exits after a successful /shutdown POST, without killing it", async () => {
  const proc = fakeProc();
  const calledUrls = [];
  const fetchFn = async (url, opts) => {
    calledUrls.push({ url, method: opts.method });
    setTimeout(() => proc.emit("exit", 0, null), 5); // server shuts down gracefully, on its own
    return { ok: true };
  };
  await gracefulStop(proc, { stopUrl: "http://h:1/shutdown", fetchFn, killGraceMs: 5000 });
  assert.deepEqual(calledUrls, [{ url: "http://h:1/shutdown", method: "POST" }]);
  assert.equal(proc.killed, false, "a process that exited gracefully on its own must not also be force-killed");
});

test("gracefulStop force-kills the process if it hasn't exited within killGraceMs (br-EMBED-002)", async () => {
  const proc = fakeProc();
  const lines = [];
  // Simulates a wedged server (or a /shutdown POST that silently fails) --
  // fetchFn never resolves and the process never exits on its own.
  const fetchFn = () => new Promise(() => {});
  await gracefulStop(proc, {
    stopUrl: "http://h:1/shutdown",
    fetchFn,
    killGraceMs: 20,
    onLog: (l) => lines.push(l),
  });
  assert.equal(proc.killed, true, "a server that never exits on its own must still be killed before we resolve");
  assert.ok(lines.some((l) => l.includes("killing it")));
});

test("gracefulStop logs (but does not throw) when the /shutdown POST itself rejects, and still falls back to killing", async () => {
  const proc = fakeProc();
  const fetchFn = async () => {
    throw new Error("ECONNREFUSED");
  };
  const lines = [];
  await gracefulStop(proc, {
    stopUrl: "http://h:1/shutdown",
    fetchFn,
    killGraceMs: 20,
    onLog: (l) => lines.push(l),
  });
  assert.equal(proc.killed, true);
  assert.ok(lines.some((l) => l.includes("graceful shutdown POST failed") && l.includes("ECONNREFUSED")));
});

test("gracefulStop never calls kill() twice (settled guard) when exit races the grace timer", async () => {
  const proc = fakeProc();
  let killCalls = 0;
  const realKill = proc.kill;
  proc.kill = (...a) => {
    killCalls++;
    realKill.apply(proc, a);
  };
  const fetchFn = async () => {
    setTimeout(() => proc.emit("exit", 0, null), 5);
    return { ok: true };
  };
  await gracefulStop(proc, { stopUrl: "http://h:1/shutdown", fetchFn, killGraceMs: 20 });
  assert.equal(killCalls, 0);
});
