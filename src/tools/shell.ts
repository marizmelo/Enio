import { spawn } from "node:child_process";
import { config } from "../config.js";
import { shellFor } from "../platform.js";
import { baseAllowedCommands, checkCommandAgainst, invokedExecutables } from "./allowlist.js";
import { activeProject } from "../project.js";
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

// The allowlist itself lives in allowlist.ts (a leaf, so project.ts can
// validate a saved verify command without importing this module); this adds
// the desktop set and the bypass, which are run-time postures.
function allowedCommands(): Set<string> {
  // Desktop control is mostly shell commands the allowlist would otherwise
  // refuse -- osascript, screencapture, open, shortcuts, mdfind, the
  // clipboard. Withheld until ENIO_DESKTOP=1 because osascript can do anything
  // the user can, which is the whole reason the flag exists.
  const desktopCommands = desktopEnabled() ? DESKTOP_COMMANDS : [];
  return new Set([...baseAllowedCommands(), ...desktopCommands]);
}

const bypass = () => process.env.ENIO_ALLOW_ANY_COMMAND === "1";

export { invokedExecutables };

export function checkCommand(command: string): { ok: true } | { ok: false; reason: string } {
  if (bypass()) return { ok: true };
  return checkCommandAgainst(command, allowedCommands());
}

/**
 * Where a command runs. With no project open: the workspace, as always.
 * With one open: the named attachment when `in` is given (a closed list --
 * the aliases the overlay and list_dir already show), else the sole
 * attached folder when there is exactly one (the common case needs no
 * parameter), else the project's out dir. Never a path -- an alias that is
 * not there errors, where a path would quietly run somewhere else.
 */
function commandCwd(inAlias: string): { cwd: string } | { error: string } {
  const active = activeProject();
  if (!active) {
    if (inAlias) return { error: `No project is open, so "in" has no meaning here.` };
    return { cwd: config.workspace };
  }
  const folders = active.attachments.filter((a) => a.kind === "folder");
  if (inAlias) {
    const mount = folders.find((a) => a.alias === inAlias);
    if (!mount) {
      const known = folders.map((a) => a.alias).join(", ") || "none";
      return { error: `No attached folder named "${inAlias}". Attached folders: ${known}.` };
    }
    return { cwd: mount.path };
  }
  if (folders.length === 1) return { cwd: folders[0]!.path };
  return { cwd: active.outDir };
}

export const shellTools: ToolDef[] = [
  {
    name: "run_command",
    description:
      "Run a shell command inside the working folder. Use this for builds, tests, git, and inspecting code. Returns combined stdout and stderr.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        in: {
          type: "string",
          description:
            "Optional: name of an attached project folder to run in. Omit to use the default working folder.",
        },
      },
      required: ["command"],
    },
    async run(args) {
      const command = String(args.command ?? "").trim();
      if (!command) return "Error: no command given.";

      const check = checkCommand(command);
      if (!check.ok) {
        // A refused mkdir/touch/rm is the model reaching for the shell to do
        // what the file tools already do -- and the bare refusal taught it
        // the filesystem was off-limits: it then wrote 7,000 characters of
        // code INTO THE REPLY rather than into files, for three turns. So
        // the refusal says what to use instead. write_file creates parent
        // directories itself; that fact is the one that was missing.
        const exe = invokedExecutables(command)[0] ?? "";
        const redirect =
          exe === "mkdir" || exe === "touch"
            ? " Use write_file instead: it creates the file AND any missing parent folders in one call."
            : exe === "rm" || exe === "mv" || exe === "cp"
              ? " Files are managed with write_file and edit_file; there is no delete or move tool."
              : "";
        return `Refused: ${check.reason}${redirect}`;
      }

      const where = commandCwd(String(args.in ?? "").trim());
      if ("error" in where) return `Refused: ${where.error}`;

      return await new Promise<string>((resolveRun) => {
        const shell = shellFor(command);
        const child = spawn(shell.file, shell.args, {
          cwd: where.cwd,
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
