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
  pickFiles(conversationId) {
    return ipcRenderer.invoke("pick-files", conversationId);
  },

  /** Save pasted or dropped image bytes into the workspace. */
  saveImage(name, base64, conversationId) {
    return ipcRenderer.invoke("save-image", { name, base64, conversationId });
  },

  /** Copy a workspace file out to wherever the user points the save panel. */
  saveFileAs(relPath) {
    return ipcRenderer.invoke("save-file-as", relPath);
  },

  /** Show a workspace file in Finder. */
  revealFile(relPath) {
    return ipcRenderer.invoke("reveal-file", relPath);
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

  /** A workspace image as a data URL, or null if it is not previewable. */
  readAttachment(name) {
    return ipcRenderer.invoke("read-attachment", name);
  },

  /** Copy an already-on-disk file into the workspace. */
  importFile(sourcePath, conversationId) {
    return ipcRenderer.invoke("import-file", sourcePath, conversationId);
  },

  /** Put text on the system clipboard. */
  copyText(text) {
    return ipcRenderer.invoke("copy-text", text);
  },

  /** Speak text through the system voice. macOS only; false elsewhere. */
  speak(text) {
    return ipcRenderer.invoke("speak", text);
  },

  /** Cut off whatever is being spoken. */
  stopSpeaking() {
    return ipcRenderer.invoke("stop-speaking");
  },

  /** Open a link in the user's default browser instead of navigating in-app. */
  openExternal(url) {
    return ipcRenderer.invoke("open-external", url);
  },

  /** Whether macOS trusts this app for Accessibility. Null off macOS. */
  accessibilityStatus() {
    return ipcRenderer.invoke("accessibility-status");
  },

  /**
   * Raise the system permission request, and open the Accessibility pane when
   * it is still missing. macOS only shows its dialog once per app ever, so the
   * pane is the part that reliably gives the user somewhere to go.
   */
  requestAccessibility() {
    return ipcRenderer.invoke("request-accessibility");
  },
});
