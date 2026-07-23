"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConnectionConfig, defaultConfigPath, hostFromTarget } = require("../../lib/connection-config");

function tmpConfigPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cttc-cfg-")), "connection.json");
}
function writeConfig(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj));
}

test("no file, no env -> embedded", () => {
  const p = tmpConfigPath(); // never written
  assert.deepEqual(loadConnectionConfig({ env: {}, configPath: p }), { mode: "embedded" });
});

test("configPath pointing at a nonexistent file behaves like no file", () => {
  const got = loadConnectionConfig({ env: {}, configPath: "/no/such/dir/connection.json" });
  assert.deepEqual(got, { mode: "embedded" });
});

test("file with mode: embedded -> embedded", () => {
  const p = tmpConfigPath();
  writeConfig(p, { mode: "embedded", ssh_target: "ignored@host" });
  assert.deepEqual(loadConnectionConfig({ env: {}, configPath: p }), { mode: "embedded" });
});

test("file with full remote config", () => {
  const p = tmpConfigPath();
  writeConfig(p, { mode: "remote", ssh_target: "deploy@docker-host", ssh_key: "~/.ssh/k", remote_port: 8765 });
  assert.deepEqual(loadConnectionConfig({ env: {}, configPath: p }), {
    mode: "remote",
    host: "docker-host",
    sshTarget: "deploy@docker-host",
    sshKey: "~/.ssh/k",
    remotePort: 8765,
  });
});

test("ssh_key defaults to null when omitted", () => {
  const p = tmpConfigPath();
  writeConfig(p, { mode: "remote", ssh_target: "deploy@docker-host", remote_port: 8765 });
  const got = loadConnectionConfig({ env: {}, configPath: p });
  assert.equal(got.sshKey, null);
});

test("env vars fully override the file", () => {
  const p = tmpConfigPath();
  writeConfig(p, { mode: "remote", ssh_target: "file@host", ssh_key: "file-key", remote_port: 1111 });
  const env = {
    CTTC_MODE: "remote",
    CTTC_SSH_TARGET: "env@host",
    CTTC_SSH_KEY: "env-key",
    CTTC_REMOTE_PORT: "2222",
  };
  assert.deepEqual(loadConnectionConfig({ env, configPath: p }), {
    mode: "remote", host: "host", sshTarget: "env@host", sshKey: "env-key", remotePort: 2222,
  });
});

test("env can flip an embedded file to remote mode as long as env supplies the rest", () => {
  const p = tmpConfigPath();
  writeConfig(p, { mode: "embedded" });
  const env = { CTTC_MODE: "remote", CTTC_SSH_TARGET: "env@host", CTTC_REMOTE_PORT: "8765" };
  const got = loadConnectionConfig({ env, configPath: p });
  assert.equal(got.mode, "remote");
});

test("missing ssh_target throws a clear error", () => {
  const p = tmpConfigPath();
  writeConfig(p, { mode: "remote", remote_port: 8765 });
  assert.throws(() => loadConnectionConfig({ env: {}, configPath: p }), /ssh_target/);
});

for (const bad of [undefined, "", "not-a-number", 0, -1, 70000, 3.5]) {
  test(`invalid remote_port (${JSON.stringify(bad)}) throws`, () => {
    const p = tmpConfigPath();
    const cfg = { mode: "remote", ssh_target: "deploy@host" };
    if (bad !== undefined) cfg.remote_port = bad;
    writeConfig(p, cfg);
    assert.throws(() => loadConnectionConfig({ env: {}, configPath: p }), /remote_port/);
  });
}

test("unknown mode throws", () => {
  const p = tmpConfigPath();
  writeConfig(p, { mode: "carrier-pigeon" });
  assert.throws(() => loadConnectionConfig({ env: {}, configPath: p }), /unknown CTTC connection mode/);
});

test("invalid JSON in the file throws with the file path in the message", () => {
  const p = tmpConfigPath();
  fs.writeFileSync(p, "{ not json");
  assert.throws(() => loadConnectionConfig({ env: {}, configPath: p }), new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a leading UTF-8 BOM (e.g. from Windows PowerShell's -Encoding UTF8) doesn't break parsing", () => {
  const p = tmpConfigPath();
  const json = JSON.stringify({ mode: "remote", ssh_target: "deploy@host", remote_port: 8765 });
  fs.writeFileSync(p, "﻿" + json, "utf8");
  assert.deepEqual(loadConnectionConfig({ env: {}, configPath: p }), {
    mode: "remote", host: "host", sshTarget: "deploy@host", sshKey: null, remotePort: 8765,
  });
});

test("defaultConfigPath resolves under the given env's HOME", () => {
  const got = defaultConfigPath({ HOME: "/home/alice" });
  assert.equal(got, path.join("/home/alice", ".cttc", "connection.json"));
});

test("hostFromTarget strips the user@ prefix", () => {
  assert.equal(hostFromTarget("deploy@docker-host.example.com"), "docker-host.example.com");
});

test("hostFromTarget leaves a bare host (no user@) alone", () => {
  assert.equal(hostFromTarget("docker-host"), "docker-host");
});
