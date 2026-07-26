"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readTunnels, recordTunnel, removeTunnel, killOrphanedTunnels } = require("../../lib/tunnel-registry");

function tmpPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cttc-tun-")), "tunnels.json");
}

test("readTunnels returns [] when the file doesn't exist yet", () => {
  assert.deepEqual(readTunnels({ configPath: tmpPath() }), []);
});

test("readTunnels returns [] on corrupt JSON rather than throwing", () => {
  const p = tmpPath();
  fs.writeFileSync(p, "{ not json");
  assert.deepEqual(readTunnels({ configPath: p }), []);
});

test("recordTunnel adds a new entry with a startedAt timestamp", () => {
  const p = tmpPath();
  const before = Date.now();
  const list = recordTunnel({ pid: 123, containerPort: 8765, sshTarget: "u@h" }, { configPath: p });
  assert.equal(list.length, 1);
  assert.equal(list[0].pid, 123);
  assert.ok(list[0].startedAt >= before);
  assert.deepEqual(readTunnels({ configPath: p }), list);
});

test("recordTunnel upserts by containerPort -- no duplicates", () => {
  const p = tmpPath();
  recordTunnel({ pid: 1, containerPort: 8765, sshTarget: "u@a" }, { configPath: p });
  const list = recordTunnel({ pid: 2, containerPort: 8765, sshTarget: "u@b" }, { configPath: p });
  assert.equal(list.length, 1);
  assert.equal(list[0].pid, 2);
  assert.equal(list[0].sshTarget, "u@b");
});

test("removeTunnel drops only the matching containerPort", () => {
  const p = tmpPath();
  recordTunnel({ pid: 1, containerPort: 8765, sshTarget: "u@a" }, { configPath: p });
  recordTunnel({ pid: 2, containerPort: 9000, sshTarget: "u@b" }, { configPath: p });
  const list = removeTunnel(8765, { configPath: p });
  assert.equal(list.length, 1);
  assert.equal(list[0].containerPort, 9000);
});

test("killOrphanedTunnels sends SIGTERM to every recorded pid and clears the file", () => {
  const p = tmpPath();
  const killed = [];
  const originalKill = process.kill;
  process.kill = (pid, sig) => killed.push([pid, sig]);
  try {
    recordTunnel({ pid: 111, containerPort: 8765, sshTarget: "u@a" }, { configPath: p });
    recordTunnel({ pid: 222, containerPort: 9000, sshTarget: "u@b" }, { configPath: p });
    const returned = killOrphanedTunnels({ configPath: p });
    assert.equal(returned.length, 2);
    assert.deepEqual(
      killed.sort(),
      [
        [111, "SIGTERM"],
        [222, "SIGTERM"],
      ].sort()
    );
    assert.deepEqual(readTunnels({ configPath: p }), []);
  } finally {
    process.kill = originalKill;
  }
});

test("killOrphanedTunnels tolerates a pid that's already gone", () => {
  const p = tmpPath();
  const originalKill = process.kill;
  process.kill = () => {
    throw new Error("ESRCH");
  };
  try {
    recordTunnel({ pid: 999, containerPort: 8765, sshTarget: "u@a" }, { configPath: p });
    assert.doesNotThrow(() => killOrphanedTunnels({ configPath: p }));
    assert.deepEqual(readTunnels({ configPath: p }), []);
  } finally {
    process.kill = originalKill;
  }
});

test("killOrphanedTunnels is a no-op (no write) when there's nothing recorded", () => {
  const p = tmpPath();
  killOrphanedTunnels({ configPath: p });
  assert.equal(fs.existsSync(p), false);
});
