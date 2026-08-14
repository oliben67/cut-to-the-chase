"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const keyVault = require("./key-vault");

// Where a gateway's key material lives on disk: for the new vault-backed
// scheme this is the *directory* the encrypted per-gateway envelopes live
// in (see key-vault.js's keyFilenameForGateway); it's also where the old,
// single, plaintext ~/.cttc/keys/cttc_ssh_key used to live (see
// migrateLegacyGatewayKeys) -- alongside connection.json in ~/.cttc, not the
// (often admin-only) Program Files install directory. `homeDir` override is
// for tests only.
function keysDir({ homeDir } = {}) {
  return path.join(homeDir || os.homedir(), ".cttc", "keys");
}

// The account to grant on Windows. NOT the well-known "OWNER RIGHTS" SID
// (*S-1-3-4) -- that was tried here previously to sidestep icacls username
// resolution issues, but Win32-OpenSSH's own key-permission check
// explicitly rejects it as a grantee ("Bad permissions... Try removing
// permissions for user: \\OWNER RIGHTS (S-1-3-4)") and refuses to load the
// key at all -- it insists on the *real* account. "DOMAIN\username" (both
// from env vars, which Windows always sets correctly for the current
// process) is more robust than a bare username for icacls, which is what
// the earlier fix actually needed -- the real bug turned out to be the
// "(RW)" vs "(R,W)" syntax error below, not username resolution.
function currentAccount() {
  if (process.env.USERDOMAIN && process.env.USERNAME) return `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  return os.userInfo().username;
}

function icacls(args) {
  const r = spawnSync("icacls", args, { encoding: "utf8" });
  return { ok: r.status === 0, output: `${r.stdout || ""}${r.stderr || ""}`.trim(), status: r.status, error: r.error };
}

// ssh refuses a private key that's readable by anyone but its owner. On
// Windows that's icacls (mirrors deploy.ps1's step 2); elsewhere it's chmod.
// Grants (R,W), not (R)-only: a read-only grant would lock the *owner* out of
// ever overwriting the file too, breaking a second run of the gateway setup with
// EPERM the moment it tries to rewrite an already-restricted file. Errors
// are checked: a silently-failed /inheritance:r or /grant:r can leave the
// file with an emptier ACL than before (nobody, not even the owner, granted
// access), which is the actual EPERM this whole function exists to prevent.
function restrictKeyPermissions(keyPath) {
  if (process.platform === "win32") {
    const r1 = icacls([keyPath, "/inheritance:r"]);
    // icacls permission masks combine simple rights with a comma, not by
    // concatenating letters -- "(RW)" is not valid syntax and fails with
    // "Invalid parameter", which is exactly the error this was meant to fix.
    const r2 = icacls([keyPath, "/grant:r", `${currentAccount()}:(R,W)`]);
    if (!r1.ok || !r2.ok) {
      // Don't leave the file locked down worse than before -- restore
      // normal inherited permissions (which always include the owner)
      // rather than an ACL that grants no one access.
      icacls([keyPath, "/reset"]);
      const detail = [r1.ok ? null : r1.output, r2.ok ? null : r2.output].filter(Boolean).join(" / ");
      throw new Error(
        `could not restrict permissions on ${keyPath} (icacls failed${detail ? ": " + detail : ""}) -- ` +
          "the key was saved with default (not locked-down) permissions."
      );
    }
  } else {
    fs.chmodSync(keyPath, 0o600);
  }
}

// ssh's key parser reads the base64 body line by line and chokes on
// anything but a bare \n -- a pasted-in key (or one copied from a file that
// already had Windows line endings) can carry \r\n internally, not just at
// the very end, which trim() alone doesn't touch and produces exactly the
// "invalid format" ssh reports when it can't parse a line. Also strips a
// leading UTF-8 BOM (e.g. a file saved by Windows Notepad), which would
// otherwise corrupt the "-----BEGIN ..." header line. Fails clearly rather
// than let a garbled/wrong-encoding/wrong-file key silently get stored and
// only surface later as ssh's opaque "invalid format" once it's already too
// late to tell the user why.
function normalizePemKey(contents) {
  let normalized = contents;
  if (normalized.charCodeAt(0) === 0xfeff) normalized = normalized.slice(1);
  normalized = normalized.replace(/\r\n/g, "\n").trim() + "\n";
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(normalized)) {
    throw new Error(
      "That doesn't look like a private key (no '-----BEGIN ... PRIVATE KEY-----' header) -- " +
        "check you picked the private key, not the .pub file, and that it wasn't saved in an unexpected encoding."
    );
  }
  return normalized;
}

/**
 * Reads a key file's actual text, regardless of which encoding it was saved
 * in. Blindly reading as utf8 (the previous behavior) silently produces
 * garbage -- and the same "invalid format" ssh error as a line-ending
 * problem -- for a file saved as UTF-16, which is a real risk on Windows:
 * PowerShell's `>`/Out-File default to UTF-16LE-with-BOM, so a key
 * generated or re-saved via PowerShell without an explicit -Encoding often
 * ends up in that encoding rather than plain UTF-8/ASCII.
 */
function decodeKeyFile(sourcePath) {
  const buf = fs.readFileSync(sourcePath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.swap16().toString("utf16le"); // UTF-16BE
  return buf.toString("utf8");
}

/**
 * Derives the public key from a private key file at `keyPath` via
 * `ssh-keygen -y` -- needed once, at ownership-claim time, to send
 * `ownerPublicKey` to the gateway (REQ-0069/br-OWNER-001). Throws a clear
 * Error rather than returning something a caller might not check.
 */
function getPublicKey(keyPath) {
  const r = spawnSync("ssh-keygen", ["-y", "-f", keyPath], { encoding: "utf8" });
  if (r.error) {
    throw new Error(
      `could not run ssh-keygen to derive the public key (${r.error.message}) -- is OpenSSH installed and on PATH?`
    );
  }
  if (r.status !== 0) {
    throw new Error(`ssh-keygen -y failed for ${keyPath}: ${(r.stderr || "").trim() || "unknown error"}`);
  }
  return r.stdout.trim();
}

// Must match server.py's ADMIN_SIGNATURE_NAMESPACE exactly -- ssh-keygen -Y
// sign/verify both require the same `-n` namespace, or verification fails
// even with the right key. No shared-constants file between the Python
// server and this client, same as e.g. the container's fixed port (8765)
// already being a literal on both sides.
const ADMIN_SIGNATURE_NAMESPACE = "cttc-admin-auth";

/**
 * Signs `nonce` (a challenge from GET /gateway/admin/challenge) with the
 * private key at `keyPath`, via `ssh-keygen -Y sign` -- produces an SSHSIG
 * armor blob the gateway verifies with the matching `ssh-keygen -Y verify`
 * (REQ-0069/br-OWNER-003). Requires OpenSSH >= 8.2 for the `-Y` subcommand.
 * `-Y sign` only operates on real files (no stdin/stdout mode), so this
 * writes the nonce to a private throwaway directory, reads back the
 * `.sig` sibling it produces, and always cleans up -- even on failure.
 */
function signChallenge(nonce, keyPath, { namespace = ADMIN_SIGNATURE_NAMESPACE } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cttc-admin-sign-"));
  const noncePath = path.join(dir, "nonce");
  const sigPath = `${noncePath}.sig`;
  try {
    fs.writeFileSync(noncePath, nonce, { encoding: "utf8" });
    const r = spawnSync("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", namespace, noncePath], {
      encoding: "utf8",
    });
    if (r.error) {
      throw new Error(
        `could not run ssh-keygen -Y sign (${r.error.message}) -- is OpenSSH >= 8.2 installed and on PATH?`
      );
    }
    if (r.status !== 0) {
      throw new Error(`ssh-keygen -Y sign failed for ${keyPath}: ${(r.stderr || "").trim() || "unknown error"}`);
    }
    return fs.readFileSync(sigPath, "utf8");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ── Gateway key storage: encrypted at rest, keyed by the gateway's own
   GUID (see lib/gateway-registry.js) rather than a single shared filename --
   the actual crypto/envelope/filename-derivation logic lives in
   key-vault.js, which knows nothing about SSH/PEM; this layer adds PEM
   validation and reuses restrictKeyPermissions for the plaintext temp files
   handed to ssh-keygen/scp/ssh (key-vault.js's own default is a plain
   chmod, fine for the encrypted envelope but not thorough enough -- on
   Windows in particular -- for a real decrypted private key). ────────────── */

/**
 * Validates+normalizes `contents` as a PEM private key and stores it
 * encrypted for `gatewayId`. `opts` is forwarded to key-vault.js's
 * writeEntry (`keysDirOverride`, `safeStorage`, `getPassphraseKey`).
 */
async function writeGatewayKey(gatewayId, contents, opts = {}) {
  const normalized = normalizePemKey(contents);
  return keyVault.writeEntry(gatewayId, normalized, { ...opts, restrictPermissions: restrictKeyPermissions });
}

/**
 * Reads an existing key file (the "browse for a file" gateway setup path)
 * and stores its decoded contents encrypted for `gatewayId` -- never reuses
 * the original file/path in place, since we don't own (and shouldn't
 * change) whatever permissions it already has wherever it lives.
 */
async function copyGatewayKey(gatewayId, sourcePath, opts = {}) {
  return writeGatewayKey(gatewayId, decodeKeyFile(sourcePath), opts);
}

// Cheap existence check (no decrypt, no safeStorage/passphrase needed) --
// used to drive the "keep the current key" default in Edit Gateways and to
// skip an already-migrated gateway during migration.
function hasGatewayKey(gatewayId, opts = {}) {
  return keyVault.readEnvelope(gatewayId, opts) != null;
}

/**
 * Decrypts `gatewayId`'s stored key to a private, correctly-permissioned
 * temp file, calls `fn(path)` (path is null if nothing is stored for this
 * gateway), and always cleans up -- for the external tools (ssh-keygen,
 * scp, ssh) that only ever operate on a real file. `opts` forwarded to
 * key-vault.js's withDecryptedFile.
 */
async function withDecryptedGatewayKeyFile(gatewayId, fn, opts = {}) {
  return keyVault.withDecryptedFile(gatewayId, fn, { ...opts, restrictPermissions: restrictKeyPermissions });
}

async function deleteGatewayKey(gatewayId, opts = {}) {
  return keyVault.deleteEnvelope(gatewayId, opts);
}

/**
 * One-time (per launch), idempotent migration of the old, single, shared
 * plaintext ~/.cttc/keys/cttc_ssh_key -- fixed filename regardless of which
 * gateway, so it silently clobbered itself across multiple gateways -- into
 * the new per-gateway encrypted vault. Verify-before-delete: the legacy
 * file is only ever removed by the caller once every gateway that
 * referenced it has a confirmed-readable encrypted copy (this function
 * itself never deletes it or touches gateways.json -- see its return value).
 * Safe to interrupt/re-run: an already-migrated gateway (hasGatewayKey) is
 * skipped, so a retry only redoes what didn't finish. Never prompts for a
 * passphrase at startup: if safeStorage is unavailable and no vault
 * passphrase has ever been set up, this logs one line and returns without
 * touching anything.
 * @param {{gateways: object[], safeStorage: object, getPassphraseKey: () => (any), keysDirOverride?: string, configPath?: string, onLog?: (msg: string) => void}} params
 * @returns {null | {legacyPath: string, migrated: object[], failed: {gateway: object, error: Error}[]}}
 *   null when there was nothing to do (no legacy file, nothing references
 *   it, or the vault isn't ready to accept a write yet).
 */
async function migrateLegacyGatewayKeys({ gateways, safeStorage, getPassphraseKey, keysDirOverride, configPath, onLog = () => {} } = {}) {
  const legacyPath = path.join(keysDirOverride || keysDir(), "cttc_ssh_key");
  if (!fs.existsSync(legacyPath)) return null;

  const candidates = gateways.filter((g) => g.mode !== "embedded" && g.sshKey === legacyPath && !g.hasSshKey);
  if (!candidates.length) return null; // nothing left references it -- leave it; never delete speculatively

  if (!safeStorage.isEncryptionAvailable() && !keyVault.readVaultMeta({ configPath })) {
    onLog(
      `[vault] ${candidates.length} gateway key(s) are still plaintext on disk -- open Secure Storage to encrypt them`
    );
    return null;
  }

  const contents = normalizePemKey(decodeKeyFile(legacyPath));
  const migrated = [];
  const failed = [];
  for (const g of candidates) {
    if (hasGatewayKey(g.id, { keysDirOverride })) {
      migrated.push(g); // a prior, partially-completed run already got this one
      continue;
    }
    try {
      await writeGatewayKey(g.id, contents, { safeStorage, getPassphraseKey, keysDirOverride, configPath });
      const roundtrip = await keyVault.readEntry(g.id, { safeStorage, getPassphraseKey, keysDirOverride, configPath });
      if (roundtrip !== contents) throw new Error("round-trip verification mismatch after encrypting");
      migrated.push(g);
    } catch (err) {
      failed.push({ gateway: g, error: err });
    }
  }

  for (const g of migrated) onLog(`[vault] migrated gateway key for ${g.label || g.host} to secure storage`);
  for (const { gateway: g, error } of failed) {
    onLog(`[vault] could not migrate gateway key for ${g.label || g.host}: ${error.message}`);
  }
  return { legacyPath, migrated, failed };
}

module.exports = {
  keysDir,
  restrictKeyPermissions,
  normalizePemKey,
  decodeKeyFile,
  getPublicKey,
  signChallenge,
  writeGatewayKey,
  copyGatewayKey,
  hasGatewayKey,
  withDecryptedGatewayKeyFile,
  deleteGatewayKey,
  migrateLegacyGatewayKeys,
};
