// Electron main process for Enio desktop.
//
// This file owns two things: the BrowserWindow, and the lifecycle of the two
// backend processes enio needs (the raw model server on :8080 and the
// agent's OpenAI-compatible endpoint on :8787). It does not talk to either
// server itself beyond health-checking them — all chat traffic happens in the
// renderer via fetch(), because that's where streaming response bodies are
// easiest to consume incrementally.
"use strict";

const { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, shell } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");

// The parent project (../ from this folder) is where `node dist/index.js ...`
// lives. It must already be built (`npm run build` there) — this app is only
// a client, it doesn't compile TypeScript.
// Set before anything reads it. An unpackaged Electron app is called
// "Electron" everywhere it is named -- the menu bar, the About panel, the force
// quit list -- because there is no bundle to take a name from. Packaged builds
// get it from productName; this is what makes `npm start` say Enio too.
app.setName("Enio");

const PARENT_DIR = path.join(__dirname, "..");
const AGENT_ENTRY = path.join(PARENT_DIR, "dist", "index.js");

const MODEL_HEALTH_URL = "http://127.0.0.1:8080/v1/models";
// /ping is unauthenticated and returns nothing but {ok:true}; /health needs the
// API key. Liveness polling therefore uses /ping, because the token file may
// not exist yet on a first run — the agent server creates it at startup.
const AGENT_PING_URL = "http://127.0.0.1:8787/ping";
const AGENT_HEALTH_URL = "http://127.0.0.1:8787/health";

const TOKEN_PATH = path.join(
  process.env.ENIO_DATA_DIR || path.join(os.homedir(), ".enio"),
  "token",
);

/**
 * The agent endpoint requires a bearer token. It's generated on first `serve`
 * and written to a 0600 file, so we read it from disk rather than passing it
 * around. Re-read on each call: on a cold start the file appears only after the
 * agent server boots, so a value cached at app launch would be stale (null).
 */
function readToken() {
  try {
    const value = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    return value.length >= 32 ? value : null;
  } catch {
    return null;
  }
}

const POLL_INTERVAL_MS = 800;
// Model load reads ~5GB off disk; give it a generous window before we give up
// and report failure rather than leaving the user staring at "starting".
const MODEL_TIMEOUT_MS = 120_000;
const AGENT_TIMEOUT_MS = 30_000;

/** @type {BrowserWindow | null} */
let mainWindow = null;

/**
 * Held in module scope, not a local.
 *
 * A Tray that only a function's stack refers to is garbage collected the moment
 * that function returns, and the icon vanishes from the menu bar seconds after
 * appearing — with nothing in any log to say why.
 */
/** @type {Tray | null} */
let tray = null;

/** @type {import('node:child_process').ChildProcess | null} */
let modelProc = null;
/** @type {import('node:child_process').ChildProcess | null} */
let agentProc = null;

// Tracked explicitly (rather than just holding the ChildProcess objects) so
// shutdown logic can log/verify what it's killing even if the process
// reference has already been nulled out by an 'exit' handler race.
let modelPid = null;
let agentPid = null;

let shuttingDown = false;

function sendStatus(phase, message, extra) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("backend-status", { phase, message, ...extra });
  }
  lastStatus = { phase, message, ...extra };
}

let lastStatus = { phase: "starting", message: "Starting up…" };

/** GET a URL with a short timeout, resolving true/false rather than throwing. */
function checkHealth(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      // Drain the response so the socket can be reused/closed cleanly.
      res.resume();
      resolve(res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

/** Poll a health URL until it responds OK or the deadline passes. */
async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealth(url)) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Spawn a backend child process, piping its output to our stdout/stderr so
 * `npm start` shows logs, and returning it so the caller can track the PID.
 */
function spawnBackend(args, label) {
  // Plain `node` off PATH, not Electron's own binary — the parent project
  // assumes a normal Node runtime (ESM loader, no Electron-specific globals).
  const child = spawn("node", [AGENT_ENTRY, ...args], {
    cwd: PARENT_DIR,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));

  child.on("exit", (code, signal) => {
    console.log(`[${label}] exited (code=${code}, signal=${signal})`);
    if (label === "model") {
      modelProc = null;
      modelPid = null;
    } else {
      agentProc = null;
      agentPid = null;
    }
    // An unexpected exit while we're not already shutting down means the
    // backend crashed after having started successfully; tell the renderer.
    if (!shuttingDown && lastStatus.phase === "ready") {
      sendStatus("failed", `${label === "model" ? "Model" : "Agent"} server stopped unexpectedly (code ${code}).`);
    }
  });

  child.on("error", (err) => {
    console.error(`[${label}] failed to spawn:`, err);
    sendStatus("failed", `Could not start the ${label} server: ${err.message}`);
  });

  return child;
}

/**
 * Bring both backends up, or discover they're already running (started from
 * the CLI by the user). Reports progress to the renderer via IPC the whole
 * way so the UI never sits silently during the ~30s model load.
 */
async function startBackends() {
  sendStatus("starting", "Checking for a running model server…");

  const modelAlreadyUp = await checkHealth(MODEL_HEALTH_URL);
  let modelStartedByUs = false;

  if (modelAlreadyUp) {
    sendStatus("starting", "Model server already running — reusing it.");
  } else {
    sendStatus(
      "starting",
      "Starting the model server. First load reads ~5GB from disk and takes about 30 seconds…",
    );
    modelProc = spawnBackend(["up"], "model");
    modelPid = modelProc.pid ?? null;
    modelStartedByUs = true;

    const modelReady = await waitForHealth(MODEL_HEALTH_URL, MODEL_TIMEOUT_MS);
    if (!modelReady) {
      sendStatus(
        "failed",
        "Model server did not respond in time. Check that Maple is installed (see setup.sh) and that nothing else is using port 8080.",
      );
      return;
    }
  }

  sendStatus("starting", "Model server ready. Checking for the agent endpoint…");

  const agentAlreadyUp = await checkHealth(AGENT_PING_URL);
  if (agentAlreadyUp) {
    sendStatus("starting", "Agent endpoint already running — reusing it.");
  } else {
    sendStatus("starting", "Starting the agent server (tools, memory, :8787)…");
    agentProc = spawnBackend(["serve"], "agent");
    agentPid = agentProc.pid ?? null;

    const agentReady = await waitForHealth(AGENT_PING_URL, AGENT_TIMEOUT_MS);
    if (!agentReady) {
      sendStatus(
        "failed",
        "Agent server did not respond in time. Check the logs in the terminal that launched this app.",
      );
      return;
    }
  }

  // Fetch the final health payload for the tool count shown in the status bar.
  let toolCount = null;
  try {
    const token = readToken();
    const res = await fetch(AGENT_HEALTH_URL, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const data = await res.json();
      toolCount = typeof data.tools === "number" ? data.tools : null;
    }
  } catch {
    // Non-fatal — the status bar just won't show a tool count.
  }

  sendStatus("ready", modelStartedByUs ? "Ready." : "Ready (reused existing servers).", { tools: toolCount });
}

/**
 * The menu bar item.
 *
 * A template image: pure black on transparency, which macOS inverts itself for
 * a light or dark menu bar and again when the bar is selected. Hard-coding a
 * white icon would look right today and wrong the moment someone switches
 * appearance.
 */
function createTray() {
  try {
    const icon = nativeImage.createFromPath(
      path.join(__dirname, "assets", "trayTemplate.png"),
    );
    if (icon.isEmpty()) return;
    icon.setTemplateImage(true);

    tray = new Tray(icon);
    tray.setToolTip("Enio");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "Show Enio",
          click: () => {
            if (!mainWindow || mainWindow.isDestroyed()) createWindow();
            else mainWindow.show();
            mainWindow?.focus();
          },
        },
        { type: "separator" },
        { label: "Quit Enio", click: () => app.quit() },
      ]),
    );

    // Left click toggles rather than only showing: the point of a menu bar item
    // is getting the window out of the way as easily as getting it back.
    tray.on("click", () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        return;
      }
      if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    // Cosmetic. No menu bar item is a worse app, not a broken one.
    console.error("could not create the tray icon:", err.message);
  }
}

function killChild(child, pid, label) {
  if (!child && !pid) return;
  try {
    if (child && !child.killed) {
      child.kill();
    } else if (pid) {
      // Fallback: we lost the ChildProcess reference (e.g. after an 'exit'
      // race) but still recorded the PID, so try to signal it directly.
      process.kill(pid);
    }
  } catch (err) {
    // ESRCH etc. — process is already gone, which is the outcome we wanted.
    console.log(`[${label}] kill on shutdown: ${err.message}`);
  }
}

function stopBackends() {
  shuttingDown = true;
  killChild(modelProc, modelPid, "model");
  killChild(agentProc, agentPid, "agent");
  modelProc = null;
  agentProc = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 700,
    minHeight: 500,
    titleBarStyle: "hiddenInset",
    icon: path.join(__dirname, "assets", "icon.png"),
    backgroundColor: "#1a1a1e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // renderer/dist is build output (npm run build). The sources live in
  // renderer/src and are never loaded directly -- they are JSX.
  mainWindow.loadFile(path.join(__dirname, "renderer", "dist", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Re-send the last known status as soon as the page finishes loading, in
  // case backend startup (which begins immediately at app ready) finishes —
  // or progresses — before the renderer has attached its listener.
  mainWindow.webContents.on("did-finish-load", () => {
    sendStatus(lastStatus.phase, lastStatus.message, { tools: lastStatus.tools });
  });
}

ipcMain.handle("get-status", () => lastStatus);

// The renderer makes the chat requests itself (streaming bodies are far easier
// to consume there), so it needs the key. This is our own trusted page with no
// remote content loaded into it.
ipcMain.handle("get-token", () => readToken());

/**
 * Where attachments have to end up.
 *
 * The agent resolves every attachment through safePath, which refuses anything
 * outside the workspace — so a file chosen from elsewhere on disk cannot be
 * read no matter how it is referenced. Copying into the workspace is therefore
 * not a convenience, it is the only thing that makes a native file picker
 * usable at all. Mirrors config.ts, which is the source of truth.
 */
const WORKSPACE = path.resolve(
  process.env.ENIO_WORKSPACE ??
    process.env.MAPLE_WORKSPACE ??
    path.join(os.homedir(), "enio-workspace"),
);

/**
 * Copy into the workspace without ever overwriting.
 *
 * A second screenshot.png must not silently replace the first — the user would
 * be asking about one image while the model reads another, and nothing on
 * screen would say so.
 */
function copyIntoWorkspace(sourcePath) {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const ext = path.extname(sourcePath);
  const stem = path.basename(sourcePath, ext).replace(/[^\w.-]+/g, "-") || "file";

  let name = `${stem}${ext}`;
  for (let n = 2; fs.existsSync(path.join(WORKSPACE, name)); n++) {
    name = `${stem}-${n}${ext}`;
  }
  fs.copyFileSync(sourcePath, path.join(WORKSPACE, name));
  return name;
}

ipcMain.handle("pick-files", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Attach to this message",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff"] },
      { name: "Text", extensions: ["txt", "md", "json", "csv", "log", "yml", "yaml"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths.map(copyIntoWorkspace);
});

const PREVIEWABLE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const PREVIEW_LIMIT = 4 * 1024 * 1024;

/**
 * A workspace image as a data URL, for showing the user what they attached.
 *
 * Resolved against the workspace and rejected if it escapes, because this
 * reads a path the renderer supplied — the same rule the agent's own file
 * tools follow, for the same reason.
 */
ipcMain.handle("read-attachment", (_event, name) => {
  try {
    const full = path.resolve(WORKSPACE, name);
    if (full !== WORKSPACE && !full.startsWith(WORKSPACE + path.sep)) return null;

    const ext = path.extname(full).toLowerCase();
    if (!PREVIEWABLE.has(ext)) return null;

    const stat = fs.statSync(full);
    // A thumbnail is a nicety; inlining megabytes of base64 into the DOM for
    // one is not. Oversized images simply show as a chip with a name.
    if (!stat.isFile() || stat.size > PREVIEW_LIMIT) return null;

    const mime = ext === ".jpg" ? "image/jpeg" : `image/${ext.slice(1)}`;
    return `data:${mime};base64,${fs.readFileSync(full).toString("base64")}`;
  } catch {
    return null;
  }
});

ipcMain.handle("import-file", (_event, sourcePath) => {
  try {
    return copyIntoWorkspace(sourcePath);
  } catch {
    // A drag from somewhere unreadable should drop the file, not the app.
    return null;
  }
});

/** Pasted or dropped image bytes, which have no path to copy from. */
ipcMain.handle("save-image", (_event, { name, base64 }) => {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const ext = path.extname(name || "") || ".png";
  const stem = (path.basename(name || "pasted", ext) || "pasted").replace(/[^\w.-]+/g, "-");

  let file = `${stem}${ext}`;
  for (let n = 2; fs.existsSync(path.join(WORKSPACE, file)); n++) {
    file = `${stem}-${n}${ext}`;
  }
  fs.writeFileSync(path.join(WORKSPACE, file), Buffer.from(base64, "base64"));
  return file;
});

/**
 * Speak a reply through the system voice.
 *
 * Spawned with the text as an argument rather than through a shell, so nothing
 * a model writes can be read as a command. Any previous utterance is stopped
 * first: two replies talking over each other is worse than missing one.
 */
let speaking = null;
ipcMain.handle("speak", (_event, text) => {
  const trimmed = String(text ?? "").trim();
  if (process.platform !== "darwin" || !trimmed) return false;

  try {
    speaking?.kill();
  } catch {
    /* already gone */
  }

  try {
    // ENIO_VOICE picks a better one; `say -v '?'` lists what is installed.
    const voice = process.env.ENIO_VOICE || process.env.MAPLE_VOICE || "";
    const args = voice ? ["-v", voice] : [];
    speaking = spawn("say", [...args, "--", trimmed.slice(0, 2000)], { stdio: "ignore" });
    speaking.on("error", () => {});
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("stop-speaking", () => {
  try {
    speaking?.kill();
  } catch {
    /* already gone */
  }
  speaking = null;
});

/**
 * Copy through Electron's own clipboard rather than the renderer's.
 *
 * navigator.clipboard.writeText is gated behind permissions the sandboxed
 * renderer does not have -- it fails with NotAllowedError. The main process has
 * no such restriction, and a copy button that silently does nothing is worse
 * than no copy button.
 */
ipcMain.handle("copy-text", (_event, text) => {
  clipboard.writeText(String(text ?? ""));
  return true;
});

ipcMain.handle("open-external", (_event, url) => {
  // Only allow http(s) links out — this is the one bit of OS access the
  // renderer gets, and it goes through the main process, never direct.
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

app.whenReady().then(() => {
  // The BrowserWindow `icon` option is ignored on macOS — the dock reads the
  // app bundle, and an unpackaged `electron .` has Electron's own. Setting it
  // here is what makes a dev run show Enio in the dock and the switcher.
  // Packaged builds get it from electron-builder's mac.icon instead.
  if (process.platform === "darwin") {
    try {
      app.dock?.setIcon(path.join(__dirname, "assets", "icon.png"));
    } catch {
      // Cosmetic. A missing or unreadable icon must not stop the app booting.
    }
  }

  // Without an explicit menu, macOS shows Electron's default one, whose first
  // item is the process name rather than the app's.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Enio",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }] },
      { label: "Window", submenu: [{ role: "minimize" }, { role: "close" }] },
    ]),
  );

  createTray();
  createWindow();
  startBackends();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopBackends();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopBackends();
});
