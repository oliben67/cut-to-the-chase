"use strict";

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

const SERVER_DIR = path.join(__dirname, "server");
const APP_ICON = path.join(__dirname, "assets", "icon.png");
let serverProc = null;
let serverPort = null;

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

ipcMain.handle("pick-files", async () => {
  const r = await dialog.showOpenDialog({
    title: "Open log / stats files",
    properties: ["openFile", "multiSelections"],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle("save-file", async (_e, defaultName) => {
  const r = await dialog.showSaveDialog({
    title: "Save sample",
    defaultPath: defaultName,
    filters: [{ name: "CTTC sample", extensions: ["cttc"] }],
  });
  return r.canceled ? null : r.filePath;
});

app.whenReady().then(async () => {
  // the window `icon` option is ignored on macOS; the running app's Dock icon
  // must be set explicitly (only affects unpackaged runs — packaged apps use .icns)
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  try {
    // files passed on the command line open at startup: npm start -- file1 file2
    const fileArgs = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-"));
    await startServer(fileArgs);
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
