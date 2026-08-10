// Electron main process for Enio desktop.
//
// This file owns two things: the BrowserWindow, and the lifecycle of the two
// backend processes enio needs (the raw model server on :8080 and the
// agent's OpenAI-compatible endpoint on :8787). It does not talk to either
// server itself beyond health-checking them — all chat traffic happens in the
// renderer via fetch(), because that's where streaming response bodies are
// easiest to consume incrementally.
"use strict";

const {
  app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, shell,
  systemPreferences,
} = require("electron");
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

const DATA_DIR = process.env.ENIO_DATA_DIR || path.join(os.homedir(), ".enio");
const TOKEN_PATH = path.join(DATA_DIR, "token");

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
// Long enough for the slow path, not just the common one: a cold start reads
// ~5GB off disk, and if another launcher is already doing that we wait for it
// (up to 90s) before falling back to starting our own. Timing out first leaves
// the app "failed" with a model that is about to come up and no agent started,
// which reads as completely broken rather than merely slow.
const MODEL_TIMEOUT_MS = 240_000;
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
/** Periodic health poll, so a backend that recovers is noticed. */
let healthTimer = null;

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
    // Its own process group, so shutdown can signal the whole tree.
    // `enio up` is a wrapper: the thing actually holding ~6GB is the python
    // mlx_lm.server it spawns underneath. child.kill() reaches the wrapper
    // only, and the python process was surviving Cmd-Q reparented to launchd
    // -- invisible, still resident, and still holding port 8080. Quit and
    // relaunch a couple of times on a 24GB machine and the survivors put the
    // whole system into swap.
    detached: true,
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
      // Watched even though startup failed: a slow first load that finishes a
      // minute later, or a server started by hand afterwards, should clear
      // this rather than require relaunching the app.
      watchBackends(null);
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
      watchBackends(null);
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
  watchBackends(toolCount);
}

/**
 * Keep the status honest after startup.
 *
 * It was latched: startBackends ran once, and the only thing that could change
 * the status afterwards was one of *our* children exiting. Two ways that lies.
 *
 * A backend that comes back stayed broken on screen — restart the model server
 * by hand, or from another terminal, and the window still said "stopped
 * unexpectedly" with no route back short of relaunching the whole app. And a
 * backend this app did not spawn has no child to exit, so if it died the
 * window went on claiming everything was fine.
 *
 * Polling both endpoints is the only honest answer to "is it up", precisely
 * because this app is not always what started them. Only transitions are
 * reported, so a healthy machine sends nothing.
 */
function watchBackends(toolCount) {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    // "starting" is someone else's business — a check landing mid-boot would
    // fight whatever is reporting progress.
    if (shuttingDown || lastStatus.phase === "starting") return;

    const [model, agent] = await Promise.all([
      checkHealth(MODEL_HEALTH_URL),
      checkHealth(AGENT_PING_URL),
    ]);
    const healthy = model && agent;

    if (healthy && lastStatus.phase !== "ready") {
      sendStatus("ready", "Ready (recovered).", { tools: toolCount ?? null });
    } else if (!healthy && lastStatus.phase === "ready") {
      sendStatus(
        "failed",
        `${!model ? "Model" : "Agent"} server is not responding.`,
      );
    }
  }, 5000);
  // Never hold the app open on its own account.
  healthTimer.unref?.();
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

/**
 * Live enio processes that still need the model server, other than our own.
 *
 * Mirrors src/model-clients.ts, deliberately: this runs during shutdown, where
 * spawning a node process to ask the question is exactly the sort of thing
 * that does not finish. The format is one pid per line and the liveness test
 * is signal 0, so the two implementations cannot drift far.
 */
function otherModelClients(ignorePid) {
  try {
    const file = path.join(DATA_DIR, "model-clients");
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== ignorePid)
      .filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function killChild(child, pid, label) {
  const target = pid ?? child?.pid;
  if (!target) return;

  // Wrapper-only: signal the single process, deliberately sparing the group,
  // because the model server inside it is still serving somebody.
  if (label === "model-wrapper-only") {
    try {
      process.kill(target, "SIGTERM");
    } catch {
      /* gone */
    }
    return;
  }

  // Negative pid signals the process group, which is why spawnBackend makes
  // one. Signalling the pid alone leaves the model server orphaned.
  try {
    process.kill(-target, "SIGTERM");
  } catch (err) {
    if (err.code === "ESRCH") return; // already gone, which is the goal
    // No group (spawn failed before setsid, or a platform without them).
    try {
      child?.kill() ?? process.kill(target, "SIGTERM");
    } catch {
      /* gone */
    }
  }

  // A model server mid-load ignores a polite signal for a while, and the user
  // is already watching the app disappear. Follow up with SIGKILL rather than
  // leaving 6GB resident because shutdown was too courteous to insist.
  setTimeout(() => {
    try {
      process.kill(-target, "SIGKILL");
      console.log(`[${label}] did not exit on SIGTERM; killed`);
    } catch {
      /* exited in the meantime, as expected */
    }
  }, 2500).unref?.();
}

function stopBackends() {
  shuttingDown = true;
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }

  // The model server is shared. If a CLI session is attached, killing it here
  // takes the model out from under someone mid-answer -- so leave it, and let
  // whichever process is genuinely last shut it down. Our own wrapper's pid is
  // excluded because it is about to exit and is not a reason to keep anything.
  const stillNeeded = otherModelClients(modelPid);
  if (stillNeeded.length > 0) {
    console.log(
      `[model] leaving the server up — in use by pid ${stillNeeded.join(", ")}`,
    );
    // The wrapper still goes, so nothing of ours is left behind; the python
    // server it started outlives it deliberately and is adopted on next launch.
    killChild(null, modelPid, "model-wrapper-only");
  } else {
    killChild(modelProc, modelPid, "model");
  }

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

/**
 * Asking macOS for Accessibility access, which is what clicking by name needs.
 *
 * Two mechanisms, and it takes both. `isTrustedAccessibilityClient(true)`
 * raises the real system dialog — the one with the "Open System Settings"
 * button — but macOS shows that **once per app, ever**. Dismiss it and it never
 * appears again, no matter how many times it is called, which is why a button
 * wired only to the prompt looks broken to precisely the users who need it.
 *
 * So the settings pane is opened as well whenever access is still missing. The
 * URL scheme is the documented way in and lands directly on the Accessibility
 * list rather than the top of Privacy & Security.
 *
 * Note this answers for Enio.app. The process that actually runs osascript is
 * the agent, spawned as a child; the authoritative answer comes from the
 * agent's own /permissions endpoint, and this is only how the request is
 * raised.
 */
const ACCESSIBILITY_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

ipcMain.handle("accessibility-status", () => {
  if (process.platform !== "darwin") return null;
  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    return null;
  }
});

ipcMain.handle("request-accessibility", () => {
  if (process.platform !== "darwin") return null;
  let granted = false;
  try {
    granted = systemPreferences.isTrustedAccessibilityClient(true);
  } catch {
    granted = false;
  }
  // Opened unconditionally when still missing: the prompt above may have been
  // silently suppressed as already-answered, and leaving the user with nothing
  // on screen is worse than one extra window.
  if (!granted) {
    try {
      shell.openExternal(ACCESSIBILITY_PANE);
    } catch {
      // Nothing to fall back to; the notice in the UI still says where to go.
    }
  }
  return granted;
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
