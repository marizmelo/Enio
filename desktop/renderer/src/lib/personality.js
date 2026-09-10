/** The Behavior tab's transport: how Enio replies, and the knobs on it. */

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

export const fetchPersonality = () => call("/personality");
export const setPersonality = (axis, level) =>
  call("/personality", { method: "POST", body: JSON.stringify({ axis, level }) });
export const setCuriosity = (curiosity) =>
  call("/personality", { method: "POST", body: JSON.stringify({ curiosity }) });
