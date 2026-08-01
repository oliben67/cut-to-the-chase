"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getOrCreateApiToken, forgetApiToken } = require("../../lib/api-token");

function tmpPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cttc-tok-")), "api-tokens.json");
}

test("getOrCreateApiToken generates a new token for a never-seen key", () => {
  const p = tmpPath();
  const token = getOrCreateApiToken("embedded", { configPath: p });
  assert.equal(typeof token, "string");
  assert.ok(token.length >= 32, "random enough to not be guessable");
});

test("getOrCreateApiToken persists and returns the exact same token on later calls (br-NET-004)", () => {
  // Reused verbatim across reconnects -- a token that changes between two
  // `docker compose up -d` calls forces docker compose to recreate the
  // container (see server-provision.js), needlessly restarting an
  // already-running, already-authenticated gateway.
  const p = tmpPath();
  const first = getOrCreateApiToken("embedded", { configPath: p });
  const second = getOrCreateApiToken("embedded", { configPath: p });
  assert.equal(second, first);
});

test("getOrCreateApiToken keeps distinct keys independent", () => {
  const p = tmpPath();
  const embedded = getOrCreateApiToken("embedded", { configPath: p });
  const remote = getOrCreateApiToken("ssh://u@h", { configPath: p });
  assert.notEqual(embedded, remote);
  assert.equal(getOrCreateApiToken("embedded", { configPath: p }), embedded);
  assert.equal(getOrCreateApiToken("ssh://u@h", { configPath: p }), remote);
});

test("getOrCreateApiToken tolerates a missing or corrupt file", () => {
  const p = tmpPath();
  assert.doesNotThrow(() => getOrCreateApiToken("embedded", { configPath: p }));

  const p2 = tmpPath();
  fs.writeFileSync(p2, "{ not json");
  const token = getOrCreateApiToken("embedded", { configPath: p2 });
  assert.equal(typeof token, "string");
  assert.ok(token.length > 0);
});

test("forgetApiToken drops the entry so a later call generates a fresh one", () => {
  const p = tmpPath();
  const before = getOrCreateApiToken("ssh://u@h", { configPath: p });
  forgetApiToken("ssh://u@h", { configPath: p });
  const after = getOrCreateApiToken("ssh://u@h", { configPath: p });
  assert.notEqual(after, before);
});

test("forgetApiToken on an unknown key is a safe no-op", () => {
  const p = tmpPath();
  assert.doesNotThrow(() => forgetApiToken("never-seen", { configPath: p }));
});
