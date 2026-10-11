/**
 * The user's apps, over the agent's API: which code editor, and "open this
 * there". Every call is a user act -- a button, or a phrase the harness
 * resolved. The agent resolves the path in its own alias grammar and only
 * ever opens what the person attached or Enio wrote.
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
  if (!res.ok) throw new Error(body?.error?.message ?? `${path} returned ${res.status}`);
  return body;
}

const NONE = { editor: null, choice: "none", editors: [] };
let cached = null;

/** The editor status, fetched once per window and after a change. */
export function getApps() {
  if (!cached) cached = call("/apps").catch(() => NONE);
  return cached;
}

export function invalidateApps() {
  cached = null;
}

export async function setEditor(id) {
  const next = await call("/apps/editor", { method: "POST", body: JSON.stringify({ id }) });
  cached = Promise.resolve(next);
  return next;
}

/** Open a path (alias grammar) in the editor in effect, or a named one. */
export function openInEditor(path, line, editor) {
  return call("/apps/open", { method: "POST", body: JSON.stringify({ path, line, editor }) });
}
