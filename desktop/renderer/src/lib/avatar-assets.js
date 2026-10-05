/**
 * The avatar's model file, fetched once per window.
 *
 * The agent serves it over the authed loopback route like everything else;
 * the renderer cannot read the data dir, and the three.js loader accepts a
 * blob URL. One blob URL per session, never revoked after a load: a
 * revoked URL cannot serve the next mount, and switching the face between
 * its thumbnail and its panel remounts it.
 */
const AGENT_BASE = "http://127.0.0.1:8787";

export class AvatarUnavailable extends Error {}

let modelUrl = null;

export function loadAvatarModel() {
  if (!modelUrl) {
    modelUrl = (async () => {
      const token = await window.maple?.getToken();
      const res = await fetch(`${AGENT_BASE}/avatar/model`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new AvatarUnavailable(`avatar model returned ${res.status}`);
      return { url: URL.createObjectURL(await res.blob()) };
    })().catch((err) => {
      modelUrl = null;
      throw err;
    });
  }
  return modelUrl;
}

/** After an install or a swap: the next mount fetches the new file. */
export function invalidateAvatarModel() {
  const old = modelUrl;
  modelUrl = null;
  old?.then(({ url }) => URL.revokeObjectURL(url)).catch(() => {});
}

/** What the agent says about the face, or null when it predates the feature. */
export function avatarCapability(capabilities) {
  const a = capabilities?.avatar;
  if (!a || typeof a !== "object") return null;
  return { installed: Boolean(a.installed), source: a.source ?? null, body: a.body === "F" ? "F" : "M" };
}
