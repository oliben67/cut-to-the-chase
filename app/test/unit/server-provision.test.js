"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { uninstallLocalContainer, uninstallRemoteContainer } = require("../../lib/server-provision");

function fakeSpawn(calls) {
  return (cmd, args) => {
    calls.push({ cmd, args });
    const { EventEmitter } = require("events");
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    setTimeout(() => p.emit("exit", 0), 5);
    return p;
  };
}

test("uninstallLocalContainer runs `docker compose down` with the resolved compose file", async () => {
  const calls = [];
  // resourcesDir undefined -> falls back to the dev checkout's releases/_shared;
  // hasBundledTarball() will be false there in a clean checkout, so this
  // exercises the registry-compose branch of resolveSource().
  await uninstallLocalContainer({ spawnFn: fakeSpawn(calls) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "docker");
  assert.deepEqual(calls[0].args.slice(0, 2), ["compose", "-f"]);
  assert.equal(calls[0].args[3], "down");
});

test("uninstallRemoteContainer runs one ssh command that stops the container and removes the remote dir", async () => {
  const calls = [];
  await uninstallRemoteContainer(
    { sshTarget: "deploy@host", sshKey: "/k", sshPort: 2222 },
    { spawnFn: fakeSpawn(calls), sshBin: "ssh" }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "ssh");
  const remoteCmd = calls[0].args.at(-1);
  assert.match(remoteCmd, /docker compose down/);
  assert.match(remoteCmd, /rm -rf cttc-gateway/);
  assert.ok(calls[0].args.includes("-i"), "ssh key flag present");
  assert.ok(calls[0].args.includes("deploy@host"), "target present");
});

test("uninstallRemoteContainer propagates onLog to run()'s command echo", async () => {
  const lines = [];
  await uninstallRemoteContainer(
    { sshTarget: "deploy@host", sshKey: null },
    { spawnFn: fakeSpawn([]), sshBin: "ssh", onLog: (l) => lines.push(l) }
  );
  assert.ok(lines.some((l) => l.startsWith("$ ssh")), lines.join("\n"));
});

// sanity: make sure requiring this module works from a real tmp cwd too,
// i.e. path resolution doesn't depend on process.cwd()
test("module loads independent of cwd", () => {
  const before = process.cwd();
  try {
    process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "cttc-sp-")));
    delete require.cache[require.resolve("../../lib/server-provision")];
    assert.doesNotThrow(() => require("../../lib/server-provision"));
  } finally {
    process.chdir(before);
  }
});
