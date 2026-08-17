"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, shell, nativeTheme, safeStorage } = require("electron");
// app.name otherwise falls back to package.json's "name" ("cttc-timeline"),
// which is what an unpackaged dev run's Dock/taskbar hover tooltip and the
// About dialog's title would show -- userData's default location is
// derived from app.name too, so it's captured *before* renaming and pinned
// back to it right after, or this would silently start a fresh, empty
// profile (recording marker, saved daemons, gateways, etc.) under a new
// path the very first time this runs.
const defaultUserDataDir = app.getPath("userData");
app.setName(`CTTC v${app.getVersion()}`);
app.setPath("userData", defaultUserDataDir);
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadConnectionConfig,
  saveConnectionConfig,
  clearConnectionConfig,
  hostFromTarget,
} = require("./lib/connection-config");
const { hasLocalDocker, canBeServerLocally } = require("./lib/docker-check");
const { shouldShowSkipButton } = require("./lib/gateway-setup-visibility");
const {
  getPublicKey,
  writeGatewayKey,
  copyGatewayKey,
  withDecryptedGatewayKeyFile,
  deleteGatewayKey,
  migrateLegacyGatewayKeys,
} = require("./lib/ssh-key-file");
const keyVault = require("./lib/key-vault");
const { auditGatewayList } = require("./lib/gateway-audit");
const {
  ensureLocalContainer,
  ensureRemoteContainer,
  uninstallLocalContainer,
  uninstallRemoteContainer,
  checkStillInstalled,
} = require("./lib/server-provision");
const {
  readGateways,
  recordGateway,
  retireGateway,
  gatewayKey,
  recordDockerHostForGateway,
  retireDockerHost,
} = require("./lib/gateway-registry");
const { readSelectedContainers, writeSelectedContainers, deleteSelectedContainers } = require("./lib/container-selection");
const { openSshTunnel, closeSshTunnel } = require("./lib/ssh-tunnel");
const { recordTunnel, removeTunnel, killOrphanedTunnels } = require("./lib/tunnel-registry");
const { getOrCreateApiToken, forgetApiToken } = require("./lib/api-token");
const {
  readSettings: readLogCollectorSettings,
  writeSettings: writeLogCollectorSettings,
  logFileName,
} = require("./lib/log-collector");
const { saveArtifact, listArtifacts, sweepArtifacts } = require("./lib/event-artifacts");
const { buildZip } = require("./lib/zip-writer");

const APP_ICON = path.join(__dirname, "assets", "icon.png");
// one-liner as published on GitHub (kept in sync with package.json's "description")
const APP_TAGLINE = "Correlate container telemetry with service logs on a shared clickable timeline";
// in-app "?" help buttons and About > User Manual open this -- a local,
// self-contained copy bundled next to the app (see package.json's
// extraResources and build/build-manual.js, which generates it from
// MANUAL.md; "prestart" also builds it for dev-mode runs) so opening the
// manual is always a local file access, never a network request -- there is
// deliberately no web fallback here. If the local file is somehow still
// missing (a dev checkout that skipped `npm run build:manual`), openManual()
// reports that clearly instead of reaching out to GitHub.
const HELP_TOPICS = {
  frequency: "#the-cursor-and-the-highlight-window",
};
function localManualPath() {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, "CTTC-Manual.html")
    : path.join(__dirname, "build", "CTTC-Manual.html");
  return fs.existsSync(p) ? p : null;
}
async function openManual(anchor) {
  const local = localManualPath();
  if (!local) {
    await dialog.showMessageBox({
      type: "error",
      title: "User Manual unavailable",
      message: "The local copy of the User Manual is missing.",
      detail: "Run `npm run build:manual` (from app/) to generate build/CTTC-Manual.html, then try again.",
    });
    return;
  }
  await shell.openExternal(`file://${local}${anchor}`);
}
// serverHost/serverPort are the actual address the client (renderer + this
// process's own fetch calls) talks to -- 127.0.0.1 for embedded/local *and*
// for a tunneled remote gateway (see connectRemoteGateway), the real
// host:port for a directly-reachable one. activeGateway{Host,Port} are the
// gateway's *logical* identity (always its real host:port, even while
// tunneled) -- what the registry keys entries by and what the dropdown
// matches "is this the active one" against; kept separate from
// serverHost/serverPort so a tunneled connection (client address
// 127.0.0.1, real identity elsewhere) doesn't get misidentified as "This
// machine" or fail to match its own registry entry.
let serverHost = "127.0.0.1";
let serverPort = null;
let activeGatewayHost = "127.0.0.1";
let activeGatewayPort = null;
let serverConnectionType = "local";
// The shared-secret required (as X-CTTC-Token) by the *currently active*
// gateway's own HTTP API, once one is generated for it -- null only before
// the very first connectToServer()/connectRemoteGateway() call has run.
// Exposed to the renderer via get-api-token/preload.js; every gateway
// connect path below (connectToServer, connectRemoteGateway,
// gateway-manage-save, the boot-time local-container fallback) must set
// this to whatever token it actually used to provision/reach that gateway.
let currentApiToken = null;
// The ssh -N -L child process backing a "remote-tunnel" connection, if any
// -- see connectRemoteGateway/lib/ssh-tunnel.js. Tracked here (not just
// left to whatever called openSshTunnel) so switching or disconnecting from
// a tunneled gateway can always find and kill the right process.
let currentTunnel = null;
let currentTunnelPort = null; // the local port currentTunnel forwards -- see setCurrentTunnel/clearCurrentTunnel

// Every currentTunnel = await openSshTunnel(...) must be paired with
// recordTunnel() (so a crash/force-quit before the next clearCurrentTunnel()
// leaves a pid behind that the *next* launch's killOrphanedTunnels() can
// still find and clean up -- see lib/tunnel-registry.js), and every closing
// path must be paired with removeTunnel(). Centralized here rather than
// duplicated at each of the several places currentTunnel is set/cleared.
function setCurrentTunnel(handle, containerPort, sshTarget) {
  currentTunnel = handle;
  currentTunnelPort = containerPort;
  recordTunnel({ pid: handle.proc.pid, containerPort, sshTarget });
  mainLog(`[tunnel] now active: pid ${handle.proc.pid}, 127.0.0.1:${containerPort} -> ${sshTarget}`);
}
function clearCurrentTunnel() {
  if (!currentTunnel) return;
  mainLog(`[tunnel] clearing active tunnel: pid ${currentTunnel.proc.pid}, port ${currentTunnelPort}`);
  closeSshTunnel(currentTunnel, { onLog: mainLog });
  removeTunnel(currentTunnelPort);
  currentTunnel = null;
  currentTunnelPort = null;
}
// The ssh target/port behind the *current* remote connection (tunneled or
// direct) -- null for local. Exists purely for get-connection-info's
// right-click detail popup (see app.js's status pill); nothing else needs
// it, since the actual ssh args live in connection.json/the registry entry.
let activeSshTarget = null;
let activeSshPort = undefined;

// Shared by get-gateways (flagging the active one for the dropdown) and
// gateway-manage-uninstall (deciding whether the uninstalled gateway was the
// one currently in use). Compares against the gateway's logical identity,
// not serverHost/serverPort -- see the comment above.
function isActiveGateway(g) {
  return g.mode === "embedded"
    ? activeGatewayHost === "127.0.0.1" && serverConnectionType === "local"
    : g.host === activeGatewayHost && g.port === activeGatewayPort;
}

// Refreshes the registry entry for whichever gateway is currently active,
// including its connectionType -- called right before switching away from
// it (see switch-gateway) so the "ssh-tunnel-gateways" list always reflects
// how the client was actually last talking to it, not just whether it was
// ever reached at all.
function recordCurrentGateway() {
  if (serverConnectionType === "local") {
    recordGateway({ mode: "embedded", host: "127.0.0.1", port: activeGatewayPort, label: "This machine", connectionType: "local" });
    return;
  }
  const existing = readGateways().find((g) => gatewayKey(g) === gatewayKey({ host: activeGatewayHost, port: activeGatewayPort }));
  if (existing) recordGateway({ ...existing, connectionType: serverConnectionType });
}

// Shared by get-gateways and switch-gateway's failure message (which needs
// to name the gateway it's staying on).
async function listGatewaysWithActiveFlag() {
  const gateways = readGateways();
  // "This machine" is a selectable gateway even if a local container has
  // never actually been provisioned here (recordGateway only ever runs
  // after one succeeds) -- it just won't have a real port yet, so there's
  // nothing to re-verify/switch to until Edit Gateways' Save actually
  // provisions one. But it can only ever manage Docker hosts if Docker is
  // actually installed here -- offering it regardless would send the user
  // into gateway setup only to hit a dead end once Docker turns out to be
  // missing.
  if (!gateways.some((g) => g.mode === "embedded") && (await hasLocalDocker())) {
    gateways.unshift({ mode: "embedded", host: "127.0.0.1", port: null, label: "This machine" });
  }
  for (const g of gateways) g.active = isActiveGateway(g);
  return gateways;
}

// Read-only reachability probe for the dropdown's passive per-item status
// (never triggers a switch on its own -- see check-gateway below). The
// never-provisioned "This machine" placeholder has no port to check and is
// always treated as reachable.
async function checkGatewayReachable(entry) {
  if (entry.mode === "embedded" && entry.port == null) return true;
  // Every other entry here has been successfully connected to before (see
  // recordGateway's own comment), so its token already exists -- this only
  // ever retrieves it, never generates a new one.
  const apiToken = getOrCreateApiToken(entry.mode === "embedded" ? "embedded" : hostFromTarget(entry.sshTarget));
  try {
    const r = await fetch(`http://${entry.host}:${entry.port}/health`, {
      signal: AbortSignal.timeout(4000),
      headers: { "X-CTTC-Token": apiToken },
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Every window's DevTools console (Help > Developer Tools) is the one place
// a user can see logs regardless of whether the app was launched from a
// terminal or double-clicked -- so main-process logging (including the
// server subprocess's own stdout/stderr, piped through here) is mirrored
// there via IPC, in addition to the usual console.log/error that only ever
// reaches a terminal if one happens to be attached.
function broadcastLog(level, text) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("main-log", { level, text });
  }
}

// "Collect CTTC Own Logs" (Preferences > Settings): an optional third sink
// alongside the console/DevTools ones above, writing to a file instead --
// covers everything mainLog/mainError already sees, not just this
// process's own messages.
// Where "Collect CTTC Own Logs" writes by default, the first time this app
// has ever run on this machine (see app.whenReady() below) -- next to the
// app itself, same folder the executable/AppImage lives in, rather than
// some separate profile directory nobody thinks to look in. Falls back to
// the writable userData dir if that folder turns out not to be writable
// (e.g. a per-machine Program Files install, or a read-only AppImage mount)
// -- see startLogCollector's error handling below, which is what actually
// detects that and falls back live.
function defaultLogCollectorDir() {
  return app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
}

let logCollectorStream = null;
function startLogCollector(dir) {
  stopLogCollector();
  logCollectorStream = fs.createWriteStream(path.join(dir, logFileName()), { flags: "a" });
  // Without this, a write failure (most likely: `dir` isn't writable --
  // Program Files without admin, a macOS .app bundle, a read-only AppImage
  // mount) would be an unhandled 'error' on the stream, crashing the whole
  // process instead of just leaving this one optional feature off.
  logCollectorStream.on("error", (err) => {
    const failedDir = dir;
    stopLogCollector();
    const settings = readLogCollectorSettings();
    if (failedDir !== app.getPath("userData")) {
      // Only retried once, into a directory Electron guarantees is
      // writable -- if *that* somehow also fails, give up rather than loop.
      const fallbackDir = app.getPath("userData");
      mainError(`[log-collector] couldn't write to ${failedDir} (${err.message}) -- falling back to ${fallbackDir}`);
      writeLogCollectorSettings({ ...settings, dir: fallbackDir });
      startLogCollector(fallbackDir);
    } else {
      mainError(`[log-collector] couldn't write to ${failedDir} (${err.message}) -- turning log collection off`);
      writeLogCollectorSettings({ ...settings, enabled: false });
    }
  });
}
function stopLogCollector() {
  if (logCollectorStream) {
    logCollectorStream.end();
    logCollectorStream = null;
  }
}
function writeToLogCollector(text) {
  logCollectorStream?.write(`${new Date().toISOString()} ${text}\n`);
}

function mainLog(...args) {
  const text = args.map(String).join(" ");
  console.log(text);
  broadcastLog("log", text);
  writeToLogCollector(text);
}
function mainError(...args) {
  const text = args.map(String).join(" ");
  console.error(text);
  broadcastLog("error", text);
  writeToLogCollector(`ERROR ${text}`);
}

async function showAboutDialog() {
  const stack = [
    `Electron ${process.versions.electron}`,
    `Chromium ${process.versions.chrome}`,
    `Node.js ${process.versions.node}`,
    // The gateway itself (log-sump-extended) runs in its own Docker
    // container, not bundled into this process -- its own dependency
    // versions (Python, Redis, ...) are that image's concern, not pinned
    // here.
    "Docker (log-sump gateway)",
  ];
  const { response } = await dialog.showMessageBox({
    type: "info",
    icon: APP_ICON,
    title: `About ${app.name}`,
    message: "Cut to the Chase (CTTC)",
    detail:
      `${APP_TAGLINE}\n\n` +
      `Version ${app.getVersion()}\n` +
      `\u00A9 ${new Date().getFullYear()} Olivier Steck\n\n` +
      `Built with:\n${stack.map((s) => `  \u2022 ${s}`).join("\n")}\n\n` +
      `Icons by Flaticon (flaticon.com)`,
    buttons: ["OK", "User Manual"],
    defaultId: 0,
    noLink: true,
  });
  if (response === 1) await openManual("");
}

// menu items that just trigger something in the renderer (open a dialog,
// click a toolbar button) go through this instead of an ipcMain.handle,
// since there's nothing for main.js itself to do — see preload.js's
// onMenuAction / app.js's listener for the renderer side.
function broadcastMenuAction(action) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("menu-action", action);
}

// The native OS menu (Menu.buildFromTemplate) can't have its row spacing
// tuned by CSS on either macOS or Windows, so the File/Edit/View/Window/Help
// bar is instead built as HTML in index.html/app.js (menubar-action below
// handles the items that need main-process access; simple ones still go
// through broadcastMenuAction/onMenuAction like before). No application menu
// is installed at all -- installMenu() just makes that explicit.
function installMenu() {
  Menu.setApplicationMenu(null);
}

// Electron shows no context menu at all by default (unlike a regular
// browser) -- text inputs/textareas got no right-click Cut/Copy/Paste/Select
// All without this. Attach to every window's webContents so it works
// anywhere text is editable (Set Sources' host field, the gateway setup's
// key-paste textarea, ...).
function attachEditContextMenu(win) {
  win.webContents.on("context-menu", (_e, params) => {
    if (!params.isEditable) return;
    Menu.buildFromTemplate([
      { label: "Cut", role: "cut", enabled: params.editFlags.canCut },
      { label: "Copy", role: "copy", enabled: params.editFlags.canCopy },
      { label: "Paste", role: "paste", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { label: "Select All", role: "selectAll", enabled: params.editFlags.canSelectAll },
    ]).popup({ window: win });
  });
}

// Edit/View/Window/quit-ish actions from the custom HTML menu bar that need
// something only main.js (or webContents) can do; File actions and dialog
// toggles are handled renderer-side and never reach here (see app.js).
ipcMain.handle("menubar-action", (e, action) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  switch (action) {
    case "about": showAboutDialog(); break;
    case "reload": win?.webContents.reload(); break;
    case "toggle-devtools": win?.webContents.toggleDevTools(); break;
    case "zoom-in": win?.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5); break;
    case "zoom-out": win?.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5); break;
    case "zoom-reset": win?.webContents.setZoomLevel(0); break;
    case "toggle-fullscreen": win?.setFullScreen(!win.isFullScreen()); break;
    case "minimize": win?.minimize(); break;
    case "close": win?.close(); break;
    case "quit": app.quit(); break;
    // Full process restart, not just a page reload (see "reload" above) --
    // relaunches the whole Electron app (fresh main process, re-spawns the
    // embedded server child, re-runs every startup path) rather than just
    // re-executing the renderer's JS in place.
    case "restart": app.relaunch(); app.exit(); break;
  }
});

// Shown from the moment the app starts until the main window has actually
// painted -- bridges both the potentially-slow connectToServer() call
// (docker pull/load, remote provisioning over ssh, ...) and the main BrowserWindow's own
// load/render time, so there's never a blank Electron window on screen in
// between. Idempotent: safe to call again if one's already up (e.g. right
// before createWindow(), after a path that already showed it earlier).
// Skipped only while the gateway setup's own window is up (see
// app.whenReady below) -- that's already a fully-drawn "please wait" UI of
// its own, so stacking a second loading window on top would be redundant.
let splashWindow = null;
function showSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) return splashWindow;
  splashWindow = new BrowserWindow({
    width: 300,
    height: 320,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    icon: APP_ICON,
    // Created hidden -- shown only once splash.html has actually rendered
    // its first frame (see 'ready-to-show' below). Without this the window
    // is mapped and painted blank (native background color, no content)
    // the instant it's constructed, which is the "blank background" flash
    // this window exists to avoid in the first place.
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  splashWindow.once("ready-to-show", () => splashWindow?.show());
  // Re-delivers whatever the latest narrate()/splashStatus() call already
  // was (see splashStatus's own comment on why sends before this can be
  // lost) the moment the page is actually able to receive it -- so
  // whatever's on screen once it's shown is always real status, never the
  // static "Loading CTTC…" placeholder baked into splash.html.
  splashWindow.webContents.once("did-finish-load", () => {
    if (lastSplashStatus != null) splashStatus(lastSplashStatus);
  });
  splashWindow.loadFile(path.join(__dirname, "renderer", "splash.html"));
  return splashWindow;
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
}

// A short, human-readable status line for the splash window -- deliberately
// NOT the same firehose as mainLog/"main-log" (the main window's activity
// log): that channel also carries raw command echoes ("$ ssh ...", "$
// docker ..." -- see server-provision.js's run()) and unfiltered subprocess
// stdout/stderr (progress bars, ssh warnings, multi-line dumps), which read
// as garbled noise squeezed into a single-line status widget. Callers pair
// this with their own mainLog() call for the full-detail line -- narrate()
// below does exactly that for the common case of "one plain-English
// sentence, nothing more.
// Tracked here (not just fired-and-forgotten) so splash.html's static
// "Loading CTTC…" placeholder never actually lingers on screen: the very
// first narrate() calls in app.whenReady() below fire essentially
// synchronously with showSplash(), which is well before the splash
// window's own page has loaded far enough to have attached its
// "splash-status" listener (loadFile() is async) -- webContents.send() to a
// not-yet-listening renderer is simply lost, not queued, so without this
// the window would sit on the placeholder text until whichever later
// narrate() call happens to land after the page finishes loading.
let lastSplashStatus = null;
function splashStatus(text) {
  lastSplashStatus = text;
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send("splash-status", text);
}
function narrate(text) {
  mainLog(`$ ${text}`);
  splashStatus(text);
}

let mainWindow = null;
async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    icon: APP_ICON,
    // Created hidden -- shown only on 'ready-to-show' below, once the page
    // has actually rendered its first frame. Without this, the window
    // paints as a blank white/gray rectangle the instant it's constructed,
    // well before index.html/app.js have anything to show -- exactly the
    // "long time before any UI" gap the splash screen exists to cover.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  // Auxiliary windows (popouts, the detached action bar) have no reason to
  // keep running once the main window they belong to is gone -- without
  // this, closing just the main window leaves them orphaned with nothing
  // behind them, and window-all-closed never fires to actually quit the
  // app. New Gateway/Edit Gateways are dialogs in the main window itself
  // now (see index.html's #dlg-gateway-setup), so they close with it.
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    if (actionBarWindow && !actionBarWindow.isDestroyed()) actionBarWindow.close();
    for (const popout of popoutWindows.values()) {
      if (!popout.isDestroyed()) popout.close();
    }
  });
  win.once("ready-to-show", () => {
    win.show();
    closeSplash();
  });
  win.webContents.on("console-message", (_e, level, msg) => {
    if (level >= 2) console.error(`[renderer] ${msg}`);
  });
  attachEditContextMenu(win);
  await win.loadFile(path.join(__dirname, "renderer", "index.html"), {
    // br-NET-004: token is whatever the active gateway actually requires
    // (null for the bare/native 127.0.0.1-only embedded path, which never
    // needed one) -- app.js reads it the same synchronous way it already
    // reads host/port, so every request it ever makes can carry it.
    search: `host=${serverHost}&port=${serverPort}&token=${currentApiToken || ""}`,
  });
  // e2e mode: CTTC_TEST=<spec.js> runs the spec in the page, reports results
  // + V8 byte coverage of app.js (as exercised by the spec) on stdout, then
  // exits (0 = all passed). The debugger can only attach to a live page, so
  // coverage starts after load — boot-only top-level lines read as uncovered.
  const testFile = process.env.CTTC_TEST;
  if (testFile) {
    // 300s, not 120s (BUG-0092): the suite's own sample-export/upload/
    // download-heavy tests now do real, non-trivial work against sources
    // that stay genuinely open all the way through the run -- 120s was
    // only ever enough because a since-fixed bug (remove-dialog.ts's
    // dlg-remove-daemon-delete closing every open source, not just the
    // host being removed) silently emptied state.sources partway through
    // every run, making everything after that artificially instant. Even
    // at 300s a full run isn't guaranteed to finish in every environment
    // (observed exceeding even 600s in one heavily-loaded sandbox) -- see
    // BUG-0092's own doc; treat a timeout here as inconclusive, not
    // necessarily a real hang, and re-check interactively before assuming
    // a regression.
    setTimeout(() => {
      console.error("[test] global timeout — spec never resolved");
      app.exit(3);
    }, 300000);
    setTimeout(async () => {
      let code = 2;
      try {
        const fs = require("fs");
        const dbg = win.webContents.debugger;
        dbg.attach("1.3");
        await dbg.sendCommand("Profiler.enable");
        await dbg.sendCommand("Profiler.startPreciseCoverage", { callCount: false, detailed: true });
        const spec = fs.readFileSync(path.resolve(testFile), "utf8");
        const result = await win.webContents.executeJavaScript(spec);
        let coverage = null;
        try {
          const cov = await win.webContents.debugger.sendCommand("Profiler.takePreciseCoverage");
          const entry = cov.result.find((s) => s.url.endsWith("renderer/app.js"));
          if (entry) {
            const src = fs.readFileSync(path.join(__dirname, "renderer", "app.js"), "utf8");
            const flat = new Uint8Array(src.length);
            for (const fn of entry.functions)
              for (const r of fn.ranges)
                flat.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(r.endOffset, src.length));
            let covered = 0;
            for (const b of flat) covered += b;
            coverage = Math.round((covered / src.length) * 1000) / 10;
          }
        } catch { /* coverage is informational only */ }
        console.log("CTTC_TEST_RESULTS " + JSON.stringify({ ...result, appJsByteCoveragePct: coverage }));
        code = result && result.failed === 0 ? 0 : 1;
      } catch (err) {
        console.error(`[test] ${err.stack || err}`);
      }
      app.exit(code);
    }, 1500);
    return;
  }
  // headless-ish verification: CTTC_SCREENSHOT=/path.png captures the window and quits
  const shot = process.env.CTTC_SCREENSHOT;
  if (shot) {
    setTimeout(async () => {
      try {
        const evalJs = process.env.CTTC_EVAL; // arbitrary setup before capture
        if (evalJs) await win.webContents.executeJavaScript(evalJs).catch((e) => console.error(`[eval] ${e}`));
        const off = process.env.CTTC_CURSOR_OFFSET;
        if (off) {
          await win.webContents.executeJavaScript(`setCursor(state.range.min_ts + ${Number(off)})`);
          await new Promise((r) => setTimeout(r, 700));
        }
        const img = await win.webContents.capturePage();
        require("fs").writeFileSync(shot, img.toPNG());
        console.log(`[screenshot] ${shot}`);
      } finally {
        app.quit();
      }
    }, 4000);
  }
}

ipcMain.handle("pick-files", async (_e, title, filters) => {
  const r = await dialog.showOpenDialog({
    title: title || "Open log / stats files",
    properties: ["openFile", "multiSelections"],
    filters: filters || [{ name: "All Files", extensions: ["*"] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle("open-help", async (_e, topic) => {
  const anchor = HELP_TOPICS[topic] || "";
  await openManual(anchor);
});

// phase 3 of docs/architecture/remote-server.md: the renderer fetches a
// sample's bytes from the server itself (GET /files/download) rather than
// asking this process to tell the server where to write on a filesystem
// they might not share -- this process's job is just the native save
// dialog + writing those already-fetched bytes locally.
ipcMain.handle("save-binary", async (_e, defaultName, bytes) => {
  const r = await dialog.showSaveDialog({
    title: "Save metrics",
    defaultPath: defaultName,
    filters: [{ name: "CTTC metrics", extensions: ["cttc-metric"] }],
  });
  if (r.canceled || !r.filePath) return null;
  await require("fs").promises.writeFile(r.filePath, Buffer.from(bytes));
  return r.filePath;
});

// counterpart for uploads: the renderer picks a local path via pick-files,
// then needs this process's fs access to actually read it before POSTing
// the bytes to /files/upload itself (this process never talks to the CTTC
// server API -- same "thin glue" split as everywhere else in main.js).
ipcMain.handle("read-file", async (_e, filePath) => {
  return await require("fs").promises.readFile(filePath);
});

/* ── Recording (Record/Pause/Stop/Open Recording) ─────────────────────────
   The renderer owns the actual state machine (when a segment starts/ends,
   which server call to make) -- this process only ever does two things a
   renderer can't: show the native save dialog once, and read/write bytes
   to a path outside the sandbox. See renderer/app.js's recording section. */

// Asked once, at Stop -- not Start, so beginning a recording never
// interrupts the user with a save dialog before they even know how long
// they'll be recording for (every segment flushed in the meantime went to
// RECORDING_SCRATCH_PATH instead, see get-recording-scratch-path above).
// If Stop's own save is cancelled/fails, the renderer keeps the scratch
// file around and can prompt again next time Stop is clicked.
ipcMain.handle("pick-recording-path", async () => {
  const r = await dialog.showSaveDialog({
    title: "Save Recording",
    defaultPath: `recording-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.cttc-record`,
    filters: [{ name: "CTTC recording", extensions: ["cttc-record"] }],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
});

ipcMain.handle("write-binary-file", async (_e, filePath, bytes) => {
  await require("fs").promises.writeFile(filePath, Buffer.from(bytes));
});

/* ── log panel export (per-panel "Export .log" button, app.js) ────────────
   Same dialog-first, write-later split as pick-recording-path/
   write-binary-file above -- and for the same reason: exporting means
   paginating through potentially every row a source has, which the
   renderer must only do once the user has actually confirmed Save, not
   before (the whole point of asking for the path here without touching
   the log data at all). */
ipcMain.handle("pick-log-export-path", async (_e, defaultName) => {
  const r = await dialog.showSaveDialog({
    title: "Export log",
    defaultPath: defaultName,
    filters: [{ name: "Log file", extensions: ["log"] }],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
});

/* ── Events (renderer/app.js's UI-hosted event engine) ────────────────────
   A UI-hosted event's triggered snapshot/recording is saved silently (no
   save dialog -- nobody's necessarily watching when a background event
   fires) under ~/.cttc/events/, with a TTL-driven sweep run periodically
   here rather than by the renderer, since only this process has fs access. */
ipcMain.handle("save-event-artifact", (_e, name, bytes, opts) => saveArtifact(name, bytes, opts));
ipcMain.handle("list-event-artifacts", () => listArtifacts());
setInterval(() => sweepArtifacts(), 3600_000); // hourly, same cadence as the gateway's own TTL sweep tick

// Durable, client-side marker (per the client/server/docker-host model's
// "client owns its own recovery state" -- see the Recording feature): if
// the app goes down mid-recording (crash, force-quit, machine sleep/
// shutdown), the next launch reads this and surfaces the interrupted
// session as *paused* rather than silently losing track of it or
// pretending nothing happened. Lives in userData, not next to
// connection.json, since it's per-install session state, not deployment
// config.
const RECORDING_MARKER_PATH = path.join(app.getPath("userData"), "recording.json");

// A fixed, never-prompted-for path every Start/Pause/Resume segment flush
// writes to (see renderer/app.js's flushRecordingSegment) -- the user only
// ever picks a *real* destination once, at Stop (pick-recording-path,
// below), which is exactly the point: asking upfront, before they even
// know how long they'll be recording, was the whole UX complaint this
// scratch file exists to fix. Using a fixed path rather than a fresh one
// per session means a crash mid-recording still recovers cleanly (same
// path recoverInterruptedRecording expects from RECORDING_MARKER_PATH) at
// the cost of only ever tracking one in-progress recording at a time,
// which the app's own UI already assumes throughout (a single `recording`
// object, one set of transport buttons).
const RECORDING_SCRATCH_PATH = path.join(app.getPath("userData"), "recording-in-progress.cttc-record");

ipcMain.handle("get-recording-scratch-path", () => RECORDING_SCRATCH_PATH);

ipcMain.handle("get-recording-marker", async () => {
  try {
    return JSON.parse(await require("fs").promises.readFile(RECORDING_MARKER_PATH, "utf8"));
  } catch {
    return null; // absent, or corrupt -- either way, nothing to recover
  }
});

ipcMain.handle("set-recording-marker", async (_e, marker) => {
  const fs = require("fs").promises;
  if (marker == null) {
    await fs.unlink(RECORDING_MARKER_PATH).catch(() => {});
    return;
  }
  await fs.mkdir(path.dirname(RECORDING_MARKER_PATH), { recursive: true });
  await fs.writeFile(RECORDING_MARKER_PATH, JSON.stringify(marker, null, 2), "utf8");
});

// snapshot exports: same dialog + write, only the file type differs
async function saveSnapshotAs(defaultName, contents, filter) {
  const r = await dialog.showSaveDialog({
    title: "Save snapshot",
    defaultPath: defaultName,
    filters: [filter],
  });
  if (r.canceled || !r.filePath) return null;
  await require("fs").promises.writeFile(r.filePath, contents, "utf-8");
  return r.filePath;
}
ipcMain.handle("save-json", (_e, name, text) =>
  saveSnapshotAs(name, text, { name: "JSON", extensions: ["json"] }));
ipcMain.handle("save-text", (_e, name, text) =>
  saveSnapshotAs(name, text, { name: "Text", extensions: ["txt"] }));

// panels ("telemetry", or a log source by id) popped out into their own
// window; still talk to the same server and stay in sync with the main
// window (and each other) via the "sync-broadcast" relay below.
const popoutWindows = new Map(); // "kind:id" -> BrowserWindow

ipcMain.handle("popout", async (e, kind, id, view) => {
  const key = `${kind}:${id || ""}`;
  const existing = popoutWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }
  const opener = BrowserWindow.fromWebContents(e.sender);
  const big = kind === "telemetry" || kind === "host" || kind === "series";
  const win = new BrowserWindow({
    width: big ? 1000 : 640,
    height: big ? 620 : 520,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popoutWindows.set(key, win);
  attachEditContextMenu(win);
  const params = new URLSearchParams({
    host: serverHost,
    port: String(serverPort),
    popout: kind,
    token: currentApiToken || "",
  });
  if (id) params.set("id", id);
  // hand the opener's current view/cursor over so the new window opens on
  // exactly the same time range instead of blank-then-reset
  if (view && view.t0 != null) {
    params.set("v0", String(view.t0));
    params.set("v1", String(view.t1));
    if (view.cursor != null) params.set("vc", String(view.cursor));
  }
  await win.loadFile(path.join(__dirname, "renderer", "index.html"), { search: params.toString() });
  win.on("closed", () => {
    popoutWindows.delete(key);
    if (opener && !opener.isDestroyed()) {
      opener.webContents.send("popout-closed", { kind, id });
      opener.focus(); // return to wherever the pop-out originated (main or another pop-out)
    }
  });
});

ipcMain.on("sync-broadcast", (e, msg) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.id !== e.sender.id) win.webContents.send("sync-broadcast", msg);
  }
});

// Connecting to the server has three shapes:
// - "embedded" + no local Docker (only reachable in an unpackaged dev
//   checkout -- see app.whenReady below, which routes packaged installs
//   with no Docker to the gateway setup instead): spawns server.py locally
//   via uv, same as always.
// - "embedded" + local Docker present: the packaged app's real default --
//   docker-load (or, once a registry is wired up, docker-pull) the server
//   image and run it as a local container instead of a bare uv/python
//   process (see app/lib/server-provision.js).
// - "remote": provisions (load/pull + `docker compose up`) the container on
//   the configured Docker-enabled host over ssh, then talks to it directly
//   over plain HTTP -- ssh is only used for that one-time provisioning
//   step, never for the ongoing client<->server traffic (no tunnel, no
//   local port-forward).
// Either way the renderer only ever sees http://<serverHost>:<serverPort> —
// it can't tell embedded, local-container, and remote apart.
// The image tarball + compose files are electron-builder extraResources
// (see app/package.json) -- only present under process.resourcesPath once
// packaged. In an unpackaged dev checkout there's nothing there, so
// server-provision.js's own dev fallback (reading straight out of
// releases/windows/) is used instead.
function resourcesDirForApp() {
  return app.isPackaged ? process.resourcesPath : undefined;
}

async function connectToServer(fileArgs) {
  const cfg = loadConnectionConfig();
  if (cfg.mode === "embedded") {
    // app/server (the bare `uv run server.py` native fallback) is gone --
    // the embedded gateway is always the local log-sump Docker container
    // now, unconditionally, on both packaged and dev-checkout runs. There is
    // no non-Docker path left to fall back to (see
    // .claude/plans/sprightly-stirring-blum.md's Phase 10); a missing Docker
    // install surfaces here as a clear, actionable error instead of a
    // confusing failure a few layers down inside ensureLocalContainer.
    if (!(await hasLocalDocker())) {
      throw new Error(
        "Docker is required to run CTTC's gateway locally -- install Docker Desktop " +
          "(or Docker Engine) and make sure it's running, then restart CTTC."
      );
    }
    narrate("starting the local gateway container...");
    const apiToken = getOrCreateApiToken("embedded");
    const { port } = await ensureLocalContainer({ resourcesDir: resourcesDirForApp(), apiToken, onLog: mainLog });
    serverHost = "127.0.0.1";
    serverPort = port;
    activeGatewayHost = "127.0.0.1";
    activeGatewayPort = port;
    serverConnectionType = "local";
    activeSshTarget = null;
    activeSshPort = undefined;
    currentApiToken = apiToken;
    mainLog(`[docker] server container running locally — port ${serverPort}`);
    recordGateway({ mode: "embedded", host: serverHost, port: serverPort, label: "This machine", connectionType: "local" });
    return;
  }
  if (fileArgs.length) {
    // file paths are local to *this* machine; meaningless against a shared
    // remote server, so they're ignored rather than silently mis-sent
    mainError(`[remote] ignoring command-line files in remote mode: ${fileArgs.join(", ")}`);
  }
  // First-time connect to a deployed gateway (see connectRemoteGateway):
  // tries direct HTTP first, falling back to an ssh tunnel if that times
  // out/fails.
  narrate(`connecting to ${cfg.sshTarget}...`);
  const result = await connectRemoteGateway(cfg, { onLog: mainLog });
  serverHost = result.host;
  serverPort = result.port;
  activeGatewayHost = result.gatewayHost;
  activeGatewayPort = result.gatewayPort;
  serverConnectionType = result.connectionType;
  activeSshTarget = cfg.sshTarget;
  activeSshPort = cfg.sshPort;
  currentApiToken = result.apiToken;
  mainLog(
    `[remote] connected to ${cfg.sshTarget} via ${result.connectionType} — http://${serverHost}:${serverPort}`
  );
  recordGateway({
    // cfg.gatewayId (a GUI-managed gateway remembered via connection.json)
    // and cfg.sshKey (a literal, scripted/env-var path) are mutually
    // exclusive -- see lib/connection-config.js's loadConnectionConfig.
    ...(cfg.gatewayId ? { id: cfg.gatewayId } : {}),
    mode: "remote",
    host: activeGatewayHost,
    port: activeGatewayPort,
    label: cfg.sshTarget,
    sshTarget: cfg.sshTarget,
    ...(cfg.gatewayId ? { sshKey: undefined, hasSshKey: true } : { sshKey: cfg.sshKey }),
    ...(cfg.sshPort ? { sshPort: cfg.sshPort } : {}),
    connectionType: result.connectionType,
    imageRef: result.imageRef,
  });
}

// Right after provisioning, check whether the server host itself has docker
// -- that's what Set Sources targets by default (an empty Docker host field
// there resolves to wherever the server process lives). Purely
// informational: failure here doesn't block setup, it just tells the user
// up front whether they'll need to type an explicit target in Set Sources
// instead of relying on the default.
async function checkServerHostDocker(host, port, onLog, apiToken) {
  onLog?.("$ checking for docker on the server host...");
  try {
    const r = await fetch(`http://${host}:${port}/docker/ps`, {
      method: "POST",
      body: JSON.stringify({}),
      ...(apiToken ? { headers: { "X-CTTC-Token": apiToken } } : {}),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      onLog?.(`  → docker found (${j.containers.length} container(s), ${j.services.length} service(s))`);
    } else {
      onLog?.(`  → no local docker on the server host: ${j.error || r.status}`);
      onLog?.("  → you'll need to set an explicit target in Set Sources' Docker host field");
    }
  } catch (err) {
    onLog?.(`  → could not check: ${err.message || err}`);
  }
}

// Embedded mode with no local Docker has nothing to sample -- offer to set
// up a remote server on a Docker-enabled host instead of just starting an
// empty embedded server. The gateway setup window itself provisions the remote
// container (so it can show its own "please wait" / error state) and sets
// `serverHost`/`serverPort` directly on success; closing it without
// succeeding rejects, which the caller treats the same as any other startup
// failure.

// Shared by the first-run wizard's own dynamic gateway-setup-submit handler
// below and the in-window "New Gateway" dialog's static gateway-add-submit
// handler (see index.html's #dlg-gateway-setup / app.js) -- both do exactly
// this to actually stand up a remote gateway, they just differ in which
// window's activity log the ssh/docker output streams to, and in what
// happens to the caller's own window afterward (the wizard resolves a
// promise and destroys itself; the in-window dialog just reports ok/error).
// Throws (rather than returning {ok:false,...}) so both callers can share
// one try/catch.
async function provisionRemoteGateway(payload, onLog) {
  const host = hostFromTarget(`${payload.sshUser}@${payload.sshHost}`);
  const existing = readGateways().find((g) => g.host === host);
  if (existing) {
    throw new Error(
      `A gateway already exists at ${host} (${existing.label}) -- use File > Gateways > Edit Gateways to modify it instead.`
    );
  }
  // Generated up front, before any gateway record exists -- this becomes
  // the real, permanent id once recordGateway() below runs (it prefers a
  // caller-supplied entry.id over minting its own), and is what the key
  // just written gets stored under. Needed now, not lazily: the key has to
  // be keyed on *something* stable before the very first connect attempt.
  const gatewayId = randomUUID();
  const keyOpts = { safeStorage, getPassphraseKey: ensureVaultUnlocked };
  if (payload.keyMode === "paste") await writeGatewayKey(gatewayId, payload.keyContents, keyOpts);
  else await copyGatewayKey(gatewayId, payload.keyPath, keyOpts);
  const cfg = {
    sshTarget: `${payload.sshUser}@${payload.sshHost}`,
    gatewayId,
    sshPort: payload.sshPort,
    remotePort: 8765, // the CTTC server's fixed container port; see docker-compose.yml
  };
  try {
    // First-time connect to this gateway -- direct HTTP first, ssh tunnel
    // fallback if that times out/fails (see connectRemoteGateway).
    const result = await connectRemoteGateway({ ...cfg, imageSource: payload.imageSource || undefined }, { onLog });
    return { remote: result, cfg };
  } catch (err) {
    // Nothing will ever reference this id (no gateway record was ever
    // created for it) -- without this, a failed first connect leaves an
    // orphaned vault entry behind forever.
    await deleteGatewayKey(gatewayId, {}).catch(() => {});
    throw err;
  }
}

// Connects to a remote gateway, choosing plain direct HTTP or an ssh -L
// tunnel as the transport:
//   - always (re-)installs the container over ssh first (idempotent --
//     `docker compose up -d` is a no-op if it's already running at the
//     right image), so both a first-time connect and a reconnect to a
//     known gateway are guaranteed to have something listening before any
//     reachability check runs.
//   - closes whatever tunnel this client currently has open, if any --
//     only one gateway is ever connected to at a time, so a stale tunnel to
//     the *previous* gateway must never linger once this one takes over.
//   - forceTunnel skips the direct-HTTP attempt and goes straight to a
//     tunnel: used when switching to a gateway this client already has
//     recorded (see switch-gateway) -- if it's known at all, use its
//     last-known-good transport info directly rather than re-probing.
//     Left false, direct HTTP is tried first (10s), falling back to a
//     tunnel only if that times out/fails -- the path for a first-time
//     connect to a freshly deployed gateway (see connectToServer,
//     gateway-setup-submit, gateway-add-submit).
// Returns the *client-facing* host/port (what serverHost/serverPort should
// become -- 127.0.0.1 when tunneled) separately from the gateway's logical
// identity (gatewayHost/gatewayPort -- always its real address, tunneled or
// not), plus imageRef for the registry and apiToken for every later request
// (br-NET-004) -- callers must set currentApiToken from the result.
// br-OWNER-001 (REQ-0069): claim ownership of a *remote* gateway once it's
// confirmed reachable -- idempotent server-side (SET NX), so reconnecting
// to an already-owned gateway is a harmless no-op there, never a rewrite.
// Only called for remote gateways: the embedded/local ("This machine")
// gateway is loopback-only (br-NET-001/003), already outside br-NET-004's
// token requirement, and has no ssh keypair to claim with in the first
// place. Best-effort -- a failure here (older gateway image with no
// /gateway/ownership/claim route yet, network hiccup, etc.) must never
// break an otherwise-successful connect.
async function claimGatewayOwnership({ host, port, apiToken, sshKey }, onLog) {
  if (!sshKey) return;
  try {
    const ownerPublicKey = getPublicKey(sshKey);
    const r = await fetch(`http://${host}:${port}/gateway/ownership/claim`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        "Content-Type": "application/json",
        ...(apiToken ? { "X-CTTC-Token": apiToken } : {}),
      },
      body: JSON.stringify({ ownerLabel: os.hostname(), ownerPublicKey }),
    });
    if (!r.ok) {
      onLog?.(`[ownership] claim request rejected (${r.status}) -- continuing unowned`);
    }
  } catch (err) {
    onLog?.(`[ownership] could not claim ownership (${err.message || err}) -- continuing unowned`);
  }
}

// br-MESH-003 / br-AUDIT-001/004 (REQ-0070/REQ-0071): posts this client's
// known gateway list to the one just connected to, adopts the merged
// list back, audits every entry (bounded concurrency, per-check
// timeout), and persists the results locally to seed the next connect.
// Entirely informational (REQ-0010's principle, reaffirmed by
// br-AUDIT-004) -- never triggers a reconnect or switch, and never
// speculatively adds a merely-*discovered* peer to the persistent
// "recent gateways" history: recordGateway's own contract is "called
// right after a connect actually succeeds -- never speculatively", so a
// peer this client has never itself actually reached only ever gets
// audited here, not written to disk, until/unless the user connects to
// it for real. Best-effort, same as claimGatewayOwnership -- a failure
// here must never break an otherwise-successful connect.
async function syncAndAuditGateways({ host, port, apiToken }, onLog) {
  try {
    const registry = readGateways().filter((g) => g.mode !== "embedded");
    const known = registry.map((g) => ({
      host: g.host,
      port: g.port,
      lastContactAt: g.lastContactAt,
      lastContactResult: g.lastContactResult,
      existence: g.existence,
    }));
    const r = await fetch(`http://${host}:${port}/gateways/sync`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        "Content-Type": "application/json",
        ...(apiToken ? { "X-CTTC-Token": apiToken } : {}),
      },
      body: JSON.stringify({ entries: known }),
    });
    if (!r.ok) {
      onLog?.(`[mesh] gateways/sync rejected (${r.status}) -- skipping this pass`);
      return;
    }
    const { entries } = await r.json();
    const audited = await auditGatewayList(entries || [], { onLog });
    for (const entry of audited) {
      const key = gatewayKey({ host: entry.host, port: entry.port });
      const existingRecord = registry.find((g) => gatewayKey(g) === key);
      if (!existingRecord) continue; // discovered, not (yet) connected to -- never recorded speculatively
      recordGateway({
        ...existingRecord,
        lastContactAt: entry.lastContactAt,
        lastContactResult: entry.lastContactResult,
        existence: entry.existence,
      });
    }
  } catch (err) {
    onLog?.(`[mesh] sync/audit failed (${err.message || err}) -- continuing`);
  }
}

async function connectRemoteGatewayWithKeyPath(cfg, { onLog, forceTunnel = false } = {}) {
  const sshBin = process.env.CTTC_SSH_BIN || "ssh";
  // Same key ensureRemoteContainer itself resolves `host` from below --
  // getOrCreateApiToken always returns the same, already-persisted token
  // for a given gateway (see lib/api-token.js), so this never changes
  // between an ordinary reconnect's `docker compose up -d` calls.
  const apiToken = getOrCreateApiToken(cfg.host || hostFromTarget(cfg.sshTarget));
  const remote = await ensureRemoteContainer(cfg, {
    sshBin,
    resourcesDir: resourcesDirForApp(),
    source: cfg.imageSource || undefined,
    apiToken,
    onLog,
  });

  clearCurrentTunnel();

  if (!forceTunnel) {
    try {
      const r = await fetch(`http://${remote.host}:${remote.port}/health`, {
        signal: AbortSignal.timeout(10000),
        headers: { "X-CTTC-Token": apiToken },
      });
      if (r.ok) {
        await claimGatewayOwnership({ host: remote.host, port: remote.port, apiToken, sshKey: cfg.sshKey }, onLog);
        await syncAndAuditGateways({ host: remote.host, port: remote.port, apiToken }, onLog);
        return {
          host: remote.host,
          port: remote.port,
          gatewayHost: remote.host,
          gatewayPort: remote.port,
          connectionType: "remote",
          imageRef: remote.imageRef,
          apiToken,
        };
      }
    } catch {
      /* not reachable directly -- fall through to the tunnel below */
    }
  }

  onLog?.(`$ ${remote.host}:${remote.port} not reachable directly -- opening an ssh tunnel instead...`);
  const tunnel = await openSshTunnel(
    { sshTarget: cfg.sshTarget, sshKey: cfg.sshKey, sshPort: cfg.sshPort, containerPort: remote.port },
    {
      sshBin,
      onLog,
      // Only clear global state if this handle is *still* the active
      // tunnel -- switching gateways in the meantime already replaced it
      // with a newer one, whose own exit this must not be mistaken for.
      onUnexpectedExit: () => {
        if (currentTunnel === tunnel) {
          mainError(`[tunnel] the active ssh tunnel to ${cfg.sshTarget} died unexpectedly -- reconnect to restore it`);
          removeTunnel(currentTunnelPort);
          currentTunnel = null;
          currentTunnelPort = null;
        }
      },
    }
  );
  setCurrentTunnel(tunnel, remote.port, cfg.sshTarget);
  await claimGatewayOwnership({ host: "127.0.0.1", port: remote.port, apiToken, sshKey: cfg.sshKey }, onLog);
  await syncAndAuditGateways({ host: "127.0.0.1", port: remote.port, apiToken }, onLog);
  return {
    host: "127.0.0.1",
    port: remote.port,
    gatewayHost: remote.host,
    gatewayPort: remote.port,
    connectionType: "remote-tunnel",
    imageRef: remote.imageRef,
    apiToken,
  };
}

// Vault-aware wrapper around connectRemoteGatewayWithKeyPath: `cfg.gatewayId`
// (a GUI-managed gateway) is resolved to a real, temporary decrypted key
// file for the duration of the connect attempt; `cfg.sshKey` (a literal
// path -- the scripted/env-var deploy case, or no key at all) is passed
// through unchanged. See withGatewayKeyFile's own comment for why this
// branch lives in exactly one place.
async function connectRemoteGateway(cfg, opts = {}) {
  if (!cfg.gatewayId) return connectRemoteGatewayWithKeyPath(cfg, opts);
  return withDecryptedGatewayKeyFile(cfg.gatewayId, (keyPath) => connectRemoteGatewayWithKeyPath({ ...cfg, sshKey: keyPath }, opts), {
    safeStorage,
    getPassphraseKey: ensureVaultUnlocked,
  });
}

let wizardWindow = null;
function runSetupWizard(dockerDetected) {
  return new Promise((resolve, reject) => {
    let settled = false;
    wizardWindow = new BrowserWindow({
      width: 520,
      // This is only ever "mode=new" now -- File > Gateways > New Gateway/
      // Edit Gateways from an already-running app use index.html's own
      // #dlg-gateway-setup dialog instead (see app.js's
      // openNewGatewayDialog/openEditGatewaysDialog); this window is just
      // the first-run/no-local-docker fallback, before any main window
      // exists to host a dialog in.
      height: 860,
      minWidth: 480,
      minHeight: 560,
      // Was fixed-size (resizable: false) at a height that clipped the
      // Connect/Skip buttons once both key-file and paste controls became
      // permanently visible (rather than toggling) -- resizable + a CSS
      // scroll fallback (see gateway-setup.css) means a taller form, a
      // larger OS font scale, or a small display can never hide them again.
      icon: APP_ICON,
      show: false, // shown on 'ready-to-show' below -- avoids a blank flash before gateway-setup.html renders
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    wizardWindow.once("ready-to-show", () => {
      wizardWindow.show();
      closeSplash();
    });
    wizardWindow.setMenuBarVisibility(false);
    attachEditContextMenu(wizardWindow);
    const showSkip = shouldShowSkipButton({ mode: "new", dockerDetected });
    wizardWindow.loadFile(path.join(__dirname, "renderer", "gateway-setup.html"), {
      search: `mode=new&skip=${showSkip ? "1" : "0"}`,
    });
    wizardWindow.on("closed", () => {
      // The splash was already closed once this window's own 'ready-to-show'
      // fired, so this window closing (successfully submitted, or
      // cancelled) always drops to zero open windows for a moment -- without
      // a window up before that happens, window-all-closed fires and quits
      // the whole app right here, before the success path ever reaches
      // createWindow() or the cancel path's local-fallback retry gets a
      // chance to run. Re-showing it (idempotent, a no-op once the real main
      // window is already up) bridges that gap either way.
      showSplash();
      wizardWindow = null;
      if (!settled) {
        ipcMain.removeHandler("gateway-setup-submit");
        reject(new Error("Setup was cancelled."));
      }
    });

    ipcMain.handle("gateway-setup-submit", async (_e, payload) => {
      try {
        const { remote, cfg } = await provisionRemoteGateway(payload, (line) =>
          wizardWindow?.webContents.send("setup-log", line)
        );
        serverHost = remote.host;
        serverPort = remote.port;
        activeGatewayHost = remote.gatewayHost;
        activeGatewayPort = remote.gatewayPort;
        serverConnectionType = remote.connectionType;
        activeSshTarget = cfg.sshTarget;
        activeSshPort = cfg.sshPort;
        currentApiToken = remote.apiToken;
        saveConnectionConfig(cfg);
        recordGateway({
          id: cfg.gatewayId,
          mode: "remote",
          host: remote.gatewayHost,
          port: remote.gatewayPort,
          label: cfg.sshTarget,
          sshTarget: cfg.sshTarget,
          sshKey: undefined,
          hasSshKey: true,
          ...(cfg.sshPort ? { sshPort: cfg.sshPort } : {}),
          connectionType: remote.connectionType,
          imageRef: remote.imageRef,
        });
        await checkServerHostDocker(
          remote.host,
          remote.port,
          (line) => wizardWindow?.webContents.send("setup-log", line),
          remote.apiToken
        );
        settled = true;
        ipcMain.removeHandler("gateway-setup-submit");
        wizardWindow.destroy();
        resolve();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });
  });
}

// Run Setup / Update Image don't hot-swap the already-loaded window's server
// connection on their own (its page was loaded with the *old* host/port
// baked into the URL) -- but a full app.relaunch() threw away the whole
// process (every popout, the splash-free startup already done) just to
// change a query string. Reloading only the main window with the
// now-updated serverHost/serverPort gets the same fresh-connection result
// without restarting CTTC itself. Popouts hold their own stale connection
// the same way, so they're closed rather than left pointing at the old
// gateway; the main window's own panels re-fetch from the new one on load.
async function reconnectMainWindow() {
  for (const popout of popoutWindows.values()) {
    if (!popout.isDestroyed()) popout.close();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"), {
      search: `host=${serverHost}&port=${serverPort}&token=${currentApiToken || ""}`,
    });
  } else {
    await createWindow();
  }
  // Closes whatever splash the caller showed while getting here (e.g.
  // switch-gateway's "Restarting, please wait…" during ssh tunnel setup) --
  // a no-op if none was ever shown for this particular reconnect.
  closeSplash();
}
// Still confirmed for Run Setup / Update Image / connection-settings changes
// -- those are deliberate settings-screen actions with a gateway still
// there to reconnect to either way, unlike uninstalling the *active*
// gateway (see gateway-manage-uninstall above), which reconnects
// immediately with no prompt: there's nothing left to "reconnect to" but
// this same machine, and every open form is already stale the moment it
// succeeds. Also unlike the quick status-pill switcher (see switch-gateway
// below, which reconnects immediately with no prompt for a different
// reason -- it's not a destructive action).
async function offerRestart(message) {
  const r = await dialog.showMessageBox({
    type: "info",
    message,
    buttons: ["Reconnect Now", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (r.response !== 0) return;
  await reconnectMainWindow();
}

// Backs the status-pill dropdown in the main window: every gateway this
// client has ever actually connected to, newest first, with the currently
// active one flagged so the renderer can highlight it.
ipcMain.handle("get-gateways", () => listGatewaysWithActiveFlag());

// Set/Edit Docker Daemon's "which containers were actually selected"
// persistence (see lib/container-selection.js) -- keyed by the same
// hostKey ("local" or "ssh://user@host[:port]") the renderer already uses
// for docker:// source paths.
ipcMain.handle("get-selected-containers", (_e, hostKey) => readSelectedContainers(hostKey));
ipcMain.handle("set-selected-containers", (_e, hostKey, names) => {
  writeSelectedContainers(hostKey, names);
  return { ok: true };
});
// "Remove Docker Daemon" (permanently forgetting a saved daemon, as opposed
// to Disconnect's "stop for now") deletes its selection file on disk too.
ipcMain.handle("delete-selected-containers", (_e, hostKey) => {
  deleteSelectedContainers(hostKey);
  return { ok: true };
});

// Backs the status pill's "(tunnel)" suffix and its right-click details
// popup (see app.js): what kind of connection this actually is right now
// (local/remote/remote-tunnel), plus the ssh target/forwarded port behind
// it when tunneled -- info the URL main.js loaded the page with
// (host=&port=) can't carry, since that's just the client-facing address
// (127.0.0.1 either way, embedded or tunneled).
ipcMain.handle("get-connection-info", () => ({
  connectionType: serverConnectionType,
  host: serverHost,
  port: serverPort,
  gatewayHost: activeGatewayHost,
  gatewayPort: activeGatewayPort,
  sshTarget: activeSshTarget,
  sshPort: activeSshPort,
}));

// Developer-only Redis CLI (Help > Developers > Redis CLI…) -- runs a raw
// command against whichever target's internal Redis is currently active.
// Deliberately just a plain fetch to the already-resolved serverHost/
// serverPort, same as claimGatewayOwnership/syncAndAuditGateways below --
// "the currently active target" is already fully described by those two
// variables (embedded or remote gateway alike), so no new connection
// (SSH tunnel, direct Redis TCP) is ever opened for this.
ipcMain.handle("redis-cli-run", async (_e, argv) => {
  try {
    const res = await fetch(`http://${serverHost}:${serverPort}/admin/redis-cli`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(currentApiToken ? { "X-CTTC-Token": currentApiToken } : {}) },
      body: JSON.stringify({ argv }),
    });
    return await res.json();
  } catch (err) {
    return { type: "error", value: String(err.message || err) };
  }
});

// Records a Docker host under the currently-active gateway's own catalog in
// gateways.json (see recordDockerHostForGateway) -- called from the
// renderer right after a Connect/Update Docker Host submission succeeds, so
// gateways.json ends up holding every Docker host actually created/used
// through it, not just the renderer's own gateway-agnostic history.
ipcMain.handle("record-docker-host", (_e, dockerHostEntry) => {
  // Embedded ("This machine") gateways are otherwise only ever written to
  // gateways.json lazily, on switch-away (recordCurrentGateway) -- without
  // this, a session that never switches gateways has no entry here at all
  // for recordDockerHostForGateway to attach to.
  recordCurrentGateway();
  const key = gatewayKey({ host: activeGatewayHost, port: activeGatewayPort });
  return recordDockerHostForGateway(key, dockerHostEntry);
});

// gateways.json's dockerHosts[] (for the active gateway) is now the sole
// source for the Connect/Remove Docker Host dialogs' history/dropdown --
// see docker-host/state.ts's dockerHostHistory(). Retired entries (see
// retire-docker-host below) are filtered out here rather than by every
// caller separately.
ipcMain.handle("get-docker-hosts", () => {
  recordCurrentGateway();
  const key = gatewayKey({ host: activeGatewayHost, port: activeGatewayPort });
  const gw = readGateways().find((g) => gatewayKey(g) === key);
  return (gw?.dockerHosts || []).filter((h) => !h.retired);
});

// Soft-deletes one Docker host from the active gateway's own catalog (see
// retireDockerHost) -- replaces the renderer's former direct localStorage
// mutation in remove-dialog.ts, which never touched gateways.json at all
// (the actual root of "Remove Docker Host" losing track of a host: three
// independent, unreconciled stores, only one of which this ever wrote to).
ipcMain.handle("retire-docker-host", (_e, hostIdOrKey) => {
  const key = gatewayKey({ host: activeGatewayHost, port: activeGatewayPort });
  const list = retireDockerHost(key, hostIdOrKey);
  const gw = list.find((g) => gatewayKey(g) === key);
  return (gw?.dockerHosts || []).filter((h) => !h.retired);
});

// Read-only: lets the dropdown flag a gateway as unreachable without
// switching to it or changing anything -- purely informational, including
// for the currently-active entry (see switch-gateway's own health check for
// the one place a failed probe actually blocks an action).
ipcMain.handle("check-gateway", (_e, entry) => checkGatewayReachable(entry));

// Switching to "This machine" doesn't re-provision anything -- it's already
// confirmed running at some point; a quick /health check just confirms it's
// still up before committing to it, since reconnecting into a dead gateway
// would be a worse experience than an upfront error here. Switching to a
// *remote* gateway is different (see connectRemoteGateway): the container is
// always (re-)installed over ssh first, then connected to either directly
// or over an ssh tunnel --
//   - not already in the registry: direct HTTP is tried first, falling
//     back to a tunnel only if that fails (same as a first-time connect).
//   - already in the registry: skip straight to a tunnel using its saved
//     ssh fields, rather than re-probing direct HTTP every time.
// Either way, whatever gateway is active *before* the switch gets its
// registry entry refreshed first (recordCurrentGateway) so the connection
// type it was actually last reached by isn't lost. "embedded" means point
// back at this machine (clears connection.json, same as Run Setup's "Revert
// to Local"); anything else writes a "remote" connection.json from the ssh
// fields used to (re-)connect. The never-provisioned "This machine"
// placeholder (see get-gateways -- no real port yet) has nothing to
// health-check; switching to it just falls back to the ordinary
// embedded-mode startup path (with or without local Docker) the same as if
// no gateway had ever been configured. No confirmation dialog here (unlike
// Run Setup/Update Image/uninstall) -- this is the quick status-pill
// switcher, meant to feel immediate; the renderer shows its own "Switching
// to X…" status message while this runs.
ipcMain.handle("switch-gateway", async (_e, entry) => {
  const isUnprovisionedLocal = entry.mode === "embedded" && entry.port == null;

  if (entry.mode === "embedded") {
    if (!isUnprovisionedLocal && !(await checkGatewayReachable(entry))) {
      const current = (await listGatewaysWithActiveFlag()).find((g) => g.active);
      const currentLabel = current?.label || (activeGatewayHost === "127.0.0.1" ? "This machine" : activeGatewayHost);
      return {
        ok: false,
        error: `Failed to reach ${entry.label || entry.host} (${entry.host}:${entry.port}) — staying on ${currentLabel}.`,
      };
    }
    recordCurrentGateway();
    clearCurrentTunnel();
    clearConnectionConfig();
    if (isUnprovisionedLocal) {
      // never actually provisioned -- same startup path a fresh launch
      // would take (re-provision or start local), which sets
      // serverHost/serverPort itself once it's done.
      await connectToServer([]);
    } else {
      serverHost = "127.0.0.1";
      serverPort = entry.port;
      activeGatewayHost = "127.0.0.1";
      activeGatewayPort = entry.port;
      serverConnectionType = "local";
      activeSshTarget = null;
      activeSshPort = undefined;
      // Already provisioned (not re-running ensureLocalContainer here) --
      // just retrieves the same token generated back then.
      currentApiToken = getOrCreateApiToken("embedded");
    }
    await reconnectMainWindow();
    return { ok: true };
  }

  recordCurrentGateway();
  const alreadyKnown = readGateways().some((g) => gatewayKey(g) === gatewayKey({ host: entry.host, port: entry.port }));
  const cfg = {
    sshTarget: entry.sshTarget,
    // entry.sshKey (a literal path, the scripted/env-var deploy case) and
    // entry.id/gatewayId (a GUI-managed gateway, resolved via the vault) are
    // mutually exclusive -- see withGatewayKeyFile's own comment.
    ...(entry.sshKey ? { sshKey: entry.sshKey } : { gatewayId: entry.id }),
    sshPort: entry.sshPort,
    remotePort: entry.port,
  };
  // Shown up front: a fallback-to-tunnel reconnect can take several seconds
  // (ssh provisioning, waiting for the forwarded port) with nothing else in
  // view once switch-gateway starts, since it reconnects immediately with
  // no confirmation dialog of its own (unlike offerRestart's callers).
  // reconnectMainWindow() closes this once the new page has loaded; the
  // catch below closes it on failure, since that path never reaches there.
  showSplash();
  splashStatus("Restarting, please wait…");
  try {
    const result = await connectRemoteGateway(cfg, {
      onLog: (line) => mainWindow?.webContents.send("setup-log", line),
      forceTunnel: alreadyKnown,
    });
    saveConnectionConfig(cfg);
    serverHost = result.host;
    serverPort = result.port;
    activeGatewayHost = result.gatewayHost;
    activeGatewayPort = result.gatewayPort;
    serverConnectionType = result.connectionType;
    activeSshTarget = cfg.sshTarget;
    activeSshPort = cfg.sshPort;
    currentApiToken = result.apiToken;
    recordGateway({
      ...(cfg.gatewayId ? { id: cfg.gatewayId } : {}),
      mode: "remote",
      host: result.gatewayHost,
      port: result.gatewayPort,
      label: entry.label || cfg.sshTarget,
      sshTarget: cfg.sshTarget,
      ...(cfg.gatewayId ? { sshKey: undefined, hasSshKey: true } : { sshKey: cfg.sshKey }),
      ...(cfg.sshPort ? { sshPort: cfg.sshPort } : {}),
      connectionType: result.connectionType,
      imageRef: result.imageRef,
    });
  } catch (err) {
    closeSplash();
    return { ok: false, error: `Failed to switch to ${entry.label || entry.host}: ${err.message || err}` };
  }
  await reconnectMainWindow();
  return { ok: true };
});

// File > Gateways > New Gateway, once the app is already running: index.html
// now has its own #dlg-gateway-setup dialog for this (see app.js's
// openNewGatewayDialog) rather than a separate window -- this just does the
// actual provisioning the dialog's Connect button asks for, streaming
// activity into the *main* window's own log instead of a wizard window's.
// Always just provisions a new one -- picking an existing gateway to revert
// to (including "This machine") or reconfigure is the status-pill dropdown/
// Edit Gateways' job, not this one's, so there's no "already connected,
// revert or reconfigure?" prompt here.
ipcMain.handle("gateway-add-submit", async (_e, payload) => {
  try {
    const { remote, cfg } = await provisionRemoteGateway(payload, (line) =>
      mainWindow?.webContents.send("setup-log", line)
    );
    serverHost = remote.host;
    serverPort = remote.port;
    activeGatewayHost = remote.gatewayHost;
    activeGatewayPort = remote.gatewayPort;
    serverConnectionType = remote.connectionType;
    activeSshTarget = cfg.sshTarget;
    activeSshPort = cfg.sshPort;
    currentApiToken = remote.apiToken;
    saveConnectionConfig(cfg);
    recordGateway({
      id: cfg.gatewayId,
      mode: "remote",
      host: remote.gatewayHost,
      port: remote.gatewayPort,
      label: cfg.sshTarget,
      sshTarget: cfg.sshTarget,
      sshKey: undefined,
      hasSshKey: true,
      ...(cfg.sshPort ? { sshPort: cfg.sshPort } : {}),
      connectionType: remote.connectionType,
      imageRef: remote.imageRef,
    });
    await checkServerHostDocker(
      remote.host,
      remote.port,
      (line) => mainWindow?.webContents.send("setup-log", line),
      remote.apiToken
    );
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  await offerRestart("Reconnect CTTC to apply the new connection settings?");
  return { ok: true };
});

// The dockable action bar's "detached" mode: a small always-on-top window
// with the same buttons as the docked bar. It has no access to the main
// window's document, so every button click there is forwarded here
// (action-bar-trigger) and relayed to the main window's own renderer
// (run-action) instead of running locally -- Undo/Redo/Reload/etc. need to
// act on the main window's content, not this window's (which has none).
let actionBarWindow = null;
function openActionBarWindow() {
  if (actionBarWindow && !actionBarWindow.isDestroyed()) {
    actionBarWindow.focus();
    return;
  }
  actionBarWindow = new BrowserWindow({
    width: 220,
    height: 520,
    minWidth: 160,
    minHeight: 200,
    alwaysOnTop: true,
    icon: APP_ICON,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  actionBarWindow.once("ready-to-show", () => actionBarWindow.show());
  actionBarWindow.setMenuBarVisibility(false);
  actionBarWindow.loadFile(path.join(__dirname, "renderer", "action-bar.html"));
  // Closing this window by ANY means -- the Bring Back button, the OS
  // window-close control, Cmd+W, clicking off it if it's ever made
  // click-outside-dismissible -- must redock the sidebar back to its last
  // position. Without this, simply closing the floating window (instead of
  // clicking Bring Back) left #action-bar hidden (data-dock="detached")
  // with no window left to show it in at all.
  actionBarWindow.on("closed", () => {
    actionBarWindow = null;
    mainWindow?.webContents.send("action-bar-redock");
  });
}
function closeActionBarWindow() {
  if (actionBarWindow && !actionBarWindow.isDestroyed()) actionBarWindow.close();
}
ipcMain.handle("open-action-bar-window", () => openActionBarWindow());
ipcMain.handle("close-action-bar-window", () => closeActionBarWindow());
ipcMain.on("action-bar-trigger", (_e, action) => {
  mainWindow?.webContents.send("run-action", action);
});
// The 'closed' handler above is what actually sends the redock signal --
// this just closes the window (Bring Back is one way to trigger that, not
// the only one).
ipcMain.on("action-bar-redock", () => {
  closeActionBarWindow();
});
ipcMain.on("action-bar-poll-interval", (_e, secs) => {
  mainWindow?.webContents.send("set-poll-interval", secs);
});

// Passphrase-protected fallback for the gateway-key vault (lib/key-vault.js)
// when safeStorage.isEncryptionAvailable() is false -- e.g. Linux without a
// keyring backend. On the common case (macOS Keychain, Windows DPAPI, Linux
// with a keyring) none of this is ever shown: safeStorage handles gateway
// keys transparently and ensureVaultUnlocked's getPassphraseKey callback is
// never invoked. Session-scoped: the derived key lives in memory only,
// cleared on quit (see the before-quit handler below), never persisted.
let sessionPassphraseKey = null;
let vaultWindow = null;
let vaultUnlockWaiters = [];

function vaultIsInitialized() {
  return keyVault.readVaultMeta() != null;
}
function resolveVaultWaiters(key) {
  const waiters = vaultUnlockWaiters;
  vaultUnlockWaiters = [];
  for (const w of waiters) w.resolve(key);
}
function rejectVaultWaiters(err) {
  const waiters = vaultUnlockWaiters;
  vaultUnlockWaiters = [];
  for (const w of waiters) w.reject(err);
}
function openVaultWindow(mode) {
  if (vaultWindow && !vaultWindow.isDestroyed()) {
    vaultWindow.focus();
    return;
  }
  vaultWindow = new BrowserWindow({
    width: 380,
    height: 260,
    minWidth: 320,
    minHeight: 220,
    icon: APP_ICON,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  vaultWindow.once("ready-to-show", () => vaultWindow.show());
  vaultWindow.setMenuBarVisibility(false);
  vaultWindow.loadFile(path.join(__dirname, "renderer", "vault.html"), { search: `mode=${mode}` });
  // Closing by any means (OS close control, Cancel button, Escape) without
  // having unlocked/set up must reject every pending waiter -- otherwise
  // whatever key operation asked for this (a gateway connect/save/uninstall)
  // would hang forever instead of failing cleanly.
  vaultWindow.on("closed", () => {
    vaultWindow = null;
    rejectVaultWaiters(new Error("Secure Storage was closed before it was unlocked."));
  });
}
function closeVaultWindow() {
  if (vaultWindow && !vaultWindow.isDestroyed()) vaultWindow.close();
}

/**
 * Resolves to the passphrase-derived key for the vault's fallback scheme,
 * unlocking it first (opening the prompt window and waiting on the user) if
 * it isn't already unlocked this session. Only ever called for the fallback
 * scheme (see key-vault.js's readEntry/writeEntry) -- a machine with a
 * working safeStorage never invokes this at all.
 */
function ensureVaultUnlocked() {
  if (sessionPassphraseKey) return Promise.resolve(sessionPassphraseKey);
  return new Promise((resolve, reject) => {
    vaultUnlockWaiters.push({ resolve, reject });
    openVaultWindow(vaultIsInitialized() ? "unlock" : "setup");
  });
}

// The single choke point for "give me a real file for this gateway's key" --
// resolves the one real ambiguity in gateway key storage: `entry.sshKey` is
// a literal filesystem path for a gateway recorded from a scripted/env-var
// deploy (CTTC_SSH_KEY/connection.json's ssh_key, see lib/connection-
// config.js) and must never be routed through the vault; `entry.id` (a
// GUI-managed gateway) is the vault lookup key otherwise. Every caller that
// used to read `.sshKey` directly goes through this now, so that branch
// can't be silently reintroduced at just one call site.
async function withGatewayKeyFile(entry, fn) {
  if (entry.sshKey) return fn(entry.sshKey);
  if (!entry.id) return fn(null);
  return withDecryptedGatewayKeyFile(entry.id, fn, { safeStorage, getPassphraseKey: ensureVaultUnlocked });
}

ipcMain.handle("vault-status", () => ({
  safeStorageAvailable: safeStorage.isEncryptionAvailable(),
  needsSetup: !vaultIsInitialized(),
  locked: !safeStorage.isEncryptionAvailable() && !sessionPassphraseKey,
}));
ipcMain.handle("vault-setup", (_e, { passphrase, confirm }) => {
  if (!passphrase || passphrase.length < 8) {
    return { ok: false, error: "Choose a passphrase at least 8 characters long." };
  }
  if (passphrase !== confirm) return { ok: false, error: "Passphrases don't match." };
  sessionPassphraseKey = keyVault.setupPassphrase(passphrase);
  resolveVaultWaiters(sessionPassphraseKey);
  closeVaultWindow();
  return { ok: true };
});
ipcMain.handle("vault-unlock", (_e, { passphrase }) => {
  const key = keyVault.verifyPassphrase(passphrase);
  if (!key) return { ok: false, error: "Wrong passphrase." };
  sessionPassphraseKey = key;
  resolveVaultWaiters(sessionPassphraseKey);
  closeVaultWindow();
  return { ok: true };
});
ipcMain.handle("vault-cancel", () => {
  rejectVaultWaiters(new Error("Secure Storage unlock was cancelled."));
  closeVaultWindow();
});
ipcMain.handle("open-vault-window", () => openVaultWindow(vaultIsInitialized() ? "unlock" : "setup"));

// nativeTheme.themeSource is process-wide (affects every window's
// prefers-color-scheme match, plus native dialogs/menus), so this doesn't
// need per-window plumbing the way the other renderer-owned settings do --
// the renderer just tells main.js once and it's applied everywhere.
ipcMain.on("set-theme-mode", (_e, mode) => {
  if (mode === "light" || mode === "dark" || mode === "system") nativeTheme.themeSource = mode;
});

// "Collect CTTC Own Logs" (Preferences > Settings). Turning it on for the
// first time (no directory saved yet) prompts for one; every later toggle
// reuses the saved directory without asking again. Toggling off just stops
// the file sink -- the directory is remembered for next time either way.
ipcMain.handle("get-log-collector-settings", () => readLogCollectorSettings());
ipcMain.handle("set-log-collector-enabled", async (_e, enabled) => {
  const settings = readLogCollectorSettings();
  if (!enabled) {
    stopLogCollector();
    writeLogCollectorSettings({ ...settings, enabled: false });
    return { ok: true, enabled: false };
  }
  // Always asks, every time it's turned on -- rather than only the first
  // time -- so switching it on always means "collect here", not "collect
  // wherever it was last pointed". Defaults to the previous folder (if
  // any) so re-confirming the same location is just Enter/Choose, not a
  // fresh navigation each time.
  const r = await dialog.showOpenDialog({
    title: "Choose a folder for CTTC's own logs",
    defaultPath: settings.dir || undefined,
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, enabled: false };
  const dir = r.filePaths[0];
  startLogCollector(dir);
  writeLogCollectorSettings({ enabled: true, dir });
  return { ok: true, enabled: true, dir };
});

// "Ship logs" (Settings > Collect CTTC Own Logs, far-right icon button):
// bundles every local .cttc-log file with the gateway's own `docker logs`
// output (GET /mlog -- server.py's gather_own_container_logs) into one
// zip, then offers to erase the local .cttc-log files now that they're
// safely archived. Silent no-op (not an error) if log collection was never
// turned on -- there's nothing local to ship, only the gateway's own log.
ipcMain.handle("ship-logs", async () => {
  const settings = readLogCollectorSettings();
  const dir = settings.dir;
  const localFiles = dir
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".cttc-log"))
        .map((f) => path.join(dir, f))
    : [];

  const entries = localFiles.map((p) => ({ name: path.basename(p), data: fs.readFileSync(p) }));

  try {
    const res = await fetch(`http://${serverHost}:${serverPort}/mlog`, {
      signal: AbortSignal.timeout(20000),
      ...(currentApiToken ? { headers: { "X-CTTC-Token": currentApiToken } } : {}),
    });
    const gatewayName = res.headers.get("X-Gateway-Name") || "gateway";
    const bytes = Buffer.from(await res.arrayBuffer());
    entries.push({ name: `${gatewayName}.log`, data: bytes });
  } catch (err) {
    entries.push({ name: "gateway.log", data: Buffer.from(`could not reach the gateway: ${err.message || err}\n`) });
  }

  if (!entries.length) return { ok: false, error: "Nothing to ship -- no local .cttc-log files and no gateway log." };

  const zip = buildZip(entries);
  const r = await dialog.showSaveDialog({
    title: "Save shipped logs",
    defaultPath: `cttc-logs-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.zip`,
    filters: [{ name: "Zip archive", extensions: ["zip"] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  await fs.promises.writeFile(r.filePath, zip);

  let erased = false;
  if (localFiles.length) {
    const confirmed = await dialog.showMessageBox({
      type: "question",
      message: `Erase the ${localFiles.length} local .cttc-log file${localFiles.length === 1 ? "" : "s"} now that they're zipped?`,
      detail: r.filePath,
      buttons: ["Erase", "Keep"],
      defaultId: 1,
      cancelId: 1,
    });
    if (confirmed.response === 0) {
      for (const p of localFiles) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* best-effort */
        }
      }
      erased = true;
    }
  }
  return { ok: true, path: r.filePath, fileCount: entries.length, erased };
});

// Re-provisions a gateway at (possibly new) ssh settings and updates its
// registry entry in place -- editing the *currently active* gateway also
// updates connection.json and offers a restart, since the already-loaded
// page can't hot-swap its own connection without one.
ipcMain.handle("gateway-manage-save", async (_e, payload) => {
  try {
    // "This machine" has no ssh settings to change -- Save/Update here only
    // ever (re-)provisions the local container with the chosen image.
    // Branches on payload.mode (sent by the renderer's own selection)
    // rather than a registry lookup, since the never-provisioned "This
    // machine" placeholder (see get-gateways) was never actually recorded.
    if (payload.mode === "embedded") {
      const apiToken = getOrCreateApiToken("embedded");
      const { port } = await ensureLocalContainer({
        source: payload.imageSource || undefined,
        resourcesDir: resourcesDirForApp(),
        apiToken,
        onLog: mainLog,
      });
      recordGateway({
        mode: "embedded",
        host: "127.0.0.1",
        port,
        label: "This machine",
        connectionType: "local",
        // br-PROV-007: remembered so a later Uninstall resolves the same
        // compose file this was actually provisioned with, instead of always
        // falling back to the bundled/default one -- see uninstallLocalContainer.
        ...(payload.imageSource ? { imageSource: payload.imageSource } : {}),
      });
      if (activeGatewayHost === "127.0.0.1" && serverConnectionType === "local") {
        serverPort = port;
        activeGatewayPort = port;
        currentApiToken = apiToken;
        await offerRestart("Reconnect CTTC to apply the updated image?");
      }
      return { ok: true };
    }

    const existing = readGateways().find((g) => gatewayKey(g) === payload.key);
    if (!existing) return { ok: false, error: "That gateway no longer exists -- refresh the list." };

    // "keep" (see renderer's gwFillFormForEdit): editing this gateway's
    // host/port/image without touching its key -- reuses whatever key it
    // already has (vault-managed via its id, or a literal scripted path)
    // rather than requiring one be re-entered on every unrelated edit.
    const keyOpts = { safeStorage, getPassphraseKey: ensureVaultUnlocked };
    if (payload.keyMode === "paste") await writeGatewayKey(existing.id, payload.keyContents, keyOpts);
    else if (payload.keyMode === "path") await copyGatewayKey(existing.id, payload.keyPath, keyOpts);
    const cfg = {
      sshTarget: `${payload.sshUser}@${payload.sshHost}`,
      ...(payload.keyMode === "keep"
        ? existing.sshKey
          ? { sshKey: existing.sshKey }
          : { gatewayId: existing.id }
        : { gatewayId: existing.id }),
      sshPort: payload.sshPort,
      remotePort: 8765,
      imageSource: payload.imageSource || undefined,
    };
    const wasActive = payload.key === gatewayKey({ host: activeGatewayHost, port: activeGatewayPort });
    // Only reconnects the transport (direct vs tunnel) if this is the
    // *active* gateway -- otherwise it's just re-provisioned in place,
    // same as before, with nothing to reconnect. Either way it's the same
    // persisted token (br-NET-004, see lib/api-token.js) -- connectRemoteGateway
    // resolves its own copy internally for the wasActive path below.
    const apiToken = getOrCreateApiToken(hostFromTarget(cfg.sshTarget));
    const result = wasActive
      ? await connectRemoteGateway(cfg, { onLog: (line) => mainWindow?.webContents.send("setup-log", line) })
      : // Bypasses connectRemoteGateway's own vault-aware dispatcher (it
        // only ever re-provisions here, no health-check/tunnel decision to
        // make), so the vault resolution has to happen by hand -- easy to
        // miss since this looks like a peer of the wasActive branch above.
        await withGatewayKeyFile({ sshKey: cfg.sshKey, id: cfg.gatewayId }, (keyPath) =>
          ensureRemoteContainer(
            { ...cfg, sshKey: keyPath },
            {
              sshBin: process.env.CTTC_SSH_BIN || "ssh",
              source: cfg.imageSource,
              apiToken,
              onLog: (line) => mainWindow?.webContents.send("setup-log", line),
            }
          )
        );
    const gatewayHost = result.gatewayHost || result.host;
    const gatewayPort = result.gatewayPort || result.port;
    recordGateway({
      ...(cfg.gatewayId ? { id: cfg.gatewayId } : {}),
      mode: "remote",
      host: gatewayHost,
      port: gatewayPort,
      label: cfg.sshTarget,
      sshTarget: cfg.sshTarget,
      ...(cfg.gatewayId ? { sshKey: undefined, hasSshKey: true } : { sshKey: cfg.sshKey }),
      ...(cfg.sshPort ? { sshPort: cfg.sshPort } : {}),
      connectionType: result.connectionType || existing.connectionType || "remote",
      imageRef: result.imageRef,
    });
    if (gatewayKey({ host: gatewayHost, port: gatewayPort }) !== payload.key) retireGateway(payload.key);
    if (wasActive) {
      saveConnectionConfig(cfg);
      serverHost = result.host;
      serverPort = result.port;
      activeGatewayHost = gatewayHost;
      activeGatewayPort = gatewayPort;
      serverConnectionType = result.connectionType;
      activeSshTarget = cfg.sshTarget;
      activeSshPort = cfg.sshPort;
      currentApiToken = result.apiToken;
      await offerRestart("Reconnect CTTC to apply the updated gateway settings?");
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Stops and removes the gateway's container *and* image (locally, or over
// ssh for a remote one), then drops it from the recorded list. Uninstalling
// the *currently active* gateway reverts connection.json to embedded mode
// (nothing else left to point at) and offers a restart. Streams progress to
// the same activity log New/Edit Gateway use (see gw-activity/onSetupLog in
// app.js) rather than uninstalling silently; on failure, also checks (and
// logs) whether the container is actually still there -- `docker compose
// down` can exit non-zero after partially succeeding, so the raw error
// alone doesn't tell you whether anything's left to clean up by hand.
ipcMain.handle("gateway-manage-uninstall", async (_e, entry) => {
  const onLog = (line) => mainWindow?.webContents.send("setup-log", line);
  try {
    if (entry.mode === "embedded") {
      // br-PROV-007: pass back whatever source this entry was actually
      // provisioned with (see recordGateway above in gateway-manage-save),
      // so uninstall resolves the same compose file instead of the default.
      await uninstallLocalContainer({ source: entry.imageSource, resourcesDir: resourcesDirForApp(), onLog });
    } else {
      await withGatewayKeyFile(entry, (keyPath) =>
        uninstallRemoteContainer(
          { sshTarget: entry.sshTarget, sshKey: keyPath, sshPort: entry.sshPort },
          { sshBin: process.env.CTTC_SSH_BIN || "ssh", onLog }
        )
      );
    }
    retireGateway(entry.id || gatewayKey(entry));
    // A retired gateway's admin key no longer needs to exist -- best-effort,
    // never blocks the uninstall itself on a vault hiccup.
    if (entry.id) await deleteGatewayKey(entry.id, {}).catch(() => {});
    // So a stale token isn't silently reused if this same host is ever
    // re-provisioned as a fresh gateway later (br-NET-004).
    forgetApiToken(entry.mode === "embedded" ? "embedded" : hostFromTarget(entry.sshTarget));
    const wasActive = isActiveGateway(entry);
    if (wasActive) {
      // Closes an active ssh tunnel, if the just-uninstalled gateway was
      // reached through one -- a local/embedded gateway's own container is
      // shared/persistent infrastructure (restart: unless-stopped) and is
      // never torn down here, only disconnected from.
      disconnectActiveTunnel();
      clearConnectionConfig();
      // reverts to embedded mode, same as switch-gateway's isUnprovisionedLocal
      // path -- there's nothing left running locally to just point at, so
      // this goes through the ordinary embedded startup (re-provision or
      // start local) rather than assuming a stale host/port still works.
      // A brand-new embedded server process starts with zero sources, so
      // this is also what guarantees no .cttc-metric/.cttc-record sample
      // data lingers from the just-uninstalled gateway.
      await connectToServer([]);
      // No confirmation here (unlike offerRestart's other callers, e.g.
      // Update Image/Save changes) -- the gateway this window was actually
      // talking to no longer exists the moment uninstall succeeds, so every
      // open dialog/form and all renderer state is already stale. Reconnect
      // immediately: reconnectMainWindow() reloads index.html from scratch,
      // which closes every popout and every open dialog (Edit Gateway
      // included) and resets all renderer state back to a fresh launch.
      await reconnectMainWindow();
    }
    return { ok: true };
  } catch (err) {
    // Best-effort diagnostics only -- a failure here (e.g. a cancelled
    // vault unlock) must never mask the real uninstall error below.
    try {
      await withGatewayKeyFile(entry, (keyPath) =>
        checkStillInstalled(
          { ...entry, sshKey: keyPath },
          { resourcesDir: resourcesDirForApp(), sshBin: process.env.CTTC_SSH_BIN || "ssh", onLog }
        )
      );
    } catch {
      /* diagnostics only -- see comment above */
    }
    return { ok: false, error: err.message || String(err) };
  }
});

app.whenReady().then(async () => {
  // Shown before anything else, including installMenu() and the
  // canBeServerLocally() check below -- it shells out to `docker info` and
  // `ssh -V` (async; see lib/docker-check.js) and can take a few seconds
  // against a slow/starting daemon or a plain "no docker on PATH" miss. The
  // gateway setup path closes this itself once its own window is ready to show (see
  // runSetupWizard()'s 'ready-to-show' handler) instead of stacking a
  // second loading window on top of it. Created before killOrphanedTunnels()
  // below so its window exists to actually receive that step's status line
  // (see splash.js/splash-status "main-log" mirroring) -- mainLog calls
  // before a window exists have nothing to reach.
  showSplash();
  // Kill any ssh -N -L tunnel left running by a previous session that never
  // exited cleanly (crash, force quit, killed by an installer/uninstaller)
  // -- otherwise it just sits on its forwarded port forever, and every
  // future connect attempt to that gateway fails ssh-tunnel.js's own
  // "something is already listening" guard with no obvious cause (see
  // lib/tunnel-registry.js).
  narrate("cleaning up any leftover connections from a previous session...");
  killOrphanedTunnels({ onLog: mainLog });
  installMenu();
  // the window `icon` option is ignored on macOS; the running app's Dock icon
  // must be set explicitly (only affects unpackaged runs — packaged apps use .icns)
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  // "Collect CTTC Own Logs" was left on from a previous run -- a fresh
  // timestamped file for this launch, same as toggling it on mid-session.
  // A completely unconfigured install (no dir ever saved, never explicitly
  // turned on or off) defaults to *on*, writing next to the app itself --
  // once the user's touched the setting either way, that choice sticks.
  {
    const logSettings = readLogCollectorSettings();
    if (logSettings.dir == null && !logSettings.enabled) {
      const dir = defaultLogCollectorDir();
      writeLogCollectorSettings({ enabled: true, dir });
      startLogCollector(dir);
    } else if (logSettings.enabled && logSettings.dir) {
      startLogCollector(logSettings.dir);
    }
  }
  // One-time (per launch), idempotent migration of the old, single, shared
  // plaintext ~/.cttc/keys/cttc_ssh_key into the new per-gateway encrypted
  // vault (see lib/key-vault.js/lib/ssh-key-file.js) -- must run after
  // safeStorage is actually usable (app.whenReady() has fired) but before
  // anything else consumes gateways.json's sshKey field. Never blocks
  // startup or prompts for a passphrase (migrateLegacyGatewayKeys' own
  // contract): a failure, or a not-yet-set-up vault, just leaves the legacy
  // file in place for the next launch to retry.
  try {
    const migration = await migrateLegacyGatewayKeys({
      gateways: readGateways(),
      safeStorage,
      getPassphraseKey: ensureVaultUnlocked,
      onLog: mainLog,
    });
    if (migration) {
      for (const g of migration.migrated) recordGateway({ id: g.id, ...g, sshKey: undefined, hasSshKey: true });
      if (migration.failed.length === 0 && migration.migrated.length > 0) {
        fs.rmSync(migration.legacyPath, { force: true });
        mainLog(`[vault] removed the old shared plaintext key file (${migration.legacyPath})`);
        // connection.json may also still reference the same legacy path (a
        // GUI-managed remote connection that predates the vault) -- point it
        // at the matching gateway's id instead, same as the gateways.json
        // records above.
        const connCfg = loadConnectionConfig();
        if (connCfg.mode === "remote" && connCfg.sshKey === migration.legacyPath) {
          const matched = migration.migrated.find((g) => g.sshTarget === connCfg.sshTarget);
          if (matched) saveConnectionConfig({ ...connCfg, gatewayId: matched.id, sshKey: undefined });
        }
      }
    }
  } catch (err) {
    mainError(`[vault] gateway key migration failed (${err.message || err}) -- will retry next launch`);
  }
  try {
    // files passed on the command line open at startup: npm start -- file1 file2
    const fileArgs = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-"));
    const cfg = loadConnectionConfig();
    narrate("checking for a local Docker installation...");
    if (cfg.mode === "embedded" && !(await canBeServerLocally())) {
      try {
        // A separate, more granular probe than canBeServerLocally() (which
        // also requires ssh, needed for reaching *other* Docker hosts, not
        // just running the gateway locally) -- "Skip -- use this machine"
        // inside the wizard only makes sense to offer when Docker itself is
        // actually present to fall back to.
        await runSetupWizard(await hasLocalDocker());
      } catch {
        // declined (Skip, or just closed the window) -- give local Docker a
        // genuine try (docker compose up) rather than trusting the earlier
        // quick canBeServerLocally() probe, which can miss a daemon that's
        // still starting up. A failure here propagates to the outer catch
        // below and surfaces as a clear error dialog -- there is no
        // bare/native fallback left (see connectToServer's own comment).
        narrate("starting the local gateway container...");
        const apiToken = getOrCreateApiToken("embedded");
        const { port } = await ensureLocalContainer({ resourcesDir: resourcesDirForApp(), apiToken, onLog: mainLog });
        serverHost = "127.0.0.1";
        serverPort = port;
        activeGatewayHost = "127.0.0.1";
        activeGatewayPort = port;
        serverConnectionType = "local";
        activeSshTarget = null;
        activeSshPort = undefined;
        currentApiToken = apiToken;
        mainLog(`[docker] server container running locally — port ${serverPort}`);
      }
    } else {
      await connectToServer(fileArgs);
    }
  } catch (err) {
    closeSplash();
    dialog.showErrorBox("CTTC Timeline", String(err.message || err));
    app.quit();
    return;
  }
  // Bridges the gap between the gateway setup window closing (or the splash
  // already up from the branch above) and the main window's first paint --
  // showSplash() is idempotent, so this is a no-op if one's already shown.
  showSplash();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// An ssh -N -L tunnel *is* this process's own child (unlike the remote
// server/local container it forwards to), so it never outlives the app
// quitting *on an orderly exit*. A crash/force-quit still leaves it running
// with nothing left to close it -- see lib/tunnel-registry.js's
// killOrphanedTunnels(), called once at the next launch to clean up exactly
// that case. A remote gateway (or a local Docker container -- see
// ensureLocalContainer's `restart: unless-stopped`) is shared/persistent
// infrastructure, not this process's own child: there is nothing else for
// this process to tear down on quit, and it must never POST /shutdown to
// either. (Named disconnectActiveTunnel, not stopServer, since this stopped
// being about stopping a server once app/server's bare `uv run server.py`
// fallback was decommissioned -- see .claude/plans/sprightly-stirring-blum.md's
// Phase 10.)
function disconnectActiveTunnel() {
  clearCurrentTunnel();
}

app.on("window-all-closed", () => {
  // Just triggers the real teardown below -- app.quit() always fires
  // before-quit first, which is the one place disconnectActiveTunnel()/
  // stopLogCollector() run.
  app.quit();
});
// Every quit path (Quit menu/button, Cmd+Q, Dock > Quit, a window's own
// close triggering window-all-closed above, or the app.quit() at the end of
// this same handler on its second pass) funnels through this event -- the
// one place to tell every still-open window's status bar a shutdown is
// underway, then actually disconnect, before the process really exits.
// Guarded against re-entrancy since the deferred app.quit() below re-fires
// before-quit -- disconnectActiveTunnel/stopLogCollector are idempotent and
// safely run twice, but shuttingDownNotified being true means this branch is
// skipped on that second pass, letting the quit actually proceed.
let shuttingDownNotified = false;
app.on("before-quit", (e) => {
  if (shuttingDownNotified) return;
  shuttingDownNotified = true;
  e.preventDefault();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("app-shutting-down");
  }
  stopLogCollector();
  sessionPassphraseKey = null; // the vault's fallback-scheme key is session-only, never persisted
  disconnectActiveTunnel();
  // A fixed 200ms floor so the "shutting down" broadcast above gets at least
  // one paint before the window actually closes -- disconnectActiveTunnel()
  // itself is synchronous (no graceful-shutdown handshake left to await now
  // that there's no local process this app owns the lifecycle of).
  setTimeout(() => app.quit(), 200);
});
