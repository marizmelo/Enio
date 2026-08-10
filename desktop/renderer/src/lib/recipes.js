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

/** The model setting: what runs now, what is installed, and what could be
 *  fetched. The two lists are separate because switching is instant and
 *  downloading is gigabytes. */
export const currentModel = () => call("/model");

/** Starts the fetch and returns once it is running, not once it is done —
 *  poll `modelDownload` for the rest. */
export const downloadModel = (model) =>
  call("/model/download", { method: "POST", body: JSON.stringify({ model }) });

export const modelDownload = () => call("/model/download");

export const cancelModelDownload = () => call("/model/download", { method: "DELETE" });

/** Switching restarts the model server under the agent; this resolves once
 *  the new one is serving, so callers can just await it. */
export const switchModel = (model) =>
  call("/model", { method: "POST", body: JSON.stringify({ model }) });

/** Whether a vouched-for recipe may run unattended. Separate from desktop
 *  mode: one says whether it can act, the other whether it may act unasked. */
export const automation = () => call("/automation");

export const setAutoRun = (autoRun) =>
  call("/automation", { method: "POST", body: JSON.stringify({ autoRun }) });
