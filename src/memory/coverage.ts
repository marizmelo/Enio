import { getDb } from "./db.js";
import { ENTITY_TYPES } from "./schema.js";

/**
 * The coverage map: what memory holds anything about, as a block small
 * enough to ride every turn.
 *
 * The facts block answers "what do I know about X"; nothing answered "do I
 * know about X at all", so a small model asked about something absent from
 * memory guessed, confidently. This turns that into a membership check —
 * the classification-shaped question this model size gets right — and it
 * is structural humility: the model does not judge its own knowledge, it
 * reads a list.
 *
 * Derived from the graph, never authoritative, so `enio reindex` rebuilds
 * it like everything else. Sized from the caller's budget (a share of
 * contextBudget()) rather than a constant: on Maple's 2,000 tokens a real
 * graph measured at ~220 tokens unabridged, which is a tenth of the whole
 * window spent on a table of contents. Filled round-robin across entity
 * types by connectedness, so one crowded type (concepts, technologies)
 * cannot push people and projects off the end; the "+N" tails keep the
 * count honest about what was cut.
 */
export interface ConnectedEntity {
  name: string;
  type: string;
  degree: number;
}

/** Every entity with its live-edge degree, most connected first. Shared
 *  with the personality derivation, which reads the same shape of the
 *  graph — one query per turn, not two. */
export function connectedEntities(): ConnectedEntity[] {
  return getDb()
    .prepare(
      `SELECT e.name, e.type, COUNT(ed.id) AS degree
         FROM entities e
         LEFT JOIN edges ed ON (ed.src = e.id OR ed.dst = e.id) AND ed.valid_to IS NULL
        GROUP BY e.id
        ORDER BY degree DESC, e.last_seen DESC`,
    )
    .all() as ConnectedEntity[];
}

export function coverageBlock(maxChars: number, rows: ConnectedEntity[] = connectedEntities()): string {
  if (maxChars < 40) return "";
  if (rows.length === 0) return "";

  const byType = new Map<string, string[]>();
  for (const type of ENTITY_TYPES) byType.set(type, []);
  for (const r of rows) byType.get(r.type)?.push(r.name);

  const plural: Record<string, string> = {
    person: "people", project: "projects", technology: "technologies",
    organization: "organizations", place: "places", concept: "concepts",
  };
  const header = "Memory has something on — ";
  const footer =
    ". Anything not here and not in the facts below, you do not remember: say so rather than guess.";
  const room = maxChars - header.length - footer.length;
  if (room < 20) return "";

  // Round-robin: one name per type per pass, until the next name would not
  // fit. Rendered length is tracked as it will print, tails included.
  const taken = new Map<string, number>();
  const render = () =>
    [...byType.entries()]
      .filter(([, names]) => names.length > 0)
      .map(([type, names]) => {
        const n = taken.get(type) ?? 0;
        const rest = names.length - n;
        const list = names.slice(0, n).join(", ");
        return `${plural[type] ?? type}: ${list}${rest > 0 ? (n > 0 ? ` (+${rest})` : `(${rest})`) : ""}`;
      })
      .join(" · ");

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [type, names] of byType) {
      const n = taken.get(type) ?? 0;
      if (n >= names.length) continue;
      taken.set(type, n + 1);
      if (render().length > room) {
        taken.set(type, n);
        continue;
      }
      progressed = true;
    }
  }
  const body = render();
  if (body.length > room || [...taken.values()].every((n) => n === 0)) return "";
  return header + body + footer;
}
