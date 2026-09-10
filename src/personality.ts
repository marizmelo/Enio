import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { contextBudget } from "./model-settings.js";
import { listExemplars, listPreferences } from "./memory/learning.js";
import { connectedEntities, type ConnectedEntity } from "./memory/coverage.js";

/**
 * Personality: how the assistant replies, as four axes with three levels,
 * derived from what memory holds and overridable by the person.
 *
 * Not a persona field. The prompt already has three behaviour surfaces —
 * the fixed identity and rules, preferences (standing instructions, every
 * turn), and exemplars (answers to imitate) — and a free-text fourth would
 * duplicate preferences while, at this model size, being mostly ignored.
 * So a level renders as ONE structural line: a positional or numeric
 * constraint on the reply ("keep each reply to two sentences", "start with
 * the answer"), never an adjective about the assistant. Whatever the
 * prompt emphasises, the model becomes; "you are terse" trains nothing and
 * "two sentences" is a rule it can check.
 *
 * Three rules from the design review, each with a reason:
 *  - A level derived from a preference renders nothing: the preference is
 *    already in the prompt in the user's own words, and a paraphrase is
 *    duplication at best. It drives the panel's "auto — because…" only.
 *  - The neutral level renders nothing. What the model does by default is
 *    the default; a line restating it costs tokens and buys nothing.
 *  - Curiosity is not an axis and not a line. The coverage footer already
 *    is "flag gaps", and a quieter level would be a prompt line suppressing
 *    the humility invariant. It is a harness switch: whether the app says
 *    so when a turn lands in the gap ledger.
 *
 * The model cannot set any of this. set_preference stays free text; the
 * loop closes the right way already — "answer briefly" lands as a
 * preference, derivation reads it, the panel says why, the person can
 * delete it.
 */

export const AXES = {
  voice: ["terse", "plain", "conversational"],
  warmth: ["matter-of-fact", "friendly", "warm"],
  initiative: ["answer-only", "suggest-next-step", "offer-follow-ups"],
  register: ["everyday", "technical", "expert"],
} as const;
export type Axis = keyof typeof AXES;
export type Level = (typeof AXES)[Axis][number];
export const AXIS_NAMES = Object.keys(AXES) as Axis[];

/** The middle of each axis: what the model does with no line at all. */
export const NEUTRAL: Record<Axis, Level> = {
  voice: "plain",
  warmth: "friendly",
  initiative: "suggest-next-step",
  register: "technical",
};

export type Curiosity = "quiet" | "flag";

/**
 * The exact lines. Each is a constraint on the reply's shape, and the two
 * that add something ("conversational", "offer-follow-ups") are additive —
 * "after the answer…", "end with…" — so they never contradict the shared
 * rule that already says to answer directly. The expert line is built from
 * the graph's top technologies at render time.
 */
export const RENDERINGS: Record<Axis, Partial<Record<Level, string>>> = {
  voice: {
    terse: "- Keep each reply to two sentences unless the user asks for more.",
    conversational: "- After the answer, add a sentence or two of context or reasoning.",
  },
  warmth: {
    "matter-of-fact": "- Start with the answer: no greeting, no acknowledgement, no closing line.",
    warm: "- Open with a few words acknowledging the request, then answer.",
  },
  initiative: {
    "answer-only": "- End at the answer. Do not suggest next steps or ask what the user wants next.",
    "offer-follow-ups": "- End with one next step the user could take, in one sentence.",
  },
  register: {
    everyday: "- Use plain words; explain any technical term the first time it appears.",
  },
};

export function expertLine(terms: string[]): string {
  const [a, b, c] = terms;
  return `- The user works with ${a}, ${b} and ${c}; use their exact terms without explaining them.`;
}

export const HEADER = "Reply shape:";
const MAX_LINES = 4;
const MAX_CHARS = 320;

/* ---------- storage ------------------------------------------------------ */

export interface PersonalityFile {
  voice: Level | "auto";
  warmth: Level | "auto";
  initiative: Level | "auto";
  register: Level | "auto";
  curiosity: Curiosity;
}

const DEFAULT_FILE: PersonalityFile = {
  voice: "auto",
  warmth: "auto",
  initiative: "auto",
  register: "auto",
  curiosity: "quiet",
};

const file = () => join(config.dataDir, "personality.json");

export function isLevel(axis: Axis, level: unknown): level is Level {
  return typeof level === "string" && (AXES[axis] as readonly string[]).includes(level);
}

/** Tolerant read: an unknown value is "auto", never an error — the file is
 *  hand-editable and a typo must not cost every turn its block. */
export function readPersonality(): PersonalityFile {
  const out: PersonalityFile = { ...DEFAULT_FILE };
  try {
    if (!existsSync(file())) return out;
    const raw = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
    for (const axis of AXIS_NAMES) {
      const v = raw[axis];
      if (v === "auto" || isLevel(axis, v)) out[axis] = v as Level | "auto";
    }
    if (raw.curiosity === "flag" || raw.curiosity === "quiet") out.curiosity = raw.curiosity;
  } catch {
    /* Unreadable: every axis auto. */
  }
  return out;
}

function writePersonality(next: PersonalityFile): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file(), JSON.stringify(next, null, 2) + "\n");
}

/** Refuse, never coerce: a level that does not exist is an error the
 *  caller sees, not a silent "auto" the user has to notice later. */
export function setAxis(axis: string, level: string): PersonalityFile {
  if (!AXIS_NAMES.includes(axis as Axis)) {
    throw new Error(`No axis named "${axis}". Axes: ${AXIS_NAMES.join(", ")}.`);
  }
  const a = axis as Axis;
  if (level !== "auto" && !isLevel(a, level)) {
    throw new Error(`"${level}" is not a ${a} level. Levels: auto, ${AXES[a].join(", ")}.`);
  }
  const next = { ...readPersonality(), [a]: level as Level | "auto" };
  writePersonality(next);
  return next;
}

export function setCuriosity(value: string): PersonalityFile {
  if (value !== "quiet" && value !== "flag") {
    throw new Error(`Curiosity is "quiet" or "flag", not "${value}".`);
  }
  const next: PersonalityFile = { ...readPersonality(), curiosity: value };
  writePersonality(next);
  return next;
}

/* ---------- derivation --------------------------------------------------- */

export interface Derived {
  level: Level;
  /** preference:<id> | exemplars:<n> | graph:<n> | none */
  source: string;
}

/** Phrase lists per level, run over lowercased preference text. Each is a
 *  closed list; a preference that matches none derives nothing. The gaps
 *  are deliberate: there is no preference → conversational (a request for
 *  detail is usually scoped — "explain errors in detail" — not global) and
 *  no preference → expert (that comes from the graph, below). */
const PREF_RULES: Array<[Axis, Level, RegExp]> = [
  ["voice", "terse", /\b(concise(ly)?|brief(ly)?|short (answers?|replies)|terse|one[- ]liners?|one sentence|no preamble)\b/],
  ["warmth", "matter-of-fact", /\b(no (pleasantries|small talk|greetings?|chit[- ]?chat|fluff)|just (the )?answer|skip the (intro|greeting)|don'?t be chatty)\b/],
  ["warmth", "warm", /\b(be (friendly|warm|casual|chatty)|(friendly|casual|warm) tone)\b/],
  ["initiative", "answer-only", /\b(don'?t suggest|no suggestions|only what i ask|nothing extra|no follow[- ]?ups?|don'?t ask (me )?(follow[- ]?up )?questions)\b/],
  ["initiative", "offer-follow-ups", /\b(suggest (a )?next steps?|offer (follow[- ]?ups?|next steps?)|end with (a )?(suggestion|next step))\b/],
  ["register", "everyday", /\b(plain (english|language|words)|no jargon|simple terms|layman'?s?|explain (like|as if) i)\b/],
  ["register", "technical", /\b(technical (answers?|detail)|assume i know|skip the basics|don'?t explain (the )?basics)\b/],
];

const WARM_OPENER = /^(sure|great|happy to|of course|absolutely)\b/i;
const FOLLOW_UP_TAIL = /(\?\s*$)|^(next|you could|you might|if you want|from here)\b/i;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
}

export interface DerivationInputs {
  preferences: Array<{ id: number; text: string }>;
  exemplars: Array<{ answer: string }>;
  entities: ConnectedEntity[];
}

/** The graph's verdict on register: the person works with these things.
 *  Requires enough connected technologies and projects to be a working
 *  life rather than a mention or two — and never derives "everyday" from
 *  the graph, because many people in memory says nothing about the
 *  person's own vocabulary. */
export function expertTerms(entities: ConnectedEntity[]): string[] {
  const connected = entities.filter((e) => e.degree >= 2);
  if (connected.length === 0) return [];
  const work = connected.filter((e) => e.type === "technology" || e.type === "project");
  if (work.length < 6 || work.length / connected.length < 0.6) return [];
  const top = connected.filter((e) => e.type === "technology").slice(0, 3);
  if (top.length < 3 || top.some((e) => e.degree < 4)) return [];
  return top.map((e) => e.name);
}

/**
 * One level per axis from the evidence, first match wins, preferences
 * before exemplars before the graph. Exemplars need three: two answers are
 * an anecdote. No signal is neutral, and says so.
 */
export function personalityDefaults(inputs: DerivationInputs): Record<Axis, Derived> {
  const out = {} as Record<Axis, Derived>;
  for (const axis of AXIS_NAMES) out[axis] = { level: NEUTRAL[axis], source: "none" };
  const taken = new Set<Axis>();

  for (const p of inputs.preferences) {
    const text = p.text.toLowerCase();
    for (const [axis, level, re] of PREF_RULES) {
      if (taken.has(axis) || !re.test(text)) continue;
      out[axis] = { level, source: `preference:${p.id}` };
      taken.add(axis);
    }
  }

  const answers = inputs.exemplars.map((e) => e.answer.trim()).filter(Boolean);
  if (answers.length >= 3) {
    const n = answers.length;
    const src = `exemplars:${n}`;
    if (!taken.has("voice")) {
      const m = median(answers.map((a) => a.length));
      if (m < 240) (out.voice = { level: "terse", source: src }), taken.add("voice");
      else if (m > 900) (out.voice = { level: "conversational", source: src }), taken.add("voice");
    }
    if (!taken.has("warmth") && answers.filter((a) => WARM_OPENER.test(a)).length * 2 >= n) {
      out.warmth = { level: "warm", source: src };
      taken.add("warmth");
    }
    if (!taken.has("initiative")) {
      const lastLine = (a: string) => a.split("\n").filter((l) => l.trim()).at(-1) ?? "";
      if (answers.filter((a) => FOLLOW_UP_TAIL.test(lastLine(a).trim())).length * 2 >= n) {
        out.initiative = { level: "offer-follow-ups", source: src };
        taken.add("initiative");
      }
    }
  }

  if (!taken.has("register")) {
    const terms = expertTerms(inputs.entities);
    if (terms.length === 3) {
      out.register = { level: "expert", source: `graph:${inputs.entities.filter((e) => e.degree >= 2).length}` };
    }
  }
  return out;
}

/* ---------- the view: what the turn and the panel both read -------------- */

export interface PersonalityView {
  /** As stored: a level, or "auto". */
  levels: Record<Axis, Level | "auto">;
  /** What is in force after derivation. */
  effective: Record<Axis, Level>;
  /** Why: explicit | preference:<id> | exemplars:<n> | graph:<n> | none */
  sources: Record<Axis, string>;
  /** Preferences that would have derived a different level than an
   *  explicit choice — the honest answer to "why does it still…". */
  conflicts: string[];
  curiosity: Curiosity;
  block: string;
  expertTerms: string[];
}

export function personalityView(inputs?: DerivationInputs, budget = contextBudget()): PersonalityView {
  const stored = readPersonality();
  const evidence: DerivationInputs = inputs ?? {
    preferences: listPreferences(),
    exemplars: listExemplars(),
    entities: connectedEntities(),
  };
  const derived = personalityDefaults(evidence);
  const terms = expertTerms(evidence.entities);

  const levels = {} as PersonalityView["levels"];
  const effective = {} as PersonalityView["effective"];
  const sources = {} as PersonalityView["sources"];
  const conflicts: string[] = [];
  const lines: string[] = [];

  for (const axis of AXIS_NAMES) {
    const chosen = stored[axis];
    levels[axis] = chosen;
    const explicit = chosen !== "auto";
    const level = explicit ? (chosen as Level) : derived[axis].level;
    effective[axis] = level;
    sources[axis] = explicit ? "explicit" : derived[axis].source;

    if (explicit && derived[axis].source.startsWith("preference:") && derived[axis].level !== level) {
      const id = Number(derived[axis].source.split(":")[1]);
      const pref = evidence.preferences.find((p) => p.id === id);
      if (pref) conflicts.push(pref.text);
    }

    if (level === NEUTRAL[axis]) continue;
    // A preference-derived level is already in the prompt, in the user's
    // words. On the smallest windows only what the person set explicitly
    // spends tokens.
    if (!explicit && derived[axis].source.startsWith("preference:")) continue;
    if (!explicit && budget <= 2000) continue;

    if (axis === "register" && level === "expert") {
      // Explicit expert with no graph to name: nothing honest to render.
      if (terms.length === 3) lines.push(expertLine(terms));
      continue;
    }
    const line = RENDERINGS[axis][level];
    if (line) lines.push(line);
  }

  let block = "";
  if (lines.length > 0) {
    const kept = lines.slice(0, MAX_LINES);
    // The caps are the contract with the budget; the expert line, being
    // the longest and the last, is what gives way.
    while (kept.length > 0 && [HEADER, ...kept].join("\n").length > MAX_CHARS) kept.pop();
    if (kept.length > 0) block = [HEADER, ...kept].join("\n");
  }

  return { levels, effective, sources, conflicts, curiosity: stored.curiosity, block, expertTerms: terms };
}

/** The behaviour gate's fixed renderings: every non-neutral level as it is
 *  served, with the expert line over stable names so runs compare. */
export function gateRenderings(): Array<{ id: string; suffix: string }> {
  const out: Array<{ id: string; suffix: string }> = [];
  for (const axis of AXIS_NAMES) {
    for (const [level, line] of Object.entries(RENDERINGS[axis])) {
      out.push({ id: `${axis}=${level}`, suffix: `${HEADER}\n${line}` });
    }
  }
  out.push({ id: "register=expert", suffix: `${HEADER}\n${expertLine(["TypeScript", "SQLite", "MLX"])}` });
  return out;
}
