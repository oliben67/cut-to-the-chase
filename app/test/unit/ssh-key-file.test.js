"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { getPublicKey, signChallenge } = require("../../lib/ssh-key-file");

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
