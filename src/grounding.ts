/**
 * The grounding check: hard specifics in a reply must come from somewhere.
 *
 * "Don't make things up" cannot be enforced by prompt -- it is a sentence
 * the model completes patterns against, and the moment it has nothing
 * grounded to say is exactly the moment it produces a fluent invention
 * (watched happen: a resume with a fabricated employer, phone number and
 * email, none of which appeared in any file, tool output or message).
 *
 * What CAN be enforced is provenance of the checkable class: emails, phone
 * numbers, URLs, money, percentages and name-like proper nouns either
 * appear in the turn's sources or they came from the model's weights.
 * Prose paraphrase never trips this -- rewording is what a language model
 * is for. Specifics are precisely the class that must be copied, not
 * composed. Same transformation as everything else here: "is this true?"
 * is unanswerable, "does this string appear in the source?" is mechanical.
 *
 * Warn-only by design. A false positive costs a one-line notice the user
 * can ignore; blocking or rewriting on a false positive would cost a good
 * answer, which is worse. And only turns that read source material are
 * checked at all -- flagging ordinary conversation, or an explicitly
 * creative ask, would train the user to ignore the notice.
 */

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL = /\bhttps?:\/\/[^\s)>\]"']+|\b[\w-]+\.(?:com|org|net|io|dev|ai|app)\b(?:\/[^\s)>\]"']*)?/g;
/** At least 8 digits with phone punctuation, so versions and line numbers
 *  stay out. Compared digits-only, so formatting differences cannot hide a
 *  match or invent a miss. */
const PHONE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const MONEY = /[$€£]\s?\d[\d,.]*(?:\s?[kKmM])?/g;
const PERCENT = /\b\d+(?:\.\d+)?\s?%/g;

/** TitleCase runs of 2+ words ("TechNova Solutions", "Acme Corp"), allowing
 *  small joiners. Single words are far too noisy to check. */
const PROPER = /\b[A-Z][a-zA-Z]+(?:\s+(?:of|and|the|for|de|da|do)\s+|\s+)[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g;

/** TitleCase sequences made only of these are document furniture -- section
 *  headings and label-speak the model legitimately composes when writing a
 *  new document -- not entities whose provenance matters. */
const GENERIC = new Set([
  "professional", "summary", "experience", "experiences", "skills", "skill",
  "key", "education", "work", "history", "contact", "information", "projects",
  "project", "certifications", "certification", "references", "reference",
  "cover", "letter", "objective", "profile", "highlights", "achievements",
  "recognition", "awards", "languages", "interests", "core", "technical",
  "additional", "relevant", "selected", "notable", "publications", "volunteer",
  "leadership", "management", "development", "engineering", "software",
  "senior", "junior", "lead", "principal", "staff", "step", "plan", "next",
  "final", "note", "notes", "overview", "introduction", "conclusion",
  "markdown", "format", "version", "table", "contents", "appendix",
]);

const digitsOf = (s: string) => s.replace(/\D/g, "");

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s ]+/g, " ").trim();
}

/**
 * Specifics in `reply` that appear nowhere in `sources`.
 *
 * Sources should be everything the turn could legitimately copy from: the
 * user's own words, tool outputs, attachments, the project's fields. Not
 * earlier model replies -- an invention repeated is still an invention, and
 * letting one turn's fabrication launder the next turn's is the exact hole
 * this exists to close.
 */
export function unsupportedSpecifics(reply: string, sources: string[]): string[] {
  const haystack = normalize(sources.join("\n"));
  const haystackDigits = sources.map((s) => digitsOf(s)).join("\n");

  const flagged: string[] = [];
  const seen = new Set<string>();
  const flag = (item: string) => {
    const key = normalize(item);
    if (!seen.has(key)) {
      seen.add(key);
      flagged.push(item.trim());
    }
  };

  for (const m of reply.match(EMAIL) ?? []) {
    if (!haystack.includes(normalize(m))) flag(m);
  }
  for (const m of reply.match(URL) ?? []) {
    if (!haystack.includes(normalize(m))) flag(m);
  }
  for (const m of reply.match(PHONE) ?? []) {
    const digits = digitsOf(m);
    if (digits.length >= 8 && !haystackDigits.includes(digits)) flag(m);
  }
  for (const m of reply.match(MONEY) ?? []) {
    if (!haystack.includes(normalize(m))) flag(m);
  }
  for (const m of reply.match(PERCENT) ?? []) {
    if (!haystack.includes(normalize(m))) flag(m);
  }
  for (const m of reply.match(PROPER) ?? []) {
    const words = m.split(/\s+/).map((w) => w.toLowerCase());
    // Entirely generic words: a heading, not an entity.
    if (words.every((w) => GENERIC.has(w))) continue;
    if (!haystack.includes(normalize(m))) flag(m);
  }

  return flagged;
}
