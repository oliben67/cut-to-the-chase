"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const {
  loadConnectionConfig,
  saveConnectionConfig,
  clearConnectionConfig,
  hostFromTarget,
} = require("./lib/connection-config");
const { hasLocalDocker, canBeServerLocally } = require("./lib/docker-check");
const { writeKeyFile, copyKeyFile } = require("./lib/ssh-key-file");
const {
  ensureLocalContainer,
  ensureRemoteContainer,
  uninstallLocalContainer,
  uninstallRemoteContainer,
} = require("./lib/server-provision");
const { readGateways, recordGateway, removeGateway, gatewayKey } = require("./lib/gateway-registry");

const SERVER_DIR = path.join(__dirname, "server");
const APP_ICON = path.join(__dirname, "assets", "icon.png");
// one-liner as published on GitHub (kept in sync with package.json's "description")
const APP_TAGLINE = "Correlate container telemetry with service logs on a shared clickable timeline";
// in-app "?" help buttons link here, one anchor per User Manual section
const HELP_URL = "https://github.com/oliben67/cut-to-the-chase/blob/main/MANUAL.md";
const HELP_TOPICS = {
  frequency: "#the-cursor-and-the-frequency-window",
};
let serverProc = null;
let serverHost = "127.0.0.1";
let serverPort = null;

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
function mainLog(...args) {
  const text = args.map(String).join(" ");
  console.log(text);
  broadcastLog("log", text);
}
function mainError(...args) {
  const text = args.map(String).join(" ");
  console.error(text);
  broadcastLog("error", text);
}

function startServer(extraArgs) {
  return new Promise((resolve, reject) => {
    // uv provisions the venv (orjson) on first run; --project pins it to server/
    serverProc = spawn(
      "uv",
      ["run", "--project", SERVER_DIR, path.join(SERVER_DIR, "server.py"), "--port", "0", ...extraArgs],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    serverProc.on("error", (err) =>
      reject(new Error(`could not start server via uv: ${err.message}`))
    );
    serverProc.stderr.on("data", (d) => mainError(`[server] ${d}`.trimEnd()));

    const rl = readline.createInterface({ input: serverProc.stdout });
    const timer = setTimeout(() => reject(new Error("server did not report a port in 30s")), 30000);
    rl.once("line", (line) => {
      clearTimeout(timer);
      try {
        const info = JSON.parse(line);
        serverPort = info.port;
        mainLog(`[server] listening on ${info.port} (json: ${info.json})`);
        resolve(info.port);
      } catch {
        reject(new Error(`unexpected server output: ${line}`));
      }
    });
    serverProc.on("exit", (code) => {
      mainLog(`[server] exited (${code})`);
      serverProc = null;
    });
  });
}

function showAboutDialog() {
  const stack = [
    `Electron ${process.versions.electron}`,
    `Chromium ${process.versions.chrome}`,
    `Node.js ${process.versions.node}`,
    "Python >=3.11 (via uv)",
    "orjson >=3.10",
    "psutil >=5.9",
  ];
  dialog.showMessageBox({
    type: "info",
    icon: APP_ICON,
    title: `About ${app.name}`,
    message: "Cut to the Chase (CTTC)",
    detail:
      `${APP_TAGLINE}\n\n` +
      `Version ${app.getVersion()}\n` +
      `\u00A9 ${new Date().getFullYear()} Olivier Steck\n\n` +
      `Built with:\n${stack.map((s) => `  \u2022 ${s}`).join("\n")}`,
    buttons: ["OK"],
    noLink: true,
  });
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
    width: 280,
    height: 220,
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
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.once("ready-to-show", () => splashWindow?.show());
  splashWindow.loadFile(path.join(__dirname, "renderer", "splash.html"));
  return splashWindow;
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
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
  // Auxiliary windows (popouts, Edit Gateways) have no reason to keep
  // running once the main window they belong to is gone -- without this,
  // closing just the main window while Edit Gateways is open leaves it as
  // an orphaned window with nothing behind it, and window-all-closed never
  // fires to actually quit the app.
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    if (gatewayManagerWindow && !gatewayManagerWindow.isDestroyed()) gatewayManagerWindow.close();
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
    search: `host=${serverHost}&port=${serverPort}`,
  });
  // e2e mode: CTTC_TEST=<spec.js> runs the spec in the page, reports results
  // + V8 byte coverage of app.js (as exercised by the spec) on stdout, then
  // exits (0 = all passed). The debugger can only attach to a live page, so
  // coverage starts after load — boot-only top-level lines read as uncovered.
  const testFile = process.env.CTTC_TEST;
  if (testFile) {
    setTimeout(() => {
      console.error("[test] global timeout — spec never resolved");
      app.exit(3);
    }, 120000);
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

ipcMain.handle("pick-files", async (_e, title) => {
  const r = await dialog.showOpenDialog({
    title: title || "Open log / stats files",
    properties: ["openFile", "multiSelections"],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle("open-help", async (_e, topic) => {
  const anchor = HELP_TOPICS[topic] || "";
  await shell.openExternal(HELP_URL + anchor);
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
    filters: [{ name: "CTTC metrics", extensions: ["cttc"] }],
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

// Asked once, when Start Recording is clicked: after this, every
// Pause/Stop segment flush overwrites the *same* path non-interactively
// (see write-binary-file below) -- no repeated dialog per segment.
ipcMain.handle("pick-recording-path", async () => {
  const r = await dialog.showSaveDialog({
    title: "Start Recording",
    defaultPath: `recording-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.cttc`,
    filters: [{ name: "CTTC metrics", extensions: ["cttc"] }],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
});

ipcMain.handle("write-binary-file", async (_e, filePath, bytes) => {
  await require("fs").promises.writeFile(filePath, Buffer.from(bytes));
});

// Durable, client-side marker (per the client/server/docker-host model's
// "client owns its own recovery state" -- see the Recording feature): if
// the app goes down mid-recording (crash, force-quit, machine sleep/
// shutdown), the next launch reads this and surfaces the interrupted
// session as *paused* rather than silently losing track of it or
// pretending nothing happened. Lives in userData, not next to
// connection.json, since it's per-install session state, not deployment
// config.
const RECORDING_MARKER_PATH = path.join(app.getPath("userData"), "recording.json");

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
  const params = new URLSearchParams({ host: serverHost, port: String(serverPort), popout: kind });
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
    if (app.isPackaged && (await hasLocalDocker())) {
      const { port } = await ensureLocalContainer({ resourcesDir: resourcesDirForApp() });
      serverHost = "127.0.0.1";
      serverPort = port;
      mainLog(`[docker] server container running locally — port ${serverPort}`);
      recordGateway({ mode: "embedded", host: serverHost, port: serverPort, label: "This machine" });
      return;
    }
    await startServer(fileArgs);
    return;
  }
  if (fileArgs.length) {
    // file paths are local to *this* machine; meaningless against a shared
    // remote server, so they're ignored rather than silently mis-sent
    mainError(`[remote] ignoring command-line files in remote mode: ${fileArgs.join(", ")}`);
  }
  // CTTC_SSH_BIN overrides the ssh binary (verification hook, same idea as
  // CTTC_TEST/CTTC_EVAL/CTTC_SCREENSHOT below): lets tests point provisioning
  // at a fake ssh instead of a real ssh + remote host.
  const remote = await ensureRemoteContainer(cfg, {
    sshBin: process.env.CTTC_SSH_BIN || "ssh",
    resourcesDir: resourcesDirForApp(),
  });
  serverHost = remote.host;
  serverPort = remote.port;
  mainLog(`[remote] connected to ${cfg.sshTarget} — http://${serverHost}:${serverPort}`);
  recordGateway({
    mode: "remote",
    host: serverHost,
    port: serverPort,
    label: cfg.sshTarget,
    sshTarget: cfg.sshTarget,
    sshKey: cfg.sshKey,
    ...(cfg.sshPort ? { sshPort: cfg.sshPort } : {}),
  });
}

// Right after provisioning, check whether the server host itself has docker
// -- that's what Set Sources targets by default (an empty Docker host field
// there resolves to wherever the server process lives). Purely
// informational: failure here doesn't block setup, it just tells the user
// up front whether they'll need to type an explicit target in Set Sources
// instead of relying on the default.
async function checkServerHostDocker(host, port, onLog) {
  onLog?.("$ checking for docker on the server host...");
  try {
    const r = await fetch(`http://${host}:${port}/docker/ps`, {
      method: "POST",
      body: JSON.stringify({}),
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
let wizardWindow = null;
function runSetupWizard() {
  return new Promise((resolve, reject) => {
    let settled = false;
    wizardWindow = new BrowserWindow({
      width: 520,
      height: 720,
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
    wizardWindow.loadFile(path.join(__dirname, "renderer", "gateway-setup.html"), { search: "mode=new" });
    wizardWindow.on("closed", () => {
      wizardWindow = null;
      if (!settled) {
        ipcMain.removeHandler("gateway-setup-submit");
        reject(new Error("Setup was cancelled."));
      }
    });

    ipcMain.handle("gateway-setup-submit", async (_e, payload) => {
      try {
        const host = hostFromTarget(`${payload.sshUser}@${payload.sshHost}`);
        const existing = readGateways().find((g) => g.host === host);
        if (existing) {
          return {
            ok: false,
            error: `A gateway already exists at ${host} (${existing.label}) -- use File > Gateways > Edit Gateways to modify it instead.`,
          };
        }
        const sshKey =
          payload.keyMode === "paste" ? writeKeyFile(payload.keyContents) : copyKeyFile(payload.keyPath);
        const cfg = {
          sshTarget: `${payload.sshUser}@${payload.sshHost}`,
          sshKey,
          sshPort: payload.sshPort,
          remotePort: 8765, // the CTTC server's fixed container port; see docker-compose.yml
        };
        const remote = await ensureRemoteContainer(cfg, {
          sshBin: process.env.CTTC_SSH_BIN || "ssh",
          resourcesDir: resourcesDirForApp(),
          source: payload.imageSource || undefined,
          onLog: (line) => wizardWindow?.webContents.send("setup-log", line),
        });
        serverHost = remote.host;
        serverPort = remote.port;
        saveConnectionConfig(cfg);
        recordGateway({
          mode: "remote",
          host: remote.host,
          port: remote.port,
          label: cfg.sshTarget,
          sshTarget: cfg.sshTarget,
          sshKey: cfg.sshKey,
          ...(cfg.sshPort ? { sshPort: cfg.sshPort } : {}),
        });
        await checkServerHostDocker(remote.host, remote.port, (line) => wizardWindow?.webContents.send("setup-log", line));
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

// Neither Run Setup nor Update Image hot-swap the already-loaded window's
// server connection (its page was loaded with the *old* host/port baked
// into the URL) -- simplest and safest is to save/apply the change, then
// offer to relaunch the app so it goes through the normal startup path from
// a clean slate.
async function offerRestart(message) {
  const r = await dialog.showMessageBox({
    type: "info",
    message,
    buttons: ["Restart Now", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (r.response === 0) {
    app.relaunch();
    app.exit(0);
  }
}

// Backs the status-pill dropdown in the main window: every gateway this
// client has ever actually connected to, newest first, with the currently
// active one flagged so the renderer can highlight it.
ipcMain.handle("get-gateways", () => {
  const gateways = readGateways();
  for (const g of gateways) g.active = g.host === serverHost && g.port === serverPort;
  return gateways;
});

// Switching gateways doesn't re-provision anything -- these are all
// gateways already confirmed running at some point; a quick /health check
// just confirms it's still up before committing to it, since restarting
// into a dead gateway would be a worse experience than an upfront error
// here. "embedded" means point back at this machine (clears
// connection.json, same as Run Setup's "Revert to Local"); anything else
// writes a "remote" connection.json from the saved ssh fields.
ipcMain.handle("switch-gateway", async (_e, entry) => {
  try {
    const r = await fetch(`http://${entry.host}:${entry.port}/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`gateway responded ${r.status}`);
  } catch (err) {
    return { ok: false, error: `could not reach ${entry.host}:${entry.port}: ${err.message || err}` };
  }
  if (entry.mode === "embedded") {
    clearConnectionConfig();
  } else {
    saveConnectionConfig({
      sshTarget: entry.sshTarget,
      sshKey: entry.sshKey,
      remotePort: entry.port,
      ...(entry.sshPort ? { sshPort: entry.sshPort } : {}),
    });
  }
  await offerRestart(`Restart CTTC to switch to ${entry.label}?`);
  return { ok: true };
});

// File > Gateways > New Gateway: always just provisions a new one -- picking
// an existing gateway to revert to (including "This machine") or
// reconfigure is the status-pill dropdown/Edit Gateways' job now, not this
// one's, so there's no "already connected, revert or reconfigure?" prompt
// here anymore.
ipcMain.handle("new-gateway", async () => {
  try {
    await runSetupWizard();
  } catch {
    return; // cancelled -- nothing changed, no need to restart
  }
  await offerRestart("Restart CTTC to apply the new connection settings?");
});

// File > Gateways > Edit Gateways: manages the recorded list itself (edit
// an existing gateway's ssh settings, or uninstall it) -- a separate,
// non-modal window since (unlike New Gateway) it isn't gating app startup.
let gatewayManagerWindow = null;
function openGatewayManager() {
  if (gatewayManagerWindow && !gatewayManagerWindow.isDestroyed()) {
    gatewayManagerWindow.focus();
    return;
  }
  gatewayManagerWindow = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 480,
    minHeight: 560,
    icon: APP_ICON,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  gatewayManagerWindow.once("ready-to-show", () => gatewayManagerWindow.show());
  gatewayManagerWindow.setMenuBarVisibility(false);
  attachEditContextMenu(gatewayManagerWindow);
  gatewayManagerWindow.loadFile(path.join(__dirname, "renderer", "gateway-setup.html"), { search: "mode=edit" });
  gatewayManagerWindow.on("closed", () => {
    gatewayManagerWindow = null;
  });
}
ipcMain.handle("edit-gateways", () => openGatewayManager());

// Re-provisions a gateway at (possibly new) ssh settings and updates its
// registry entry in place -- editing the *currently active* gateway also
// updates connection.json and offers a restart, since this window can't
// hot-swap the main window's already-loaded connection.
ipcMain.handle("gateway-manage-save", async (_e, payload) => {
  try {
    const existing = readGateways().find((g) => gatewayKey(g) === payload.key);
    if (!existing) return { ok: false, error: "That gateway no longer exists -- refresh the list." };

    // "This machine" has no ssh settings to change -- Save/Update here only
    // ever re-provisions the local container with the chosen image.
    if (existing.mode === "embedded") {
      const { port } = await ensureLocalContainer({
        source: payload.imageSource || undefined,
        resourcesDir: resourcesDirForApp(),
      });
      recordGateway({ mode: "embedded", host: "127.0.0.1", port, label: "This machine" });
      if (payload.key === `${serverHost}:${serverPort}`) {
        serverHost = "127.0.0.1";
        serverPort = port;
        await offerRestart("Restart CTTC to apply the updated image?");
      }
      return { ok: true };
    }

    const sshKey =
      payload.keyMode === "paste" ? writeKeyFile(payload.keyContents) : copyKeyFile(payload.keyPath);
    const cfg = {
      sshTarget: `${payload.sshUser}@${payload.sshHost}`,
      sshKey,
      sshPort: payload.sshPort,
      remotePort: 8765,
    };
    const remote = await ensureRemoteContainer(cfg, {
      sshBin: process.env.CTTC_SSH_BIN || "ssh",
      source: payload.imageSource || undefined,
      onLog: (line) => gatewayManagerWindow?.webContents.send("setup-log", line),
    });
    const wasActive = payload.key === `${serverHost}:${serverPort}`;
    recordGateway({
      mode: "remote",
      host: remote.host,
      port: remote.port,
      label: cfg.sshTarget,
      sshTarget: cfg.sshTarget,
      sshKey: cfg.sshKey,
      ...(cfg.sshPort ? { sshPort: cfg.sshPort } : {}),
    });
    if (gatewayKey({ host: remote.host, port: remote.port }) !== payload.key) removeGateway(payload.key);
    if (wasActive) {
      saveConnectionConfig(cfg);
      await offerRestart("Restart CTTC to apply the updated gateway settings?");
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Stops and removes the gateway's container (locally, or over ssh for a
// remote one), then drops it from the recorded list. Uninstalling the
// *currently active* gateway reverts connection.json to embedded mode
// (nothing else left to point at) and offers a restart.
ipcMain.handle("gateway-manage-uninstall", async (_e, entry) => {
  try {
    if (entry.mode === "embedded") {
      await uninstallLocalContainer({ resourcesDir: resourcesDirForApp() });
    } else {
      await uninstallRemoteContainer(
        { sshTarget: entry.sshTarget, sshKey: entry.sshKey, sshPort: entry.sshPort },
        { sshBin: process.env.CTTC_SSH_BIN || "ssh" }
      );
    }
    removeGateway(gatewayKey(entry));
    if (entry.host === serverHost && entry.port === serverPort) {
      clearConnectionConfig();
      await offerRestart("This gateway was uninstalled. Restart CTTC to reconnect?");
    }
    return { ok: true };
  } catch (err) {
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
  // second loading window on top of it.
  showSplash();
  installMenu();
  // the window `icon` option is ignored on macOS; the running app's Dock icon
  // must be set explicitly (only affects unpackaged runs — packaged apps use .icns)
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  try {
    // files passed on the command line open at startup: npm start -- file1 file2
    const fileArgs = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-"));
    const cfg = loadConnectionConfig();
    if (cfg.mode === "embedded" && !(await canBeServerLocally())) {
      try {
        await runSetupWizard();
      } catch {
        // declined (Skip, or just closed the window) -- give local docker a
        // genuine try (docker compose up) rather than trusting the earlier
        // quick canBeServerLocally() probe, which can miss a daemon that's
        // still starting up; only fall back to the bare, docker-less
        // embedded server if that attempt itself fails.
        try {
          const { port } = await ensureLocalContainer({ resourcesDir: resourcesDirForApp() });
          serverPort = port;
          mainLog(`[docker] server container running locally — port ${serverPort}`);
        } catch {
          await startServer(fileArgs);
        }
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

function stopServer() {
  // A remote server (or a local Docker container -- see ensureLocalContainer's
  // `restart: unless-stopped`) is shared/persistent infrastructure, not this
  // process's own child: there's nothing local to tear down, and this
  // process must never POST /shutdown to it. Only a bare `uv run server.py`
  // (serverProc) is actually owned by this process.
  if (serverProc) {
    try {
      // graceful: lets the server stop docker collectors and ssh sessions
      fetch(`http://${serverHost}:${serverPort}/shutdown`, { method: "POST" }).catch(() => {});
      setTimeout(() => serverProc && serverProc.kill(), 1500);
    } catch {
      serverProc.kill();
    }
  }
}

app.on("window-all-closed", () => {
  stopServer();
  app.quit();
});
app.on("before-quit", stopServer);
