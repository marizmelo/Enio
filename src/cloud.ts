import { execFile, spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

/**
 * Sending a packaged handoff to a frontier model.
 *
 * DECISIONS rejected wiring a frontier API key in as an automatic fallback:
 * "it would be quieter, and quiet is the problem, since data leaving the
 * machine is exactly the decision that must stay loud". That reasoning is
 * kept, and this does not contradict it -- what is rejected is the *quiet*
 * path, not the capability. Here a target is configured by hand, and every
 * send is a button the user presses on a payload they can read.
 *
 * The property that makes it safe is structural, not a promise: **no tool
 * reaches any of this**. The model packages the handoff, as it always did;
 * only a person can send it. So an escalation cannot be something the model
 * talks itself into, and a page it read cannot talk it into one either.
 *
 * A CLI target is the user's own installed agent, authenticated as
 * themselves; an API target is a key they entered. Both are listed the same
 * way because from here the difference is only how the bytes travel.
 */

/** Frontier CLIs worth detecting, and how each takes a one-shot prompt.
 *  A closed list: guessing at an unknown binary's flags would hang a send
 *  in an interactive prompt with no way to answer it. */
const CLI_TARGETS = [
  { id: "claude", label: "Claude Code", args: (p: string) => ["-p", p] },
  // -p is deprecated upstream in favour of the positional form.
  { id: "gemini", label: "Gemini CLI", args: (p: string) => [p] },
  { id: "codex", label: "Codex CLI", args: (p: string) => ["exec", p] },
] as const;

/** Providers reachable with a key, and how to ask them. */
const API_TARGETS = [
  {
    id: "anthropic",
    label: "Anthropic API",
    env: "ANTHROPIC_API_KEY",
    model: "claude-sonnet-4-5",
  },
  { id: "openai", label: "OpenAI API", env: "OPENAI_API_KEY", model: "gpt-4o" },
] as const;

export interface CloudTarget {
  id: string;
  label: string;
  kind: "cli" | "api";
  available: boolean;
  /** Version for a CLI, or whether a key is held. Never the key itself. */
  detail: string;
}

interface CloudSettings {
  /** Which target a send uses. Null means the handoff is copy-and-paste,
   *  which stays the default: nothing is configured until someone says so. */
  target: string | null;
  keys: Record<string, string>;
}

const FILE = () => join(config.dataDir, "cloud.json");

function read(): CloudSettings {
  try {
    const parsed = JSON.parse(readFileSync(FILE(), "utf8")) as Partial<CloudSettings>;
    return { target: parsed.target ?? null, keys: parsed.keys ?? {} };
  } catch {
    return { target: null, keys: {} };
  }
}

function write(settings: CloudSettings): void {
  writeFileSync(FILE(), JSON.stringify(settings, null, 2) + "\n");
  // Owner-only, like the browser state file: this holds a credential, and a
  // default-mode file in a shared home is a credential anyone can read.
  try {
    chmodSync(FILE(), 0o600);
  } catch {
    /* A filesystem without modes still stores the setting. */
  }
}

/** Is this executable on PATH, and what does it call itself? */
async function cliVersion(id: string): Promise<string | null> {
  try {
    await execFileAsync("which", [id], { timeout: 3000 });
  } catch {
    return null;
  }
  try {
    const { stdout } = await execFileAsync(id, ["--version"], { timeout: 8000 });
    return stdout.trim().split("\n")[0]!.slice(0, 60) || "installed";
  } catch {
    // On PATH but not answering --version is still on PATH.
    return "installed";
  }
}

/** Everything that could receive a handoff, and whether it currently can. */
export async function cloudTargets(): Promise<CloudTarget[]> {
  const settings = read();
  const clis = await Promise.all(
    CLI_TARGETS.map(async (t) => {
      const version = await cliVersion(t.id);
      return {
        id: t.id,
        label: t.label,
        kind: "cli" as const,
        available: version !== null,
        detail: version ?? "not installed",
      };
    }),
  );
  const apis = API_TARGETS.map((t) => {
    // The environment counts too: someone who already exports a key for
    // their own tooling should not have to paste it in again.
    const held = Boolean(settings.keys[t.id] || process.env[t.env]);
    return {
      id: t.id,
      label: t.label,
      kind: "api" as const,
      available: held,
      detail: held ? (settings.keys[t.id] ? "key saved" : `using ${t.env}`) : "no key",
    };
  });
  return [...clis, ...apis];
}

/** The chosen target, or null when sends are not set up. */
export function cloudTarget(): string | null {
  return read().target;
}

export function setCloudTarget(id: string | null): void {
  if (id !== null && !knownTarget(id)) throw new Error(`Unknown target "${id}".`);
  write({ ...read(), target: id });
}

/** Store or clear a key. Empty clears, so removing one needs no second verb. */
export function setCloudKey(provider: string, key: string): void {
  if (!API_TARGETS.some((t) => t.id === provider)) {
    throw new Error(`Unknown provider "${provider}".`);
  }
  const settings = read();
  const keys = { ...settings.keys };
  if (key.trim()) keys[provider] = key.trim();
  else delete keys[provider];
  // A target that just lost its key would fail on the next send with a
  // confusing error; unsetting it here makes the state honest instead.
  const target = settings.target === provider && !key.trim() ? null : settings.target;
  write({ target, keys });
}

function knownTarget(id: string): boolean {
  return CLI_TARGETS.some((t) => t.id === id) || API_TARGETS.some((t) => t.id === id);
}

function keyFor(provider: string): string | null {
  const settings = read();
  const fromEnv = API_TARGETS.find((t) => t.id === provider)?.env;
  return settings.keys[provider] || (fromEnv ? process.env[fromEnv] ?? null : null);
}

/**
 * Send a handoff and return what came back.
 *
 * Long by nature -- a frontier model working through a packaged task takes
 * minutes -- so the timeout is generous and the failure is reported rather
 * than thrown: a send that dies should read as "this did not work", not as a
 * broken app.
 */
export async function sendToCloud(
  text: string,
  onProgress?: (chunk: string) => void,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  const target = cloudTarget();
  if (!target) return { ok: false, error: "No cloud target is set up." };

  const cli = CLI_TARGETS.find((t) => t.id === target);
  if (cli) return await runCli(cli.id, cli.args(text), onProgress);

  const api = API_TARGETS.find((t) => t.id === target);
  if (!api) return { ok: false, error: `Unknown target "${target}".` };
  const key = keyFor(api.id);
  if (!key) return { ok: false, error: `No API key for ${api.label}.` };
  return await callApi(api, key, text);
}

function runCli(
  id: string,
  args: string[],
  onProgress?: (chunk: string) => void,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(id, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        resolve({ ok: false, error: `${id} took longer than 15 minutes and was stopped.` });
      },
      15 * 60_000,
    );
    child.stdout.on("data", (c: Buffer) => {
      const s = c.toString();
      out += s;
      onProgress?.(s);
    });
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Could not run ${id}: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve({ ok: true, output: out.trim() });
      else resolve({ ok: false, error: err.trim() || out.trim() || `${id} exited with code ${code}.` });
    });
  });
}

async function callApi(
  api: (typeof API_TARGETS)[number],
  key: string,
  text: string,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  try {
    const anthropic = api.id === "anthropic";
    const res = await fetch(
      anthropic ? "https://api.anthropic.com/v1/messages" : "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: anthropic
          ? {
              "Content-Type": "application/json",
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
            }
          : { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(
          anthropic
            ? { model: api.model, max_tokens: 8192, messages: [{ role: "user", content: text }] }
            : { model: api.model, messages: [{ role: "user", content: text }] },
        ),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // The key can appear in an error body; never hand one back verbatim.
      return { ok: false, error: `${api.label} returned ${res.status}. ${detail.slice(0, 200)}` };
    }
    const body = (await res.json()) as Record<string, unknown>;
    const output = anthropic
      ? ((body.content as Array<{ text?: string }> | undefined) ?? [])
          .map((c) => c.text ?? "")
          .join("")
      : ((body.choices as Array<{ message?: { content?: string } }> | undefined) ?? [])
          .map((c) => c.message?.content ?? "")
          .join("");
    return output.trim()
      ? { ok: true, output: output.trim() }
      : { ok: false, error: `${api.label} returned nothing.` };
  } catch (err) {
    return { ok: false, error: `Could not reach ${api.label}: ${(err as Error).message}` };
  }
}

/** Whether a handoff file exists to send — used to decide if the button shows. */
export function cloudConfigured(): boolean {
  return cloudTarget() !== null;
}

export { FILE as cloudSettingsFile };
