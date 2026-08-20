/**
 * Processes an agent started and left running.
 *
 * A background command outlives the turn that started it, so it has to be
 * visible and stoppable by the person whose machine it is on. Every call here
 * is a user act, over the same authed endpoints as everything else — the
 * model has no route to this list and cannot stop anything, because process
 * control is what it should not hold.
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

export const listCommands = () => call("/commands").then((d) => d.commands ?? []);

export const stopCommand = (pid) => call(`/commands/${pid}`, { method: "DELETE" });

export const stopAllCommands = () => call("/commands", { method: "DELETE" });
