"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  readGateways,
  recordGateway,
  gatewayKey,
  recordDockerHostForGateway,
  retireGateway,
  retireDockerHost,
} = require("../../lib/gateway-registry");

function tmpPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cttc-gw-")), "gateways.json");
}

test("readGateways returns [] when the file doesn't exist yet", () => {
  assert.deepEqual(readGateways({ configPath: tmpPath() }), []);
});

test("readGateways returns [] on corrupt JSON rather than throwing", () => {
  const p = tmpPath();
  fs.writeFileSync(p, "{ not json");
  assert.deepEqual(readGateways({ configPath: p }), []);
});

test("recordGateway adds a new entry with a lastUsed timestamp", () => {
  const p = tmpPath();
  const before = Date.now();
  const list = recordGateway({ mode: "embedded", host: "127.0.0.1", port: 8765, label: "This machine" }, { configPath: p });
  assert.equal(list.length, 1);
  assert.equal(list[0].label, "This machine");
  assert.ok(list[0].lastUsed >= before);
  assert.deepEqual(readGateways({ configPath: p }), list);
});

test("recordGateway upserts by host:port -- no duplicates, moved to front", () => {
  const p = tmpPath();
  recordGateway({ mode: "remote", host: "a.example.com", port: 8765, label: "deploy@a" }, { configPath: p });
  recordGateway({ mode: "remote", host: "b.example.com", port: 8765, label: "deploy@b" }, { configPath: p });
  const list = recordGateway(
    { mode: "remote", host: "a.example.com", port: 8765, label: "deploy@a (renamed)" },
    { configPath: p }
  );
  assert.equal(list.length, 2, "still only two distinct gateways");
  assert.equal(list[0].label, "deploy@a (renamed)", "re-recorded entry moved to the front");
  assert.equal(list[0].host, "a.example.com");
  assert.equal(list[1].host, "b.example.com");
});

test("gatewayKey combines host and port", () => {
  assert.equal(gatewayKey({ host: "h", port: 1 }), "h:1");
});

test("gatewayKey collapses the embedded gateway to a stable key regardless of its (ephemeral) port", () => {
  assert.equal(gatewayKey({ mode: "embedded", host: "127.0.0.1", port: 1111 }), "embedded");
  assert.equal(gatewayKey({ mode: "embedded", host: "127.0.0.1", port: 2222 }), "embedded");
  assert.equal(gatewayKey({ host: "127.0.0.1", port: 3333 }), "embedded", "127.0.0.1 alone is enough, mode isn't required");
});

test("recordGateway preserves extra fields (sshTarget/sshKey/sshPort) for remote entries", () => {
  const p = tmpPath();
  const list = recordGateway(
    { mode: "remote", host: "h", port: 8765, label: "deploy@h", sshTarget: "deploy@h", sshKey: "/k", sshPort: 2222 },
    { configPath: p }
  );
  assert.equal(list[0].sshTarget, "deploy@h");
  assert.equal(list[0].sshKey, "/k");
  assert.equal(list[0].sshPort, 2222);
});

test("recordGateway preserves fields it doesn't know about (e.g. dockerHosts) on a routine re-record", () => {
  const p = tmpPath();
  recordGateway({ mode: "embedded", host: "127.0.0.1", port: 8765, label: "This machine" }, { configPath: p });
  recordDockerHostForGateway("embedded", { hostKey: "local", host: null }, { configPath: p });
  const list = recordGateway({ mode: "embedded", host: "127.0.0.1", port: 8765, label: "This machine", connectionType: "local" }, { configPath: p });
  assert.equal(list[0].connectionType, "local");
  assert.equal(list[0].dockerHosts.length, 1, "dockerHosts survives an unrelated re-record");
  assert.equal(list[0].dockerHosts[0].hostKey, "local");
});

test("recordGateway doesn't duplicate the embedded gateway when its port changes across restarts (regression)", () => {
  const p = tmpPath();
  recordGateway({ mode: "embedded", host: "127.0.0.1", port: 1111, label: "This machine" }, { configPath: p });
  recordDockerHostForGateway("embedded", { hostKey: "local", host: null }, { configPath: p });
  const list = recordGateway({ mode: "embedded", host: "127.0.0.1", port: 2222, label: "This machine" }, { configPath: p });
  assert.equal(list.length, 1, "still a single entry despite the port change");
  assert.equal(list[0].port, 2222, "port updated to the new one");
  assert.equal(list[0].dockerHosts.length, 1, "dockerHosts recorded under the old port survives");
});

test("recordDockerHostForGateway adds a Docker host under its matching gateway", () => {
  const p = tmpPath();
  recordGateway({ mode: "remote", host: "h", port: 8765, label: "deploy@h" }, { configPath: p });
  const list = recordDockerHostForGateway("h:8765", { hostKey: "ssh://user@other", host: "ssh://user@other" }, { configPath: p });
  assert.equal(list[0].dockerHosts.length, 1);
  assert.equal(list[0].dockerHosts[0].hostKey, "ssh://user@other");
  assert.ok(list[0].dockerHosts[0].lastUsed);
});

test("recordDockerHostForGateway upserts by hostKey -- no duplicates, moved to front", () => {
  const p = tmpPath();
  recordGateway({ mode: "remote", host: "h", port: 8765, label: "deploy@h" }, { configPath: p });
  recordDockerHostForGateway("h:8765", { hostKey: "local" }, { configPath: p });
  recordDockerHostForGateway("h:8765", { hostKey: "ssh://user@other" }, { configPath: p });
  const list = recordDockerHostForGateway("h:8765", { hostKey: "local" }, { configPath: p });
  assert.equal(list[0].dockerHosts.length, 2, "still only two distinct docker hosts");
  assert.equal(list[0].dockerHosts[0].hostKey, "local", "re-recorded host moved to the front");
});

test("recordDockerHostForGateway is a no-op when the gateway key doesn't match anything", () => {
  const p = tmpPath();
  recordGateway({ mode: "remote", host: "h", port: 8765, label: "deploy@h" }, { configPath: p });
  const list = recordDockerHostForGateway("nope:1", { hostKey: "local" }, { configPath: p });
  assert.equal(list.length, 1);
  assert.equal(list[0].dockerHosts, undefined);
});

/* ── id / retired / retiredAt (the real, sole identifier) ─────────────── */

test("a freshly recorded gateway gets an id and is not retired", () => {
  const p = tmpPath();
  const list = recordGateway({ mode: "remote", host: "h", port: 8765, label: "deploy@h" }, { configPath: p });
  assert.equal(typeof list[0].id, "string");
  assert.ok(list[0].id.length > 0);
  assert.equal(list[0].retired, false);
  assert.equal(list[0].retiredAt, null);
});

test("re-recording an existing gateway preserves its id, not a fresh one", () => {
  const p = tmpPath();
  const first = recordGateway({ mode: "remote", host: "h", port: 8765, label: "deploy@h" }, { configPath: p });
  const originalId = first[0].id;
  const second = recordGateway({ mode: "remote", host: "h", port: 8765, label: "renamed" }, { configPath: p });
  assert.equal(second[0].id, originalId);
});

test("a freshly recorded Docker host gets an id and is not retired", () => {
  const p = tmpPath();
  recordGateway({ mode: "remote", host: "h", port: 8765, label: "deploy@h" }, { configPath: p });
  const list = recordDockerHostForGateway("h:8765", { hostKey: "ssh://user@other" }, { configPath: p });
  const dh = list[0].dockerHosts[0];
  assert.equal(typeof dh.id, "string");
  assert.ok(dh.id.length > 0);
  assert.equal(dh.retired, false);
  assert.equal(dh.retiredAt, null);
});

test("re-recording an existing Docker host preserves its id", () => {
  const p = tmpPath();
  recordGateway({ mode: "remote", host: "h", port: 8765, label: "deploy@h" }, { configPath: p });
  const first = recordDockerHostForGateway("h:8765", { hostKey: "ssh://user@other" }, { configPath: p });
  const originalId = first[0].dockerHosts[0].id;
  const second = recordDockerHostForGateway("h:8765", { hostKey: "ssh://user@other", sshKey: "/new/key" }, { configPath: p });
  assert.equal(second[0].dockerHosts[0].id, originalId);
  assert.equal(second[0].dockerHosts[0].sshKey, "/new/key");
});

test("readGateways backfills id/retired/retiredAt for a pre-migration file and persists the backfill", () => {
  const p = tmpPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify([
      { mode: "remote", host: "h", port: 8765, label: "deploy@h", dockerHosts: [{ hostKey: "local" }] },
    ])
  );
  const list = readGateways({ configPath: p });
  assert.equal(typeof list[0].id, "string");
  assert.equal(list[0].retired, false);
  assert.equal(list[0].retiredAt, null);
  assert.equal(typeof list[0].dockerHosts[0].id, "string");
  assert.equal(list[0].dockerHosts[0].retired, false);
  // persisted, not just returned in-memory -- a second independent read
  // sees the *same* backfilled id, not a freshly generated one each time.
  const reread = readGateways({ configPath: p });
  assert.equal(reread[0].id, list[0].id);
  assert.equal(reread[0].dockerHosts[0].id, list[0].dockerHosts[0].id);
});

test("retireGateway marks an entry retired with a timestamp but never removes it", () => {
  const p = tmpPath();
  const before = Date.now();
  const recorded = recordGateway({ mode: "remote", host: "h", port: 8765, label: "deploy@h" }, { configPath: p });
  const list = retireGateway(recorded[0].id, { configPath: p });
  assert.equal(list.length, 1, "entry stays in the file");
  assert.equal(list[0].retired, true);
  assert.ok(new Date(list[0].retiredAt).getTime() >= before);
  assert.equal(readGateways({ configPath: p })[0].retired, true, "persisted to disk");
});

test("retireGateway also matches by the legacy host:port key, for a not-yet-migrated caller", () => {
  const p = tmpPath();
  recordGateway({ mode: "remote", host: "h", port: 8765, label: "deploy@h" }, { configPath: p });
  const list = retireGateway("h:8765", { configPath: p });
  assert.equal(list[0].retired, true);
});

test("retireGateway is a no-op when nothing matches", () => {
  const p = tmpPath();
  recordGateway({ mode: "remote", host: "h", port: 8765, label: "deploy@h" }, { configPath: p });
  const list = retireGateway("does-not-exist", { configPath: p });
  assert.equal(list[0].retired, false);
});

test("retireDockerHost marks a docker host retired with a timestamp but never removes it, and leaves the gateway itself alone", () => {
  const p = tmpPath();
  const before = Date.now();
  recordGateway({ mode: "remote", host: "h", port: 8765, label: "deploy@h" }, { configPath: p });
  const recorded = recordDockerHostForGateway("h:8765", { hostKey: "ssh://user@other" }, { configPath: p });
  const hostId = recorded[0].dockerHosts[0].id;
  const list = retireDockerHost("h:8765", hostId, { configPath: p });
  assert.equal(list[0].retired, false, "the gateway itself is untouched");
  assert.equal(list[0].dockerHosts.length, 1, "docker host entry stays in the file");
  assert.equal(list[0].dockerHosts[0].retired, true);
  assert.ok(new Date(list[0].dockerHosts[0].retiredAt).getTime() >= before);
});
