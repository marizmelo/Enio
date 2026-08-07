import { getDb } from "./memory/db.js";
import { embed, embedBatch } from "./memory/embed.js";
import { cosine } from "./memory/db.js";

/**
 * Finding what's worth automating, from evidence rather than intuition.
 *
 * The usual failure in automation is deciding in advance what ought to be
 * repetitive and being wrong about it. enio already records every turn, so the
 * question is answerable directly: what have you actually repeated?
 *
 * Three signals, in descending order of how much they tell you:
 *
 *  1. Clusters of near-identical questions — you have been re-explaining the
 *     same thing, which is a skill you never wrote down.
 *  2. Repeated tool sequences — the same steps in the same order, which is a
 *     procedure whether or not you think of it as one.
 *  3. Time concentration inside a cluster — the same ask every Monday is a
 *     schedule, not a prompt.
 */

export interface TurnFact {
  id: number;
  question: string;
  specialist: string;
  startedAt: number;
  tools: string[];
}

export function loadTurnFacts(limit = 2000): TurnFact[] {
  const db = getDb();
  const turns = db
    .prepare(
      `SELECT id, question, specialist, started_at AS startedAt
       FROM turns ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as Omit<TurnFact, "tools">[];

  const toolsFor = db.prepare(
    `SELECT name FROM turn_steps WHERE turn_id = ? AND kind = 'tool' ORDER BY seq`,
  );

  return turns.map((t) => ({
    ...t,
    tools: (toolsFor.all(t.id) as { name: string | null }[])
      .map((r) => r.name ?? "")
      .filter(Boolean),
  }));
}

/* ---------- clustering -------------------------------------------------- */

export interface Cluster<T> {
  members: T[];
  /** The member closest to the rest — used as the human-readable label. */
  representative: T;
}

/**
 * Greedy single-pass clustering.
 *
 * Deliberately not k-means: the number of clusters isn't known, most turns
 * belong to no cluster at all, and a greedy threshold pass is both easier to
 * explain and easier to trust. If a suggestion is wrong you want to be able to
 * see immediately why it grouped what it did.
 */
export function clusterBy<T>(
  items: T[],
  similarity: (a: T, b: T) => number,
  threshold: number,
  minSize = 3,
): Cluster<T>[] {
  const unassigned = [...items];
  const clusters: Cluster<T>[] = [];

  while (unassigned.length > 0) {
    const seed = unassigned.shift()!;
    const members = [seed];

    for (let i = unassigned.length - 1; i >= 0; i--) {
      if (similarity(seed, unassigned[i]!) >= threshold) {
        members.push(unassigned[i]!);
        unassigned.splice(i, 1);
      }
    }

    if (members.length >= minSize) clusters.push({ members, representative: seed });
  }

  return clusters.sort((a, b) => b.members.length - a.members.length);
}

/**
 * Crude suffix stripping, so "summarise", "summarize" and "summary" collapse to
 * one token, as do "work" and "worked".
 *
 * Without this the lexical fallback fails on precisely the cases that matter:
 * people rephrase when they repeat themselves, and the rephrasing is usually a
 * tense change or a British/American spelling. Not a real stemmer — it only has
 * to make repeated asks look alike, and over-stemming two unrelated words into
 * a false match costs more than missing one.
 */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/ise(s|d)?$/, "ize").replace(/isation$/, "ization");
  const suffixes = ["izations", "ization", "izes", "ized", "ize", "ings", "ing", "ies", "ied", "es", "ed", "ly", "s", "y", "e"];
  for (const suffix of suffixes) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

/** Jaccard overlap of stemmed content words. Used when embeddings are unavailable. */
export function lexicalSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w))
        .map(stem),
    );
  const setA = words(a);
  const setB = words(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared++;
  return shared / (setA.size + setB.size - shared);
}

const STOPWORDS = new Set([
  "what", "when", "where", "which", "that", "this", "with", "from", "have",
  "does", "your", "there", "about", "would", "could", "should", "please",
  "make", "just", "like", "want", "need", "tell", "show", "give",
]);

/* ---------- time patterns ---------------------------------------------- */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface TimePattern {
  description: string;
  cron: string;
  confidence: number;
}

/**
 * Looks for concentration in weekday or hour-of-day.
 *
 * Requires a clear majority, because with a handful of samples almost any set
 * of timestamps has a mode, and proposing a schedule from noise is worse than
 * proposing nothing.
 */
export function detectTimePattern(timestamps: number[]): TimePattern | null {
  if (timestamps.length < 3) return null;

  const dates = timestamps.map((t) => new Date(t));
  const byDay = tally(dates.map((d) => d.getDay()));
  const byHour = tally(dates.map((d) => d.getHours()));

  const topDay = strongest(byDay, timestamps.length);
  const topHour = strongest(byHour, timestamps.length);

  if (topDay && topDay.share >= 0.6) {
    const hour = topHour && topHour.share >= 0.5 ? topHour.value : 9;
    return {
      description: `mostly on ${DAYS[topDay.value]}${
        topHour && topHour.share >= 0.5 ? ` around ${hour}:00` : ""
      }`,
      cron: `0 ${hour} * * ${topDay.value}`,
      confidence: topDay.share,
    };
  }

  if (topHour && topHour.share >= 0.6) {
    return {
      description: `mostly around ${topHour.value}:00, across the week`,
      cron: `0 ${topHour.value} * * *`,
      confidence: topHour.share,
    };
  }

  return null;
}

function tally(values: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

function strongest(
  counts: Map<number, number>,
  total: number,
): { value: number; share: number } | null {
  let best: { value: number; share: number } | null = null;
  for (const [value, count] of counts) {
    const share = count / total;
    if (!best || share > best.share) best = { value, share };
  }
  return best;
}

/* ---------- proposals --------------------------------------------------- */

export interface Proposal {
  kind: "skill" | "task";
  title: string;
  reason: string;
  /** Verbatim examples, so a wrong suggestion is obvious at a glance. */
  evidence: string[];
  suggestedName: string;
  cron?: string;
  tools?: string[];
  specialist?: string;
}

export async function analyse(limit = 2000): Promise<{
  proposals: Proposal[];
  turnsExamined: number;
  usedEmbeddings: boolean;
}> {
  const facts = loadTurnFacts(limit);
  if (facts.length < 5) {
    return { proposals: [], turnsExamined: facts.length, usedEmbeddings: false };
  }

  // Semantic clustering catches rephrasings that word overlap misses, which is
  // most of them — people rarely ask the same thing the same way twice.
  const vectors = await embedBatch(facts.map((f) => f.question));
  const usedEmbeddings = vectors.some(Boolean);

  const similarity = usedEmbeddings
    ? (a: TurnFact, b: TurnFact) => {
        const va = vectors[facts.indexOf(a)];
        const vb = vectors[facts.indexOf(b)];
        return va && vb ? cosine(va, vb) : 0;
      }
    : (a: TurnFact, b: TurnFact) => lexicalSimilarity(a.question, b.question);

  const threshold = usedEmbeddings ? 0.82 : 0.4;
  const proposals: Proposal[] = [];

  for (const cluster of clusterBy(facts, similarity, threshold)) {
    const timing = detectTimePattern(cluster.members.map((m) => m.startedAt));
    const tools = commonTools(cluster.members);
    const specialist = majoritySpecialist(cluster.members);

    proposals.push({
      kind: timing ? "task" : "skill",
      title: shorten(cluster.representative.question),
      reason: timing
        ? `Asked ${cluster.members.length} times, ${timing.description}.`
        : `Asked ${cluster.members.length} times in different words.`,
      evidence: cluster.members.slice(0, 4).map((m) => shorten(m.question, 100)),
      suggestedName: slug(cluster.representative.question),
      cron: timing?.cron,
      tools: tools.length ? tools : undefined,
      specialist,
    });
  }

  // A repeated tool sequence is a procedure even when the wording varies too
  // much to cluster, so this catches cases the question clustering misses.
  for (const [sequence, members] of groupByToolSequence(facts)) {
    if (members.length < 3) continue;
    const alreadyCovered = proposals.some((p) =>
      members.some((m) => p.evidence.includes(shorten(m.question, 100))),
    );
    if (alreadyCovered) continue;

    proposals.push({
      kind: "skill",
      title: `Repeated sequence: ${sequence.replace(/,/g, " → ")}`,
      reason: `The same ${sequence.split(",").length} tools ran in the same order ${members.length} times.`,
      evidence: members.slice(0, 4).map((m) => shorten(m.question, 100)),
      suggestedName: slug(sequence.replace(/,/g, "-")),
      tools: sequence.split(","),
      specialist: majoritySpecialist(members),
    });
  }

  return { proposals, turnsExamined: facts.length, usedEmbeddings };
}

function groupByToolSequence(facts: TurnFact[]): Map<string, TurnFact[]> {
  const groups = new Map<string, TurnFact[]>();
  for (const f of facts) {
    if (f.tools.length < 2) continue; // a single tool is not a procedure
    const key = f.tools.join(",");
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return groups;
}

function commonTools(members: TurnFact[]): string[] {
  const counts = new Map<string, number>();
  for (const m of members) {
    for (const tool of new Set(m.tools)) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= members.length * 0.5)
    .map(([tool]) => tool);
}

function majoritySpecialist(members: TurnFact[]): string | undefined {
  const counts = new Map<string, number>();
  for (const m of members) counts.set(m.specialist, (counts.get(m.specialist) ?? 0) + 1);
  const [top] = [...counts.entries()].sort(([, a], [, b]) => b - a);
  return top && top[1] > members.length / 2 ? top[0] : undefined;
}

export function shorten(text: string, max = 70): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1) + "…";
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .slice(0, 3)
      .join("-") || "untitled"
  );
}

/** A starting point, not a finished skill — the user knows their own method. */
export function draftSkill(proposal: Proposal): string {
  const trigger = proposal.evidence.map((e) => `  - "${e}"`).join("\n");
  return `---
name: ${proposal.suggestedName}
description: >-
  ${proposal.title}. Use when the user asks something like the examples below.
${proposal.tools ? `allowed-tools: [${proposal.tools.join(", ")}]\n` : ""}---

# ${proposal.title}

> Drafted from ${proposal.reason.toLowerCase()}
> Replace everything below with how you actually want this done.

## When this applies

Asked in forms like:
${trigger}

## Method

1. …

## Rules

- …
`;
}
