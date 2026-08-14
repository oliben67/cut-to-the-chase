"use strict";

// Generic at-rest encryption for small secrets (SSH private keys today),
// keyed by an owning object's GUID rather than a user-chosen filename.
// Deliberately has no idea what it's storing (no PEM/SSH awareness -- see
// lib/ssh-key-file.js for that layer) and never touches `require("electron")`
// itself, so it stays testable under plain `node --test` the same way
// lib/gateway-registry.js is: every OS-keychain dependency (`safeStorage`) is
// injected by the caller rather than imported here.
//
// Two independent layers, same split as the design doc this implements:
//  - filename: deterministic, one-way HMAC of the GUID -- lets a caller who
//    already knows the GUID compute the file name directly, without ever
//    storing the GUID in the clear. Never reversible (filename -> GUID) by
//    design; nothing here needs that direction (see findOrphanedKeyFiles).
//  - content: encrypted via safeStorage (OS keychain/DPAPI/libsecret) where
//    available, otherwise a passphrase-derived key (scrypt + AES-256-GCM) --
//    never plaintext.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function defaultKeysDir(env) {
  return path.join(env.HOME || os.homedir(), ".cttc", "keys");
}

function defaultVaultMetaPath(env) {
  return path.join(env.HOME || os.homedir(), ".cttc", "vault-meta.json");
}

// The base key an object's GUID is HMAC'd under to produce its filename.
// Hardcoded and reproducible from source -- this is *not* a confidentiality
// boundary (anyone with the app binary can recompute it), only obfuscation of
// the GUID<->file mapping. That's an accepted tradeoff: the actual key
// material is protected by encryptEntry/decryptEntry below, not by this.
const FILENAME_HMAC_KEY = crypto.createHash("sha256").update("CutToTheChase").digest();

// Deterministic, one-way: same GUID -> same filename, every run, but the
// GUID can't be recovered from the filename. "v1_" versions the derivation
// so it can be rotated later without colliding with existing files.
function keyFilenameForGateway(gatewayId) {
  const digest = crypto.createHmac("sha256", FILENAME_HMAC_KEY).update(gatewayId, "utf8").digest();
  const b64url = digest.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `v1_${b64url}.key`;
}

function resolveKeysDir(opts) {
  return (opts && opts.keysDirOverride) || defaultKeysDir(process.env);
}

// Locks down a just-written file's permissions. A plain chmod is enough here
// (unlike a raw private key file, this holds ciphertext) -- callers that want
// the fuller cross-platform (icacls-on-Windows) treatment a real plaintext
// key needs can pass their own `restrictPermissions` instead (see
// ssh-key-file.js's writeGatewayKey).
function defaultRestrictPermissions(filePath) {
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
}

// Writes `contents` (a JSON-serializable envelope) to `dir/name`, atomically
// (temp file + rename) so a crash mid-write never leaves a partial/corrupt
// file where a real one used to be.
function writeFileAtomic(dir, name, contents, restrictPermissions) {
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, name);
  const tmpPath = path.join(dir, `.${name}.tmp-${crypto.randomBytes(6).toString("hex")}`);
  fs.writeFileSync(tmpPath, contents, { encoding: "utf8" });
  (restrictPermissions || defaultRestrictPermissions)(tmpPath);
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

/**
 * Reads and JSON-parses the envelope stored for `gatewayId`. Returns null if
 * nothing is stored for it (not an error -- "no key yet" is a normal state).
 * Throws on genuinely corrupt JSON, same philosophy as gateway-registry.js's
 * readGateways (only a missing file is a normal, silent case).
 */
function readEnvelope(gatewayId, opts = {}) {
  const filePath = path.join(resolveKeysDir(opts), keyFilenameForGateway(gatewayId));
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`corrupt key envelope at ${filePath}: ${err.message}`);
  }
}

function writeEnvelope(gatewayId, envelope, opts = {}) {
  return writeFileAtomic(resolveKeysDir(opts), keyFilenameForGateway(gatewayId), JSON.stringify(envelope), opts.restrictPermissions);
}

function deleteEnvelope(gatewayId, opts = {}) {
  const filePath = path.join(resolveKeysDir(opts), keyFilenameForGateway(gatewayId));
  fs.rmSync(filePath, { force: true });
}

/* ── Passphrase fallback (used when safeStorage.isEncryptionAvailable() is
   false -- e.g. Linux without a keyring backend) ─────────────────────────
   Note: the determinism problem that rules Fernet out for *filenames* above
   does not apply here -- a fresh random IV per encrypt is exactly what's
   wanted for content, never reproduced, just stored and later decrypted. */

const SCRYPT_KEYLEN = 32;
// N=2**14 keeps scrypt's default memory ceiling (Node's `scrypt` defaults to
// a 32MB maxmem) comfortably unexceeded (128*N*r bytes = 16MB here) without
// needing a custom maxmem option, while still being a real, non-trivial cost
// -- tune upward (with an explicit maxmem) if a future review finds this too
// weak for the threat model.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

function deriveKeyFromPassphrase(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
}

function encryptWithKey(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

// Throws a clear error (wrong passphrase, or corrupt data -- GCM's auth tag
// can't tell the two apart) rather than returning garbage.
function decryptWithKey(envelope, key) {
  const iv = Buffer.from(envelope.iv, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
  } catch (err) {
    throw new Error(`could not decrypt (wrong passphrase, or corrupt data): ${err.message}`);
  }
}

const VERIFIER_PLAINTEXT = "cttc-vault-verify-v1";

function readVaultMeta(opts = {}) {
  const filePath = opts.configPath || defaultVaultMetaPath(process.env);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeVaultMeta(meta, opts = {}) {
  const filePath = opts.configPath || defaultVaultMetaPath(process.env);
  writeFileAtomic(path.dirname(filePath), path.basename(filePath), JSON.stringify(meta), opts.restrictPermissions);
}

/**
 * First-time passphrase setup: derives a key from `passphrase` under a fresh
 * random salt, stores {salt, verifier} so a later verifyPassphrase() can
 * check a re-entered passphrase without ever storing the passphrase (or the
 * derived key) itself. Returns the derived key -- callers hold it in memory
 * for the session, never persist it.
 */
function setupPassphrase(passphrase, opts = {}) {
  const salt = crypto.randomBytes(16);
  const key = deriveKeyFromPassphrase(passphrase, salt);
  const verifier = encryptWithKey(VERIFIER_PLAINTEXT, key);
  writeVaultMeta({ salt: salt.toString("base64"), verifier }, opts);
  return key;
}

/**
 * Re-derives the key from a re-entered passphrase and checks it against the
 * stored verifier. Returns the derived key on success, null on a wrong
 * passphrase (never throws for that case -- only for a missing/corrupt vault).
 */
function verifyPassphrase(passphrase, opts = {}) {
  const meta = readVaultMeta(opts);
  if (!meta) throw new Error("no vault passphrase has been set up yet");
  const key = deriveKeyFromPassphrase(passphrase, Buffer.from(meta.salt, "base64"));
  try {
    return decryptWithKey(meta.verifier, key) === VERIFIER_PLAINTEXT ? key : null;
  } catch {
    return null; // auth-tag mismatch -- wrong passphrase
  }
}

/* ── Envelope-level read/write, dispatching on `alg` ──────────────────── */

/**
 * Returns the plaintext stored for `gatewayId`, or null if nothing is
 * stored. `getPassphraseKey` (sync or async, awaited either way) is only
 * ever called for the passphrase-fallback scheme -- a safeStorage-encrypted
 * entry never touches it, so a machine with a working OS keychain never
 * prompts for a passphrase at all, even if one happens to be configured.
 */
async function readEntry(gatewayId, opts = {}) {
  const envelope = readEnvelope(gatewayId, opts);
  if (!envelope) return null;
  if (envelope.alg === "safeStorage") {
    return opts.safeStorage.decryptString(Buffer.from(envelope.data, "base64"));
  }
  if (envelope.alg === "aes-256-gcm+scrypt") {
    const key = await opts.getPassphraseKey();
    return decryptWithKey(envelope, key);
  }
  throw new Error(`unknown key envelope alg: ${JSON.stringify(envelope.alg)}`);
}

/**
 * Encrypts `plaintext` and writes its envelope for `gatewayId`. Dispatches
 * on safeStorage availability *at call time* -- deliberately never cached
 * globally, since this can legitimately differ across separate app launches
 * on the same machine (e.g. a Linux keyring becoming available/unavailable).
 */
async function writeEntry(gatewayId, plaintext, opts = {}) {
  if (opts.safeStorage && opts.safeStorage.isEncryptionAvailable()) {
    const envelope = { v: 1, alg: "safeStorage", data: opts.safeStorage.encryptString(plaintext).toString("base64") };
    return writeEnvelope(gatewayId, envelope, opts);
  }
  const key = await opts.getPassphraseKey();
  const meta = readVaultMeta(opts);
  if (!meta) throw new Error("no vault passphrase set up -- call setupPassphrase first");
  const envelope = { v: 1, alg: "aes-256-gcm+scrypt", salt: meta.salt, ...encryptWithKey(plaintext, key) };
  return writeEnvelope(gatewayId, envelope, opts);
}

/**
 * Decrypts `gatewayId`'s entry to a private throwaway temp file, calls
 * `fn(path)` (path is null if nothing is stored), and always cleans up --
 * even if `fn` throws. For the external tools (ssh-keygen, scp, ssh) that
 * only ever operate on a real file, never in-memory content.
 */
async function withDecryptedFile(gatewayId, fn, opts = {}) {
  const plaintext = await readEntry(gatewayId, opts);
  if (plaintext == null) return fn(null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cttc-key-vault-"));
  const tempPath = path.join(dir, "key");
  try {
    fs.writeFileSync(tempPath, plaintext, { encoding: "utf8" });
    (opts.restrictPermissions || defaultRestrictPermissions)(tempPath);
    return await fn(tempPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ── Orphan detection (forward-only: enumerate known ids, compute their
   expected filenames -- never needs to recover a GUID from a filename) ─── */

function listKnownKeyFiles(opts = {}) {
  const dir = resolveKeysDir(opts);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^v1_[A-Za-z0-9_-]+\.key$/.test(f));
}

function findOrphanedKeyFiles(knownGatewayIds, opts = {}) {
  const expected = new Set(knownGatewayIds.map(keyFilenameForGateway));
  return listKnownKeyFiles(opts).filter((f) => !expected.has(f));
}

module.exports = {
  defaultKeysDir,
  defaultVaultMetaPath,
  keyFilenameForGateway,
  readEnvelope,
  writeEnvelope,
  deleteEnvelope,
  deriveKeyFromPassphrase,
  encryptWithKey,
  decryptWithKey,
  readVaultMeta,
  writeVaultMeta,
  setupPassphrase,
  verifyPassphrase,
  readEntry,
  writeEntry,
  withDecryptedFile,
  listKnownKeyFiles,
  findOrphanedKeyFiles,
};
