import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Is the built code older than the source it was built from?
 *
 * `dist/` is what actually runs, and a `git pull` updates `src/` without
 * touching it. On a second machine that pulled and relaunched, the app ran
 * last week's build for a day while every symptom pointed at the new code —
 * an hour of wrong debugging that a one-line warning would have prevented.
 * A check, never an automatic rebuild: building takes seconds but needs
 * node_modules in order, and a launcher that starts compiling is a launcher
 * that can hang on startup.
 */
export interface Staleness {
  stale: boolean;
  /** Newest source file's modification time, ms. */
  srcAt: number;
  /** The built entry point's modification time, ms; 0 when there is none. */
  distAt: number;
  newest: string;
}

function newestUnder(dir: string, exts: string[]): { at: number; file: string } {
  let best = { at: 0, file: "" };
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (exts.some((e) => entry.name.endsWith(e))) {
        const at = statSync(full).mtimeMs;
        if (at > best.at) best = { at, file: full };
      }
    }
  };
  try {
    walk(dir);
  } catch {
    /* No source tree: nothing can be stale relative to it. */
  }
  return best;
}

/** A minute of slack: a build finishes moments after the last edit, and a
 *  checkout's timestamps are whatever git gave them. */
const SLACK_MS = 60_000;

export function distStaleness(repoRoot: string): Staleness {
  const src = newestUnder(join(repoRoot, "src"), [".ts"]);
  let distAt = 0;
  try {
    distAt = statSync(join(repoRoot, "dist", "index.js")).mtimeMs;
  } catch {
    /* Not built at all: the launcher already refuses that case loudly. */
  }
  return {
    stale: distAt > 0 && src.at > distAt + SLACK_MS,
    srcAt: src.at,
    distAt,
    newest: src.file,
  };
}
