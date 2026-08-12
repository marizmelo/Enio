/**
 * Pipelines, over the agent's API.
 *
 * Compose returns a draft graph and stores nothing; save/run are separate,
 * deliberate acts. The run endpoint streams RunEvents over SSE — consumed
 * here with the same line-parser shape lib/agent.js uses.
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
    throw new Error(body?.error?.message ?? body?.reason ?? `${path} returned ${res.status}`);
  }
  return body;
}

export const listPipelines = () => call("/pipelines").then((d) => d.pipelines);
export const getPipeline = (id) => call(`/pipelines/${id}`).then((d) => d.pipeline);
export const savePipeline = (fields) =>
  call(fields.id ? `/pipelines/${fields.id}` : "/pipelines", {
    method: "POST",
    body: JSON.stringify(fields),
  }).then((d) => d.pipeline);
export const deletePipeline = (id) => call(`/pipelines/${id}`, { method: "DELETE" });
/** The execution log: past runs with each step's reply, artifacts, error. */
export const listRuns = (id) => call(`/pipelines/${id}/runs`).then((d) => d.runs);
export const composePipeline = (prompt) =>
  call("/pipelines/compose", { method: "POST", body: JSON.stringify({ prompt }) });
/** Mine the trace history for repeated tool sequences; returns unsaved
 *  drafts. Deliberately a POST the user triggers — it embeds real work. */
export const suggestPipelines = () =>
  call("/pipelines/suggest", { method: "POST" }).then((d) => d.drafts);
/** Ask a running pipeline (saved or draft) to stop. The stop lands at the
 *  next safe boundary; the stream reports the rest. */
export const stopPipeline = (id) => call(`/pipelines/${id}/stop`, { method: "POST" });
/** Run a pipeline, invoking onEvent per SSE frame. Resolves when the stream
 *  closes. The caller treats events as the only truth about progress. */
export function runPipeline(id, onEvent, signal) {
  return runStream(`/pipelines/${id}/run`, undefined, onEvent, signal);
}
/** Run an unsaved graph. Same stream; the run_started event carries the
 *  ephemeral id (for stopping) and runId (for adoption on save). */
export function runDraft(graph, onEvent, signal) {
  return runStream("/pipelines/run-draft", JSON.stringify(graph), onEvent, signal);
}

async function runStream(path, body, onEvent, signal) {
  const token = await window.maple?.getToken();
  const res = await fetch(`${AGENT_BASE}${path}`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body,
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `run returned ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at;
    while ((at = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch {
        /* a malformed frame is dropped, not fatal */
      }
    }
  }
}
