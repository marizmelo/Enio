/**
 * Projects, over the agent's API.
 *
 * Every call here is a user act — creating, attaching, opening. That is the
 * consent model: the sandbox widens only through these authed endpoints, and
 * no tool the model holds can reach them.
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
    // The server's refusals are written for people (caps, attach guards);
    // surface them verbatim rather than as a status code.
    throw new Error(body?.error?.message ?? `${path} returned ${res.status}`);
  }
  return body;
}

/** Mirror of the server-side caps (project.ts CAPS), for live counters. The
 *  server refuses overflow either way — these just make the refusal visible
 *  before the round-trip. */
export const CAPS = { name: 60, description: 200, instructions: 600, note: 120 };

export const listProjects = () => call("/projects").then((d) => d.projects);

export const getProject = (id) => call(`/projects/${id}`).then((d) => d.project);

export const createProject = (fields) =>
  call("/projects", { method: "POST", body: JSON.stringify(fields) }).then((d) => d.project);

export const updateProject = (id, patch) =>
  call(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) }).then(
    (d) => d.project,
  );

export const deleteProject = (id) => call(`/projects/${id}`, { method: "DELETE" });

export const attachToProject = (id, path, note) =>
  call(`/projects/${id}/attachments`, {
    method: "POST",
    body: JSON.stringify({ path, note }),
  }).then((d) => d.attachment);

export const detachFromProject = (id, alias) =>
  call(`/projects/${id}/attachments/${encodeURIComponent(alias)}`, { method: "DELETE" });

export const openProject = (id) =>
  call(`/projects/${id}/open`, { method: "POST" }).then((d) => d.project);

export const closeProject = () => call("/project/close", { method: "POST" });

/** The active project, or null. Includes latestConversation for resume. */
export const currentProject = () => call("/project").then((d) => d.project);

/** The active project plus the id the user last chose to have open — what a
 *  fresh launch should restore, since the server forgets on restart. */
export const projectState = () => call("/project");
