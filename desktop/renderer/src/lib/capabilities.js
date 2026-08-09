/**
 * What the agent can do, fetched once as data.
 *
 * Deliberately not asked of the model: it only ever sees the tool slice its
 * specialist owns, so it answers "what can you do" with two tools out of
 * eleven. This endpoint knows all of them, costs no tokens, and cannot invent
 * a tool that does not exist.
 */

const AGENT_BASE = "http://127.0.0.1:8787";

const EMPTY = { tools: [], skills: [], agents: [], servers: [], files: [] };

export async function fetchCapabilities() {
  try {
    const token = await window.maple?.getToken();
    const res = await fetch(`${AGENT_BASE}/capabilities`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return EMPTY;
    return { ...EMPTY, ...(await res.json()) };
  } catch {
    // The menus just come up empty. This is a nicety on top of a chat box that
    // works without it, so a failure here must not surface as an error.
    return EMPTY;
  }
}

/**
 * Replace the trailing "/word" the user is typing with the chosen skill.
 *
 * A slash is only a command as the first token — anywhere else it is a path
 * separator — so this refuses to fire mid-sentence, matching the server's own
 * rule in mentions.ts.
 */
export function applySlash(value, skillName) {
  return `/${skillName} ${value.replace(/^\/\S*\s*/, "")}`;
}

/** Append an @mention, leaving whatever the user already typed intact. */
export function appendMention(value, token) {
  const trimmed = value.replace(/\s+$/, "");
  return trimmed.length > 0 ? `${trimmed} @${token} ` : `@${token} `;
}

/** The "/foo" being typed at the start of the box, or null. */
export function slashQuery(value) {
  const m = /^\/([\w-]*)$/.exec(value);
  return m ? m[1].toLowerCase() : null;
}

/**
 * The "@word" currently being typed at the end of the box, or null.
 *
 * Requires start-of-string or whitespace before the @, matching the server's
 * rule — that is what keeps `user@example.com` from opening a palette halfway
 * through an email address.
 */
export function mentionQuery(value) {
  const m = /(^|\s)@([\w./-]*)$/.exec(value);
  return m ? m[2].toLowerCase() : null;
}

/** Replace the half-typed @token at the end with the chosen one. */
export function completeMention(value, token) {
  return value.replace(/(^|\s)@[\w./-]*$/, `$1@${token} `);
}

const MENTION = /(^|\s)@([\w./-]+)/g;

/**
 * Which attached files the message currently refers to.
 *
 * Derived from the text rather than tracked alongside it, so there is one
 * source of truth. Delete "@notes.txt" by hand and the chip goes with it; the
 * alternative is a list that quietly disagrees with what gets sent.
 *
 * Only known workspace files count — @researcher is an agent and @anything
 * else is just text the server will leave alone.
 */
export function attachedFiles(value, files = []) {
  const known = new Set(files);
  const found = [];
  for (const [, , token] of value.matchAll(MENTION)) {
    if (known.has(token) && !found.includes(token)) found.push(token);
  }
  return found;
}

/** Drop one @mention, leaving the rest of the sentence intact. */
export function removeMention(value, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value
    .replace(new RegExp(`(^|\\s)@${escaped}(?![\\w./-])\\s?`, "g"), "$1")
    .replace(/\s{2,}/g, " ")
    .trimStart();
}

/** Images get a thumbnail; everything else gets a name and an icon. */
export function isImageName(name) {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
}
