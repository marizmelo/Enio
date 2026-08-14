/**
 * Skills, over the agent's API. Read-only: a skill is the user's document,
 * edited in their editor — this fetch is the window onto it, not a second
 * editor.
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

/** {skills: [...healthy and broken rows], unresolved: [{name, count}]} */
export const listSkills = () => call("/skills");
