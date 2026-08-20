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

/**
 * Commands that were started and left running.
 *
 * A web server is the case this exists for: it never exits, so the ordinary
 * path — run it, wait, capture output — spends the whole 60s timeout and then
 * SIGKILLs the thing you wanted to keep. That made "serve this and check it
 * works" impossible to express, which is why the coder could write a page and
 * never test it.
 *
 * Kept as a plain module map rather than a lifecycle the model manages: it
 * cannot list, inspect or stop these, because a small model given process
 * control will use it. What bounds them instead is structural — a hard cap
 * with the oldest evicted, and every child killed when enio exits (they stay
 * in this process group precisely so that works).
 */
const running = new Map<number, { command: string; output: string; startedAt: number }>();
const MAX_BACKGROUND = 3;

function stopBackground(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* Already gone: the point was that it is not running. */
  }
  running.delete(pid);
}

/** What is still running, for the CLI and for tests. */
export function backgroundCommands(): Array<{ pid: number; command: string; startedAt: number }> {
  return [...running.entries()].map(([pid, r]) => ({
    pid,
    command: r.command,
    startedAt: r.startedAt,
  }));
}

export function stopAllBackground(): void {
  for (const pid of [...running.keys()]) stopBackground(pid);
}

// Orphaned servers holding a port are the failure mode of this feature, so
// the exit path is wired once, at load, rather than left to callers.
for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, stopAllBackground);
}

/**
 * `python3 -m http.server` binds 0.0.0.0 — every folder it serves is on the
 * local network. The refusal names the exact flag rather than adding it
 * silently: what the user reads in the trace has to be what ran. Only this
 * one command is checked, because it is the one enio's own skill recommends
 * and the only common server that defaults to a public bind (vite, next and
 * `npx serve` all default to localhost).
 */
function refuseWideBind(command: string): string | null {
  if (!/\bhttp\.server\b/.test(command)) return null;
  if (/--bind[= ]\s*(127\.0\.0\.1|localhost|::1)/.test(command)) return null;
  return (
    "Refused: 'python3 -m http.server' listens on every network interface by default, " +
    "which would share that folder with the whole network. Add --bind 127.0.0.1."
  );
}

export const shellTools: ToolDef[] = [
  {
    name: "run_command",
    description:
      "Run a shell command inside the working folder. Use this for builds, tests, git, and inspecting code. Returns combined stdout and stderr. Set background true for a command that does not exit on its own, such as a web server — it keeps running so you can then curl it.",
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
        background: {
          type: "boolean",
          description:
            "Optional: true for a long-running command such as a web server. It starts, keeps running after this call, and returns its first output instead of waiting for it to finish.",
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

      if (args.background === true) {
        const wideBind = refuseWideBind(command);
        if (wideBind) return wideBind;
        return await startBackground(command, where.cwd);
      }

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

/**
 * Start a command and leave it running.
 *
 * Waits a beat before returning, which is the whole difference between a
 * useful result and a lie: a server that dies immediately — port already
 * taken, missing module, a typo — otherwise reports "started" and the model
 * spends the next call curling nothing. If it is dead by then, this returns
 * the failure exactly as the ordinary path would.
 */
async function startBackground(command: string, cwd: string): Promise<string> {
  // Oldest first, so a session that keeps starting servers replaces its own
  // rather than accumulating ports nobody remembers.
  while (running.size >= MAX_BACKGROUND) {
    const oldest = [...running.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (!oldest) break;
    stopBackground(oldest[0]);
  }

  const shell = shellFor(command);
  const child = spawn(shell.file, shell.args, {
    cwd,
    env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
  });

  const record = { command, output: "", startedAt: Date.now() };
  const capture = (chunk: Buffer) => {
    // A server that logs every request would otherwise grow without bound for
    // as long as it runs.
    if (record.output.length < 4000) record.output += chunk.toString();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  return await new Promise<string>((resolveRun) => {
    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      resolveRun(text);
    };

    child.on("error", (err) => finish(`Failed to start: ${err.message}`));
    child.on("close", (code) => {
      if (child.pid) running.delete(child.pid);
      finish(
        `Exited immediately with code ${code}. It is not running.\n` +
          (record.output.trim().slice(0, 2000) || "(no output)"),
      );
    });

    setTimeout(() => {
      if (settled || !child.pid) return;
      running.set(child.pid, record);
      finish(
        `Started in the background (pid ${child.pid}) and is still running. ` +
          `It keeps running after this call, so you can check it now — curl it, or ask the user to open it.\n` +
          (record.output.trim().slice(0, 1000) || "(no output yet)"),
      );
    }, config.backgroundSettleMs);
  });
}
