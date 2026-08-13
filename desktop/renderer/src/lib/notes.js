/** The managed note store, over the agent's API. */

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

const enc = encodeURIComponent;

export const listNotes = () => call("/notes");
export const createNote = (title) =>
  call("/notes", { method: "POST", body: JSON.stringify({ title }) });
export const fetchComments = (name) => call(`/notes/${enc(name)}/comments`);
export const createThread = (name, args) =>
  call(`/notes/${enc(name)}/comments`, { method: "POST", body: JSON.stringify(args) });
export const replyThread = (name, threadId, text) =>
  call(`/notes/${enc(name)}/comments/${enc(threadId)}/reply`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
export const resolveThread = (name, threadId, resolved) =>
  call(`/notes/${enc(name)}/comments/${enc(threadId)}/resolve`, {
    method: "POST",
    body: JSON.stringify({ resolved }),
  });
export const deleteThread = (name, threadId) =>
  call(`/notes/${enc(name)}/comments/${enc(threadId)}`, { method: "DELETE" });
export const transformSelection = (args) =>
  call("/notes/transform", { method: "POST", body: JSON.stringify(args) });
