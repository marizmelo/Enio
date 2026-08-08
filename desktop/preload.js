// Preload script: the only bridge between the sandboxed renderer and the
// main process. Deliberately minimal — no fs, no child_process, no direct
// node: module access is exposed. The renderer talks to the agent server
// over plain fetch() (it's just an HTTP client), so it doesn't need IPC for
// that; IPC here is only for backend lifecycle status and opening links.
"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("maple", {
  /** Subscribe to backend status pushes. Returns an unsubscribe function. */
  onStatus(callback) {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("backend-status", handler);
    return () => ipcRenderer.removeListener("backend-status", handler);
  },

  /** Pull the current status on demand (e.g. right after the page loads). */
  getStatus() {
    return ipcRenderer.invoke("get-status");
  },

  /** The API key for the agent endpoint, read from disk by the main process. */
  getToken() {
    return ipcRenderer.invoke("get-token");
  },

  /**
   * Native file picker. Returns workspace-relative names, because the chosen
   * files are copied in — the agent cannot read anything outside the workspace.
   */
  pickFiles() {
    return ipcRenderer.invoke("pick-files");
  },

  /** Save pasted or dropped image bytes into the workspace. */
  saveImage(name, base64) {
    return ipcRenderer.invoke("save-image", { name, base64 });
  },

  /**
   * The real path behind a dropped File. Electron removed File.path from the
   * renderer, and webUtils is the supported replacement — it must be called
   * here, in the preload, because the renderer is sandboxed.
   */
  filePath(file) {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },

  /** Copy an already-on-disk file into the workspace. */
  importFile(sourcePath) {
    return ipcRenderer.invoke("import-file", sourcePath);
  },

  /** Open a link in the user's default browser instead of navigating in-app. */
  openExternal(url) {
    return ipcRenderer.invoke("open-external", url);
  },
});
