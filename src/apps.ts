import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { config } from "./config.js";

/**
 * Enio works beside the user's apps rather than replacing them: the canvas
 * previews, the editor edits. The one mapping the OS does not already hold
 * is which code editor -- a file has a default handler, a folder has
 * Finder, and the unit of code work is the folder. So this module knows a
 * closed list of editors, finds which are installed, remembers the one
 * chosen, and opens a path in it. Nothing here is model-facing: the model
 * never picks an app; the user's word or the saved choice does.
 *
 * First run is the detection: one editor installed means that one, with no
 * question asked; several means the first "Edit in…" asks once and keeps
 * the answer; none means the buttons stay away and Settings says what it
 * looked for.
 */
export interface EditorDef {
  id: string;
  name: string;
  /** The .app bundle name on macOS. */
  bundle: string;
  /** The command-line launcher, on PATH or inside the bundle. */
  cli: string;
  /** Where the CLI lives inside the bundle, when the user never installed it on PATH. */
  bundleCli?: string;
  /** How the CLI takes a line number. */
  goto: "dash-g" | "colon" | "dash-l" | "plus";
}

export const EDITORS: readonly EditorDef[] = [
  { id: "cursor", name: "Cursor", bundle: "Cursor.app", cli: "cursor", bundleCli: "Contents/Resources/app/bin/cursor", goto: "dash-g" },
  { id: "vscode", name: "Visual Studio Code", bundle: "Visual Studio Code.app", cli: "code", bundleCli: "Contents/Resources/app/bin/code", goto: "dash-g" },
  { id: "codium", name: "VSCodium", bundle: "VSCodium.app", cli: "codium", bundleCli: "Contents/Resources/app/bin/codium", goto: "dash-g" },
  { id: "zed", name: "Zed", bundle: "Zed.app", cli: "zed", bundleCli: "Contents/MacOS/cli", goto: "colon" },
  { id: "sublime", name: "Sublime Text", bundle: "Sublime Text.app", cli: "subl", bundleCli: "Contents/SharedSupport/bin/subl", goto: "colon" },
  { id: "nova", name: "Nova", bundle: "Nova.app", cli: "nova", goto: "dash-l" },
  { id: "bbedit", name: "BBEdit", bundle: "BBEdit.app", cli: "bbedit", goto: "plus" },
];

export interface InstalledEditor extends EditorDef {
  /** The bundle on disk, when there is one. */
  appPath: string | null;
  /** A launcher that takes a line number, when there is one. */
  cliPath: string | null;
}

/** What the probe can see; injectable so tests need no editors installed. */
export interface Probe {
  appDirs: string[];
  pathDirs: string[];
  exists: (p: string) => boolean;
  executable: (p: string) => boolean;
}

export function defaultProbe(): Probe {
  return {
    appDirs: process.platform === "darwin" ? ["/Applications", join(homedir(), "Applications")] : [],
    pathDirs: (process.env.PATH ?? "").split(delimiter).filter(Boolean),
    exists: (p) => existsSync(p),
    executable: (p) => {
      try {
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function installedEditors(probe: Probe = defaultProbe()): InstalledEditor[] {
  const out: InstalledEditor[] = [];
  for (const e of EDITORS) {
    const appPath = probe.appDirs.map((d) => join(d, e.bundle)).find((p) => probe.exists(p)) ?? null;
    const onPath = probe.pathDirs.map((d) => join(d, e.cli)).find((p) => probe.executable(p)) ?? null;
    const inBundle = appPath && e.bundleCli && probe.executable(join(appPath, e.bundleCli)) ? join(appPath, e.bundleCli) : null;
    const cliPath = onPath ?? inBundle;
    if (appPath || cliPath) out.push({ ...e, appPath, cliPath });
  }
  return out;
}

/* ------------------------------------------------------------ preference */

const FILE = () => join(config.dataDir, "apps.json");

function readPrefs(): { editor?: string } {
  try {
    return JSON.parse(readFileSync(FILE(), "utf8")) as { editor?: string };
  } catch {
    return {};
  }
}

export function setEditor(id: string | null): void {
  if (id !== null && !EDITORS.some((e) => e.id === id)) throw new Error(`Unknown editor "${id}".`);
  const prefs = readPrefs();
  if (id === null) delete prefs.editor;
  else prefs.editor = id;
  writeFileSync(FILE(), JSON.stringify(prefs, null, 2) + "\n");
}

export interface AppsStatus {
  /** The editor Enio will use, or null. */
  editor: { id: string; name: string } | null;
  /** How it was arrived at: chosen in Settings, the only one found, several found and none chosen, none found. */
  choice: "set" | "detected" | "ambiguous" | "none";
  editors: Array<{ id: string; name: string; installed: boolean }>;
}

/** The editor in effect: the saved choice while it is still installed, else
 *  the only one installed, else nothing -- several found is a question for
 *  the person, not a guess. */
export function effectiveEditor(probe?: Probe): { editor: InstalledEditor | null; choice: AppsStatus["choice"] } {
  const installed = installedEditors(probe);
  const stored = readPrefs().editor;
  const chosen = stored ? installed.find((e) => e.id === stored) : undefined;
  if (chosen) return { editor: chosen, choice: "set" };
  if (installed.length === 1) return { editor: installed[0]!, choice: "detected" };
  return { editor: null, choice: installed.length === 0 ? "none" : "ambiguous" };
}

export function appsStatus(probe?: Probe): AppsStatus {
  const installed = installedEditors(probe);
  const { editor, choice } = effectiveEditor(probe);
  return {
    editor: editor ? { id: editor.id, name: editor.name } : null,
    choice,
    editors: EDITORS.map((e) => ({ id: e.id, name: e.name, installed: installed.some((i) => i.id === e.id) })),
  };
}

/* --------------------------------------------------------------- opening */

/** The command that opens `path` in `editor`, at `line` when the editor's
 *  launcher can take one. Without a launcher, macOS `open -a` opens the
 *  path in the bundle, line ignored. Pure, so it is testable per editor. */
export function editorCommand(editor: InstalledEditor, path: string, line?: number): { bin: string; args: string[] } | null {
  if (editor.cliPath) {
    const at = line && line > 0 ? line : null;
    switch (editor.goto) {
      case "dash-g":
        return { bin: editor.cliPath, args: at ? ["-g", `${path}:${at}`] : [path] };
      case "colon":
        return { bin: editor.cliPath, args: [at ? `${path}:${at}` : path] };
      case "dash-l":
        return { bin: editor.cliPath, args: at ? ["-l", String(at), path] : [path] };
      case "plus":
        return { bin: editor.cliPath, args: at ? [`+${at}`, path] : [path] };
    }
  }
  if (editor.appPath && process.platform === "darwin") return { bin: "open", args: ["-a", editor.appPath, path] };
  return null;
}

/** Open an already-resolved path. The caller resolves it: only paths the
 *  person attached or Enio wrote ever get here (safePath), never a string
 *  from the model or a client straight to the shell. */
export function openInEditor(
  absPath: string,
  opts: { line?: number; editorId?: string | null; probe?: Probe; launch?: (bin: string, args: string[]) => void } = {},
): { ok: true; editor: { id: string; name: string } } | { ok: false; reason: string } {
  const installed = installedEditors(opts.probe);
  const editor = opts.editorId ? (installed.find((e) => e.id === opts.editorId) ?? null) : effectiveEditor(opts.probe).editor;
  if (!editor) {
    const named = opts.editorId ? EDITORS.find((e) => e.id === opts.editorId)?.name : null;
    return {
      ok: false,
      reason: named
        ? `${named} is not installed.`
        : installed.length === 0
          ? "No code editor was found. Enio looks for Cursor, Visual Studio Code, VSCodium, Zed, Sublime Text, Nova and BBEdit."
          : "Several editors are installed and none is chosen — pick one under Settings.",
    };
  }
  const cmd = editorCommand(editor, absPath, opts.line);
  if (!cmd) return { ok: false, reason: `${editor.name} has no launcher Enio can call.` };
  const launch =
    opts.launch ??
    ((bin: string, args: string[]) => {
      const child = spawn(bin, args, { detached: true, stdio: "ignore" });
      child.on("error", () => {
        /* The reply already said what was attempted; a launcher that fails is Settings' business. */
      });
      child.unref();
    });
  launch(cmd.bin, cmd.args);
  return { ok: true, editor: { id: editor.id, name: editor.name } };
}

/* -------------------------------------------------------------- the phrase */

/** The editor words a person uses, mapped to ids. "editor" means the one in effect. */
const EDITOR_WORDS: Array<[RegExp, string | null]> = [
  [/^(?:my )?(?:code )?editor$/i, null],
  [/^(?:vs ?code|visual studio code|code)$/i, "vscode"],
  [/^cursor$/i, "cursor"],
  [/^(?:vs ?codium|codium)$/i, "codium"],
  [/^zed$/i, "zed"],
  [/^sublime(?: text)?$/i, "sublime"],
  [/^nova$/i, "nova"],
  [/^bbedit$/i, "bbedit"],
];

export interface EditorRequest {
  /** "project" for the open project's folder, else the path as typed. */
  target: "project" | string;
  /** An editor id, or null for the one in effect. */
  editor: string | null;
}

/** "open the project in cursor", "open src/app.js in my editor": a request
 *  to hand a path to an editor, resolved by grammar before the model sees
 *  it -- the same species as `open <app>`. Null when it is not that. */
export function editorRequest(text: string): EditorRequest | null {
  const t = text.trim();
  if (t.length === 0 || t.length > 160) return null;
  const m = /^(?:please\s+)?(?:can you\s+|could you\s+)?open\s+(?:the\s+|this\s+)?(.+?)\s+(?:in|with)\s+(?:my\s+)?([a-z .]+?)\s*[.!?]?$/i.exec(t);
  if (!m) return null;
  const word = m[2]!.trim();
  const hit = EDITOR_WORDS.find(([re]) => re.test(word));
  if (!hit) return null;
  const what = m[1]!.trim();
  const target = /^(?:current\s+)?project(?:\s+folder)?$/i.test(what) ? "project" : what.replace(/^["'`]|["'`]$/g, "");
  return { target, editor: hit[1] };
}
