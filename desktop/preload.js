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
   * Native file picker. Returns names the agent can address: a file already
   * inside one of the project's attached folders comes back as its alias
   * path (a reference), anything else is copied into the workspace first.
   */
  pickFiles(conversationId, projectRoots) {
    return ipcRenderer.invoke("pick-files", conversationId, projectRoots);
  },

  /** Folder/file picker for project attachments. Absolute paths, no copying —
   *  the server's guards decide whether each one is attachable. */
  pickProjectPaths(title) {
    return ipcRenderer.invoke("pick-project-paths", title);
  },

  /** Tell the main process which project roots are open, so previews,
   *  Save as… and Reveal work for project files too. */
  setProjectRoots(roots) {
    return ipcRenderer.invoke("set-project-roots", roots);
  },

  /** Write the canvas editor's buffer back to a workspace file. */
  saveFileContent(relPath, text) {
    return ipcRenderer.invoke("save-file-content", relPath, text);
  },

  /** Discard a canvas draft to the macOS Trash (Put Back works). */
  trashFile(relPath) {
    return ipcRenderer.invoke("trash-file", relPath);
  },

  /** Open a workspace file in the system's default app for it. */
  openInDefaultApp(relPath) {
    return ipcRenderer.invoke("open-in-default-app", relPath);
  },

  /** Pick an application and open the file in it (a real Open With…). */
  openWithApp(relPath) {
    return ipcRenderer.invoke("open-with-app", relPath);
  },

  /** Modification time, for noticing edits made in external editors. */
  statFile(relPath) {
    return ipcRenderer.invoke("stat-file", relPath);
  },

  /** Media (image/svg/video/audio) as a data URL for the canvas preview. */
  readMedia(relPath) {
    return ipcRenderer.invoke("read-media", relPath);
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

  /** Show a project attachment in Finder — absolute path, because
   *  attachments live wherever the user attached them. */
  revealProjectPath(absolutePath) {
    return ipcRenderer.invoke("reveal-project-path", absolutePath);
  },

  /** A file's contents for the viewer: an image data URL, decoded text, or a
   *  kind saying why neither is on offer. */
  readFilePreview(relPath) {
    return ipcRenderer.invoke("read-file-preview", relPath);
  },

  /** Open a PDF in its own window, which is where Chromium's viewer lives. */
  openPdf(relPath) {
    return ipcRenderer.invoke("open-pdf", relPath);
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

  /** The cloud AIs a handoff can go to, with which have desktop apps here. */
  aiProviders() {
    return ipcRenderer.invoke("ai-providers");
  },

  /** Copy a handoff file to the clipboard and open the chosen AI. */
  sendToAi(providerId, path) {
    return ipcRenderer.invoke("send-to-ai", providerId, path);
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
