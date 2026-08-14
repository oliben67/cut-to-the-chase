"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  keyFilenameForGateway,
  readEnvelope,
  writeEnvelope,
  deleteEnvelope,
  setupPassphrase,
  verifyPassphrase,
  readEntry,
  writeEntry,
  withDecryptedFile,
  findOrphanedKeyFiles,
} = require("../../lib/key-vault");

function tmpKeysDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cttc-key-vault-keys-"));
}
function tmpVaultMetaPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cttc-key-vault-meta-")), "vault-meta.json");
}

// Deterministic, reversible fake -- not real security, just enough to prove
// writeEntry/readEntry dispatch on it correctly without needing a real OS
// keychain (unavailable under plain `node --test`).
function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (buf) => buf.toString("utf8").replace(/^enc:/, ""),
  };
}

test("keyFilenameForGateway is deterministic and one-way", () => {
  const a = keyFilenameForGateway("guid-1");
  const b = keyFilenameForGateway("guid-1");
  const c = keyFilenameForGateway("guid-2");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^v1_[A-Za-z0-9_-]+\.key$/);
});

test("readEnvelope returns null when nothing is stored for the id", () => {
  assert.equal(readEnvelope("nope", { keysDirOverride: tmpKeysDir() }), null);
});

test("writeEnvelope/readEnvelope round-trip", () => {
  const keysDirOverride = tmpKeysDir();
  writeEnvelope("guid-1", { v: 1, alg: "safeStorage", data: "abc" }, { keysDirOverride });
  assert.deepEqual(readEnvelope("guid-1", { keysDirOverride }), { v: 1, alg: "safeStorage", data: "abc" });
});

test("deleteEnvelope removes the file and is a no-op when nothing exists", () => {
  const keysDirOverride = tmpKeysDir();
  writeEnvelope("guid-1", { v: 1, alg: "safeStorage", data: "abc" }, { keysDirOverride });
  deleteEnvelope("guid-1", { keysDirOverride });
  assert.equal(readEnvelope("guid-1", { keysDirOverride }), null);
  assert.doesNotThrow(() => deleteEnvelope("guid-1", { keysDirOverride }));
});

test("writeEntry/readEntry round-trip via safeStorage when available", async () => {
  const keysDirOverride = tmpKeysDir();
  const safeStorage = fakeSafeStorage({ available: true });
  await writeEntry("guid-1", "-----BEGIN KEY-----\nabc\n-----END KEY-----\n", { keysDirOverride, safeStorage });
  const out = await readEntry("guid-1", { keysDirOverride, safeStorage });
  assert.equal(out, "-----BEGIN KEY-----\nabc\n-----END KEY-----\n");
  assert.equal(readEnvelope("guid-1", { keysDirOverride }).alg, "safeStorage");
});

test("writeEntry never calls getPassphraseKey when safeStorage is available", async () => {
  const keysDirOverride = tmpKeysDir();
  let calls = 0;
  const getPassphraseKey = () => { calls++; return Buffer.alloc(32); };
  await writeEntry("guid-1", "secret", { keysDirOverride, safeStorage: fakeSafeStorage({ available: true }), getPassphraseKey });
  await readEntry("guid-1", { keysDirOverride, safeStorage: fakeSafeStorage({ available: true }), getPassphraseKey });
  assert.equal(calls, 0);
});

test("writeEntry/readEntry round-trip via the passphrase fallback when safeStorage is unavailable", async () => {
  const keysDirOverride = tmpKeysDir();
  const configPath = tmpVaultMetaPath();
  const key = setupPassphrase("correct horse battery staple", { configPath });
  const getPassphraseKey = () => key;
  const safeStorage = fakeSafeStorage({ available: false });
  await writeEntry("guid-1", "top secret key material", { keysDirOverride, configPath, safeStorage, getPassphraseKey });
  const envelope = readEnvelope("guid-1", { keysDirOverride });
  assert.equal(envelope.alg, "aes-256-gcm+scrypt");
  const out = await readEntry("guid-1", { keysDirOverride, configPath, safeStorage, getPassphraseKey });
  assert.equal(out, "top secret key material");
});

test("verifyPassphrase returns the derived key on a correct passphrase and null on a wrong one", () => {
  const configPath = tmpVaultMetaPath();
  setupPassphrase("hunter2", { configPath });
  const ok = verifyPassphrase("hunter2", { configPath });
  assert.ok(Buffer.isBuffer(ok));
  assert.equal(verifyPassphrase("wrong-passphrase", { configPath }), null);
});

test("verifyPassphrase throws a clear error when no vault has ever been set up", () => {
  assert.throws(() => verifyPassphrase("anything", { configPath: tmpVaultMetaPath() }), /no vault passphrase/);
});

test("withDecryptedFile calls fn with a real, readable temp file and always cleans up", async () => {
  const keysDirOverride = tmpKeysDir();
  const safeStorage = fakeSafeStorage({ available: true });
  await writeEntry("guid-1", "the-actual-key-bytes", { keysDirOverride, safeStorage });
  let seenPath;
  const result = await withDecryptedFile("guid-1", async (p) => {
    seenPath = p;
    assert.equal(fs.readFileSync(p, "utf8"), "the-actual-key-bytes");
    return "fn-return-value";
  }, { keysDirOverride, safeStorage });
  assert.equal(result, "fn-return-value");
  assert.equal(fs.existsSync(seenPath), false, "temp file cleaned up after fn returns");
});

test("withDecryptedFile still cleans up its temp dir when fn throws", async () => {
  const keysDirOverride = tmpKeysDir();
  const safeStorage = fakeSafeStorage({ available: true });
  await writeEntry("guid-1", "key-bytes", { keysDirOverride, safeStorage });
  let seenPath;
  await assert.rejects(
    withDecryptedFile("guid-1", async (p) => { seenPath = p; throw new Error("boom"); }, { keysDirOverride, safeStorage }),
    /boom/
  );
  assert.equal(fs.existsSync(seenPath), false);
});

test("withDecryptedFile calls fn(null) when nothing is stored for the id", async () => {
  const keysDirOverride = tmpKeysDir();
  const result = await withDecryptedFile("nope", (p) => p, { keysDirOverride, safeStorage: fakeSafeStorage() });
  assert.equal(result, null);
});

test("findOrphanedKeyFiles reports files with no matching known gateway id", async () => {
  const keysDirOverride = tmpKeysDir();
  const safeStorage = fakeSafeStorage({ available: true });
  await writeEntry("known-1", "a", { keysDirOverride, safeStorage });
  await writeEntry("orphan-1", "b", { keysDirOverride, safeStorage });
  const orphans = findOrphanedKeyFiles(["known-1"], { keysDirOverride });
  assert.deepEqual(orphans, [keyFilenameForGateway("orphan-1")]);
});
