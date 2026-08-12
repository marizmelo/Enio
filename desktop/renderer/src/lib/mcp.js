/**
 * MCP connections, over the agent's API.
 *
 * Every mutation returns the full merged list (config + live status), so the
 * dialog never needs a second round-trip to know what a change did — and a
 * server that failed to connect arrives with its error string, not a guess.
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

export const listMcpServers = () => call("/mcp/servers").then((d) => d.servers);

export const addMcpServer = ({ name, command, args, tools }) =>
  call("/mcp/servers", {
    method: "POST",
    body: JSON.stringify({ name, command, args, tools }),
  }).then((d) => d.servers);

export const setMcpServerDisabled = (name, disabled) =>
  call(`/mcp/servers/${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify({ disabled }),
  }).then((d) => d.servers);

export const removeMcpServer = (name) =>
  call(`/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE" }).then((d) => d.servers);
