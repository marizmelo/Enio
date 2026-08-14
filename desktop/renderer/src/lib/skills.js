/**
 * Skills, over the agent's API. Read-only: a skill is the user's document,
 * edited in their editor — this fetch is the window onto it, not a second
 * editor.
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
    throw new Error(body?.error?.message ?? `${path} returned ${res.status}`);
  }
  return body;
}

/** {skills: [...healthy and broken rows], unresolved: [{name, count}]} */
export const listSkills = () => call("/skills");

/** One skill's SKILL.md, for the canvas. Addressed by name — the server
 *  resolves the file, so the renderer never holds a path into the data dir. */
export const readSkillSource = (name) => call(`/skills/${encodeURIComponent(name)}/source`);

/** Saving validates the frontmatter server-side and REFUSES a save that
 *  would drop the skill out of the catalogue; the reason comes back as the
 *  error message. */
export const saveSkillSource = (name, content) =>
  call(`/skills/${encodeURIComponent(name)}/source`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
