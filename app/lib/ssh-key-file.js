"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// Where the setup wizard drops a key file (pasted, or copied in from
// elsewhere -- see copyKeyFile): alongside connection.json in ~/.cttc, not
// the (often admin-only) Program Files install directory.
function keysDir() {
  return path.join(os.homedir(), ".cttc", "keys");
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
// ever overwriting the file too, breaking a second run of the wizard with
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

/**
 * Writes a key's contents to ~/.cttc/keys/<name> and locks its permissions
 * down. Returns the written path. Used both for a pasted-in key and (via
 * copyKeyFile) for a key the user pointed at an existing file on disk --
 * either way the result is a copy under our control with the same ACL
 * guarantees, not a reference to a file we don't own the permissions of.
 */
function writeKeyFile(contents, name = "cttc_ssh_key") {
  const dir = keysDir();
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, name);
  if (process.platform === "win32" && fs.existsSync(keyPath)) {
    // A previous run may have left this file's ACL locked down (or, if that
    // run's icacls call itself failed, with no access granted to anyone at
    // all) -- /reset restores the permissions it would've inherited from
    // ~/.cttc/keys, which always includes the owner, regardless of whatever
    // broken state the explicit ACL is currently in.
    icacls([keyPath, "/reset"]);
  }
  // ssh's key parser reads the base64 body line by line and chokes on
  // anything but a bare \n -- a pasted-in key (or one copied from a file
  // that already had Windows line endings) can carry \r\n internally, not
  // just at the very end, which trim() alone doesn't touch and produces
  // exactly the "invalid format" ssh reports when it can't parse a line.
  // Also strip a leading UTF-8 BOM (e.g. a file saved by Windows Notepad),
  // which would otherwise corrupt the "-----BEGIN ..." header line.
  let normalized = contents;
  if (normalized.charCodeAt(0) === 0xfeff) normalized = normalized.slice(1);
  normalized = normalized.replace(/\r\n/g, "\n").trim() + "\n";
  fs.writeFileSync(keyPath, normalized, { encoding: "utf8" });
  restrictKeyPermissions(keyPath);
  return keyPath;
}

/**
 * Copies an existing key file (the "browse for a file" wizard path) into
 * our managed ~/.cttc/keys/ and locks down the *copy*'s permissions --
 * never reuses the original file/path in place, since we don't own (and
 * shouldn't change) whatever permissions it already has wherever it lives.
 */
function copyKeyFile(sourcePath, name = "cttc_ssh_key") {
  return writeKeyFile(fs.readFileSync(sourcePath, "utf8"), name);
}

module.exports = { keysDir, restrictKeyPermissions, writeKeyFile, copyKeyFile };
