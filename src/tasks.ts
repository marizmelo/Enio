import { Cron } from "croner";
import { config } from "./config.js";
import { getDb } from "./memory/db.js";
import { endSession, indexPending, startSession } from "./memory/store.js";
import { runTurn } from "./agent.js";
import { buildRegistry } from "./tools/index.js";
import { setMemorySession } from "./tools/memory.js";
import { listWatches, runHeartbeat } from "./heartbeat.js";
import { listPipelines, runPipeline } from "./pipelines.js";
import type { Message } from "./types.js";

/**
 * Scheduled tasks.
 *
 * A task is a prompt OR a pipeline, plus a cron expression. A prompt task
 * goes through the ordinary turn path — same specialists, same memory, same
 * tracing — so a scheduled run is inspectable exactly like a conversation,
 * and anything it learns is remembered. A pipeline task calls runPipeline
 * directly: the trigger is deterministic, with no model and no router
 * between the clock and the graph the user built. That reuse is the entire
 * design: a separate execution path for automation would drift from the
 * interactive one and rot.
 */

export interface Task {
  id: number;
  name: string;
  prompt: string;
  pipeline: string | null;
  schedule: string;
  specialist: string | null;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
}

const now = () => Date.now();

/** Rejects a bad cron expression at creation time rather than at 3am. */
export function validateSchedule(schedule: string): { ok: true; next: Date } | { ok: false; reason: string } {
  try {
    const cron = new Cron(schedule, { paused: true });
    const next = cron.nextRun();
    cron.stop();
    if (!next) return { ok: false, reason: "that schedule will never fire" };
    return { ok: true, next };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export function addTask(input: {
  name: string;
  prompt?: string;
  pipeline?: string | null;
  schedule: string;
  specialist?: string | null;
}): Task {
  const name = input.name.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`invalid name "${name}" — lowercase letters, digits and hyphens only`);
  }
  const check = validateSchedule(input.schedule);
  if (!check.ok) throw new Error(`invalid schedule: ${check.reason}`);

  const prompt = input.prompt?.trim() ?? "";
  const pipeline = input.pipeline?.trim() || null;
  // Exactly one action. Both set is ambiguous about which runs; neither set
  // is a task that fires and does nothing, at 3am, silently.
  if (pipeline && prompt) throw new Error("a task takes a prompt or a pipeline, not both");
  if (!pipeline && !prompt) throw new Error("a task needs a prompt");
  if (pipeline && !listPipelines().some((p) => p.name === pipeline)) {
    throw new Error(`no pipeline named "${pipeline}" — save it in the pipeline builder first`);
  }

  getDb()
    .prepare(
      `INSERT INTO tasks (name, prompt, pipeline, schedule, specialist, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(name, prompt, pipeline, input.schedule, input.specialist ?? null, now());

  return getTask(name)!;
}

const ROW_TO_TASK = `id, name, prompt, pipeline, schedule, specialist, enabled,
  created_at AS createdAt, last_run_at AS lastRunAt,
  last_status AS lastStatus, last_error AS lastError`;

function hydrate(row: Record<string, unknown> | undefined): Task | null {
  if (!row) return null;
  return { ...row, enabled: row.enabled === 1 } as Task;
}

export function getTask(name: string): Task | null {
  return hydrate(
    getDb().prepare(`SELECT ${ROW_TO_TASK} FROM tasks WHERE name = ?`).get(name) as never,
  );
}

export function listTasks(): Task[] {
  return (getDb().prepare(`SELECT ${ROW_TO_TASK} FROM tasks ORDER BY name`).all() as Record<
    string,
    unknown
  >[]).map((r) => hydrate(r)!);
}

export function removeTask(name: string): boolean {
  return getDb().prepare(`DELETE FROM tasks WHERE name = ?`).run(name).changes > 0;
}

export function setTaskEnabled(name: string, enabled: boolean): boolean {
  return (
    getDb().prepare(`UPDATE tasks SET enabled = ? WHERE name = ?`).run(enabled ? 1 : 0, name)
      .changes > 0
  );
}

export interface TaskRun {
  id: number;
  startedAt: number;
  durationMs: number;
  status: string;
  output: string | null;
  error: string | null;
}

export function runsFor(name: string, limit = 10): TaskRun[] {
  return getDb()
    .prepare(
      `SELECT r.id, r.started_at AS startedAt, r.duration_ms AS durationMs,
              r.status, r.output, r.error
       FROM task_runs r JOIN tasks t ON t.id = r.task_id
       WHERE t.name = ? ORDER BY r.id DESC LIMIT ?`,
    )
    .all(name, limit) as TaskRun[];
}

/**
 * Executes a task once.
 *
 * Each run gets its own session, so its trace is self-contained and its
 * transcript is summarised into memory independently. Errors are recorded
 * rather than thrown: one failing task must not take down the daemon and with
 * it every other task.
 */
export async function runTask(
  task: Task,
  onLog: (message: string) => void = () => {},
): Promise<TaskRun> {
  const db = getDb();
  const startedAt = now();
  onLog(`running ${task.name}`);

  let status = "ok";
  let output: string | null = null;
  let error: string | null = null;

  try {
    const registry = await buildRegistry();

    if (task.pipeline) {
      // Deterministic trigger: the clock fires the graph directly. No model
      // decides whether to run it, no router picks who -- each node inside
      // still runs as an ordinary turn, so every gate holds.
      const pipeline = listPipelines().find((p) => p.name === task.pipeline);
      if (!pipeline) {
        throw new Error(`no pipeline named "${task.pipeline}" — was it deleted?`);
      }
      const lines: string[] = [];
      const run = await runPipeline(pipeline, registry, (event) => {
        if (event.type === "node_finished") {
          lines.push(`${event.nodeId}: ${event.reply.slice(0, 300).replace(/\s+/g, " ")}`);
        }
        if (event.type === "node_failed") {
          lines.push(`${event.nodeId} FAILED: ${event.error}`);
        }
      });
      output = lines.join("\n");
      if (run.status === "failed") throw new Error(output || "pipeline failed");
    } else {
      const sessionId = startSession();
      setMemorySession(sessionId);

      const history: Message[] = [];
      const result = await runTurn(
        task.prompt,
        history,
        registry,
        sessionId,
        {},
        // The pinned specialist was stored and then silently ignored for as
        // long as tasks existed; passing it through is the fix.
        task.specialist ? { specialist: task.specialist } : {},
      );
      output = result.reply;

      endSession(sessionId);
    }
    // Fold it into memory now, so a scheduled run contributes what it learned
    // rather than waiting for the next interactive session to end.
    await indexPending();
  } catch (err) {
    status = "error";
    error = (err as Error).message;
    onLog(`  ${task.name} failed: ${error}`);
  }

  const durationMs = now() - startedAt;
  const inserted = db
    .prepare(
      `INSERT INTO task_runs (task_id, started_at, duration_ms, status, output, error)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(task.id, startedAt, durationMs, status, output?.slice(0, 20_000) ?? null, error);

  db.prepare(
    `UPDATE tasks SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?`,
  ).run(startedAt, status, error, task.id);

  onLog(`  ${task.name} ${status} in ${Math.round(durationMs / 1000)}s`);
  return {
    id: Number(inserted.lastInsertRowid),
    startedAt,
    durationMs,
    status,
    output,
    error,
  };
}

/**
 * The scheduler loop.
 *
 * Tasks are re-read from the database on each tick rather than only at startup,
 * so adding or disabling one takes effect without restarting the daemon.
 * `protect` prevents overlap: a task still running when its next slot arrives
 * is skipped rather than started twice, which for a model that takes tens of
 * seconds per turn is a real possibility.
 */
export function startScheduler(onLog: (message: string) => void): { stop(): void } {
  const jobs = new Map<string, Cron>();

  const sync = () => {
    const tasks = listTasks().filter((t) => t.enabled);
    const wanted = new Set(tasks.map((t) => `${t.name}:${t.schedule}`));

    // The heartbeat rides the same sync loop as the tasks, keyed like one, so
    // adding the first watch starts it and removing the last stops it without
    // a restart. It exists only while there is something to watch: an empty
    // sweep every half hour is model time spent proving nothing.
    if (config.heartbeatSchedule && listWatches().some((w) => w.enabled)) {
      wanted.add(`\0heartbeat:${config.heartbeatSchedule}`);
      if (!jobs.has(`\0heartbeat:${config.heartbeatSchedule}`)) {
        try {
          const job = new Cron(config.heartbeatSchedule, { protect: true }, async () => {
            await runHeartbeat(onLog);
          });
          jobs.set(`\0heartbeat:${config.heartbeatSchedule}`, job);
          onLog(
            `heartbeat every "${config.heartbeatSchedule}" — next ${job.nextRun()?.toISOString()}`,
          );
        } catch (err) {
          onLog(`could not schedule heartbeat: ${(err as Error).message}`);
        }
      }
    }

    for (const [key, job] of jobs) {
      if (!wanted.has(key)) {
        job.stop();
        jobs.delete(key);
      }
    }

    for (const task of tasks) {
      const key = `${task.name}:${task.schedule}`;
      if (jobs.has(key)) continue;
      try {
        const job = new Cron(task.schedule, { protect: true }, async () => {
          // Re-read: the prompt may have changed since the job was scheduled.
          const current = getTask(task.name);
          if (current?.enabled) await runTask(current, onLog);
        });
        jobs.set(key, job);
        onLog(`scheduled ${task.name} (${task.schedule}) — next ${job.nextRun()?.toISOString()}`);
      } catch (err) {
        onLog(`could not schedule ${task.name}: ${(err as Error).message}`);
      }
    }
  };

  sync();
  const rescan = setInterval(sync, 30_000);

  return {
    stop() {
      clearInterval(rescan);
      for (const job of jobs.values()) job.stop();
      jobs.clear();
    },
  };
}
