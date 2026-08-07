// Small null-safe formatting helpers. The backend is fed by a small local
// model, so any field documented as nullable will actually be null
// sometimes, and fields not documented as nullable can still show up empty
// or malformed — everything here is defensive.

export function relativeTime(iso) {
  if (!iso) return "unknown time";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown time";
  const now = Date.now();
  const diffMs = now - then;
  const abs = Math.abs(diffMs);
  const future = diffMs < 0;

  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  const week = Math.round(day / 7);
  const month = Math.round(day / 30);
  const year = Math.round(day / 365);

  let text;
  if (sec < 45) text = "just now";
  else if (min < 60) text = `${min}m`;
  else if (hr < 24) text = `${hr}h`;
  else if (day < 7) text = `${day}d`;
  else if (week < 5) text = `${week}w`;
  else if (month < 12) text = `${month}mo`;
  else text = `${year}y`;

  if (text === "just now") return text;
  return future ? `in ${text}` : `${text} ago`;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return "—";
  const n = Number(ms);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)}s`;
  const m = Math.floor(n / 60000);
  const s = Math.round((n % 60000) / 1000);
  return `${m}m ${s}s`;
}

export function truncate(str, max = 400) {
  if (str === null || str === undefined) return "";
  const s = String(str);
  if (s.length <= max) return s;
  return s.slice(0, max);
}

export function isTruncatable(str, max = 400) {
  if (str === null || str === undefined) return false;
  return String(str).length > max;
}

// Best-effort pretty-print for values that are supposed to be JSON strings
// but, coming from a flaky model, might be malformed, already an object, or
// missing entirely.
export function prettyJson(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  if (typeof value !== "string") return String(value);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

const SPECIALIST_COLORS = {
  researcher: { fg: "#8ab4ff", bg: "rgba(138, 180, 255, 0.14)" },
  coder: { fg: "#7ee0b8", bg: "rgba(126, 224, 184, 0.14)" },
  librarian: { fg: "#e0b87e", bg: "rgba(224, 184, 126, 0.14)" },
  generalist: { fg: "#c9a8ff", bg: "rgba(201, 168, 255, 0.14)" },
};
const DEFAULT_SPECIALIST_COLOR = { fg: "#9fa8b8", bg: "rgba(159, 168, 184, 0.14)" };

export function specialistColor(name) {
  if (!name) return DEFAULT_SPECIALIST_COLOR;
  return SPECIALIST_COLORS[String(name).toLowerCase()] || DEFAULT_SPECIALIST_COLOR;
}

export function specialistLabel(name) {
  if (!name || typeof name !== "string" || !name.trim()) return "unrouted";
  return name;
}

const ENTITY_TYPE_COLORS = {
  person: "#8ab4ff",
  project: "#7ee0b8",
  technology: "#e0b87e",
  organization: "#c9a8ff",
  place: "#ff9d8a",
  concept: "#7fd4e0",
};
const DEFAULT_ENTITY_COLOR = "#9fa8b8";

export function entityColor(type) {
  if (!type) return DEFAULT_ENTITY_COLOR;
  return ENTITY_TYPE_COLORS[String(type).toLowerCase()] || DEFAULT_ENTITY_COLOR;
}

export function safeNumber(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

// Extracts the <memory>...</memory> block from a system prompt, defensively.
// Returns { before, memory, after } where memory is "" when no block is
// present (the API contract says memoryBlock may already be "" too — this
// is a fallback for when memoryBlock itself is missing but the prompt still
// contains the tags).
export function splitMemoryBlock(systemPrompt, memoryBlock) {
  const prompt = systemPrompt || "";
  if (memoryBlock) {
    const idx = prompt.indexOf(memoryBlock);
    if (idx !== -1) {
      return {
        before: prompt.slice(0, idx),
        memory: memoryBlock,
        after: prompt.slice(idx + memoryBlock.length),
      };
    }
  }
  const start = prompt.indexOf("<memory>");
  const end = prompt.indexOf("</memory>");
  if (start !== -1 && end !== -1 && end > start) {
    const endIdx = end + "</memory>".length;
    return {
      before: prompt.slice(0, start),
      memory: prompt.slice(start, endIdx),
      after: prompt.slice(endIdx),
    };
  }
  return { before: prompt, memory: "", after: "" };
}
