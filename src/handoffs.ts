import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";
import { safePath } from "./tools/fs.js";

/**
 * Running a handoff through a cloud agent the user already has.
 *
 * "Send to Claude" began as clipboard + open — pasting was the consent act
 * and the whole privacy story. Users asked for the errand to disappear:
 * run it inside enio, as a background job, answer comes back. The way to
 * do that WITHOUT enio holding API keys is the provider's own CLI agent
 * (claude, codex, gemini): already installed, already authenticated as the
 * user, billed to their own account. enio's part is spawning it and
 * catching stdout.
 *
 * Consent moved from the paste to the click, and the click is enough
 * because everything else is pinned: the payload is exactly the reviewed
 * handoff file, the runner is the user's own agent, and the flags below
 * force non-interactive, read-only runs — the CLI answers, it does not
 * act on the machine. Do not loosen those flags to make an agent "more
 * useful"; an agent that can act is a different feature with a different
 * consent surface.
 *
 * Nothing here persists. Like a model download, a run is owned by the
 * process that started it; a restart forgets the status, never the answer
 * file.
 */

export interface HandoffRun {
  id: string;
  provider: string;
  file: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  /** Workspace-relative path of the saved answer, once done. */
  answerFile?: string;
  error?: string;
}

export class HandoffRefused extends Error {}

/**
 * The agents this can drive — a closed list, one entry per verified CLI.
 * Args pin each one to its non-interactive, no-side-effects mode; the
 * prompt always arrives on stdin, because a handoff embeds documents and
 * argv is the wrong place for a page of text.
 *
 * These are external interfaces and they drift. When one breaks, the run
 * fails with the CLI's own stderr — degrade loudly, never guess flags.
 */
const AGENTS: Record<string, { name: string; bin: string; args: string[] }> = {
  claude: {
    name: "Claude",
    bin: "claude",
    // -p is print mode: headless, and tool permissions are denied rather
    // than prompted, so the run can only ever produce text.
    args: ["-p", "--output-format", "text"],
  },
  codex: {
    name: "Codex",
    bin: "codex",
    // "-" reads the prompt from stdin; read-only sandbox, and the repo
    // check skipped because the run's cwd is a scratch dir, not a repo.
    args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"],
  },
  gemini: {
    name: "Gemini",
    bin: "gemini",
    // Piped stdin is gemini's non-interactive mode; no flag needed.
    args: [],
  },
};

/**
 * Where a CLI might live. The server often runs with a launchd-sized PATH
 * (the desktop app spawned it), so PATH alone misses ~/.local/bin installs
 * and npm globals; the extras cover the observed homes without guessing.
 */
function findBin(bin: string): string | null {
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    dirname(process.execPath),
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const full = join(dir, bin);
    if (existsSync(full)) return full;
  }
  return null;
}

export interface AgentInfo {
  id: string;
  name: string;
  available: boolean;
}

export function availableAgents(): AgentInfo[] {
  return Object.entries(AGENTS).map(([id, a]) => ({
    id,
    name: a.name,
    available: findBin(a.bin) !== null,
  }));
}

export interface HandoffDeps {
  /** Overridden in tests: which binary an agent id resolves to. */
  resolve?: (id: string) => { bin: string; args: string[] } | null;
  timeoutMs?: number;
}

const runs = new Map<string, HandoffRun>();
const children = new Map<string, ReturnType<typeof spawn>>();
const MAX_RUNS_KEPT = 20;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export function listHandoffRuns(): HandoffRun[] {
  return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function handoffRun(id: string): HandoffRun | null {
  return runs.get(id) ?? null;
}

export function cancelHandoffRun(id: string): boolean {
  const child = children.get(id);
  const run = runs.get(id);
  if (!child || !run || run.status !== "running") return false;
  child.kill("SIGTERM");
  run.status = "failed";
  run.error = "cancelled";
  run.finishedAt = Date.now();
  return true;
}

export function startHandoffRun(
  file: string,
  provider: string,
  deps: HandoffDeps = {},
): HandoffRun {
  const agent = AGENTS[provider];
  const resolved = deps.resolve
    ? deps.resolve(provider)
    : agent
      ? (() => {
          const bin = findBin(agent.bin);
          return bin ? { bin, args: agent.args } : null;
        })()
      : null;
  if (!agent && !resolved) {
    throw new HandoffRefused(
      `Unknown agent "${provider}". Available: ${Object.keys(AGENTS).join(", ")}.`,
    );
  }
  if (!resolved) {
    throw new HandoffRefused(
      `The ${agent!.name} CLI is not installed — enio runs the agent you already have, it holds no API keys.`,
    );
  }

  const target = safePath(file);
  if (!existsSync(target)) throw new HandoffRefused(`No such file: ${file}`);
  const prompt = readFileSync(target);
  if (prompt.length === 0 || prompt.length > MAX_PROMPT_BYTES) {
    throw new HandoffRefused(`Refusing to send ${file}: empty or over 1MB.`);
  }
  for (const r of runs.values()) {
    if (r.status === "running" && r.file === file && r.provider === provider) {
      throw new HandoffRefused(`${agent?.name ?? provider} is already running on ${file}.`);
    }
  }

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const run: HandoffRun = {
    id,
    provider,
    file,
    status: "running",
    startedAt: Date.now(),
  };
  runs.set(id, run);
  // Oldest settled runs age out; a status map is not a history.
  const settled = listHandoffRuns().filter((r) => r.status !== "running");
  for (const old of settled.slice(MAX_RUNS_KEPT)) runs.delete(old.id);

  // cwd is enio's own data dir, not the workspace and not $HOME: the flags
  // already forbid writes, and a scratch cwd means even a misbehaving CLI
  // has nothing of the user's in reach as ".".
  //
  // The nesting markers are dropped from the env: when enio itself was
  // launched from inside a Claude Code session (development, mostly), the
  // child claude CLI sees them and behaves as a nested instance. The
  // user's auth variables pass through untouched.
  const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _ce, ...env } = process.env;
  const child = spawn(resolved.bin, resolved.args, {
    cwd: config.dataDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.set(id, child);

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => {
    if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString();
  });

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    run.status = "failed";
    run.error = "timed out";
    run.finishedAt = Date.now();
  }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  child.on("error", (err) => {
    clearTimeout(timeout);
    children.delete(id);
    if (run.status !== "running") return;
    run.status = "failed";
    run.error = err.message;
    run.finishedAt = Date.now();
  });

  child.on("close", (code) => {
    clearTimeout(timeout);
    children.delete(id);
    if (run.status !== "running") return; // timeout or cancel already spoke
    void (async () => {
      // An auth wall is not an answer. claude prints "Not logged in" to
      // stdout WITH exit 0, which would otherwise be saved as the reply;
      // gemini names its env vars on stderr. Short output plus sign-in
      // vocabulary is the tell, checked before the exit code so both
      // shapes land on the same actionable message.
      const combined = `${stdout}\n${stderr}`.trim();
      if (
        combined.length < 400 &&
        /not logged in|please run \/login|set an auth method|api key/i.test(combined)
      ) {
        run.status = "failed";
        run.error =
          `The ${AGENTS[provider]?.name ?? provider} CLI is not signed in. ` +
          `Open a terminal, run it once and sign in — enio uses your account, it has no keys of its own.`;
        run.finishedAt = Date.now();
        return;
      }
      if (code !== 0 || stdout.trim().length === 0) {
        run.status = "failed";
        run.error =
          stderr.trim().slice(0, 500) ||
          (code !== 0 ? `exited with code ${code}` : "the agent returned nothing");
        run.finishedAt = Date.now();
        return;
      }
      try {
        // answer-<topic>-<agent>.md beside the handoff. The prefix changes
        // so the reply's Send to detection does not offer to send an
        // answer back out again.
        const base = file
          .replace(/\.md$/i, "")
          .replace(/(^|\/)handoff-/, "$1answer-");
        let rel = `${base}-${provider}.md`;
        let out = safePath(rel);
        for (let n = 2; existsSync(out); n++) {
          rel = `${base}-${provider}-${n}.md`;
          out = safePath(rel);
        }
        await writeFile(out, stdout.trim() + "\n", "utf8");
        run.answerFile = rel;
        run.status = "done";
      } catch (err) {
        run.status = "failed";
        run.error = (err as Error).message;
      }
      run.finishedAt = Date.now();
    })();
  });

  child.stdin?.end(prompt);
  return { ...run };
}
