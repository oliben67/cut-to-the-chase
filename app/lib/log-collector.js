"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Persists whether "Collect CTTC Own Logs" (Preferences > Settings) is on
// and which directory it writes to -- same ~/.cttc/*.json shape as
// gateway-registry.js/connection-config.js, main-process-owned since the
// actual log file writing happens there, not in any one renderer.

function defaultSettingsPath(env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".cttc", "log-collector.json");
}

function readSettings({ configPath } = {}) {
  const resolvedPath = configPath || defaultSettingsPath(process.env);
  if (!fs.existsSync(resolvedPath)) return { enabled: false, dir: null };
  let raw;
  try {
    raw = fs.readFileSync(resolvedPath, "utf8");
  } catch {
    return { enabled: false, dir: null };
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM -- see connection-config.js
  try {
    const settings = JSON.parse(raw);
    return { enabled: !!settings.enabled, dir: settings.dir || null };
  } catch {
    return { enabled: false, dir: null }; // corrupt file -- treat as off rather than blocking startup
  }
}

function writeSettings(settings, { configPath } = {}) {
  const resolvedPath = configPath || defaultSettingsPath(process.env);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, JSON.stringify(settings, null, 2), "utf8");
}

// One file per collection start (app launch while enabled, or the moment
// the toggle is switched on) rather than one ever-growing file -- a fresh
// timestamped name each time, per the feature's own naming spec.
function logFileName(now = new Date()) {
  return `${now.toISOString().replace(/[:.]/g, "-")}.cttc-log`;
}

module.exports = { defaultSettingsPath, readSettings, writeSettings, logFileName };
