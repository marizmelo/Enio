/**
 * Schedules, over the agent's API.
 *
 * The UI never says "task": a schedule is a property of an automation, and
 * the reserved `auto-<pipeline id>` name is how the two are joined. This
 * module speaks the /tasks routes; the mapping back onto automation rows
 * happens in the dialog.
 */

const AGENT_BASE = "http://127.0.0.1:8787";

async function call(path, init = {}) {
  const token = await window.maple?.getToken();
  const res = await fetch(`${AGENT_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `${path} returned ${res.status}`);
  }
  return body;
}

/** All schedules plus whether anything will actually fire them. */
export const listTasks = () => call("/tasks");

export const setSchedule = (pipelineId, cron) =>
  call("/tasks/schedule", {
    method: "POST",
    body: JSON.stringify({ pipelineId, cron }),
  }).then((d) => d.task);

export const clearSchedule = (pipelineId) =>
  call(`/tasks/schedule/${encodeURIComponent(pipelineId)}`, { method: "DELETE" });
