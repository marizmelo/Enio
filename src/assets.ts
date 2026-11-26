import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { config } from "./config.js";
import { activeProject, listProjects } from "./project.js";
import { getDb } from "./memory/db.js";
import { extractArtifacts } from "./artifacts.js";

/**
 * Assets: everything Enio creates, in one place, in the order it was made,
 * each one carrying what made it.
 *
 * Before this a created file landed in one of three places depending on how
 * the model happened to spell the path — the workspace root, a project's
 * hidden out/ dir, or an attached folder — and nothing recorded why it
 * existed. The only link from a file back to its reason was the
 * conversation's trace, and discarding the conversation deletes the trace.
 * A workspace became a flat pile of screen-1786307090790.png.
 *
 * The model here is one rule and one exception.
 *
 * The rule: a new file with no stated home goes into an asset folder under
 * <workspace>/assets, named by when it was made and what it is
 * (2026-11-25-1624-trails-sintra). One folder per turn, or per plan run, so
 * an app written as five files is one asset and not five. The folder sorts
 * by date in Finder with no app open.
 *
 * The exception: a file written into a folder the user attached stays
 * there, because attaching it was the instruction — "fix app.js" must edit
 * the repo, not a copy. What is recorded then is a pointer: an asset folder
 * holding only where the files went.
 *
 * Each folder carries its own origin in a sidecar (.asset.json): the
 * request that produced it, quoted; the agents that ran; the conversation
 * and project. It lives with the files rather than in the database on
 * purpose. The database's account of a conversation is deleted with the
 * conversation; this is the part that has to outlive it, and it is the
 * same choice the notes made — the files are the store, anything listed
 * from them is derived and rebuildable.
 *
 * "Why" is the person's own request, never a summary of it, and "what" is
 * read off the content (a document's first heading, an app's page title).
 * Nothing here is written by the model: a description is exactly the kind
 * of free generation a small model fills with things that are not there.
 *
 * The store sits inside the workspace so that nothing about the sandbox
 * changes: safePath's one boundary still contains every path below.
 */

export const ASSETS_DIR = "assets";
const SIDECAR = ".asset.json";
/** In a pointer asset, the visible half of the sidecar: Finder shows an
 *  otherwise empty folder, and an empty dated folder explains nothing. */
const POINTER = "LOCATION.txt";

export interface AssetOrigin {
  /** The folder's name: when it was made, then what it is. */
  id: string;
  createdAt: number;
  /** The words that led to it. For a plan or an automation, what was asked
   *  of the whole run. */
  request: string;
  agents: string[];
  source: "chat" | "plan" | "automation";
  /** The automation's name, when a saved one made this. */
  automation?: string;
  conversationId: string | null;
  /** Kept beside the id because the id stops resolving when the
   *  conversation is discarded, and this is what is left to show. */
  conversationTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  /** A pointer asset: the files are in a folder the user attached. */
  linkedTo?: { alias: string; path: string };
  links?: string[];
}

export type AssetMeta = Pick<AssetOrigin, "request" | "source" | "conversationId"> & {
  automation?: string;
  agent?: string | null;
};

/* ------------------------------------------------------------------ scope */

interface Scope {
  meta: AssetMeta;
  agents: string[];
  /** A run holds its scope across the turns inside it. */
  held: boolean;
  /** Chosen on the first new file and created when one is actually written. */
  folder: string | null;
  /** One pointer asset per attached folder written into. */
  pointers: Map<string, string>;
}

let scope: Scope | null = null;

const fresh = (meta: AssetMeta, held: boolean): Scope => ({
  meta,
  agents: meta.agent ? [meta.agent] : [],
  held,
  folder: null,
  pointers: new Map(),
});

/** A turn is starting. Inside a held run it joins the run's asset. */
export function enterAssetTurn(meta: AssetMeta): void {
  if (scope?.held) {
    noteAssetAgent(meta.agent ?? null);
    return;
  }
  scope = fresh(meta, false);
}

/** The turn is over. A held run keeps its scope until the run ends. */
export function leaveAssetTurn(): void {
  if (scope && !scope.held) scope = null;
}

/** A plan or automation run: every step's files are one asset. */
export function beginAssetRun(meta: AssetMeta): void {
  scope = fresh(meta, true);
}

export function endAssetRun(): void {
  scope = null;
}

/** Who is doing the work, once routing has said. */
export function noteAssetAgent(agent: string | null): void {
  if (!scope || !agent || scope.agents.includes(agent)) return;
  scope.agents.push(agent);
  for (const dir of [scope.folder, ...scope.pointers.values()]) {
    if (!dir) continue;
    const origin = readOrigin(dir);
    if (origin && !origin.agents.includes(agent)) writeOrigin(dir, { ...origin, agents: [...origin.agents, agent] });
  }
}

/** Whether a new file would become an asset right now. Outside a turn —
 *  a tool called directly — files go where they always went. */
export function assetScopeOpen(): boolean {
  return scope !== null;
}

/* ------------------------------------------------------------------ store */

export function assetsRoot(): string {
  return resolve(config.workspace, ASSETS_DIR);
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

function readOrigin(dir: string): AssetOrigin | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, SIDECAR), "utf8")) as Partial<AssetOrigin>;
    if (typeof parsed.createdAt !== "number") return null;
    return {
      id: basename(dir),
      createdAt: parsed.createdAt,
      request: String(parsed.request ?? ""),
      agents: Array.isArray(parsed.agents) ? parsed.agents.map(String) : [],
      source: parsed.source === "plan" || parsed.source === "automation" ? parsed.source : "chat",
      automation: typeof parsed.automation === "string" ? parsed.automation : undefined,
      conversationId: typeof parsed.conversationId === "string" ? parsed.conversationId : null,
      conversationTitle: typeof parsed.conversationTitle === "string" ? parsed.conversationTitle : null,
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : null,
      projectName: typeof parsed.projectName === "string" ? parsed.projectName : null,
      linkedTo:
        parsed.linkedTo && typeof parsed.linkedTo.path === "string"
          ? { alias: String(parsed.linkedTo.alias ?? ""), path: parsed.linkedTo.path }
          : undefined,
      links: Array.isArray(parsed.links) ? parsed.links.map(String) : undefined,
    };
  } catch {
    return null;
  }
}

function writeOrigin(dir: string, origin: AssetOrigin): void {
  const { id: _id, ...stored } = origin;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SIDECAR), JSON.stringify(stored, null, 2) + "\n", "utf8");
  if (origin.links) {
    writeFileSync(
      join(dir, POINTER),
      `These files were created in ${origin.linkedTo?.path ?? "an attached folder"}, not here:\n\n` +
        origin.links.map((l) => `  ${l}`).join("\n") +
        "\n",
      "utf8",
    );
  }
}

/** Local time, because the name is read by a person in Finder and "when I
 *  made it" is their clock, not UTC's. Sorts by date as text. */
function stamp(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

/** File names that say nothing about what the thing is. */
const GENERIC = new Set(["index", "main", "app", "readme", "style", "styles", "script", "untitled", "document", "notes", "file", "output", "draft", "screen"]);
const FILLER = new Set(["a", "an", "the", "me", "my", "for", "to", "of", "and", "in", "on", "with", "please", "can", "you", "it", "as", "that", "this", "up"]);

/** What to call the folder: the subfolder the model chose, else the file's
 *  own name, else — when that name is "index" or "screen-1786…" — the first
 *  telling words of the request. */
function slugFor(firstPath: string, request: string): string {
  const segments = firstPath.split(/[\\/]+/).filter(Boolean);
  if (segments.length > 1) {
    const top = slugify(segments[0]!);
    if (top) return top;
  }
  const stem = slugify(basename(firstPath, extname(firstPath)).replace(/-?\d{6,}$/, ""));
  if (stem && !GENERIC.has(stem)) return stem;
  const words = request
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !FILLER.has(w))
    .slice(0, 5)
    .join("-");
  return slugify(words) || stem || "asset";
}

function unusedFolder(slug: string): string {
  const root = assetsRoot();
  const base = `${stamp()}-${slug}`;
  let name = base;
  for (let n = 2; existsSync(join(root, name)); n++) name = `${base}-${n}`;
  return join(root, name);
}

function conversationTitle(id: string | null, request: string): string | null {
  if (!id) return null;
  try {
    const row = getDb()
      .prepare(`SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY ts ASC LIMIT 1`)
      .get(id) as { content: string } | undefined;
    // The first message is the conversation's title everywhere else. On the
    // turn that opens a conversation it is not stored yet, and it is this
    // request.
    return (row?.content ?? request).replace(/\s+/g, " ").trim().slice(0, 80);
  } catch {
    return request.replace(/\s+/g, " ").trim().slice(0, 80);
  }
}

function originFor(dir: string, extra: Partial<AssetOrigin> = {}): AssetOrigin {
  const s = scope!;
  const project = activeProject();
  return {
    id: basename(dir),
    createdAt: Date.now(),
    request: s.meta.request.replace(/\s+/g, " ").trim().slice(0, 500),
    agents: [...s.agents],
    source: s.meta.source,
    automation: s.meta.automation,
    conversationId: s.meta.conversationId,
    conversationTitle: conversationTitle(s.meta.conversationId, s.meta.request),
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    ...extra,
  };
}

/* ------------------------------------------------------------- resolution */

/** A path the model wrote with the store's own prefix: the path a tool
 *  printed, copied back. Null when it is not one. */
export function storePath(segments: string[]): string | null {
  if (segments[0] !== ASSETS_DIR) return null;
  const root = assetsRoot();
  const target = resolve(root, segments.slice(1).join(sep));
  if (!within(root, target)) throw new Error("Path escapes the assets folder.");
  return target;
}

/**
 * An existing file this path most plausibly means: one in the asset being
 * made right now, else one in an asset this same conversation made earlier,
 * newest first.
 *
 * This is what lets "now change the title in trails.md" work on the next
 * turn. The model was told the full path when it wrote the file and usually
 * copies it; when it does not, the bare name must still find the thing it
 * made rather than start a second one beside it.
 */
export function existingAssetFile(raw: string): string | null {
  if (!scope) return null;
  const tryIn = (dir: string): string | null => {
    const target = resolve(dir, raw);
    return within(dir, target) && target !== dir && existsSync(target) ? target : null;
  };
  if (scope.folder) {
    const here = tryIn(scope.folder);
    if (here) return here;
  }
  const conversation = scope.meta.conversationId;
  if (!conversation) return null;
  for (const origin of storeOrigins()) {
    if (origin.conversationId !== conversation || origin.links) continue;
    const found = tryIn(join(assetsRoot(), origin.id));
    if (found) return found;
  }
  return null;
}

/**
 * Where a new file with this relative path goes: inside the asset this turn
 * or run is making. Chooses the folder's name on first use and creates
 * nothing — resolving a path is not writing to it, and edit_file resolves a
 * path it may then refuse. The folder appears when assetFileWritten runs.
 */
export function plannedAssetFile(raw: string): string {
  if (!scope) throw new Error("No asset is being made.");
  if (!scope.folder) scope.folder = unusedFolder(slugFor(raw, scope.meta.request));
  const target = resolve(scope.folder, raw);
  if (!within(scope.folder, target) || target === scope.folder) {
    throw new Error("Path escapes the asset being made.");
  }
  return target;
}

/** A file was just written. If it is inside an asset folder that has no
 *  origin yet, this is the moment the asset exists. */
export function assetFileWritten(target: string): void {
  if (!scope?.folder || !within(scope.folder, target)) return;
  if (!existsSync(join(scope.folder, SIDECAR))) {
    writeOrigin(scope.folder, originFor(scope.folder));
    originCache = null;
  }
}

/**
 * A new file was created inside a folder the user attached. It stays there;
 * the store gets a pointer, so the timeline of what was made is complete
 * even for things that do not live in it. Only for files that did not
 * exist: editing the user's own file creates nothing.
 */
export function assetLinked(mount: { alias: string; path: string }, target: string): void {
  if (!scope) return;
  let dir = scope.pointers.get(mount.path);
  if (!dir) {
    dir = unusedFolder(slugify(`${mount.alias}-${slugFor(relative(mount.path, target), scope.meta.request)}`) || "linked");
    scope.pointers.set(mount.path, dir);
  }
  const prior = readOrigin(dir);
  const links = prior?.links ?? [];
  if (links.includes(target)) return;
  writeOrigin(dir, {
    ...(prior ?? originFor(dir)),
    linkedTo: { alias: mount.alias, path: mount.path },
    links: [...links, target],
  });
  originCache = null;
}

/**
 * Where a file the harness itself is about to write should go — a
 * screenshot, an email draft, a handoff. Unlike plannedAssetFile the folder
 * is created now, because the caller writes immediately and by its own
 * means. Outside a turn it is the workspace root, as before.
 */
export function placeNewFile(name: string): string {
  if (!scope) {
    mkdirSync(config.workspace, { recursive: true });
    return join(config.workspace, name);
  }
  const target = plannedAssetFile(name);
  mkdirSync(scope.folder!, { recursive: true });
  assetFileWritten(target);
  return target;
}

/* ---------------------------------------------------------------- listing */

let originCache: { at: number; origins: AssetOrigin[] } | null = null;

/** Every asset's origin, newest first. Cached against the store folder's
 *  own modification time, which changes when an asset is added or removed;
 *  changes to a sidecar go through this module and clear it. */
function storeOrigins(): AssetOrigin[] {
  const root = assetsRoot();
  let at = 0;
  try {
    at = statSync(root).mtimeMs;
  } catch {
    return [];
  }
  if (originCache && originCache.at === at) return originCache.origins;
  const origins: AssetOrigin[] = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith(".")) continue;
    const origin = readOrigin(join(root, name));
    if (origin) origins.push(origin);
  }
  origins.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  originCache = { at, origins };
  return origins;
}

export type AssetKind = "document" | "image" | "app" | "email" | "files" | "linked";

export interface AssetView {
  id: string;
  createdAt: number;
  title: string;
  kind: AssetKind;
  /** What it is, read off its content. Empty when nothing can be read. */
  description: string;
  /** Why it exists: the request, quoted. Empty for a file from before
   *  assets whose conversation is gone. */
  request: string;
  agents: string[];
  source: AssetOrigin["source"];
  automation: string | null;
  conversation: { id: string; title: string; exists: boolean } | null;
  project: { id: string; name: string } | null;
  /** Where it is on disk, for Show in Finder. */
  location: string;
  /** `path` is workspace-relative when the file is in the workspace, which
   *  is the form every viewer and tool accepts; absolute otherwise. */
  files: Array<{ path: string; bytes: number }>;
  bytes: number;
  /** The file to open first. */
  entry: string | null;
  /** Made before assets existed, listed where it sits. */
  legacy: boolean;
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
const DOCUMENT = /\.(md|markdown|txt|pdf|docx?|rtf)$/i;

function walk(dir: string, max = 200): string[] {
  const out: string[] = [];
  const visit = (d: string, depth: number) => {
    if (out.length >= max || depth > 6) return;
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(d, name);
      try {
        if (statSync(full).isDirectory()) visit(full, depth + 1);
        else out.push(full);
      } catch {
        /* vanished between readdir and stat */
      }
      if (out.length >= max) return;
    }
  };
  visit(dir, 0);
  return out;
}

const addressable = (abs: string): string => {
  const ws = resolve(config.workspace);
  return within(ws, abs) ? relative(ws, abs) : abs;
};

function sized(paths: string[]): Array<{ path: string; bytes: number }> {
  return paths.flatMap((p) => {
    try {
      return [{ path: addressable(p), bytes: statSync(p).size }];
    } catch {
      return [];
    }
  });
}

function head(path: string, bytes = 4096): string {
  try {
    return readFileSync(path, "utf8").slice(0, bytes);
  } catch {
    return "";
  }
}

/** The page a browser would open: index.html if there is one, else the
 *  only HTML file. */
function entryPage(files: string[]): string | null {
  const html = files.filter((f) => /\.html?$/i.test(f));
  return html.find((f) => /(^|\/)index\.html?$/i.test(f)) ?? (html.length === 1 ? html[0]! : null);
}

function describe(files: string[]): { kind: AssetKind; title: string | null; description: string; entry: string | null } {
  if (files.length === 0) return { kind: "files", title: null, description: "", entry: null };
  const page = entryPage(files);
  if (page) {
    const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(head(page))?.[1]?.trim() ?? null;
    const names = files.map((f) => basename(f));
    return {
      kind: "app",
      title,
      description: `${files.length} file${files.length === 1 ? "" : "s"}: ${names.slice(0, 6).join(", ")}${names.length > 6 ? "…" : ""}`,
      entry: page,
    };
  }
  const first = files[0]!;
  if (files.length === 1) {
    if (IMAGE.test(first)) return { kind: "image", title: null, description: "", entry: first };
    if (/\.eml$/i.test(first)) {
      const subject = /^Subject:\s*(.+)$/im.exec(head(first))?.[1]?.trim() ?? "";
      const to = /^To:\s*(.+)$/im.exec(head(first))?.[1]?.trim() ?? "";
      return { kind: "email", title: subject || null, description: to ? `Email draft to ${to}` : "Email draft", entry: first };
    }
    if (DOCUMENT.test(first)) {
      const text = /\.(md|markdown|txt)$/i.test(first) ? head(first) : "";
      const heading = /^#{1,3}\s+(.+)$/m.exec(text)?.[1]?.trim() ?? null;
      const line = text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith("#") && !/^[-=*_]{3,}$/.test(l));
      return { kind: "document", title: heading, description: (line ?? "").replace(/[*_`]/g, "").slice(0, 160), entry: first };
    }
  }
  const names = files.map((f) => basename(f));
  return {
    kind: files.every((f) => IMAGE.test(f)) ? "image" : "files",
    title: null,
    description: `${files.length} file${files.length === 1 ? "" : "s"}: ${names.slice(0, 6).join(", ")}${names.length > 6 ? "…" : ""}`,
    entry: files.find((f) => DOCUMENT.test(f)) ?? first,
  };
}

/** Folder name without its date: the readable half. */
const nameOf = (id: string): string => id.replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, "").replace(/-/g, " ");

function liveConversations(ids: Array<string | null>): Map<string, string> {
  const wanted = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const live = new Map<string, string>();
  if (wanted.length === 0) return live;
  try {
    const db = getDb();
    const first = db.prepare(
      `SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY ts ASC LIMIT 1`,
    );
    const exists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`);
    for (const id of wanted) {
      if (!exists.get(id)) continue;
      const row = first.get(id) as { content: string } | undefined;
      live.set(id, (row?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 80));
    }
  } catch {
    /* without the database every conversation reads as gone, which the
       saved title and request are there for */
  }
  return live;
}

/**
 * Everything Enio has made, newest first.
 *
 * Derived on every call from what is on disk. Assets with nothing left in
 * them are left out: a screenshot that failed after its folder was made is
 * not something anyone made.
 */
export function listAssets(limit = 300): AssetView[] {
  const origins = storeOrigins();
  const legacy = legacyFiles();
  const live = liveConversations([...origins.map((o) => o.conversationId), ...legacy.map((l) => l.origin?.sessionId ?? null)]);
  const views: AssetView[] = [];

  for (const origin of origins) {
    const dir = join(assetsRoot(), origin.id);
    const paths = origin.links ? origin.links.filter((l) => existsSync(l)) : walk(dir).filter((p) => basename(p) !== POINTER);
    if (paths.length === 0 && !origin.links) continue;
    const files = sized(paths);
    const d = describe(paths);
    views.push({
      id: origin.id,
      createdAt: origin.createdAt,
      title: d.title ?? (paths.length === 1 ? basename(paths[0]!) : nameOf(origin.id)),
      kind: origin.links ? "linked" : d.kind,
      description: origin.links
        ? paths.length === 0
          ? `Created in ${origin.linkedTo?.alias ?? "an attached folder"}; no longer there.`
          : `In ${origin.linkedTo?.alias ?? "an attached folder"}: ${d.description || basename(paths[0]!)}`
        : d.description,
      request: origin.request,
      agents: origin.agents,
      source: origin.source,
      automation: origin.automation ?? null,
      conversation: origin.conversationId
        ? {
            id: origin.conversationId,
            title: live.get(origin.conversationId) || origin.conversationTitle || "",
            exists: live.has(origin.conversationId),
          }
        : null,
      project: origin.projectId ? { id: origin.projectId, name: origin.projectName ?? "" } : null,
      location: origin.links ? (origin.linkedTo?.path ?? dir) : dir,
      files,
      bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      entry: d.entry ? addressable(d.entry) : null,
      legacy: false,
    });
  }

  for (const item of legacy) {
    const d = describe([item.path]);
    const files = sized([item.path]);
    const session = item.origin?.sessionId ?? null;
    views.push({
      id: `legacy:${item.path}`,
      createdAt: item.origin?.at ?? item.modified,
      title: d.title ?? basename(item.path),
      kind: d.kind,
      description: d.description,
      request: item.origin?.request ?? "",
      agents: item.origin?.agent ? [item.origin.agent] : [],
      source: "chat",
      automation: null,
      conversation: session ? { id: session, title: live.get(session) ?? "", exists: live.has(session) } : null,
      project: item.project,
      location: item.path,
      files,
      bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      entry: addressable(item.path),
      legacy: true,
    });
  }

  views.sort((a, b) => b.createdAt - a.createdAt);
  return views.slice(0, limit);
}

/** One asset, for the routes that act on it. */
export function getAssetOrigin(id: string): AssetOrigin | null {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith(".")) return null;
  const dir = join(assetsRoot(), id);
  return within(assetsRoot(), dir) ? readOrigin(dir) : null;
}

/**
 * Remove an asset. The folder goes, with everything in it. A pointer asset
 * loses only the pointer: the files it names are in a folder the user
 * attached, and nothing here deletes from one of those.
 */
export function removeAsset(id: string): boolean {
  const origin = getAssetOrigin(id);
  if (!origin) return false;
  rmSync(join(assetsRoot(), id), { recursive: true, force: true });
  originCache = null;
  return true;
}

/* ----------------------------------------------------------------- legacy */

interface LegacyFile {
  path: string;
  modified: number;
  project: { id: string; name: string } | null;
  origin: { request: string; agent: string; sessionId: string; at: number } | null;
}

/** Folders in the workspace root that are stores of their own. */
const NOT_ASSETS = new Set([ASSETS_DIR, "attachments", "library"]);

/**
 * Files made before assets existed, where they sit: the workspace root and
 * each project's out dir. Their origin is recovered from the traces while
 * the conversation that made them still exists — the same derivation a
 * restored conversation uses for its file chips — and is simply absent
 * once it does not. They are listed, never moved: a path someone's notes
 * or a saved automation already names keeps working.
 */
function legacyFiles(): LegacyFile[] {
  const found: LegacyFile[] = [];
  const take = (dir: string, project: LegacyFile["project"], skip: Set<string>) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || skip.has(name)) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isFile()) found.push({ path: full, modified: st.mtimeMs, project, origin: null });
      } catch {
        /* vanished */
      }
    }
  };
  take(resolve(config.workspace), null, NOT_ASSETS);
  try {
    for (const p of listProjects()) take(p.outDir, { id: p.id, name: p.name }, new Set());
  } catch {
    /* no projects, or an unreadable one: the workspace list still stands */
  }
  if (found.length === 0) return found;

  const byName = new Map<string, LegacyFile["origin"]>();
  try {
    const rows = getDb()
      .prepare(
        `SELECT s.name, s.output, t.question, t.specialist, t.session_id AS sessionId, t.started_at AS at
           FROM turn_steps s JOIN turns t ON t.id = s.turn_id
          WHERE s.name IN ('write_file', 'take_screenshot', 'send_email', 'handoff_saved')
          ORDER BY t.started_at ASC`,
      )
      .all() as Array<{ name: string; output: string | null; question: string; specialist: string; sessionId: string; at: number }>;
    for (const row of rows) {
      for (const made of extractArtifacts(row.name, row.output ?? "")) {
        if (!made.path) continue;
        // By name: the trace holds the path as the tool printed it, relative
        // to a root that depended on what was open at the time. Later rows
        // overwrite earlier ones, so a rewritten file is credited to the
        // turn that last wrote it.
        byName.set(basename(made.path), {
          request: row.question,
          agent: row.specialist,
          sessionId: row.sessionId,
          at: row.at,
        });
      }
    }
  } catch {
    /* no traces: listed without an origin */
  }
  for (const f of found) f.origin = byName.get(basename(f.path)) ?? null;
  return found;
}
