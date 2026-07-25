"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { saveArtifact, listArtifacts, sweepArtifacts, DEFAULT_TTL_MS } = require("../../lib/event-artifacts");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cttc-events-"));
}

test("saveArtifact writes bytes and a sidecar with a default 24h expiry", () => {
  const dir = tmpDir();
  const bytes = new Uint8Array([1, 2, 3]);
  const before = Date.now();
  const filePath = saveArtifact("a.cttc-metric", bytes, { dir });
  assert.equal(filePath, path.join(dir, "a.cttc-metric"));
  assert.deepEqual([...fs.readFileSync(filePath)], [1, 2, 3]);
  const meta = JSON.parse(fs.readFileSync(filePath + ".meta.json", "utf8"));
  assert.ok(meta.expiresAt >= before + DEFAULT_TTL_MS - 1000);
  assert.ok(meta.expiresAt <= before + DEFAULT_TTL_MS + 5000);
});

test("saveArtifact honors safe + maxKeepMs over the default ttl", () => {
  const dir = tmpDir();
  const before = Date.now();
  saveArtifact("b.cttc-record", new Uint8Array([9]), { dir, safe: true, maxKeepMs: 3600_000 });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "b.cttc-record.meta.json"), "utf8"));
  assert.ok(meta.expiresAt >= before + 3600_000 - 1000);
  assert.ok(meta.expiresAt < before + DEFAULT_TTL_MS);
});

test("safe without maxKeepMs falls back to the default ttl", () => {
  const dir = tmpDir();
  const before = Date.now();
  saveArtifact("c.cttc-metric", new Uint8Array([1]), { dir, safe: true });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "c.cttc-metric.meta.json"), "utf8"));
  assert.ok(meta.expiresAt <= before + DEFAULT_TTL_MS + 1000);
});

test("listArtifacts returns [] for a directory that doesn't exist yet", () => {
  assert.deepEqual(listArtifacts({ dir: path.join(tmpDir(), "nope") }), []);
});

test("listArtifacts reports every saved artifact", () => {
  const dir = tmpDir();
  saveArtifact("a.cttc-metric", new Uint8Array([1]), { dir });
  saveArtifact("b.cttc-record", new Uint8Array([2]), { dir });
  const names = listArtifacts({ dir }).map((a) => a.name).sort();
  assert.deepEqual(names, ["a.cttc-metric", "b.cttc-record"]);
});

test("listArtifacts tolerates a corrupt sidecar rather than throwing", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "x.cttc-metric"), "data");
  fs.writeFileSync(path.join(dir, "x.cttc-metric.meta.json"), "{ not json");
  const [a] = listArtifacts({ dir });
  assert.equal(a.name, "x.cttc-metric");
  assert.equal(a.expiresAt, null);
});

test("sweepArtifacts removes only artifacts past their expiry", () => {
  const dir = tmpDir();
  const now = Date.now();
  saveArtifact("old.cttc-metric", new Uint8Array([1]), { dir, ttlMs: -1000 }); // already expired
  saveArtifact("fresh.cttc-metric", new Uint8Array([1]), { dir, ttlMs: 3600_000 });
  const removed = sweepArtifacts({ dir, now });
  assert.deepEqual(removed, ["old.cttc-metric"]);
  assert.ok(!fs.existsSync(path.join(dir, "old.cttc-metric")));
  assert.ok(!fs.existsSync(path.join(dir, "old.cttc-metric.meta.json")));
  assert.ok(fs.existsSync(path.join(dir, "fresh.cttc-metric")));
});

test("sweepArtifacts leaves artifacts with no readable expiry alone", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "y.cttc-metric"), "data");
  fs.writeFileSync(path.join(dir, "y.cttc-metric.meta.json"), "{ not json");
  assert.deepEqual(sweepArtifacts({ dir }), []);
  assert.ok(fs.existsSync(path.join(dir, "y.cttc-metric")));
});
