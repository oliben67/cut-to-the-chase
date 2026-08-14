"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  getPublicKey,
  signChallenge,
  normalizePemKey,
  writeGatewayKey,
  copyGatewayKey,
  hasGatewayKey,
  withDecryptedGatewayKeyFile,
  deleteGatewayKey,
  migrateLegacyGatewayKeys,
} = require("../../lib/ssh-key-file");

function tmpKeysDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cttc-ssh-key-file-vault-"));
}

// Same reversible fake as key-vault.test.js -- real security isn't the
// point here, just proving these wrappers dispatch through key-vault.js
// correctly without needing a real OS keychain (unavailable under plain
// `node --test`).
function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (buf) => buf.toString("utf8").replace(/^enc:/, ""),
  };
}

// Exercises the real ssh-keygen binary against a throwaway keypair rather
// than mocking spawnSync -- getPublicKey has no injectable spawnFn (matches
// writeKeyFile/restrictKeyPermissions' own un-injected style in this file),
// and openssh-client is already a hard requirement elsewhere (the gateway
// container bundles it; see Dockerfile), so this is the least-fake way to
// verify the real ssh-keygen -y contract.
function makeThrowawayKeypair() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cttc-ssh-key-file-test-"));
  const keyPath = path.join(dir, "id_ed25519");
  const r = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "test", "-f", keyPath], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `ssh-keygen -t ed25519 failed: ${r.stderr}`);
  return { dir, keyPath, pubPath: `${keyPath}.pub` };
}

test("getPublicKey derives the same public key ssh-keygen -t already wrote alongside it", () => {
  const { dir, keyPath, pubPath } = makeThrowawayKeypair();
  try {
    const derived = getPublicKey(keyPath);
    const expected = fs.readFileSync(pubPath, "utf8").trim();
    assert.equal(derived, expected);
    assert.match(derived, /^ssh-ed25519 /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getPublicKey throws a clear error for a nonexistent key file", () => {
  assert.throws(() => getPublicKey("/nonexistent/path/to/a/key"), /ssh-keygen -y failed/);
});

test("getPublicKey throws a clear error for a file that isn't a private key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cttc-ssh-key-file-test-"));
  try {
    const notAKey = path.join(dir, "not-a-key");
    fs.writeFileSync(notAKey, "this is not a private key\n");
    assert.throws(() => getPublicKey(notAKey), /ssh-keygen -y failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Verifies a signChallenge() output the same way server.py's
// _verify_owner_signature actually does -- pipes the nonce on stdin to
// `ssh-keygen -Y verify` against an allowed_signers file naming the public
// key -- so this test exercises the real cross-process contract, not just
// that signChallenge produced *some* SSHSIG-shaped text.
function verifySignature(nonce, signature, publicKeyLine, namespace = "cttc-admin-auth") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cttc-ssh-key-file-test-verify-"));
  try {
    const allowedSigners = path.join(dir, "allowed_signers");
    fs.writeFileSync(allowedSigners, `owner ${publicKeyLine}\n`);
    const sigPath = path.join(dir, "nonce.sig");
    fs.writeFileSync(sigPath, signature);
    const r = spawnSync(
      "ssh-keygen",
      ["-Y", "verify", "-f", allowedSigners, "-I", "owner", "-n", namespace, "-s", sigPath],
      { input: nonce, encoding: "utf8" }
    );
    return r.status === 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("signChallenge produces a signature ssh-keygen -Y verify accepts against the matching public key", () => {
  const { dir, keyPath, pubPath } = makeThrowawayKeypair();
  try {
    const publicKey = fs.readFileSync(pubPath, "utf8").trim();
    const signature = signChallenge("some-nonce-value", keyPath);
    assert.match(signature, /^-----BEGIN SSH SIGNATURE-----/);
    assert.equal(verifySignature("some-nonce-value", signature, publicKey), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a signChallenge signature does not verify against a different nonce (matches server-side rejection)", () => {
  const { dir, keyPath, pubPath } = makeThrowawayKeypair();
  try {
    const publicKey = fs.readFileSync(pubPath, "utf8").trim();
    const signature = signChallenge("original-nonce", keyPath);
    assert.equal(verifySignature("a-different-nonce", signature, publicKey), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a signChallenge signature does not verify against a different public key (matches server-side rejection)", () => {
  const signer = makeThrowawayKeypair();
  const other = makeThrowawayKeypair();
  try {
    const otherPublicKey = fs.readFileSync(other.pubPath, "utf8").trim();
    const signature = signChallenge("some-nonce-value", signer.keyPath);
    assert.equal(verifySignature("some-nonce-value", signature, otherPublicKey), false);
  } finally {
    fs.rmSync(signer.dir, { recursive: true, force: true });
    fs.rmSync(other.dir, { recursive: true, force: true });
  }
});

test("signChallenge throws a clear error for a nonexistent key file", () => {
  assert.throws(() => signChallenge("some-nonce", "/nonexistent/path/to/a/key"), /ssh-keygen -Y sign failed/);
});

test("normalizePemKey strips a BOM and CRLF line endings, and requires a PEM header", () => {
  const withBomAndCrlf = "﻿-----BEGIN OPENSSH PRIVATE KEY-----\r\nabc\r\n-----END OPENSSH PRIVATE KEY-----\r\n";
  assert.equal(normalizePemKey(withBomAndCrlf), "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n");
  assert.throws(() => normalizePemKey("not a key"), /doesn't look like a private key/);
});

test("writeGatewayKey/hasGatewayKey/deleteGatewayKey round-trip through the vault", async () => {
  const keysDirOverride = tmpKeysDir();
  const safeStorage = fakeSafeStorage();
  const { dir, keyPath } = makeThrowawayKeypair();
  try {
    const contents = fs.readFileSync(keyPath, "utf8");
    assert.equal(hasGatewayKey("gw-1", { keysDirOverride }), false);
    await writeGatewayKey("gw-1", contents, { keysDirOverride, safeStorage });
    assert.equal(hasGatewayKey("gw-1", { keysDirOverride }), true);
    await deleteGatewayKey("gw-1", { keysDirOverride });
    assert.equal(hasGatewayKey("gw-1", { keysDirOverride }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("copyGatewayKey reads an existing file and stores its decoded contents", async () => {
  const keysDirOverride = tmpKeysDir();
  const safeStorage = fakeSafeStorage();
  const { dir, keyPath } = makeThrowawayKeypair();
  try {
    await copyGatewayKey("gw-1", keyPath, { keysDirOverride, safeStorage });
    assert.equal(hasGatewayKey("gw-1", { keysDirOverride }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withDecryptedGatewayKeyFile hands ssh-keygen a real, readable, correctly-permissioned temp file, then cleans it up", async () => {
  const keysDirOverride = tmpKeysDir();
  const safeStorage = fakeSafeStorage();
  const { dir, keyPath, pubPath } = makeThrowawayKeypair();
  try {
    const contents = fs.readFileSync(keyPath, "utf8");
    await writeGatewayKey("gw-1", contents, { keysDirOverride, safeStorage });
    const expected = fs.readFileSync(pubPath, "utf8").trim();
    let seenPath;
    const derived = await withDecryptedGatewayKeyFile("gw-1", (p) => {
      seenPath = p;
      if (process.platform !== "win32") assert.equal(fs.statSync(p).mode & 0o777, 0o600);
      return getPublicKey(p);
    }, { keysDirOverride, safeStorage });
    assert.equal(derived, expected);
    assert.equal(fs.existsSync(seenPath), false, "temp file cleaned up after fn returns");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withDecryptedGatewayKeyFile calls fn(null) when no key is stored for the gateway", async () => {
  const keysDirOverride = tmpKeysDir();
  const result = await withDecryptedGatewayKeyFile("nope", (p) => p, { keysDirOverride, safeStorage: fakeSafeStorage() });
  assert.equal(result, null);
});

test("migrateLegacyGatewayKeys is a no-op when there's no legacy file", async () => {
  const keysDirOverride = tmpKeysDir();
  const result = await migrateLegacyGatewayKeys({
    gateways: [{ id: "gw-1", sshKey: "/whatever" }],
    safeStorage: fakeSafeStorage(),
    keysDirOverride,
  });
  assert.equal(result, null);
});

test("migrateLegacyGatewayKeys encrypts every gateway pointing at the legacy file, verifies, and reports what it did", async () => {
  const keysDirOverride = tmpKeysDir();
  const { dir, keyPath } = makeThrowawayKeypair();
  try {
    const legacyPath = path.join(keysDirOverride, "cttc_ssh_key");
    fs.copyFileSync(keyPath, legacyPath);
    const gateways = [
      { id: "gw-1", mode: "remote", label: "one", sshKey: legacyPath },
      { id: "gw-2", mode: "remote", label: "two", sshKey: legacyPath },
      { id: "gw-3", mode: "remote", label: "unrelated", sshKey: "/some/other/path" },
      { mode: "embedded", label: "This machine" },
    ];
    const safeStorage = fakeSafeStorage();
    const result = await migrateLegacyGatewayKeys({ gateways, safeStorage, keysDirOverride });
    assert.equal(result.legacyPath, legacyPath);
    assert.deepEqual(result.migrated.map((g) => g.id).sort(), ["gw-1", "gw-2"]);
    assert.equal(result.failed.length, 0);
    assert.equal(hasGatewayKey("gw-1", { keysDirOverride }), true);
    assert.equal(hasGatewayKey("gw-2", { keysDirOverride }), true);
    assert.equal(hasGatewayKey("gw-3", { keysDirOverride }), false);

    // idempotent: a second run against the same (still-present) legacy file
    // and the same gateways array (as if `hasSshKey` hadn't been persisted
    // yet by the caller) doesn't re-do or fail on the already-migrated ones.
    const second = await migrateLegacyGatewayKeys({ gateways, safeStorage, keysDirOverride });
    assert.deepEqual(second.migrated.map((g) => g.id).sort(), ["gw-1", "gw-2"]);
    assert.equal(second.failed.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migrateLegacyGatewayKeys leaves the legacy file's candidates unmigrated (and reports them) on a write failure, without aborting the others", async () => {
  const keysDirOverride = tmpKeysDir();
  const { dir, keyPath } = makeThrowawayKeypair();
  try {
    const legacyPath = path.join(keysDirOverride, "cttc_ssh_key");
    fs.copyFileSync(keyPath, legacyPath);
    const gateways = [
      { id: "gw-good", mode: "remote", label: "good", sshKey: legacyPath },
      { id: "gw-bad", mode: "remote", label: "bad", sshKey: legacyPath },
    ];
    let calls = 0;
    const flakySafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => {
        calls++;
        if (calls === 2) throw new Error("simulated keychain failure");
        return Buffer.from(`enc:${s}`, "utf8");
      },
      decryptString: (buf) => buf.toString("utf8").replace(/^enc:/, ""),
    };
    const result = await migrateLegacyGatewayKeys({ gateways, safeStorage: flakySafeStorage, keysDirOverride });
    assert.equal(result.migrated.length, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].gateway.id, "gw-bad");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migrateLegacyGatewayKeys never prompts (returns null) when safeStorage is unavailable and no vault passphrase exists yet", async () => {
  const keysDirOverride = tmpKeysDir();
  const { dir, keyPath } = makeThrowawayKeypair();
  try {
    const legacyPath = path.join(keysDirOverride, "cttc_ssh_key");
    fs.copyFileSync(keyPath, legacyPath);
    let getPassphraseKeyCalled = false;
    const result = await migrateLegacyGatewayKeys({
      gateways: [{ id: "gw-1", mode: "remote", sshKey: legacyPath }],
      safeStorage: fakeSafeStorage({ available: false }),
      getPassphraseKey: () => { getPassphraseKeyCalled = true; return Buffer.alloc(32); },
      keysDirOverride,
      // No vault-meta.json at this path -- proves the "no passphrase set up
      // yet" branch, isolated from whatever the real ~/.cttc might contain.
      configPath: path.join(keysDirOverride, "vault-meta.json"),
    });
    assert.equal(result, null);
    assert.equal(getPassphraseKeyCalled, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
