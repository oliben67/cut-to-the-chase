"use strict";

// Real-process integration tests: no spawnFn mock. startTunnel() actually
// spawns test/fixtures/fake-ssh.js as a real child process communicating
// over real sockets, exercising getFreeLocalPort + buildSshArgs's real argv
// + waitForPortOpen together, the way it will really run against `ssh`.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const net = require("net");
const http = require("http");
const { startTunnel } = require("../../lib/ssh-tunnel");

const FAKE_SSH = path.join(__dirname, "..", "fixtures", "fake-ssh.js");

function startEchoServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => res.end("hello from remote"));
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

test("startTunnel really forwards traffic through a spawned ssh-alike", async () => {
  const remote = await startEchoServer();
  try {
    const tunnel = await startTunnel(
      { sshTarget: "irrelevant@host", sshKey: null, remotePort: remote.address().port },
      { sshBin: FAKE_SSH, timeoutMs: 5000 }
    );
    try {
      const body = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${tunnel.localPort}/`, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(data));
        }).on("error", reject);
      });
      assert.equal(body, "hello from remote");
    } finally {
      tunnel.stop();
    }
  } finally {
    remote.close();
  }
});

test("startTunnel.stop() actually closes the local forwarded port", async () => {
  const remote = await startEchoServer();
  try {
    const tunnel = await startTunnel(
      { sshTarget: "irrelevant@host", sshKey: null, remotePort: remote.address().port },
      { sshBin: FAKE_SSH, timeoutMs: 5000 }
    );
    const { localPort } = tunnel;
    tunnel.stop();
    // give the killed process a moment to actually release the socket
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(
      new Promise((resolve, reject) => {
        const s = net.connect({ host: "127.0.0.1", port: localPort });
        s.once("connect", () => { s.destroy(); resolve(); });
        s.once("error", reject);
      })
    );
  } finally {
    remote.close();
  }
});

test("startTunnel rejects when the real process exits immediately (auth failure)", async () => {
  process.env.FAKE_SSH_BEHAVIOR = "fail"; // fake-ssh.js reads this; child inherits process.env
  try {
    await assert.rejects(
      startTunnel(
        { sshTarget: "irrelevant@host", sshKey: null, remotePort: 1 },
        { sshBin: FAKE_SSH, timeoutMs: 5000 }
      ),
      /Permission denied/
    );
  } finally {
    delete process.env.FAKE_SSH_BEHAVIOR;
  }
});

test("startTunnel times out (and kills the child) against a hung ssh", async () => {
  process.env.FAKE_SSH_BEHAVIOR = "hang";
  try {
    await assert.rejects(
      startTunnel(
        { sshTarget: "irrelevant@host", sshKey: null, remotePort: 1 },
        { sshBin: FAKE_SSH, timeoutMs: 500 }
      ),
      /timed out waiting/
    );
  } finally {
    delete process.env.FAKE_SSH_BEHAVIOR;
  }
});
