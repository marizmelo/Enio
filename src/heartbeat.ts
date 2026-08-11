import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb } from "./memory/db.js";
import { endSession, indexPending, startSession } from "./memory/store.js";
import { runTurn } from "./agent.js";
import { buildRegistry } from "./tools/index.js";
import { setMemorySession } from "./tools/memory.js";
import { complete } from "./model.js";
import type { Message } from "./types.js";

/**
 * Watches: "tell me if something changed", as opposed to tasks' "run this at
 * 9am".
 *
 * A task fires and delivers its output every time; the value of a watch is
 * mostly in staying quiet. The daemon checks the whole watch list on one
 * heartbeat, and a check that found nothing new ends silently — no
 * notification, no output, just a timestamp. The pattern is borrowed from
 * OpenClaw's heartbeat, with its one model-facing judgement transformed for a
 * small model: OpenClaw asks the agent to *decide* to reply HEARTBEAT_OK,
 * which is open generation resting on the model remembering an instruction.
 * Here the check turn just reports what it sees, and a second, separate call
 * answers a closed yes/no — "does the current report say anything the
 * previous one did not?" — which is classification, the thing this model
 * size is actually good at. The sentinel became a comparison.
 *
 * Each check runs through the ordinary turn path (router, specialists,
 * memory, tracing) for the same reason tasks do: a separate execution path
 * for automation would drift from the interactive one and rot.
 */

export interface Watch {
  id: number;
  prompt: string;
  enabled: boolean;
  createdAt: number;
  lastCheckedAt: number | null;
  lastReport: string | null;
  lastAlertedAt: number | null;
}

const now = () => Date.now();

export function addWatch(prompt: string): Watch {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("a watch needs something to watch");
  const inserted = getDb()
    .prepare(`INSERT INTO watches (prompt, created_at) VALUES (?, ?)`)
    .run(trimmed, now());
  return getWatch(Number(inserted.lastInsertRowid))!;
}

const ROW_TO_WATCH = `id, prompt, enabled, created_at AS createdAt,
  last_checked_at AS lastCheckedAt, last_report AS lastReport,
  last_alerted_at AS lastAlertedAt`;

function hydrate(row: Record<string, unknown> | undefined): Watch | null {
  if (!row) return null;
  return { ...row, enabled: row.enabled === 1 } as Watch;
}

export function getWatch(id: number): Watch | null {
  return hydrate(
    getDb().prepare(`SELECT ${ROW_TO_WATCH} FROM watches WHERE id = ?`).get(id) as never,
  );
}

export function listWatches(): Watch[] {
  return (
    getDb().prepare(`SELECT ${ROW_TO_WATCH} FROM watches ORDER BY id`).all() as Record<
      string,
      unknown
    >[]
  ).map((r) => hydrate(r)!);
}

export function removeWatch(id: number): boolean {
  return getDb().prepare(`DELETE FROM watches WHERE id = ?`).run(id).changes > 0;
}

/**
 * The closed comparison that replaces OpenClaw's HEARTBEAT_OK sentinel.
 *
 * Greedy, like the router, because it is a classification with one right
 * answer. The parse is deliberately loose — the first yes/no anywhere in the
 * answer — because small models pad ("Yes, the current report mentions...")
 * and a strict match would misread padding as failure.
 *
 * Errors and unparseable answers count as "new". A flaky comparison that
 * over-notifies is visible and annoying; one that under-notifies is a watch
 * that silently stopped watching, which is the worse failure because nothing
 * shows it happened.
 */
export async function isNewInformation(previous: string, current: string): Promise<boolean> {
  const messages: Message[] = [
    {
      role: "user",
      content:
        `Previous report:\n${previous}\n\n` +
        `Current report:\n${current}\n\n` +
        `Does the current report contain anything meaningfully new or different ` +
        `that the previous report did not? Ignore rewording. Answer with one word: yes or no.`,
    },
  ];
  try {
    const result = await complete(messages, [], {}, undefined, { temperature: 0 });
    const verdict = /\b(yes|no)\b/i.exec(result.content);
    return (verdict?.[1] ?? "yes").toLowerCase() === "yes";
  } catch {
    return true;
  }
}

const run = promisify(execFile);

/**
 * A macOS notification, and quietly nothing elsewhere. The report goes
 * through AppleScript string quoting because a watch's report contains
 * whatever the web said — a double quote in a headline must stay a headline.
 */
export async function notifyDesktop(title: string, body: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `display notification "${esc(body.slice(0, 180))}" with title "${esc(title.slice(0, 60))}"`;
  await run("osascript", ["-e", script], { timeout: 5000 }).catch(() => {
    /* no notification is a log line lost, not a failure */
  });
}

export interface HeartbeatResult {
  watch: Watch;
  report: string;
  alerted: boolean;
  error: string | null;
}

/**
 * Check every enabled watch once.
 *
 * The first check of a watch always alerts: the user just asked for it, and
 * "here is what it looks like now" both confirms the watch works and gives
 * the comparison a baseline. After that, only a report the comparison calls
 * new gets through. The last report is stored even when nothing was new, so
 * drift accumulates against the latest state rather than the last alert —
 * three small changes over three checks alert once each, not compound into
 * a false "no change".
 *
 * One watch failing must not stop the sweep: its error is recorded on the
 * result and the next watch runs.
 */
export async function runHeartbeat(
  onLog: (message: string) => void = () => {},
  notify: (title: string, body: string) => Promise<void> = notifyDesktop,
): Promise<HeartbeatResult[]> {
  const db = getDb();
  const results: HeartbeatResult[] = [];

  for (const watch of listWatches().filter((w) => w.enabled)) {
    onLog(`checking watch ${watch.id}: ${watch.prompt.slice(0, 60)}`);
    let report = "";
    let alerted = false;
    let error: string | null = null;

    try {
      const registry = await buildRegistry();
      const sessionId = startSession();
      setMemorySession(sessionId);
      const history: Message[] = [];
      const result = await runTurn(
        `Check the following and report what you find, briefly and factually. ` +
          `Only read; do not change anything. What to check: ${watch.prompt}`,
        history,
        registry,
        sessionId,
      );
      report = result.reply.trim();
      endSession(sessionId);
      await indexPending();

      const isNew =
        watch.lastReport === null ? true : await isNewInformation(watch.lastReport, report);

      if (isNew && report) {
        alerted = true;
        db.prepare(`INSERT INTO watch_alerts (watch_id, at, report) VALUES (?, ?, ?)`).run(
          watch.id,
          now(),
          report.slice(0, 20_000),
        );
        db.prepare(`UPDATE watches SET last_alerted_at = ? WHERE id = ?`).run(now(), watch.id);
        await notify(`enio — ${watch.prompt.slice(0, 50)}`, report);
        onLog(`  new: ${report.slice(0, 80)}`);
      } else {
        onLog(`  quiet`);
      }

      db.prepare(`UPDATE watches SET last_checked_at = ?, last_report = ? WHERE id = ?`).run(
        now(),
        report.slice(0, 20_000),
        watch.id,
      );
    } catch (err) {
      error = (err as Error).message;
      onLog(`  watch ${watch.id} failed: ${error}`);
    }

    results.push({ watch, report, alerted, error });
  }

  return results;
}

export interface WatchAlert {
  id: number;
  watchId: number;
  at: number;
  report: string;
}

export function recentAlerts(limit = 20): WatchAlert[] {
  return getDb()
    .prepare(
      `SELECT id, watch_id AS watchId, at, report
       FROM watch_alerts ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as WatchAlert[];
}
