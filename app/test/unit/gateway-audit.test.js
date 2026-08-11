"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const {
  tcpPing,
  httpPing,
  interpretAuditResult,
  auditGateway,
  auditGatewayList,
} = require("../../lib/gateway-audit");

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
}

function withoutTimestamp({ lastContactAt, ...rest }) {
  assert.ok(lastContactAt && lastContactAt.endsWith("Z"), `expected a UTC ISO timestamp, got ${lastContactAt}`);
  return rest;
}

/* ── interpretAuditResult: br-AUDIT-002's truth table ────────────────── */

test("interpretAuditResult: HTTP ok -> existing/ok regardless of the TCP result", () => {
  assert.deepEqual(withoutTimestamp(interpretAuditResult(true, true, "unknown")), {
    existence: "existing", lastContactResult: "ok",
  });
  assert.deepEqual(withoutTimestamp(interpretAuditResult(true, false, "absent")), {
    existence: "existing", lastContactResult: "ok",
  });
});

test("interpretAuditResult: HTTP fail + TCP open -> unknown/failed (port open, service unconfirmed)", () => {
  assert.deepEqual(withoutTimestamp(interpretAuditResult(false, true, "existing")), {
    existence: "unknown", lastContactResult: "failed",
  });
});

test("interpretAuditResult: HTTP fail + TCP closed, previously verified -> absent/failed", () => {
  assert.deepEqual(withoutTimestamp(interpretAuditResult(false, false, "existing")), {
    existence: "absent", lastContactResult: "failed",
  });
  assert.deepEqual(withoutTimestamp(interpretAuditResult(false, false, "absent")), {
    existence: "absent", lastContactResult: "failed",
  });
});

test("interpretAuditResult: HTTP fail + TCP closed, never verified -> stays unknown (no confident negative)", () => {
  assert.deepEqual(withoutTimestamp(interpretAuditResult(false, false, "unknown")), {
    existence: "unknown", lastContactResult: "failed",
  });
  assert.deepEqual(withoutTimestamp(interpretAuditResult(false, false, undefined)), {
    existence: "unknown", lastContactResult: "failed",
  });
});

/* ── httpPing: real fetch against a real HTTP server ─────────────────── */

test("httpPing resolves true when GET /ping answers ok", async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === "/ping") { res.writeHead(200); res.end("{}"); }
    else res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    assert.equal(await httpPing("127.0.0.1", port), true);
  } finally {
    srv.close();
  }
});

test("httpPing resolves false when nothing is listening", async () => {
  const port = await freePort();
  assert.equal(await httpPing("127.0.0.1", port, { timeoutMs: 500 }), false);
});

test("httpPing resolves false (not throws/hangs) on a server that never responds within timeoutMs", async () => {
  const srv = http.createServer(() => {}); // never calls res.end()
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const start = Date.now();
    assert.equal(await httpPing("127.0.0.1", port, { timeoutMs: 300 }), false);
    assert.ok(Date.now() - start < 3000, "should not wait anywhere near a default fetch timeout");
  } finally {
    srv.close();
  }
});

/* ── tcpPing: real OS tooling against a real socket ──────────────────── */
// Posix only -- Test-NetConnection/telnet's own branch can't be exercised
// from this dev/CI environment (matches this codebase's existing
// precedent for untestable platform-specific paths, e.g. app.js's
// startRecording "no window.cttc" guard).

test("tcpPing resolves true for an open port", { skip: process.platform === "win32" }, async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    assert.equal(await tcpPing("127.0.0.1", port), true);
  } finally {
    srv.close();
  }
});

test("tcpPing resolves false for a closed port", { skip: process.platform === "win32" }, async () => {
  const port = await freePort();
  assert.equal(await tcpPing("127.0.0.1", port, { timeoutMs: 1000 }), false);
});

/* ── auditGateway: the three truth-table branches end to end ────────── */

test("auditGateway: HTTP ok -> existing/ok, keeps the entry's other fields", async () => {
  const entry = { host: "10.0.0.1", port: 8765, existence: "unknown" };
  const result = await auditGateway(entry, {
    httpPingFn: async () => true,
    tcpPingFn: async () => true,
  });
  assert.equal(result.host, "10.0.0.1");
  assert.equal(result.port, 8765);
  assert.equal(result.existence, "existing");
  assert.equal(result.lastContactResult, "ok");
});

test("auditGateway: HTTP fail + TCP open -> unknown/failed", async () => {
  const result = await auditGateway(
    { host: "10.0.0.2", port: 8765, existence: "existing" },
    { httpPingFn: async () => false, tcpPingFn: async () => true }
  );
  assert.equal(result.existence, "unknown");
  assert.equal(result.lastContactResult, "failed");
});

test("auditGateway: HTTP fail + TCP closed -> absent/failed (previously verified)", async () => {
  const result = await auditGateway(
    { host: "10.0.0.3", port: 8765, existence: "existing" },
    { httpPingFn: async () => false, tcpPingFn: async () => false }
  );
  assert.equal(result.existence, "absent");
  assert.equal(result.lastContactResult, "failed");
});

/* ── auditGatewayList: concurrency bound + hung-entry resilience ─────── */

test("auditGatewayList bounds concurrency to the configured cap", async () => {
  let inFlight = 0, maxInFlight = 0;
  const entries = Array.from({ length: 10 }, (_, i) => ({ host: `10.0.1.${i}`, port: 8765 }));
  await auditGatewayList(entries, {
    concurrency: 3,
    httpPingFn: async () => true,
    tcpPingFn: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return true;
    },
  });
  assert.ok(maxInFlight <= 3, `expected at most 3 entries in flight, saw ${maxInFlight}`);
  assert.ok(maxInFlight >= 2, "sanity: real overlap should have happened, not accidentally serial");
});

test("a hung entry's checks don't stall the rest of the batch", async () => {
  const hangForever = () => new Promise(() => {});
  const entries = [
    { host: "hung.example", port: 8765 },
    { host: "10.0.2.1", port: 8765 },
    { host: "10.0.2.2", port: 8765 },
  ];
  const results = await auditGatewayList(entries, {
    concurrency: 2,
    timeoutMs: 50, // small on purpose -- the outer race fires at timeoutMs+200ms
    httpPingFn: (host) => (host === "hung.example" ? hangForever() : Promise.resolve(true)),
    tcpPingFn: (host) => (host === "hung.example" ? hangForever() : Promise.resolve(true)),
  });
  assert.equal(results.length, 3);
  assert.equal(results[1].existence, "existing");
  assert.equal(results[2].existence, "existing");
  assert.equal(results[0].lastContactResult, "failed"); // the hung entry's own outer-timeout fallback
  assert.equal(results[0].host, "hung.example");
});

test("auditGatewayList returns every entry even for an empty list", async () => {
  assert.deepEqual(await auditGatewayList([]), []);
});
