"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const { loadConnectionConfig, saveConnectionConfig } = require("./lib/connection-config");
const { startTunnel } = require("./lib/ssh-tunnel");
const { hasLocalDocker } = require("./lib/docker-check");
const { writeKeyFile } = require("./lib/ssh-key-file");

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
let serverPort = null;
let tunnel = null; // set instead of serverProc in ssh-tunnel mode (see lib/ssh-tunnel.js)

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
    serverProc.stderr.on("data", (d) => console.error(`[server] ${d}`.trimEnd()));

    const rl = readline.createInterface({ input: serverProc.stdout });
    const timer = setTimeout(() => reject(new Error("server did not report a port in 30s")), 30000);
    rl.once("line", (line) => {
      clearTimeout(timer);
      try {
        const info = JSON.parse(line);
        serverPort = info.port;
        console.log(`[server] listening on ${info.port} (json: ${info.json})`);
        resolve(info.port);
      } catch {
        reject(new Error(`unexpected server output: ${line}`));
      }
    });
    serverProc.on("exit", (code) => {
      console.log(`[server] exited (${code})`);
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
    "cryptography >=49.0.0",
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

function installMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { label: `About ${app.name}`, click: showAboutDialog },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),
    {
      label: "File",
      submenu: [
        { label: "Add Sources…", accelerator: "CmdOrCtrl+O", click: () => broadcastMenuAction("add-sources") },
        { label: "Load Metrics…", accelerator: "CmdOrCtrl+L", click: () => broadcastMenuAction("load-metrics") },
        { type: "separator" },
        {
          label: "Preferences",
          submenu: [
            { label: "Theme…", click: () => broadcastMenuAction("open-theme") },
            { label: "Settings…", click: () => broadcastMenuAction("open-settings") },
          ],
        },
        ...(isMac ? [] : [{ type: "separator" }, { role: "quit" }]),
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: `About ${app.name}`, click: showAboutDialog }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on("console-message", (_e, level, msg) => {
    if (level >= 2) console.error(`[renderer] ${msg}`);
  });
  await win.loadFile(path.join(__dirname, "renderer", "index.html"), {
    search: `port=${serverPort}`,
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
  const params = new URLSearchParams({ port: String(serverPort), popout: kind });
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

// Connecting to the server has two shapes: "embedded" (default, unchanged
// from before this existed) spawns it locally via uv; "ssh-tunnel" connects
// to a server already running in a container on a remote docker-enabled
// host instead, over a local port-forward, for clients that can't have
// Docker installed locally. See docs/architecture/remote-server.md. Either
// way the renderer only ever sees http://127.0.0.1:<serverPort> — it can't
// tell the two apart.
async function connectToServer(fileArgs) {
  const cfg = loadConnectionConfig();
  if (cfg.mode === "embedded") {
    await startServer(fileArgs);
    return;
  }
  if (fileArgs.length) {
    // file paths are local to *this* machine; meaningless against a shared
    // remote server, so they're ignored rather than silently mis-sent
    console.error(`[tunnel] ignoring command-line files in ssh-tunnel mode: ${fileArgs.join(", ")}`);
  }
  // CTTC_SSH_BIN overrides the ssh binary (verification hook, same idea as
  // CTTC_TEST/CTTC_EVAL/CTTC_SCREENSHOT below): lets tests point the tunnel
  // manager at test/fixtures/fake-ssh.js instead of a real ssh + remote host.
  tunnel = await startTunnel(cfg, { sshBin: process.env.CTTC_SSH_BIN || "ssh" });
  serverPort = tunnel.localPort;
  console.log(`[tunnel] connected to ${cfg.sshTarget} — local port ${serverPort}`);
}

// Embedded mode with no local Docker has nothing to sample -- offer to set
// up an ssh-tunnel connection to a Docker-enabled host instead of just
// starting an empty embedded server. The wizard window itself establishes
// the tunnel (so it can show its own "please wait" / error state) and sets
// `tunnel`/`serverPort` directly on success; closing it without succeeding
// rejects, which the caller treats the same as any other startup failure.
let wizardWindow = null;
function runSetupWizard() {
  return new Promise((resolve, reject) => {
    let settled = false;
    wizardWindow = new BrowserWindow({
      width: 520,
      height: 640,
      resizable: false,
      icon: APP_ICON,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    wizardWindow.setMenuBarVisibility(false);
    wizardWindow.loadFile(path.join(__dirname, "renderer", "setup-wizard.html"));
    wizardWindow.on("closed", () => {
      wizardWindow = null;
      if (!settled) {
        ipcMain.removeHandler("setup-wizard-submit");
        reject(new Error("Setup was cancelled."));
      }
    });

    ipcMain.handle("setup-wizard-submit", async (_e, payload) => {
      try {
        const sshKey =
          payload.keyMode === "paste" ? writeKeyFile(payload.keyContents) : payload.keyPath;
        const cfg = {
          sshTarget: `${payload.sshUser}@${payload.sshHost}`,
          sshKey,
          sshPort: payload.sshPort,
          remotePort: 8765, // the CTTC server's fixed container port; see docker-compose.yml
        };
        tunnel = await startTunnel(cfg, { sshBin: process.env.CTTC_SSH_BIN || "ssh" });
        serverPort = tunnel.localPort;
        saveConnectionConfig(cfg);
        settled = true;
        ipcMain.removeHandler("setup-wizard-submit");
        wizardWindow.destroy();
        resolve();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });
  });
}

app.whenReady().then(async () => {
  installMenu();
  // the window `icon` option is ignored on macOS; the running app's Dock icon
  // must be set explicitly (only affects unpackaged runs — packaged apps use .icns)
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  try {
    // files passed on the command line open at startup: npm start -- file1 file2
    const fileArgs = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-"));
    const cfg = loadConnectionConfig();
    if (cfg.mode === "embedded" && !hasLocalDocker()) {
      await runSetupWizard();
    } else {
      await connectToServer(fileArgs);
    }
  } catch (err) {
    dialog.showErrorBox("CTTC Timeline", String(err.message || err));
    app.quit();
    return;
  }
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function stopServer() {
  if (tunnel) {
    // the remote server is shared infrastructure, not this process's child —
    // never POST /shutdown to it; just tear down our local ssh forward
    tunnel.stop();
    return;
  }
  if (serverProc) {
    try {
      // graceful: lets the server stop docker collectors and ssh sessions
      fetch(`http://127.0.0.1:${serverPort}/shutdown`, { method: "POST" }).catch(() => {});
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
