/** Handoff runs: the user's own CLI agent, driven by the server as a job. */

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

export const fetchHandoffs = () => call("/handoffs");
export const runHandoff = (path, provider) =>
  call("/handoffs/run", { method: "POST", body: JSON.stringify({ path, provider }) });
export const cancelHandoff = (id) => call(`/handoffs/${id}`, { method: "DELETE" });
