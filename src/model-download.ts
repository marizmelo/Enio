import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { catalogueModel } from "./model-catalogue.js";
import { venvPythonPath } from "./runtime.js";

/**
 * Fetching a model into the Hugging Face cache, with progress.
 *
 * One at a time, deliberately. Two concurrent multi-gigabyte downloads on a
 * laptop finish later than the same two in sequence and make both progress
 * bars lie about when either will be done. It also keeps the status a single
 * object a client can poll, rather than a collection it has to reconcile.
 *
 * State lives in this module rather than on disk: an interrupted download
 * resumes from the Hugging Face cache on the next attempt, so there is nothing
 * a restart needs to remember. What it must not do is *claim* a download is
 * still running after the process that owned it is gone, which is exactly what
 * persisting this would risk.
 */

export interface DownloadState {
  id: string;
  /** Bytes still to fetch when this started; 0 until the plan comes back. */
  total: number;
  done: number;
  status: "planning" | "downloading" | "complete" | "failed" | "cancelled";
  error?: string;
}

let current: (DownloadState & { child?: ChildProcess }) | null = null;

export function downloadState(): DownloadState | null {
  if (!current) return null;
  const { child: _child, ...rest } = current;
  return rest;
}

export function downloadScriptPath(): string {
  // Resolved from this module rather than from cwd: the agent is started from
  // the desktop app's directory as often as from the repo root.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "scripts", "hf_download.py");
}

export class DownloadRefused extends Error {}

/**
 * Start fetching a catalogued model. Returns once the process is spawned, not
 * once it finishes -- a 17GB download outlives any reasonable request.
 */
export function startDownload(id: string): DownloadState {
  if (!catalogueModel(id)) {
    // The closed list is the security boundary, not just a curation aid: this
    // id arrives in an HTTP body, and accepting an arbitrary one turns the
    // endpoint into "download anything to this machine".
    throw new DownloadRefused(`${id} is not in the model catalogue`);
  }
  if (current && (current.status === "planning" || current.status === "downloading")) {
    if (current.id === id) return downloadState()!;
    throw new DownloadRefused(`Already downloading ${current.id}`);
  }

  const python = venvPythonPath();
  if (!existsSync(python)) {
    throw new DownloadRefused(
      "No model runtime found. Run install.sh first — downloading uses its Python.",
    );
  }

  const state: DownloadState & { child?: ChildProcess } = {
    id,
    total: 0,
    done: 0,
    status: "planning",
  };
  current = state;

  const child = spawn(python, [downloadScriptPath(), id], { stdio: ["ignore", "pipe", "pipe"] });
  state.child = child;

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split("\n");
    // The last element is whatever arrived without a newline yet. Parsing it
    // would mean parsing half a JSON object on most chunk boundaries.
    stdout = lines.pop() ?? "";
    for (const line of lines) applyLine(state, line);
  });

  // Kept only to attach to a failure. The hub is chatty on stderr -- rate-limit
  // warnings, tqdm frames -- so it is never a signal on its own.
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  child.on("error", (err) => {
    if (current !== state) return;
    state.status = "failed";
    state.error = err.message;
  });

  child.on("close", (code) => {
    if (current !== state) return;
    if (state.status === "cancelled") return;
    if (state.status === "complete") return;
    state.status = "failed";
    state.error ??= code === null ? "Download stopped" : lastLine(stderr) || `exited ${code}`;
  });

  return downloadState()!;
}

export function cancelDownload(): boolean {
  if (!current || (current.status !== "planning" && current.status !== "downloading")) return false;
  current.status = "cancelled";
  current.child?.kill("SIGTERM");
  return true;
}

function applyLine(state: DownloadState, line: string): void {
  const text = line.trim();
  // Hub warnings and stray progress frames share this stream. Skipping
  // anything that is not an object keeps a chatty library version from
  // breaking the parse.
  if (!text.startsWith("{")) return;
  let event: { phase?: string; total?: number; done?: number; message?: string };
  try {
    event = JSON.parse(text);
  } catch {
    return;
  }
  switch (event.phase) {
    case "plan":
      state.total = Number(event.total) || 0;
      state.status = "downloading";
      break;
    case "progress":
      state.done = Number(event.done) || 0;
      break;
    case "done":
      state.done = state.total;
      state.status = "complete";
      break;
    case "error":
      state.status = "failed";
      state.error = event.message ?? "Download failed";
      break;
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter(Boolean);
  return lines[lines.length - 1] ?? "";
}
