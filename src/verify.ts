import { existsSync, readFileSync, realpathSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { config } from "./config.js";
import { activeProject } from "./project.js";
import { checkCommand } from "./tools/shell.js";

/**
 * What to run after the coder edits code, and where.
 *
 * The coder's prompt has said "run the relevant test or build command after
 * a change" for as long as it has existed, and `run_command` had been called
 * zero times in twelve traced coder turns. The allowlist already held npm,
 * tsc, cargo, go and make -- the machinery was there; the judgement was not
 * happening. So the harness makes it: after a write in a coder turn, it runs
 * the project's verify command itself and the model sees the result. Same
 * move as the researcher's search seed, same reason.
 *
 * Detection is a closed list, first hit wins, and a package.json SETTLES the
 * ecosystem -- it does not fall through to Cargo or Go. Two traps recorded
 * from the first cut of this design: `pytest` is not on the allowlist (so the
 * Python command is `python3 -m pytest -q`), and `npm init -y` writes
 * `"test": "echo \"Error: no test specified\" && exit 1"`, which must read
 * as "no test script" or every fresh package fails verification by
 * construction.
 */

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function detectVerifyCommand(root: string): string | null {
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts = (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, unknown> })
        .scripts ?? {};
    } catch {
      // Unparseable package.json: treat as "no test script", which is true.
    }
    const test = typeof scripts.test === "string" ? scripts.test : "";
    if (test && !/no test specified/i.test(test)) return "npm test";
    if (existsSync(join(root, "tsconfig.json"))) return "npx tsc --noEmit";
    return null;
  }
  if (existsSync(join(root, "Cargo.toml"))) return "cargo check";
  if (existsSync(join(root, "go.mod"))) return "go build ./...";
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini"))) {
    return "python3 -m pytest -q";
  }
  return null;
}

/** Files whose edits are documents, not code: no build runs for them. */
const DOCUMENT_EXTS = new Set([".md", ".txt", ".markdown"]);

export type Verification =
  | { command: string; in?: string; cwd: string }
  | { refused: string }
  | null;

/**
 * For the files a turn just wrote: the command to run, and the attached
 * folder to run it in. Maps the first code file back to its attachment
 * (the same rule commandCwd follows: `in` is set only when there are
 * several folders, else the sole folder is the cwd), or to the project's
 * out dir; an unmapped path means nothing to verify. The project's own
 * verifyCommand wins over detection; either is checked against the
 * allowlist before being handed back, so the caller never pushes a call
 * the shell would refuse.
 */
export function verificationFor(editedAbs: string[]): Verification {
  const code = editedAbs.filter((p) => !DOCUMENT_EXTS.has(extname(p).toLowerCase()));
  if (code.length === 0) return null;

  const active = activeProject();
  let root: string;
  let inAlias: string | undefined;
  if (!active) {
    root = resolve(config.workspace);
  } else {
    const folders = active.attachments.filter((a) => a.kind === "folder");
    // Attachments store the realpath (so /var → /private/var on macOS); the
    // edited path must be compared in the same terms or nothing ever maps.
    let first: string;
    try {
      first = realpathSync(code[0]!);
    } catch {
      return null;
    }
    const owner = folders.find((a) => first === a.path || first.startsWith(a.path + sep));
    if (owner) {
      root = owner.path;
      if (folders.length > 1) inAlias = owner.alias;
    } else if (first.startsWith(safeReal(active.outDir) + sep)) {
      root = safeReal(active.outDir);
    } else {
      return null;
    }
  }

  const command = active?.verifyCommand || detectVerifyCommand(root);
  if (!command) return null;
  const check = checkCommand(command);
  if (!check.ok) return { refused: check.reason };
  return inAlias ? { command, in: inAlias, cwd: root } : { command, cwd: root };
}

/** run_command reports failure as a prefix, not as an Error: -- "exit 1\n…",
 *  "Timed out…", "Refused: …". This is what tells the notice (and only the
 *  notice) whether the run passed; the model sees the full text either way. */
export function verifyFailed(output: string): boolean {
  return /^(exit \d+|Timed out|Refused:|Failed to start|Error:)/.test(output);
}
