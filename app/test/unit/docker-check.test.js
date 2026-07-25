"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { hasLocalDocker, hasLocalSsh, canBeServerLocally } = require("../../lib/docker-check");

function fakeChild() {
  const p = new EventEmitter();
  p.kill = () => {};
  return p;
}

// spawnFn/timeoutMs are injectable on every probe (see lib/docker-check.js's
// probe()) -- these tests never touch a real `docker`/`ssh` binary.
function spawnThatExits(code) {
  return () => {
    const p = fakeChild();
    setTimeout(() => p.emit("exit", code), 5);
    return p;
  };
}

function spawnThatErrors() {
  return () => {
    const p = fakeChild();
    setTimeout(() => p.emit("error", new Error("ENOENT")), 5);
    return p;
  };
}

test("hasLocalDocker resolves true on a clean exit (docker info succeeded)", async () => {
  assert.equal(await hasLocalDocker({ spawnFn: spawnThatExits(0) }), true);
});

test("hasLocalDocker resolves false on a non-zero exit (no daemon reachable)", async () => {
  assert.equal(await hasLocalDocker({ spawnFn: spawnThatExits(1) }), false);
});

test("hasLocalDocker resolves false when spawning the binary itself fails", async () => {
  assert.equal(await hasLocalDocker({ spawnFn: spawnThatErrors() }), false);
});

test("hasLocalDocker resolves false if spawn() throws synchronously", async () => {
  const spawnFn = () => {
    throw new Error("posix_spawn failed");
  };
  assert.equal(await hasLocalDocker({ spawnFn }), false);
});

test("hasLocalDocker resolves false (not hung) once the timeout elapses", async () => {
  const killed = { called: false };
  const spawnFn = () => {
    const p = fakeChild();
    p.kill = () => {
      killed.called = true;
    };
    return p; // never exits on its own
  };
  const start = Date.now();
  assert.equal(await hasLocalDocker({ spawnFn, timeoutMs: 50 }), false);
  assert.ok(Date.now() - start < 2000, "should resolve at the timeout, not hang");
  assert.equal(killed.called, true, "the hung process should be killed");
});

test("hasLocalSsh resolves true on a clean exit (ssh -V succeeded)", async () => {
  assert.equal(await hasLocalSsh({ spawnFn: spawnThatExits(0) }), true);
});

test("hasLocalSsh resolves false on a non-zero exit", async () => {
  assert.equal(await hasLocalSsh({ spawnFn: spawnThatExits(1) }), false);
});

test("hasLocalSsh resolves false when the ssh binary is missing", async () => {
  assert.equal(await hasLocalSsh({ spawnFn: spawnThatErrors() }), false);
});

test("canBeServerLocally is true only when both Docker and ssh are present", async () => {
  let call = 0;
  // hasLocalDocker and hasLocalSsh each call probe() once, concurrently, in
  // that order -- first invocation is docker, second is ssh.
  const spawnFn = () => {
    const p = fakeChild();
    const ok = call === 0; // docker: ok, ssh: fails
    call++;
    setTimeout(() => p.emit("exit", ok ? 0 : 1), 5);
    return p;
  };
  assert.equal(await canBeServerLocally({ spawnFn }), false);
});

test("canBeServerLocally is true when both probes succeed", async () => {
  assert.equal(await canBeServerLocally({ spawnFn: spawnThatExits(0) }), true);
});

test("canBeServerLocally is false when both probes fail", async () => {
  assert.equal(await canBeServerLocally({ spawnFn: spawnThatExits(1) }), false);
});

test("hasLocalDocker respects CTTC_SSH_BIN only for the ssh probe, not docker", async () => {
  let captured = null;
  const spawnFn = (bin, args) => {
    captured = bin;
    const p = fakeChild();
    setTimeout(() => p.emit("exit", 0), 5);
    return p;
  };
  await hasLocalDocker({ spawnFn });
  assert.equal(captured, "docker");
});
