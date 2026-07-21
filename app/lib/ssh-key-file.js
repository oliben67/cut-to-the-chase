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

// The well-known "OWNER RIGHTS" SID -- whatever the file's *current* owner
// is, regardless of their actual username. Deliberately used instead of
// `${os.userInfo().username}:(RW)`: a bare username can fail to resolve
// under icacls (domain-joined machines where the short name is ambiguous,
// unusual characters, machines where the process runs as a different
// account than expected, etc.), and *that* silent failure is exactly what
// caused the "could not restrict permissions" error even after the
// /reset-before-write fix below -- the grant itself was failing, not just
// a stale ACL from a previous run. The SID form can't suffer a username
// lookup failure since it isn't a username at all.
const OWNER_RIGHTS_SID = "*S-1-3-4";

function icacls(args) {
  const r = spawnSync("icacls", args, { encoding: "utf8" });
  return { ok: r.status === 0, output: `${r.stdout || ""}${r.stderr || ""}`.trim(), status: r.status, error: r.error };
}

// ssh refuses a private key that's readable by anyone but its owner. On
// Windows that's icacls (mirrors deploy.ps1's step 2); elsewhere it's chmod.
// Grants (RW), not (R)-only: a read-only grant would lock the *owner* out of
// ever overwriting the file too, breaking a second run of the wizard with
// EPERM the moment it tries to rewrite an already-restricted file. Errors
// are checked: a silently-failed /inheritance:r or /grant:r can leave the
// file with an emptier ACL than before (nobody, not even the owner, granted
// access), which is the actual EPERM this whole function exists to prevent.
function restrictKeyPermissions(keyPath) {
  if (process.platform === "win32") {
    const r1 = icacls([keyPath, "/inheritance:r"]);
    const r2 = icacls([keyPath, "/grant:r", `${OWNER_RIGHTS_SID}:(RW)`]);
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
  // ssh is picky about trailing whitespace/newline conventions from a
  // copy-paste; normalize to a single trailing newline.
  fs.writeFileSync(keyPath, contents.trim() + "\n", { encoding: "utf8" });
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
