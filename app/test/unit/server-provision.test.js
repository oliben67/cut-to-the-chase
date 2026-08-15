"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const {
  uninstallLocalContainer,
  uninstallRemoteContainer,
  checkStillInstalled,
  ensureLocalContainer,
  ensureRemoteContainer,
} = require("../../lib/server-provision");

// ensureLocalContainer defaults pluginDir to ~/.cttc/log-sump-plugin --
// every test that calls it needs its own throwaway dir instead, or it'd
// create real state under the developer's actual home directory (and
// leak a stale `else`-branch mkdir across unrelated test runs).
function tmpPluginDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cttc-plugin-"));
}

function freeLocalHttpServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

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

// Like fakeSpawn, but also records opts (env) -- ensureLocalContainer's own
// CTTC_API_TOKEN/CTTC_IMAGE passthrough lives in the env it hands to
// `docker compose up`, not in argv.
function fakeSpawnWithOpts(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const { EventEmitter } = require("events");
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    setTimeout(() => p.emit("exit", 0), 5);
    return p;
  };
}

test("ensureLocalContainer passes CTTC_API_TOKEN through the docker compose up env when given (br-NET-004)", async () => {
  // br-PROV-004 already flags ensureLocalContainer as hard to test end-to-end
  // (a real /health/ready check against the fixed container port) --
  // binding a real local HTTP server on an ephemeral port and passing it as
  // `port` here sidesteps that without needing to touch the function itself.
  let seenHeaders = null;
  const srv = await freeLocalHttpServer((req, res) => {
    seenHeaders = req.headers;
    res.writeHead(200);
    res.end();
  });
  const port = srv.address().port;
  const calls = [];
  const pluginDir = tmpPluginDir();
  try {
    const result = await ensureLocalContainer({
      spawnFn: fakeSpawnWithOpts(calls),
      resourcesDir: "/fake/resources",
      source: { type: "registry", ref: "osteck/cttc-gateway:1.2.3" },
      port,
      apiToken: "s3cr3t",
      pluginDir,
    });
    assert.equal(result.port, port);
    const upCall = calls.find((c) => c.args.includes("up"));
    assert.ok(upCall, JSON.stringify(calls));
    assert.equal(upCall.opts.env.CTTC_API_TOKEN, "s3cr3t");
    assert.equal(upCall.opts.env.CTTC_PLUGINS_DIR, pluginDir);
    // the readiness check itself also carried the token -- a token-gated
    // /health/ready would otherwise 401 forever and never report ready.
    assert.equal(seenHeaders["x-cttc-token"], "s3cr3t");
  } finally {
    srv.close();
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("ensureLocalContainer omits CTTC_API_TOKEN from the env when no apiToken is given", async () => {
  let seenHeaders = null;
  const srv = await freeLocalHttpServer((req, res) => {
    seenHeaders = req.headers;
    res.writeHead(200);
    res.end();
  });
  const port = srv.address().port;
  const calls = [];
  const pluginDir = tmpPluginDir();
  try {
    await ensureLocalContainer({
      spawnFn: fakeSpawnWithOpts(calls),
      resourcesDir: "/fake/resources",
      source: { type: "registry", ref: "osteck/cttc-gateway:1.2.3" },
      port,
      pluginDir,
    });
    const upCall = calls.find((c) => c.args.includes("up"));
    assert.ok(!("CTTC_API_TOKEN" in upCall.opts.env));
    assert.equal(seenHeaders["x-cttc-token"], undefined);
  } finally {
    srv.close();
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("ensureLocalContainer clones log-sump-plugin fresh when pluginDir has no existing checkout", async () => {
  const srv = await freeLocalHttpServer((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  const port = srv.address().port;
  const calls = [];
  // tmpPluginDir() already exists as an empty dir (mkdtempSync) but has no
  // .git -- exercises ensurePluginCheckout's "clone" branch, not "fetch+reset".
  const pluginDir = tmpPluginDir();
  try {
    await ensureLocalContainer({
      spawnFn: fakeSpawnWithOpts(calls),
      resourcesDir: "/fake/resources",
      source: { type: "registry", ref: "osteck/cttc-gateway:1.2.3" },
      port,
      pluginDir,
    });
    const cloneCall = calls.find((c) => c.args.includes("clone"));
    assert.ok(cloneCall, JSON.stringify(calls));
    assert.deepEqual(cloneCall.args, [
      "clone",
      "--branch",
      "main",
      "git@github.com:oliben67/cttc-log-sump-plugin.git",
      pluginDir,
    ]);
    assert.ok(!calls.some((c) => c.args.includes("fetch") || c.args.includes("reset")), JSON.stringify(calls));
  } finally {
    srv.close();
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("ensureLocalContainer fetches+resets log-sump-plugin when pluginDir already has a checkout", async () => {
  const srv = await freeLocalHttpServer((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  const port = srv.address().port;
  const calls = [];
  const pluginDir = tmpPluginDir();
  fs.mkdirSync(path.join(pluginDir, ".git"));
  try {
    await ensureLocalContainer({
      spawnFn: fakeSpawnWithOpts(calls),
      resourcesDir: "/fake/resources",
      source: { type: "registry", ref: "osteck/cttc-gateway:1.2.3" },
      port,
      pluginDir,
    });
    assert.ok(!calls.some((c) => c.args.includes("clone")), JSON.stringify(calls));
    const fetchCall = calls.find((c) => c.args.includes("fetch"));
    const resetCall = calls.find((c) => c.args.includes("reset"));
    assert.ok(fetchCall, JSON.stringify(calls));
    assert.ok(resetCall, JSON.stringify(calls));
    assert.deepEqual(fetchCall.args, ["-C", pluginDir, "fetch", "origin", "main"]);
    assert.deepEqual(resetCall.args, ["-C", pluginDir, "reset", "--hard", "origin/main"]);
  } finally {
    srv.close();
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("ensureRemoteContainer's ssh command includes CTTC_API_TOKEN when apiToken is given (registry source) (br-NET-004)", async () => {
  let seenHeaders = null;
  const srv = await freeLocalHttpServer((req, res) => {
    seenHeaders = req.headers;
    res.writeHead(200);
    res.end();
  });
  const port = srv.address().port;
  const calls = [];
  try {
    await ensureRemoteContainer(
      { sshTarget: "deploy@host", sshKey: null, remotePort: port, host: "127.0.0.1" },
      {
        spawnFn: fakeSpawn(calls),
        resourcesDir: "/fake/resources",
        source: { type: "registry", ref: "osteck/cttc-gateway:1.2.3" },
        apiToken: "s3cr3t",
      }
    );
    const upCall = calls.find((c) => c.args.at(-1)?.includes("docker compose"));
    assert.ok(upCall, JSON.stringify(calls));
    assert.match(upCall.args.at(-1), /CTTC_API_TOKEN=s3cr3t /);
    // the reachability health-check itself also carried the token -- a
    // token-gated /health would otherwise 401 forever and always fall back
    // to an unnecessary ssh tunnel.
    assert.equal(seenHeaders["x-cttc-token"], "s3cr3t");
  } finally {
    srv.close();
  }
});

test("ensureRemoteContainer's ssh command includes CTTC_API_TOKEN when apiToken is given (tarball source)", async () => {
  const srv = await freeLocalHttpServer((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  const port = srv.address().port;
  const calls = [];
  try {
    await ensureRemoteContainer(
      { sshTarget: "deploy@host", sshKey: null, remotePort: port, host: "127.0.0.1" },
      {
        spawnFn: fakeSpawn(calls),
        resourcesDir: "/fake/resources",
        source: { type: "tarball", path: "/tmp/custom.tar.gz" },
        apiToken: "s3cr3t",
      }
    );
    const upCall = calls.find((c) => c.args.at(-1)?.includes("docker compose"));
    assert.ok(upCall, JSON.stringify(calls));
    assert.match(upCall.args.at(-1), /CTTC_API_TOKEN=s3cr3t /);
  } finally {
    srv.close();
  }
});

test("ensureRemoteContainer's ssh command omits CTTC_API_TOKEN when no apiToken is given", async () => {
  const srv = await freeLocalHttpServer((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  const port = srv.address().port;
  const calls = [];
  try {
    await ensureRemoteContainer(
      { sshTarget: "deploy@host", sshKey: null, remotePort: port, host: "127.0.0.1" },
      {
        spawnFn: fakeSpawn(calls),
        resourcesDir: "/fake/resources",
        source: { type: "registry", ref: "osteck/cttc-gateway:1.2.3" },
      }
    );
    const upCall = calls.find((c) => c.args.at(-1)?.includes("docker compose"));
    assert.ok(upCall, JSON.stringify(calls));
    assert.ok(!upCall.args.at(-1).includes("CTTC_API_TOKEN"));
  } finally {
    srv.close();
  }
});

test("ensureRemoteContainer's ssh commands clone log-sump-plugin on the remote host and pass CTTC_PLUGINS_DIR to the compose up command", async () => {
  const srv = await freeLocalHttpServer((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  const port = srv.address().port;
  const calls = [];
  try {
    await ensureRemoteContainer(
      { sshTarget: "deploy@host", sshKey: null, remotePort: port, host: "127.0.0.1" },
      {
        spawnFn: fakeSpawn(calls),
        resourcesDir: "/fake/resources",
        source: { type: "registry", ref: "osteck/cttc-gateway:1.2.3" },
      }
    );
    const sshCalls = calls.filter((c) => c.cmd === "ssh");
    const cloneCall = sshCalls.find((c) => c.args.at(-1)?.includes("log-sump-plugin"));
    assert.ok(cloneCall, JSON.stringify(calls));
    assert.match(cloneCall.args.at(-1), /cd cttc-gateway && if \[ -d log-sump-plugin\/\.git \]/);
    assert.match(cloneCall.args.at(-1), /git clone --branch main git@github\.com:oliben67\/cttc-log-sump-plugin\.git log-sump-plugin/);
    const upCall = calls.find((c) => c.args.at(-1)?.includes("docker compose"));
    assert.ok(upCall, JSON.stringify(calls));
    assert.match(upCall.args.at(-1), /CTTC_PLUGINS_DIR="\$PWD\/log-sump-plugin" /);
  } finally {
    srv.close();
  }
});

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
  assert.deepEqual(calls[0].args.slice(4), ["--rmi", "all"], "removes the image too, not just the container");
});

test("uninstallLocalContainer resolves the compose file matching a provided registry source, not the default (br-PROV-007)", async () => {
  const calls = [];
  await uninstallLocalContainer({
    spawnFn: fakeSpawn(calls),
    resourcesDir: "/fake/resources",
    source: { type: "registry", ref: "osteck/cttc-gateway:1.2.3" },
  });
  assert.equal(calls[0].args[2], path.join("/fake/resources", "docker-compose.registry.yml"));
});

test("uninstallLocalContainer resolves the compose file matching a provided tarball source, distinct from a registry source's", async () => {
  const calls = [];
  await uninstallLocalContainer({
    spawnFn: fakeSpawn(calls),
    resourcesDir: "/fake/resources",
    source: { type: "tarball", path: "/tmp/custom.tar.gz" },
  });
  assert.equal(calls[0].args[2], path.join("/fake/resources", "docker-compose.offline.yml"));
});

test("uninstallLocalContainer propagates onLog to run()'s command echo", async () => {
  const lines = [];
  await uninstallLocalContainer({ spawnFn: fakeSpawn([]), onLog: (l) => lines.push(l) });
  assert.ok(lines.some((l) => l.startsWith("$ docker")), lines.join("\n"));
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
  assert.match(remoteCmd, /docker compose down --rmi all/, "removes the image too, not just the container");
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

test("checkStillInstalled runs a local `docker compose ps -a` and logs it, never throws", async () => {
  const lines = [];
  const calls = [];
  await checkStillInstalled({ mode: "embedded" }, { spawnFn: fakeSpawn(calls), onLog: (l) => lines.push(l) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "docker");
  assert.ok(calls[0].args.includes("ps") && calls[0].args.includes("-a"));
  assert.ok(lines.some((l) => l.includes("checking whether")));
});

test("checkStillInstalled runs a remote `docker compose ps -a` over ssh for a non-embedded entry", async () => {
  const calls = [];
  await checkStillInstalled(
    { mode: "ssh", sshTarget: "deploy@host", sshKey: null },
    { spawnFn: fakeSpawn(calls), sshBin: "ssh" }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "ssh");
  assert.match(calls[0].args.at(-1), /docker compose ps -a/);
});

test("checkStillInstalled resolves the compose file matching entry.imageSource, not the default (br-PROV-007)", async () => {
  const calls = [];
  await checkStillInstalled(
    { mode: "embedded", imageSource: { type: "registry", ref: "osteck/cttc-gateway:1.2.3" } },
    { spawnFn: fakeSpawn(calls), resourcesDir: "/fake/resources" }
  );
  assert.equal(calls[0].args[2], path.join("/fake/resources", "docker-compose.registry.yml"));
});

test("checkStillInstalled logs (not throws) when the check itself fails", async () => {
  const lines = [];
  const failingSpawn = () => {
    const { EventEmitter } = require("events");
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    setTimeout(() => p.emit("error", new Error("boom")), 5);
    return p;
  };
  await assert.doesNotReject(
    checkStillInstalled({ mode: "embedded" }, { spawnFn: failingSpawn, onLog: (l) => lines.push(l) })
  );
  assert.ok(lines.some((l) => l.includes("could not check")), lines.join("\n"));
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
