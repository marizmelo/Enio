import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config.js";

/**
 * The avatar file: which GLB the desktop's face is, and where it came from.
 *
 * The model file is never committed or bundled -- the largest tracked file
 * in this repo is 400 KB and the default head is tens of megabytes -- so it
 * lives in the data dir as a downloaded default or a file the user brought
 * (an Avaturn export is theirs to use, not ours to ship). Resolution is
 * evaluated on every call rather than cached: `enio avatar use` must show
 * in the running app without a restart.
 *
 * Only a real glTF binary is ever served. A file named .glb that is an
 * HTML error page would reach the renderer's loader and fail there with a
 * parse error nobody can act on; twelve bytes of header check cost nothing.
 */

export const BODIES = ["M", "F"] as const;
export type Body = (typeof BODIES)[number];
export type AvatarSource = "custom" | "default";

export interface AvatarStatus {
  installed: boolean;
  source: AvatarSource | null;
  body: Body;
  bytes: number;
  path: string | null;
  /** Each candidate's presence, so a status line can say what remove would do. */
  custom: boolean;
  default: boolean;
}

const CUSTOM = "custom.glb";
const DEFAULT = "default.glb";
const META = "avatar.json";

export function avatarDir(): string {
  return join(config.dataDir, "avatar");
}

/** glTF binary: magic "glTF" then container version 2. */
export function isGlb(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const header = Buffer.alloc(12);
    if (readSync(fd, header, 0, 12, 0) < 12) return false;
    return header.toString("latin1", 0, 4) === "glTF" && header.readUInt32LE(4) === 2;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function usable(path: string): boolean {
  try {
    return statSync(path).isFile() && isGlb(path);
  } catch {
    return false;
  }
}

let warnedEnv = false;

/** ENIO_AVATAR, then the file the user brought, then the downloaded default. */
export function resolveAvatarFile(): { path: string; source: AvatarSource } | null {
  const explicit = config.avatarPath;
  if (explicit) {
    if (usable(explicit)) return { path: explicit, source: "custom" };
    if (!warnedEnv) {
      warnedEnv = true;
      console.error(`[avatar] ENIO_AVATAR points at ${explicit}, which is not a readable GLB; using the data dir instead.`);
    }
  }
  const custom = join(avatarDir(), CUSTOM);
  if (usable(custom)) return { path: custom, source: "custom" };
  const fallback = join(avatarDir(), DEFAULT);
  if (usable(fallback)) return { path: fallback, source: "default" };
  return null;
}

interface Meta {
  body?: unknown;
  version?: unknown;
  sha256?: unknown;
}

function readMeta(): Meta {
  try {
    return JSON.parse(readFileSync(join(avatarDir(), META), "utf8")) as Meta;
  } catch {
    return {};
  }
}

function writeMeta(meta: Meta): void {
  mkdirSync(avatarDir(), { recursive: true });
  writeFileSync(join(avatarDir(), META), `${JSON.stringify(meta, null, 2)}\n`);
}

/** Male unless the sidecar says F: the body form only steers the library's
 *  idle poses, so an absent or unreadable sidecar is a default, not an error. */
export function avatarBody(): Body {
  return readMeta().body === "F" ? "F" : "M";
}

export function avatarStatus(): AvatarStatus {
  const file = resolveAvatarFile();
  let bytes = 0;
  if (file) {
    try {
      bytes = statSync(file.path).size;
    } catch {
      bytes = 0;
    }
  }
  return {
    installed: file !== null,
    source: file?.source ?? null,
    body: avatarBody(),
    bytes,
    path: file?.path ?? null,
    custom: usable(join(avatarDir(), CUSTOM)),
    default: usable(join(avatarDir(), DEFAULT)),
  };
}

export function avatarInstalled(): boolean {
  return resolveAvatarFile() !== null;
}

/** Copy a GLB the user chose into place. Validated first, written to a
 *  temp name in the same directory and renamed, so a half-copied file is
 *  never what the route serves. */
export function useAvatarFile(src: string): AvatarStatus {
  const abs = resolve(src);
  if (!usable(abs)) throw new Error(`${src} is not a GLB file (glTF binary, version 2).`);
  mkdirSync(avatarDir(), { recursive: true });
  const tmp = join(avatarDir(), `.custom-${process.pid}.part`);
  copyFileSync(abs, tmp);
  renameSync(tmp, join(avatarDir(), CUSTOM));
  return avatarStatus();
}

export function setAvatarBody(body: string): AvatarStatus {
  if (!(BODIES as readonly string[]).includes(body)) {
    throw new Error(`Body must be one of: ${BODIES.join(", ")}.`);
  }
  writeMeta({ ...readMeta(), body });
  return avatarStatus();
}

export function removeAvatar(which: AvatarSource = "custom"): AvatarStatus {
  try {
    unlinkSync(join(avatarDir(), which === "custom" ? CUSTOM : DEFAULT));
  } catch {
    // Already absent is the state asked for.
  }
  return avatarStatus();
}
