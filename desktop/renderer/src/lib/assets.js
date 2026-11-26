/**
 * Assets, over the agent's API: everything Enio has made, newest first,
 * each with what made it. The list is derived server-side from what is on
 * disk on every call, so there is nothing here to keep in step.
 */

const AGENT_BASE = "http://127.0.0.1:8787";

async function call(path, init = {}) {
  const token = await window.maple?.getToken();
  const res = await fetch(`${AGENT_BASE}${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `${path} returned ${res.status}`);
  return body;
}

export const listAssets = () => call("/assets").then((d) => d.assets ?? []);
/** Removes an asset's folder. A pointer to files in an attached folder
 *  loses only the pointer. */
export const removeAsset = (id) => call(`/assets/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Local-day buckets, newest first, for the timeline. */
export function groupByDay(assets, now = new Date()) {
  const dayOf = (ms) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const today = dayOf(now.getTime());
  const label = (day) => {
    const days = Math.round((today - day) / 86_400_000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    return new Date(day).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(new Date(day).getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    });
  };
  const groups = [];
  for (const asset of assets) {
    const day = dayOf(asset.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.assets.push(asset);
    else groups.push({ day, label: label(day), assets: [asset] });
  }
  return groups;
}
