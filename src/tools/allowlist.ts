import { WINDOWS_COMMANDS, isWindows } from "../platform.js";

/**
 * The command allowlist, as a leaf.
 *
 * Split out of shell.ts so project.ts can validate a saved verify command
 * without importing the shell tool -- shell.ts imports project.ts (for the
 * active project's folders), and project.ts importing shell.ts back would
 * drag desktop.ts, plans.ts and vision.ts into the project module's graph.
 * Pure functions over a Set; shell.ts still owns the desktop additions and
 * the ENIO_ALLOW_ANY_COMMAND bypass.
 *
 * A denylist would be the easier thing to write and the wrong thing to ship:
 * you cannot enumerate every dangerous command, but you can enumerate the
 * useful safe ones.
 */

export const DEFAULT_ALLOWED = [
  "ls", "cat", "head", "tail", "wc", "find", "grep", "rg", "tree", "file", "stat",
  "echo", "pwd", "diff", "sort", "uniq", "cut", "sed", "awk",
  "git", "node", "npm", "npx", "pnpm", "yarn", "tsc", "python3", "pip3",
  "cargo", "go", "make", "jq", "curl",
];

/** Defaults plus the platform set plus ENIO_EXTRA_COMMANDS -- everything
 *  except the desktop commands, which are gated on ENIO_DESKTOP at run time
 *  and must not be accepted into a saved command on their strength. */
export function baseAllowedCommands(): Set<string> {
  const extra = (process.env.ENIO_EXTRA_COMMANDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const platformCommands = isWindows() ? WINDOWS_COMMANDS : [];
  return new Set([...DEFAULT_ALLOWED, ...platformCommands, ...extra]);
}

/** Extract the executables a shell line will actually invoke, across pipes,
 *  sequencing and substitution — not just the first word. */
export function invokedExecutables(command: string): string[] {
  const withoutStrings = command.replace(/'[^']*'|"[^"]*"/g, '""');
  return withoutStrings
    .split(/\||;|&&|\|\||\n/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      // Skip leading VAR=value assignments.
      const words = segment.split(/\s+/).filter(Boolean);
      const first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
      return (first ?? "").replace(/^.*\//, "");
    })
    .filter(Boolean);
}

/** The allowlist check against an explicit set. No bypass here: the bypass
 *  is a run-time posture, and a command being SAVED must pass on its own. */
export function checkCommandAgainst(
  command: string,
  allowed: Set<string>,
): { ok: true } | { ok: false; reason: string } {
  if (/\$\(|`/.test(command)) {
    return { ok: false, reason: "Command substitution is not permitted." };
  }
  // cmd.exe's %VAR% and delayed-expansion !VAR! are the same hazard.
  if (isWindows() && /%\w+%|![\w]+!/.test(command)) {
    return { ok: false, reason: "Variable expansion is not permitted." };
  }
  for (const exe of invokedExecutables(command)) {
    // Windows executables are case-insensitive and usually carry an extension.
    const normalised = isWindows()
      ? exe.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "")
      : exe;
    if (!allowed.has(normalised)) {
      return {
        ok: false,
        reason:
          `'${exe}' is not in the allowed command list. Allowed: ` +
          `${[...allowed].sort().join(", ")}.`,
      };
    }
  }
  return { ok: true };
}
