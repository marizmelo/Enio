# Maple desktop

An Electron chat UI for `maple-agent`. It is a thin client of the agent's
OpenAI-compatible HTTP endpoint — all tool execution, memory, and model
inference happen in the parent project; this app only renders the
conversation and manages the two backend processes.

## Before you run this

The parent project must be built first, since this app spawns
`node dist/index.js ...` directly:

```sh
cd ..
npm install
npm run build
```

Also make sure the Maple model itself is set up (`../setup.sh` /
`../maple-setup.sh`) — `npm start` below will try to launch the model
server, but it can't install the model for you.

## Run in dev

```sh
npm install
npm start
```

On launch, the app checks whether the model server (`:8080`) and agent
server (`:8787`) are already running (e.g. you started them yourself with
`maple up` / `maple serve`). If not, it spawns them as child processes and
shows startup progress in the status bar — the first model load reads
about 5GB off disk and takes roughly 30 seconds, which the status bar says
explicitly rather than leaving you looking at a blank screen. Closing the
window stops any backend processes this app started.

## Build a .dmg

```sh
npm run dist
```

Produces a macOS arm64 `.dmg` under `build/` via `electron-builder`. This
only targets Apple Silicon Macs; adjust the `build.mac.target.arch` in
`package.json` if you need an Intel build too.

## Files

- `main.js` — Electron main process: window creation, backend process
  lifecycle (spawn, health-poll, kill on quit), IPC status updates.
- `preload.js` — contextBridge surface exposed to the renderer
  (`onStatus`, `getStatus`, `openExternal`). No filesystem or process
  access is exposed.
- `renderer/` — the chat UI itself: plain HTML/CSS/JS, no framework, no
  build step. `app.js` talks to `http://127.0.0.1:8787` directly with
  `fetch()` and hand-parses the SSE stream, including the non-standard
  `: tool NAME` comment frames the agent emits when a tool starts running.

## Limitations

- Packaging (`npm run dist`) is only configured for macOS arm64. Windows/
  Linux targets would need additional `electron-builder` config and were
  out of scope here.
- The app assumes `node` is on `PATH` for the spawned backend processes;
  it does not bundle a Node runtime for them (only Electron's own runtime
  is bundled by `electron-builder`).
- No auto-update, no code signing/notarization configured — `npm run dist`
  produces an unsigned `.dmg` suitable for local use, not distribution.
- If the model server is already running under a different port than 8080
  (via `MAPLE_BASE_URL`) or the agent under a different port than 8787
  (via `MAPLE_AGENT_PORT`), this app won't find it — the health-check URLs
  are hardcoded to the defaults.
