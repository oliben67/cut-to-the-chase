"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// Where the setup wizard drops a pasted-in key: alongside connection.json in
// ~/.cttc, not the (often admin-only) Program Files install directory.
function keysDir() {
  return path.join(os.homedir(), ".cttc", "keys");
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
    const username = os.userInfo().username;
    const r1 = spawnSync("icacls", [keyPath, "/inheritance:r"]);
    const r2 = spawnSync("icacls", [keyPath, "/grant:r", `${username}:(RW)`]);
    if (r1.status !== 0 || r2.status !== 0) {
      // Don't leave the file locked down worse than before -- restore
      // normal inherited permissions (which always include the owner)
      // rather than an ACL that grants no one access.
      spawnSync("icacls", [keyPath, "/reset"]);
      throw new Error(
        `could not restrict permissions on ${keyPath} (icacls failed) -- ` +
          "the key was saved with default (not locked-down) permissions."
      );
    }
  } else {
    fs.chmodSync(keyPath, 0o600);
  }
}

/**
 * Writes a pasted-in key's contents to ~/.cttc/keys/<name> and locks its
 * permissions down. Returns the written path.
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
    spawnSync("icacls", [keyPath, "/reset"]);
  }
  // ssh is picky about trailing whitespace/newline conventions from a
  // copy-paste; normalize to a single trailing newline.
  fs.writeFileSync(keyPath, contents.trim() + "\n", { encoding: "utf8" });
  restrictKeyPermissions(keyPath);
  return keyPath;
}

module.exports = { keysDir, restrictKeyPermissions, writeKeyFile };
