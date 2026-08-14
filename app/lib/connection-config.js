"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Deployment-time connection config: absent entirely -> "embedded" (today's
// behavior, spawn the server locally). Env vars take precedence over the
// config file so scripted/MDM-pushed deployments don't need to write a file.
// See docs/architecture/remote-server.md.
//
// "remote" mode: the client talks straight over HTTP to the server
// container running on cfg.host:cfg.remotePort -- no ssh tunnel, no local
// port-forward. ssh is only ever used to *provision* that container (see
// lib/server-provision.js's ensureRemoteContainer), not for the ongoing
// request/response traffic, so sshTarget/sshKey/sshPort are kept around
// purely for later re-provisioning (Settings > Update server image).

function defaultConfigPath(env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".cttc", "connection.json");
}

// "user@host[:ignored]" -> "host" -- the bare address the client uses for
// direct HTTP, as opposed to sshTarget's full user@host form ssh needs.
function hostFromTarget(sshTarget) {
  const at = sshTarget.lastIndexOf("@");
  return at === -1 ? sshTarget : sshTarget.slice(at + 1);
}

function readConfigFile(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return {};
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(`could not read connection config ${configPath}: ${err.message}`);
  }
  // Node's utf8 read doesn't strip a byte-order-mark, and JSON.parse treats
  // a leading BOM as invalid syntax -- easy to hit on Windows, where several
  // common tools (PowerShell's `-Encoding UTF8` in particular) write one.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in connection config ${configPath}: ${err.message}`);
  }
}

/**
 * @param {{env?: object, configPath?: string}} opts
 *   configPath overrides the default ~/.cttc/connection.json (mainly for tests).
 * @returns {{mode: "embedded", runMode?: "native"|"container"} | {mode: "remote", host: string, sshTarget: string, sshKey: string|null, remotePort: number, gatewayId?: string}}
 */
function loadConnectionConfig({ env = process.env, configPath } = {}) {
  const resolvedPath = configPath || defaultConfigPath(env);
  const fileCfg = readConfigFile(resolvedPath);

  const mode = env.CTTC_MODE || fileCfg.mode || "embedded";
  if (mode === "embedded") {
    // runMode: the user's one-time choice (see main.js's first-run dialog)
    // between running the gateway as a local Docker container or as a bare
    // native process -- omitted (not just `undefined`) when never chosen,
    // so callers can tell "never asked" apart from an explicit pick.
    return fileCfg.run_mode ? { mode: "embedded", runMode: fileCfg.run_mode } : { mode: "embedded" };
  }
  if (mode !== "remote") {
    throw new Error(`unknown CTTC connection mode: ${JSON.stringify(mode)} (expected "embedded" or "remote")`);
  }

  const sshTarget = env.CTTC_SSH_TARGET || fileCfg.ssh_target;
  if (!sshTarget) {
    throw new Error("remote mode requires ssh_target (CTTC_SSH_TARGET env var, or ssh_target in connection.json)");
  }
  const sshKey = env.CTTC_SSH_KEY || fileCfg.ssh_key || null;
  // Set for a GUI-managed gateway (its key lives encrypted in the vault,
  // keyed on this id -- see lib/key-vault.js/lib/ssh-key-file.js) instead of
  // sshKey above, which stays a literal path for the scripted/env-var deploy
  // case. The two are mutually exclusive in practice (see main.js's
  // recordGateway call sites) but both are read here unconditionally --
  // it's loadConnectionConfig's job to report what's in the file, not to
  // enforce that invariant.
  const gatewayId = fileCfg.gateway_id || null;

  const remotePortRaw = env.CTTC_REMOTE_PORT || fileCfg.remote_port;
  const remotePort = Number(remotePortRaw);
  if (!remotePortRaw || !Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
    throw new Error(`remote mode requires a valid remote_port between 1-65535 (got ${JSON.stringify(remotePortRaw)})`);
  }

  // ssh_port is optional -- absent means ssh's own default (22); only used
  // for (re-)provisioning, never for the client's direct HTTP traffic.
  const sshPortRaw = env.CTTC_SSH_PORT || fileCfg.ssh_port;
  const sshPort = sshPortRaw ? Number(sshPortRaw) : undefined;
  if (sshPortRaw && (!Number.isInteger(sshPort) || sshPort <= 0 || sshPort > 65535)) {
    throw new Error(`remote mode's ssh_port must be between 1-65535 (got ${JSON.stringify(sshPortRaw)})`);
  }

  return {
    mode: "remote",
    host: hostFromTarget(sshTarget),
    sshTarget,
    sshKey,
    remotePort,
    ...(sshPort ? { sshPort } : {}),
    ...(gatewayId ? { gatewayId } : {}),
  };
}

/**
 * Writes a "remote" connection.json (mirrors deploy.ps1's step 4) so the
 * gateway setup (see main.js's runSetupWizard) and the PowerShell deploy path
 * produce byte-identical config files. `cfg.gatewayId` and `cfg.sshKey` are
 * mutually exclusive (see loadConnectionConfig): a GUI-managed gateway's key
 * lives encrypted in the vault, keyed by gateway_id; a scripted/env-var
 * deploy keeps a literal ssh_key path.
 * @param {{sshTarget: string, sshKey?: string|null, gatewayId?: string, remotePort: number, sshPort?: number}} cfg
 * @param {{configPath?: string}} [opts]
 */
function saveConnectionConfig(cfg, { configPath } = {}) {
  const resolvedPath = configPath || defaultConfigPath(process.env);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const json = JSON.stringify(
    {
      mode: "remote",
      ssh_target: cfg.sshTarget,
      // Explicit `undefined` (JSON.stringify drops it) rather than simply
      // omitted, so a stale ssh_key can never leak through if this is ever
      // called with a merged/previous object instead of a freshly built one.
      ssh_key: cfg.gatewayId ? undefined : cfg.sshKey,
      ...(cfg.gatewayId ? { gateway_id: cfg.gatewayId } : {}),
      remote_port: cfg.remotePort,
      ...(cfg.sshPort ? { ssh_port: cfg.sshPort } : {}),
    },
    null,
    2
  );
  // BOM-less UTF-8 -- see readConfigFile's comment; write it the same way here.
  fs.writeFileSync(resolvedPath, json, { encoding: "utf8" });
  return resolvedPath;
}

/**
 * Deletes connection.json, reverting to embedded mode (today's default) --
 * used by the "revert to local" path in main.js's Run Setup flow.
 */
function clearConnectionConfig({ configPath } = {}) {
  const resolvedPath = configPath || defaultConfigPath(process.env);
  if (fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath);
}

/**
 * Persists the user's one-time choice (see main.js's first-run dialog)
 * between running the embedded gateway as a local Docker container or as a
 * bare native process. Preserves any other keys already in the file (there
 * shouldn't be any for embedded mode today, but this keeps it forward
 * compatible rather than clobbering the file).
 * @param {"native"|"container"} runMode
 * @param {{configPath?: string}} [opts]
 */
function saveRunMode(runMode, { configPath } = {}) {
  const resolvedPath = configPath || defaultConfigPath(process.env);
  const existing = readConfigFile(resolvedPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const json = JSON.stringify({ ...existing, mode: "embedded", run_mode: runMode }, null, 2);
  fs.writeFileSync(resolvedPath, json, { encoding: "utf8" });
  return resolvedPath;
}

module.exports = {
  loadConnectionConfig,
  saveConnectionConfig,
  saveRunMode,
  clearConnectionConfig,
  defaultConfigPath,
  hostFromTarget,
};
