"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Deployment-time connection config: absent entirely -> "embedded" (today's
// behavior, spawn the server locally). Env vars take precedence over the
// config file so scripted/MDM-pushed deployments don't need to write a file.
// See docs/architecture/remote-server.md.

function defaultConfigPath(env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".cttc", "connection.json");
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
 * @returns {{mode: "embedded"} | {mode: "ssh-tunnel", sshTarget: string, sshKey: string|null, remotePort: number}}
 */
function loadConnectionConfig({ env = process.env, configPath } = {}) {
  const resolvedPath = configPath || defaultConfigPath(env);
  const fileCfg = readConfigFile(resolvedPath);

  const mode = env.CTTC_MODE || fileCfg.mode || "embedded";
  if (mode === "embedded") return { mode: "embedded" };
  if (mode !== "ssh-tunnel") {
    throw new Error(`unknown CTTC connection mode: ${JSON.stringify(mode)} (expected "embedded" or "ssh-tunnel")`);
  }

  const sshTarget = env.CTTC_SSH_TARGET || fileCfg.ssh_target;
  if (!sshTarget) {
    throw new Error("ssh-tunnel mode requires ssh_target (CTTC_SSH_TARGET env var, or ssh_target in connection.json)");
  }
  const sshKey = env.CTTC_SSH_KEY || fileCfg.ssh_key || null;

  const remotePortRaw = env.CTTC_REMOTE_PORT || fileCfg.remote_port;
  const remotePort = Number(remotePortRaw);
  if (!remotePortRaw || !Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
    throw new Error(`ssh-tunnel mode requires a valid remote_port between 1-65535 (got ${JSON.stringify(remotePortRaw)})`);
  }

  // ssh_port is optional -- absent means ssh's own default (22)
  const sshPortRaw = env.CTTC_SSH_PORT || fileCfg.ssh_port;
  const sshPort = sshPortRaw ? Number(sshPortRaw) : undefined;
  if (sshPortRaw && (!Number.isInteger(sshPort) || sshPort <= 0 || sshPort > 65535)) {
    throw new Error(`ssh-tunnel mode's ssh_port must be between 1-65535 (got ${JSON.stringify(sshPortRaw)})`);
  }

  return { mode: "ssh-tunnel", sshTarget, sshKey, remotePort, ...(sshPort ? { sshPort } : {}) };
}

/**
 * Writes an ssh-tunnel connection.json (mirrors deploy.ps1's step 4) so the
 * setup wizard (see main.js's runSetupWizard) and the PowerShell deploy path
 * produce byte-identical config files.
 * @param {{sshTarget: string, sshKey: string, remotePort: number, sshPort?: number}} cfg
 * @param {{configPath?: string}} [opts]
 */
function saveConnectionConfig(cfg, { configPath } = {}) {
  const resolvedPath = configPath || defaultConfigPath(process.env);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const json = JSON.stringify(
    {
      mode: "ssh-tunnel",
      ssh_target: cfg.sshTarget,
      ssh_key: cfg.sshKey,
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

module.exports = { loadConnectionConfig, saveConnectionConfig, defaultConfigPath };
