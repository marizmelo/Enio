/**
 * The agents panel's data: the derived view of every agent, the catalog a
 * new agent picks tools from, and create/edit/delete for the user's own.
 *
 * Custom agents are a user act over the authed routes, same as projects —
 * the model has no tool that reaches these, so an agent can never mint
 * itself a colleague with tools it was not given.
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

/** { agents, catalog } — the whole panel in one fetch. */
export const fetchAgents = () => call("/agents");

/** Create or edit (same name replaces). Returns the refreshed agents list. */
export const saveAgent = (agent) =>
  call("/agents", { method: "POST", body: JSON.stringify(agent) });

export const deleteAgent = (name) =>
  call(`/agents/${encodeURIComponent(name)}`, { method: "DELETE" });

/** Pin skills to an agent, built-in or custom — the one edit a built-in
 *  accepts, because know-how is not capability. */
export const setAgentSkills = (name, skills) =>
  call(`/agents/${encodeURIComponent(name)}/skills`, {
    method: "PUT",
    body: JSON.stringify({ skills }),
  });
