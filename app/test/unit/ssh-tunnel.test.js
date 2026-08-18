"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { EventEmitter } = require("events");
const { openSshTunnel, closeSshTunnel, sshTunnelArgs } = require("../../lib/ssh-tunnel");

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
}

// Fakes ssh -N -L actually forwarding by opening a real listener on
// containerPort shortly after "spawning" -- openSshTunnel's own readiness
// check is a real waitForPortOpen, so this is the least-fake way to make it
// resolve without an actual ssh binary. Everything happens inside the
// returned spawnFn (not eagerly when this factory is called) -- openSshTunnel
// itself checks the port is free *before* invoking spawnFn, and an eagerly-
// started listener would race that check and be mistaken for "something's
// already listening", leaving a real, never-closed server dangling and
// hanging the whole test run.
function fakeSpawnThatForwards(containerPort) {
  return () => {
    const p = new EventEmitter();
    p.pid = 4242;
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.killed = false;
    p.kill = () => {
      p.killed = true;
      p.emit("exit", 0, null);
    };
    const srv = net.createServer();
    setTimeout(() => srv.listen(containerPort, "127.0.0.1"), 20);
    p._testServer = srv;
    return p;
  };
}

test("openSshTunnel logs the port check, spawn, and establishment", async () => {
  const port = await freePort();
  const lines = [];
  const handle = await openSshTunnel(
    { sshTarget: "u@h", sshKey: null, containerPort: port },
    { spawnFn: fakeSpawnThatForwards(port), sshBin: "ssh", onLog: (l) => lines.push(l) }
  );
  try {
    assert.ok(lines.some((l) => l.includes(`checking whether 127.0.0.1:${port}`)));
    assert.ok(lines.some((l) => l.includes(`127.0.0.1:${port} is free`)));
    assert.ok(lines.some((l) => l.includes("ssh tunnel process started (pid 4242)")));
    assert.ok(lines.some((l) => l.includes("ssh tunnel established (pid 4242)") && l.includes("u@h")));
  } finally {
    handle.proc._testServer.close();
    closeSshTunnel(handle);
  }
});

test("openSshTunnel refuses to shadow a port already in use, with a log line explaining why", async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const lines = [];
  try {
    await assert.rejects(
      openSshTunnel(
        { sshTarget: "u@h", sshKey: null, containerPort: port },
        { spawnFn: () => assert.fail("must not spawn ssh when the port is already taken"), onLog: (l) => lines.push(l) }
      ),
      /already listening/
    );
    assert.ok(lines.some((l) => l.includes(`checking whether 127.0.0.1:${port}`)));
  } finally {
    srv.close();
  }
});

test("openSshTunnel calls onUnexpectedExit (and logs) when the tunnel dies after being established", async () => {
  const port = await freePort();
  const lines = [];
  let unexpectedExit = null;
  const spawnFn = fakeSpawnThatForwards(port);
  const handle = await openSshTunnel(
    { sshTarget: "u@h", sshKey: null, containerPort: port },
    {
      spawnFn,
      onLog: (l) => lines.push(l),
      onUnexpectedExit: (info) => (unexpectedExit = info),
    }
  );
  handle.proc._testServer.close();
  handle.proc.emit("exit", 1, null); // simulate the real ssh process dying mid-session
  assert.deepEqual(unexpectedExit, { code: 1, signal: null });
  assert.ok(lines.some((l) => l.includes("exited unexpectedly") && l.includes(String(port))));
});

test("openSshTunnel kills the still-running process when the readiness timeout wins the race (br-TUNL-007)", async () => {
  const port = await freePort();
  const lines = [];
  const p = new EventEmitter();
  p.pid = 5150;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.killed = false;
  let killed = false;
  p.kill = () => {
    killed = true;
    p.killed = true;
    // Deliberately does NOT emit "exit" -- a real ssh process being sent
    // SIGTERM doesn't die synchronously either; the point being tested is
    // that openSshTunnel calls kill() at all; a delayed/absent exit event
    // must not be mistaken for "already exited" and skip the kill.
  };
  await assert.rejects(
    openSshTunnel(
      { sshTarget: "u@h", sshKey: null, containerPort: port },
      { spawnFn: () => p, onLog: (l) => lines.push(l), readyTimeoutMs: 30 }
    ),
    /timed out/
  );
  assert.equal(killed, true, "the never-established process must be killed, not orphaned");
  assert.ok(lines.some((l) => l.includes(`ssh tunnel (pid ${p.pid}) failed to establish -- killing it`)));
});

test("openSshTunnel does not try to kill a process that already exited before the race settled", async () => {
  const port = await freePort();
  const lines = [];
  const p = new EventEmitter();
  p.pid = 5151;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.killed = false;
  let killCalls = 0;
  p.kill = () => {
    killCalls++;
    p.killed = true;
  };
  const spawnFn = () => {
    setTimeout(() => p.emit("exit", 1, null), 5); // dies before ever forwarding
    return p;
  };
  await assert.rejects(
    openSshTunnel(
      { sshTarget: "u@h", sshKey: null, containerPort: port },
      { spawnFn, onLog: (l) => lines.push(l), readyTimeoutMs: 5000 }
    ),
    /ssh tunnel exited/
  );
  assert.equal(killCalls, 0, "a process that already exited on its own must not be killed again");
});

test("closeSshTunnel logs when it actually kills a running tunnel", () => {
  const p = new EventEmitter();
  p.pid = 99;
  p.killed = false;
  p.kill = () => (p.killed = true);
  const lines = [];
  closeSshTunnel({ proc: p }, { onLog: (l) => lines.push(l) });
  assert.equal(p.killed, true);
  assert.ok(lines.some((l) => l.includes("closing ssh tunnel (pid 99)")));
});

test("closeSshTunnel is a no-op (no log) for a null/already-dead handle", () => {
  const lines = [];
  assert.doesNotThrow(() => closeSshTunnel(null, { onLog: (l) => lines.push(l) }));
  assert.equal(lines.length, 0);
});

// br-TUNL-009: without these, an idle -L forward only notices a dead path
// via the OS's own multi-hour TCP keepalive default, and never notices at
// all a NAT/firewall/VPN that silently drops idle connection state instead
// of resetting it outright.
test("sshTunnelArgs sends SSH-level keepalive probes (br-TUNL-009)", () => {
  const args = sshTunnelArgs({ sshTarget: "u@h", sshKey: null, containerPort: 8765 });
  assert.ok(args.includes("ServerAliveInterval=15"), args.join(" "));
  assert.ok(args.includes("ServerAliveCountMax=3"), args.join(" "));
});
