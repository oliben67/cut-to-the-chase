"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  identityForHostKey,
  fileForHostKey,
  readSelectedContainers,
  writeSelectedContainers,
} = require("../../lib/container-selection");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cttc-containers-"));
}

test("identityForHostKey falls back to the OS user for local/no host", () => {
  assert.equal(identityForHostKey("local", "alice"), "alice@local");
  assert.equal(identityForHostKey(null, "alice"), "alice@local");
  assert.equal(identityForHostKey(undefined, "alice"), "alice@local");
});

test("identityForHostKey extracts user@host from a full ssh:// target", () => {
  assert.equal(identityForHostKey("ssh://deploy@example.com:2222", "alice"), "deploy@example.com");
});

test("identityForHostKey falls back to the OS user when the ssh target has no user@", () => {
  assert.equal(identityForHostKey("ssh://example.com", "alice"), "alice@example.com");
});

test("fileForHostKey names the file [user]@[gateway]-containers.json under the given dir", () => {
  const dir = tmpDir();
  const file = fileForHostKey("ssh://deploy@example.com", { dir, osUsername: "alice" });
  assert.equal(file, path.join(dir, "deploy@example.com-containers.json"));
});

test("readSelectedContainers returns empty lists when the file doesn't exist yet", () => {
  const dir = tmpDir();
  assert.deepEqual(readSelectedContainers("local", { dir, osUsername: "alice" }), { containers: [], services: [] });
});

test("readSelectedContainers returns empty lists on corrupt JSON rather than throwing", () => {
  const dir = tmpDir();
  const file = fileForHostKey("local", { dir, osUsername: "alice" });
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(readSelectedContainers("local", { dir, osUsername: "alice" }), { containers: [], services: [] });
});

test("readSelectedContainers tolerates a wrong-shaped file (non-array fields)", () => {
  const dir = tmpDir();
  const file = fileForHostKey("local", { dir, osUsername: "alice" });
  fs.writeFileSync(file, JSON.stringify({ containers: "nope", services: null }));
  assert.deepEqual(readSelectedContainers("local", { dir, osUsername: "alice" }), { containers: [], services: [] });
});

test("writeSelectedContainers then readSelectedContainers round-trips, deduped and sorted", () => {
  const dir = tmpDir();
  const opts = { dir, osUsername: "alice" };
  writeSelectedContainers("local", { containers: ["b", "a", "a"], services: ["y", "x"] }, opts);
  assert.deepEqual(readSelectedContainers("local", opts), { containers: ["a", "b"], services: ["x", "y"] });
});

test("writeSelectedContainers creates the target directory if missing", () => {
  const parent = tmpDir();
  const dir = path.join(parent, "nested", "cttc");
  writeSelectedContainers("local", { containers: ["a"] }, { dir, osUsername: "alice" });
  assert.ok(fs.existsSync(path.join(dir, "alice@local-containers.json")));
});

test("writeSelectedContainers keeps separate files per host identity", () => {
  const dir = tmpDir();
  writeSelectedContainers("local", { containers: ["a"] }, { dir, osUsername: "alice" });
  writeSelectedContainers("ssh://deploy@example.com", { containers: ["b"] }, { dir, osUsername: "alice" });
  assert.deepEqual(readSelectedContainers("local", { dir, osUsername: "alice" }), { containers: ["a"], services: [] });
  assert.deepEqual(readSelectedContainers("ssh://deploy@example.com", { dir, osUsername: "alice" }), { containers: ["b"], services: [] });
});
