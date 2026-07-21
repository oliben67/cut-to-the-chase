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
// EPERM the moment it tries to rewrite an already-restricted file.
function restrictKeyPermissions(keyPath) {
  if (process.platform === "win32") {
    spawnSync("icacls", [keyPath, "/inheritance:r"]);
    spawnSync("icacls", [keyPath, "/grant:r", `${os.userInfo().username}:(RW)`]);
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
    // An earlier (R)-only run may have locked out even the owner's write
    // access -- the owner can always re-grant themselves permissions on a
    // file they own regardless of its current ACL, so restore write access
    // before truncating it below.
    spawnSync("icacls", [keyPath, "/grant:r", `${os.userInfo().username}:(RW)`]);
  }
  // ssh is picky about trailing whitespace/newline conventions from a
  // copy-paste; normalize to a single trailing newline.
  fs.writeFileSync(keyPath, contents.trim() + "\n", { encoding: "utf8" });
  restrictKeyPermissions(keyPath);
  return keyPath;
}

module.exports = { keysDir, restrictKeyPermissions, writeKeyFile };
