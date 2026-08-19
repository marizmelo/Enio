/** The Memory dialog's transport: what memory holds, and the ways to prune it. */

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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
  return data;
}

export const fetchMemory = () => call("/memory");
export const fetchMemoryGraph = (limit = 150) => call(`/memory/graph?limit=${limit}`);
export const forgetFact = (id) => call(`/memory/facts/${id}`, { method: "DELETE" });
export const pinFact = (id, pinned) =>
  call(`/memory/facts/${id}`, { method: "POST", body: JSON.stringify({ pinned }) });
export const forgetPreference = (id) =>
  call(`/memory/preferences/${id}`, { method: "DELETE" });
export const forgetSummary = (sessionId) =>
  call(`/memory/summaries/${sessionId}`, { method: "DELETE" });

/** "Remember this": the reply reduced to candidate facts, for the user to
 *  read and prune. Nothing is written by this call. */
export const distilFacts = (question, answer) =>
  call("/memory/distil", { method: "POST", body: JSON.stringify({ question, answer }) });

/** Writes exactly the facts the user approved, tagged to the conversation
 *  so they die with it if it is later forgotten. */
export const rememberFacts = (facts, sessionId) =>
  call("/memory/facts", { method: "POST", body: JSON.stringify({ facts, sessionId }) });
