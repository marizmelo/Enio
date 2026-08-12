import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { config } from "./config.js";

/**
 * Projects: a contextual overlay, not a mode.
 *
 * A project is a name, a type, a description, capped instructions, and a list
 * of attached files and folders each carrying a one-line note saying what it
 * is for. Nothing here is coder-specific -- the router keeps routing, and the
 * overlay rides along with whichever specialist a turn lands on.
 *
 * Two properties are load-bearing and deliberate:
 *
 *  - **Only the user widens the sandbox.** No tool definition anywhere calls
 *    into this module. Creating a project, attaching a path and opening a
 *    project are user acts (CLI or authed HTTP), so the set of readable roots
 *    is something the user grants, never something the model talks itself
 *    into. This is the invariant DECISIONS.md records for opening a second
 *    root: consented per session, not a permanent allowlist.
 *
 *  - **Every always-loaded field is capped at save time and refused on
 *    overflow, never truncated.** The overlay enters the prompt on every
 *    project turn and the context budget follows the selected model
 *    (contextBudget()), so caps are sized for the *smallest* supported budget
 *    -- silently truncating instead would mean the user's instructions
 *    degrade exactly when they matter.
 *
 * Activation is process memory: a restart forgets the active project, and
 * reopening is a fresh user act. project.json persists the definition, not
 * the activation.
 */

export type ProjectType = "general" | "code" | "planning";
export const PROJECT_TYPES: readonly ProjectType[] = ["general", "code", "planning"];

/** Sized for the smallest supported context budget (2000 tokens), so the
 *  overlay stays a sliver of the prompt on any model. Exported for UI
 *  counters -- the desktop shows live remaining-characters from these. */
export const CAPS = {
  name: 60,
  description: 200,
  instructions: 600,
  note: 120,
} as const;

export interface Attachment {
  /** First path segment tools use to address this attachment. Deduped
   *  basename -- stable once assigned, recomputed only on detach/attach. */
  alias: string;
  /** Absolute, realpath-resolved at attach time. */
  path: string;
  kind: "file" | "folder";
  /** What this is for, in the user's words. Goes in the prompt overlay. */
  note: string;
  addedAt: number;
}

export interface Project {
  id: string;
  name: string;
  type: ProjectType;
  description: string;
  instructions: string;
  attachments: Attachment[];
  createdAt: number;
  lastOpenedAt: number;
  /** ~/.enio/projects/<id> -- project.json, skills/, index.db, out/. */
  dir: string;
  /** Where generated files land while this project is active, so they live
   *  and die with the project instead of piling into the global workspace. */
  outDir: string;
}

/** Aliases that would shadow paths the sandbox needs to keep meaning what
 *  they mean: "out" is the project's own output dir, "attachments" is where
 *  conversation attachments live in the global workspace fallback. */
const RESERVED_ALIASES = new Set(["out", "attachments"]);

export function projectsRoot(): string {
  return join(config.dataDir, "projects");
}

/* ------------------------------------------------------------- validation */

function checkCap(field: keyof typeof CAPS, value: string): void {
  if (value.length > CAPS[field]) {
    throw new Error(
      `${field} is ${value.length} characters; the cap is ${CAPS[field]}. ` +
        `This text loads into every turn's context, so shorten it -- it will not be truncated for you.`,
    );
  }
}

function checkType(type: string): asserts type is ProjectType {
  if (!PROJECT_TYPES.includes(type as ProjectType)) {
    throw new Error(`Unknown project type "${type}". One of: ${PROJECT_TYPES.join(", ")}.`);
  }
}

/**
 * Whether a path may be attached. Checked against the realpath so a symlink
 * cannot smuggle in what a plain path could not name.
 *
 * The refusals are the roots that would make "attached" meaningless: the
 * filesystem root and the home directory are "everything"; the data dir is
 * enio's own memory (attaching it would let a turn read the raw DB); any
 * ancestor of the data dir contains it; the workspace is already the
 * sandbox, so attaching it is a no-op asked confusingly.
 */
/** realpath when the path exists, plain resolve otherwise -- the guard must
 *  compare like with like on systems where /var is a symlink to /private/var,
 *  or a scratch workspace slips past its own refusal. */
function realish(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function assertAttachable(path: string): { real: string; kind: "file" | "folder" } {
  if (!existsSync(path)) throw new Error(`${path} does not exist.`);
  const real = realpathSync(path);
  const stat = statSync(real);
  const kind = stat.isDirectory() ? ("folder" as const) : ("file" as const);

  const dataDir = realish(config.dataDir);
  const home = realish(homedir());
  const workspace = realish(config.workspace);

  const isOrContains = (candidate: string, target: string) =>
    candidate === target || target.startsWith(candidate + sep);

  if (real === resolve("/")) throw new Error("Refusing to attach the filesystem root.");
  if (real === home) {
    throw new Error("Refusing to attach the home directory itself. Attach the specific folder instead.");
  }
  if (isOrContains(dataDir, real) || isOrContains(real, dataDir)) {
    throw new Error("Refusing to attach enio's own data directory (or anything containing it).");
  }
  if (real === workspace) {
    throw new Error("The workspace is already readable in every conversation; attaching it changes nothing.");
  }
  return { real, kind };
}

/* ------------------------------------------------------------ persistence */

interface StoredProject {
  id: string;
  name: string;
  type: ProjectType;
  description: string;
  instructions: string;
  attachments: Attachment[];
  createdAt: number;
  lastOpenedAt: number;
}

function projectDir(id: string): string {
  return join(projectsRoot(), id);
}

function hydrate(stored: StoredProject): Project {
  const dir = projectDir(stored.id);
  return { ...stored, dir, outDir: join(dir, "out") };
}

function persist(project: Project): void {
  const { dir, outDir, ...stored } = project;
  writeFileSync(join(dir, "project.json"), JSON.stringify(stored, null, 2) + "\n");
}

function load(id: string): Project {
  const file = join(projectDir(id), "project.json");
  if (!existsSync(file)) throw new Error(`No project with id ${id}.`);
  const stored = JSON.parse(readFileSync(file, "utf8")) as StoredProject;
  return hydrate(stored);
}

export function listProjects(): Project[] {
  const root = projectsRoot();
  if (!existsSync(root)) return [];
  const projects: Project[] = [];
  for (const entry of readdirSync(root)) {
    try {
      projects.push(load(entry));
    } catch {
      /* A stray dir without project.json is not a project. */
    }
  }
  return projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/** Look a project up by id or (case-insensitive) name -- the CLI addresses
 *  projects by name, the desktop by id. */
export function findProject(ref: string): Project | null {
  const root = projectsRoot();
  if (existsSync(join(root, ref, "project.json"))) return load(ref);
  const wanted = ref.trim().toLowerCase();
  return listProjects().find((p) => p.name.toLowerCase() === wanted) ?? null;
}

/* ------------------------------------------------------------------- crud */

export function createProject(input: {
  name: string;
  type?: string;
  description?: string;
}): Project {
  const name = input.name?.trim();
  if (!name) throw new Error("A project needs a name.");
  checkCap("name", name);
  const type = input.type ?? "general";
  checkType(type);
  const description = input.description?.trim() ?? "";
  checkCap("description", description);
  if (findProject(name)) throw new Error(`A project named "${name}" already exists.`);

  const id = randomUUID();
  const dir = projectDir(id);
  mkdirSync(join(dir, "skills"), { recursive: true });
  mkdirSync(join(dir, "out"), { recursive: true });

  const project = hydrate({
    id,
    name,
    type,
    description,
    instructions: "",
    attachments: [],
    createdAt: Date.now(),
    lastOpenedAt: 0,
  });
  persist(project);
  return project;
}

export function updateProject(
  id: string,
  patch: { name?: string; type?: string; description?: string; instructions?: string },
): Project {
  const project = load(id);
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("A project needs a name.");
    checkCap("name", name);
    const clash = findProject(name);
    if (clash && clash.id !== id) throw new Error(`A project named "${name}" already exists.`);
    project.name = name;
  }
  if (patch.type !== undefined) {
    checkType(patch.type);
    project.type = patch.type;
  }
  if (patch.description !== undefined) {
    const description = patch.description.trim();
    checkCap("description", description);
    project.description = description;
  }
  if (patch.instructions !== undefined) {
    const instructions = patch.instructions.trim();
    checkCap("instructions", instructions);
    project.instructions = instructions;
  }
  persist(project);
  if (active?.id === id) active = project;
  return project;
}

export function deleteProject(id: string): void {
  const dir = projectDir(id);
  if (!existsSync(join(dir, "project.json"))) throw new Error(`No project with id ${id}.`);
  if (active?.id === id) active = null;
  // Sessions tagged with this id keep their tag: the conversations are the
  // user's history, and the raw transcript remaining the source of truth
  // does not stop mattering because the project folder is gone.
  rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------ attachments */

function dedupedAlias(base: string, taken: Set<string>): string {
  // Basenames arrive as filesystem names; the alias is a path segment the
  // model will type back, so it must stay one segment and nothing fancier.
  const cleaned = base.replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "item";
  let alias = cleaned;
  for (let n = 2; taken.has(alias.toLowerCase()) || RESERVED_ALIASES.has(alias.toLowerCase()); n++) {
    alias = `${cleaned}-${n}`;
  }
  return alias;
}

export function attachPath(id: string, path: string, note = ""): Attachment {
  const project = load(id);
  const trimmedNote = note.trim();
  checkCap("note", trimmedNote);
  const { real, kind } = assertAttachable(resolve(path));
  if (project.attachments.some((a) => a.path === real)) {
    throw new Error(`${real} is already attached.`);
  }
  const taken = new Set(project.attachments.map((a) => a.alias.toLowerCase()));
  const attachment: Attachment = {
    alias: dedupedAlias(basename(real), taken),
    path: real,
    kind,
    note: trimmedNote,
    addedAt: Date.now(),
  };
  project.attachments.push(attachment);
  persist(project);
  if (active?.id === id) active = project;
  return attachment;
}

export function detachPath(id: string, alias: string): void {
  const project = load(id);
  const before = project.attachments.length;
  project.attachments = project.attachments.filter((a) => a.alias !== alias);
  if (project.attachments.length === before) {
    throw new Error(`No attachment named "${alias}".`);
  }
  persist(project);
  if (active?.id === id) active = project;
}

/* ------------------------------------------------------------- activation */

let active: Project | null = null;

export function activeProject(): Project | null {
  return active;
}

export function openProject(ref: string): Project {
  const project = findProject(ref);
  if (!project) throw new Error(`No project matches "${ref}".`);
  // The out dir can be missing on a project created by an older build or a
  // hand-copied project.json; recreate rather than fail the open.
  mkdirSync(project.outDir, { recursive: true });
  mkdirSync(join(project.dir, "skills"), { recursive: true });
  project.lastOpenedAt = Date.now();
  persist(project);
  active = project;
  return project;
}

export function closeProject(): void {
  active = null;
}

/** The directory unprefixed relative paths resolve against: the active
 *  project's out dir when one is open, the global workspace otherwise.
 *  Callers that must stay global (conversation attachments, email drafts,
 *  screenshots) read config.workspace directly and never this. */
export function activeOutRoot(): string {
  return active ? active.outDir : resolve(config.workspace);
}

/** The attachment a first path segment addresses, if any. */
export function findMount(segment: string): Attachment | null {
  if (!active) return null;
  return active.attachments.find((a) => a.alias === segment) ?? null;
}
