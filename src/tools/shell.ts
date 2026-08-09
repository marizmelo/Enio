import { spawn } from "node:child_process";
import { config } from "../config.js";
import { WINDOWS_COMMANDS, isWindows, shellFor } from "../platform.js";
import { DESKTOP_COMMANDS, desktopEnabled } from "./desktop.js";
import type { ToolDef } from "../types.js";

/**
 * Shell access, deliberately constrained.
 *
 * Commands run with cwd pinned to the workspace and go through an explicit
 * allowlist of executables. A denylist would be the easier thing to write and
 * the wrong thing to ship: you cannot enumerate every dangerous command, but you
 * can enumerate the useful safe ones.
 *
 * Set ENIO_ALLOW_ANY_COMMAND=1 to bypass this. That is a genuinely different
 * risk posture — the model can then run anything your user account can, and this
 * model is small enough to be talked into things by content it reads in a file.
 */

const DEFAULT_ALLOWED = [
  "ls", "cat", "head", "tail", "wc", "find", "grep", "rg", "tree", "file", "stat",
  "echo", "pwd", "diff", "sort", "uniq", "cut", "sed", "awk",
  "git", "node", "npm", "npx", "pnpm", "yarn", "tsc", "python3", "pip3",
  "cargo", "go", "make", "jq", "curl",
];

function allowedCommands(): Set<string> {
  const extra = (process.env.ENIO_EXTRA_COMMANDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const platformCommands = isWindows() ? WINDOWS_COMMANDS : [];
  // Desktop control is mostly shell commands the allowlist would otherwise
  // refuse -- osascript, screencapture, open, shortcuts, mdfind, the
  // clipboard. Withheld until ENIO_DESKTOP=1 because osascript can do anything
  // the user can, which is the whole reason the flag exists.
  const desktopCommands = desktopEnabled() ? DESKTOP_COMMANDS : [];
  return new Set([...DEFAULT_ALLOWED, ...platformCommands, ...desktopCommands, ...extra]);
}

const bypass = () => process.env.ENIO_ALLOW_ANY_COMMAND === "1";

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

export function checkCommand(command: string): { ok: true } | { ok: false; reason: string } {
  if (bypass()) return { ok: true };
  if (/\$\(|`/.test(command)) {
    return { ok: false, reason: "Command substitution is not permitted." };
  }
  // cmd.exe's %VAR% and delayed-expansion !VAR! are the same hazard.
  if (isWindows() && /%\w+%|![\w]+!/.test(command)) {
    return { ok: false, reason: "Variable expansion is not permitted." };
  }
  const allowed = allowedCommands();
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

export const shellTools: ToolDef[] = [
  {
    name: "run_command",
    description:
      "Run a shell command inside the workspace directory. Use this for builds, tests, git, and inspecting code. Returns combined stdout and stderr.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
      },
      required: ["command"],
    },
    async run(args) {
      const command = String(args.command ?? "").trim();
      if (!command) return "Error: no command given.";

      const check = checkCommand(command);
      if (!check.ok) return `Refused: ${check.reason}`;

      return await new Promise<string>((resolveRun) => {
        const shell = shellFor(command);
        const child = spawn(shell.file, shell.args, {
          cwd: config.workspace,
          env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
        });

        let out = "";
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, config.shellTimeoutMs);

        const capture = (chunk: Buffer) => {
          if (out.length < config.maxToolOutputChars * 2) out += chunk.toString();
        };
        child.stdout.on("data", capture);
        child.stderr.on("data", capture);

        child.on("error", (err) => {
          clearTimeout(timer);
          resolveRun(`Failed to start: ${err.message}`);
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (killed) {
            resolveRun(
              `Timed out after ${config.shellTimeoutMs / 1000}s and was killed.\n` +
                out.slice(0, 2000),
            );
            return;
          }
          const body = out.trim() || "(no output)";
          resolveRun(code === 0 ? body : `exit ${code}\n${body}`);
        });
      });
    },
  },
];
