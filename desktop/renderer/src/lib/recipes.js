/**
 * The recipe list, over the agent's API.
 *
 * Errors carry the script's own output on `detail`, because when a save is
 * refused the useful part is why osascript rejected it — not the status code.
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `${path} returned ${res.status}`);
    err.detail = data?.output ?? "";
    throw err;
  }
  return data;
}

export const listRecipes = () => call("/recipes");

/** Saving runs the script; a failure rejects with the reason on `detail`. */
export const saveRecipe = (name, { summary, script }) =>
  call(`/recipes/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ summary, script }),
  });

export const deleteRecipe = (name) =>
  call(`/recipes/${encodeURIComponent(name)}`, { method: "DELETE" });
