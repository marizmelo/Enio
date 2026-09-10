import { getDb } from "./db.js";
import { extractSources } from "../sources.js";

/**
 * The source ledger: how each place knowledge came from has fared.
 *
 * A counter and nothing more, for now. Facts carry an origin (a URL, a file,
 * a bigger model's answer); some of them get superseded, some get pinned;
 * and a /good on an answer credits the pages that answer read. Counted per
 * source, that is the raw material for a trust signal — one that must stay
 * a tie-breaker, never a label, because single-user data is sparse: a
 * month before any of these numbers means anything, which is why counting
 * starts now and ranking waits (DECISIONS.md).
 *
 * Computed on read from facts, exemplars and turn steps rather than kept
 * as a table: everything it reads is already derived or authoritative,
 * so there is nothing for reindex to rebuild and nothing that can drift.
 */

export interface SourceRow {
  /** A hostname, `file:<path>`, or `handoff:<provider>`. */
  source: string;
  facts: number;
  live: number;
  superseded: number;
  pinned: number;
  /** Answers marked good that read this source. */
  good: number;
}

/** One key per place: a URL by its host, so a site is one row however
 *  many pages of it were read. */
export function sourceKey(origin: string): string | null {
  const o = origin.trim();
  if (!o) return null;
  if (/^https?:\/\//i.test(o)) {
    try {
      return new URL(o).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }
  if (/^handoff:/.test(o)) return o;
  return `file:${o}`;
}

export function sourceLedger(): SourceRow[] {
  const db = getDb();
  const rows = new Map<string, SourceRow>();
  const row = (key: string) => {
    let r = rows.get(key);
    if (!r) {
      r = { source: key, facts: 0, live: 0, superseded: 0, pinned: 0, good: 0 };
      rows.set(key, r);
    }
    return r;
  };

  const facts = db
    .prepare(`SELECT origin, pinned, valid_to FROM facts WHERE origin IS NOT NULL AND origin != ''`)
    .all() as Array<{ origin: string; pinned: number; valid_to: number | null }>;
  for (const f of facts) {
    const key = sourceKey(f.origin);
    if (!key) continue;
    const r = row(key);
    r.facts++;
    if (f.valid_to == null) r.live++;
    else r.superseded++;
    if (f.pinned) r.pinned++;
  }

  // A good answer credits every web page its turn read — the pages, not
  // the search that listed them, since a listing is not a reading.
  const exemplars = db
    .prepare(`SELECT turn_id AS turnId FROM exemplars WHERE turn_id IS NOT NULL`)
    .all() as Array<{ turnId: number }>;
  const stepsFor = db.prepare(
    `SELECT name, args, output FROM turn_steps WHERE turn_id = ? AND kind = 'tool' ORDER BY seq`,
  );
  for (const e of exemplars) {
    const credited = new Set<string>();
    const steps = stepsFor.all(e.turnId) as Array<{ name: string | null; args: string | null; output: string | null }>;
    for (const s of steps) {
      if (!s.name || s.name === "web_search") continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(s.args ?? "{}") as Record<string, unknown>;
      } catch {
        /* unparseable args: the tool never ran with them */
      }
      for (const src of extractSources(s.name, args, s.output ?? "")) {
        const key = src.kind === "file" ? `file:${src.path}` : sourceKey(src.url);
        if (key) credited.add(key);
      }
    }
    for (const key of credited) row(key).good++;
  }

  return [...rows.values()].sort((a, b) => b.facts + b.good - (a.facts + a.good) || a.source.localeCompare(b.source));
}
