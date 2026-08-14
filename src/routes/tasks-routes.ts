import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../http-util.js";
import {
  addTask,
  getTask,
  listTasks,
  removeTask,
  updateTask,
  validateSchedule,
} from "../tasks.js";
import { getPipeline, hasSuccessfulRun } from "../pipelines.js";
import { leaseInfo } from "../scheduler-lease.js";

/**
 * Schedules as a property of an automation, not a separate concept.
 *
 * The desktop never shows "tasks": it shows an automation with a schedule
 * chip. The reserved task name `auto-<pipeline id>` is the entire mapping --
 * one schedule per automation, upserted in place so the task id (and with it
 * the run history) survives every edit. CLI-authored tasks with names of
 * their own pass through the listing untouched; the `auto-` prefix alone is
 * not enough to claim one, since a user's task named `auto-daily` is theirs.
 */

const AUTO_NAME = /^auto-([0-9a-f-]{36})$/;

function isAutoSchedule(name: string, pipeline: string | null): boolean {
  const match = AUTO_NAME.exec(name);
  return match !== null && pipeline !== null && getPipeline(match[1]!) !== null;
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/tasks") {
    const tasks = listTasks().map((t) => {
      const check = validateSchedule(t.schedule);
      return {
        ...t,
        nextRun: t.enabled && check.ok ? check.next.toISOString() : null,
        isAutoSchedule: isAutoSchedule(t.name, t.pipeline),
      };
    });
    // schedulerRunning is the lease's freshness: false means nothing will
    // fire (no serve, no daemon), which the UI surfaces as a quiet banner.
    sendJson(res, 200, { schedulerRunning: leaseInfo().fresh, tasks });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/tasks/schedule") {
    let body: { pipelineId?: string; cron?: string };
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      sendJson(res, 400, { error: { message: "Invalid JSON." } });
      return true;
    }
    const pipelineId = String(body.pipelineId ?? "").trim();
    const cron = String(body.cron ?? "").trim();
    const pipeline = pipelineId ? getPipeline(pipelineId) : null;
    if (!pipeline) {
      sendJson(res, 404, { error: { message: "No automation with that id." } });
      return true;
    }
    const check = validateSchedule(cron);
    if (!check.ok) {
      sendJson(res, 400, { error: { message: `Invalid schedule: ${check.reason}` } });
      return true;
    }
    // The vouching rule, same as run_pipeline and the skill export: only a
    // flow reality has tested gets to fire unattended at 3am. (The CLI's
    // `task add` stays ungated -- typing the command is its own vouching.)
    if (!hasSuccessfulRun(pipelineId)) {
      sendJson(res, 409, {
        error: { message: "Run it successfully once first — a schedule fires unattended." },
      });
      return true;
    }
    const name = `auto-${pipelineId}`;
    try {
      // Upsert in place: updateTask keeps the task id and its run history.
      // Refreshing `pipeline` to the current name also heals any drift from
      // renames that happened before the cascade existed.
      const task = getTask(name)
        ? updateTask(name, { schedule: cron, pipeline: pipeline.name, enabled: true })
        : addTask({ name, pipeline: pipeline.name, schedule: cron });
      sendJson(res, 200, { task });
    } catch (err) {
      sendJson(res, 400, { error: { message: (err as Error).message } });
    }
    return true;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/tasks/schedule/")) {
    const pipelineId = decodeURIComponent(url.pathname.slice("/tasks/schedule/".length));
    sendJson(res, 200, { removed: removeTask(`auto-${pipelineId}`) });
    return true;
  }

  return false;
}
