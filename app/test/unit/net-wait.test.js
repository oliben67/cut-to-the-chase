"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { waitForPortOpen, waitForHttpOk } = require("../../lib/net-wait");

test("waitForPortOpen resolves once something is listening", async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await waitForPortOpen("127.0.0.1", port, { timeoutMs: 2000 });
  srv.close();
});

test("waitForPortOpen retries until the port opens", async () => {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
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
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
  await assert.rejects(
    waitForPortOpen("127.0.0.1", port, { timeoutMs: 300, intervalMs: 50 }),
    /timed out waiting/
  );
});

test("waitForHttpOk resolves once the fetch returns ok", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return { ok: calls >= 2, status: calls >= 2 ? 200 : 503 };
  };
  await waitForHttpOk("http://127.0.0.1:9/health", { timeoutMs: 2000, intervalMs: 10, fetchFn });
  assert.ok(calls >= 2);
});

test("waitForHttpOk retries through fetch rejections (connection refused, etc.)", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    if (calls < 3) throw new Error("ECONNREFUSED");
    return { ok: true, status: 200 };
  };
  await waitForHttpOk("http://127.0.0.1:9/health", { timeoutMs: 2000, intervalMs: 10, fetchFn });
  assert.equal(calls, 3);
});

test("waitForHttpOk rejects on timeout when the server never responds ok", async () => {
  const fetchFn = async () => ({ ok: false, status: 500 });
  await assert.rejects(
    waitForHttpOk("http://127.0.0.1:9/health", { timeoutMs: 200, intervalMs: 50, fetchFn }),
    /timed out waiting/
  );
});

test("waitForHttpOk passes headers through to fetchFn when given (br-NET-004)", async () => {
  // ensureRemoteContainer's own health check must be able to send
  // X-CTTC-Token once the gateway requires one, or a token-gated /health
  // would 401 forever and this would just spin until timeoutMs.
  let seenHeaders = null;
  const fetchFn = async (_url, opts) => {
    seenHeaders = opts.headers;
    return { ok: true, status: 200 };
  };
  await waitForHttpOk("http://127.0.0.1:9/health", {
    timeoutMs: 2000,
    intervalMs: 10,
    fetchFn,
    headers: { "X-CTTC-Token": "s3cr3t" },
  });
  assert.deepEqual(seenHeaders, { "X-CTTC-Token": "s3cr3t" });
});

test("waitForHttpOk omits the headers option entirely for fetchFn when none is given", async () => {
  let sawHeadersKey = true;
  const fetchFn = async (_url, opts) => {
    sawHeadersKey = "headers" in opts;
    return { ok: true, status: 200 };
  };
  await waitForHttpOk("http://127.0.0.1:9/health", { timeoutMs: 2000, intervalMs: 10, fetchFn });
  assert.equal(sawHeadersKey, false);
});
