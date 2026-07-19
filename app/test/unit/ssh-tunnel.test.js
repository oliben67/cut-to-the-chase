"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { EventEmitter } = require("events");
const { getFreeLocalPort, buildSshArgs, waitForPortOpen, startTunnel } = require("../../lib/ssh-tunnel");

test("getFreeLocalPort returns a usable, distinct port each call", async () => {
  const a = await getFreeLocalPort();
  const b = await getFreeLocalPort();
  assert.ok(Number.isInteger(a) && a > 0 && a < 65536);
  assert.notEqual(a, b);
  // and it's actually bindable right after being handed back
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(a, "127.0.0.1", () => srv.close(resolve));
  });
});

test("buildSshArgs shapes the -L forward and safety options", () => {
  const args = buildSshArgs({ localPort: 4001, remotePort: 8765, sshTarget: "deploy@host", sshKey: null });
  assert.deepEqual(args, [
    "-N", "-L", "127.0.0.1:4001:127.0.0.1:8765",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=10",
    "deploy@host",
  ]);
});

test("buildSshArgs adds -i/IdentitiesOnly when a key is given, target stays last", () => {
  const args = buildSshArgs({ localPort: 1, remotePort: 2, sshTarget: "deploy@host", sshKey: "/k" });
  assert.ok(args.includes("-i"));
  assert.equal(args[args.indexOf("-i") + 1], "/k");
  assert.ok(args.includes("IdentitiesOnly=yes"));
  assert.equal(args[args.length - 1], "deploy@host");
});

test("waitForPortOpen resolves once something is listening", async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await waitForPortOpen("127.0.0.1", port, { timeoutMs: 2000 });
  srv.close();
});

test("waitForPortOpen retries until the port opens", async () => {
  const port = await getFreeLocalPort();
  let srv;
  const opener = setTimeout(() => {
    srv = net.createServer();
    srv.listen(port, "127.0.0.1");
  }, 300);
  try {
    await waitForPortOpen("127.0.0.1", port, { timeoutMs: 3000, intervalMs: 50 });
  } finally {
    clearTimeout(opener);
    srv?.close();
  }
});

test("waitForPortOpen rejects on timeout when nothing ever listens", async () => {
  const port = await getFreeLocalPort();
  await assert.rejects(
    waitForPortOpen("127.0.0.1", port, { timeoutMs: 300, intervalMs: 50 }),
    /timed out waiting/
  );
});

// ── startTunnel orchestration, with a fake child process (no real spawn) ──

function fakeChild() {
  const p = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => { p.killed = true; p.emit("exit", null, "SIGTERM"); };
  return p;
}

test("startTunnel resolves {localPort, stop} once the forwarded port opens", async () => {
  let spawnedWith = null;
  const spawnFn = (bin, args) => {
    spawnedWith = { bin, args };
    const p = fakeChild();
    const localPort = Number(args[2].split(":")[1]);
    // simulate ssh having established the forward: open that local port ourselves
    const srv = net.createServer();
    srv.listen(localPort, "127.0.0.1");
    p.__srv = srv;
    p.kill = () => { p.killed = true; srv.close(); p.emit("exit", 0, null); };
    return p;
  };
  const tunnel = await startTunnel(
    { sshTarget: "deploy@host", sshKey: null, remotePort: 8765 },
    { spawnFn, timeoutMs: 3000 }
  );
  assert.ok(Number.isInteger(tunnel.localPort));
  assert.equal(spawnedWith.bin, "ssh");
  assert.ok(spawnedWith.args.includes("deploy@host"));
  tunnel.stop();
});

test("startTunnel rejects promptly if the child exits before the port opens", async () => {
  const spawnFn = () => {
    const p = fakeChild();
    setTimeout(() => {
      p.stderr.emit("data", Buffer.from("Permission denied (publickey)\n"));
      p.emit("exit", 255, null);
    }, 20);
    return p;
  };
  const start = Date.now();
  await assert.rejects(
    startTunnel({ sshTarget: "deploy@host", sshKey: null, remotePort: 8765 }, { spawnFn, timeoutMs: 15000 }),
    /Permission denied/
  );
  assert.ok(Date.now() - start < 2000, "should fail fast on child exit, not wait out the full timeout");
});

test("startTunnel surfaces a spawn error (e.g. ssh binary missing)", async () => {
  const spawnFn = () => {
    const p = fakeChild();
    setTimeout(() => p.emit("error", new Error("ENOENT")), 10);
    return p;
  };
  await assert.rejects(
    startTunnel({ sshTarget: "deploy@host", sshKey: null, remotePort: 8765 }, { spawnFn, timeoutMs: 15000 }),
    /could not start ssh/
  );
});

test("startTunnel rejects on timeout when the child never opens the port or exits", async () => {
  const spawnFn = () => fakeChild(); // never emits exit, never opens anything
  await assert.rejects(
    startTunnel({ sshTarget: "deploy@host", sshKey: null, remotePort: 8765 }, { spawnFn, timeoutMs: 300 }),
    /timed out waiting/
  );
});
