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

/* ---------- names the evidence never gave ------------------------------- */

/**
 * Title Case runs of two or more words, with the small joiners names use.
 *
 * Two boundaries the first version lacked. A run may not begin inside a
 * token: "16GB RAM" gave "GB RAM", "macOS Sequoia" gave "OS Sequoia". And
 * a joiner must be a whole word: "Casa Norte offers" matched "of" and
 * became "Casa Norte of". The lookarounds are spelled out because \b is
 * ASCII-only here and takes "é" for a word boundary.
 */
const TITLE_RUN =
  /(?<![\p{L}\p{N}])(?:\p{Lu}[\p{L}'’-]+)(?:\s+(?:(?:de|da|do|dos|das|e|of|and|the)(?![\p{L}\p{N}'’-])|&|\p{Lu}[\p{L}'’-]+)){1,6}/gu;
const JOINERS = new Set(["de", "da", "do", "dos", "das", "e", "of", "and", "the", "&"]);
/** Bare labels the model heads a paragraph with. */
const NOT_A_NAME = /^(conclusion|summary|note|key points?|overview|sources?|answer|result|in short|tl ?dr)$/i;
/**
 * Words a run picks up from the sentence around a name: the pattern above
 * starts at any capital, so "Is Flamengo", "The Lucid Air" and "Casa Norte
 * and" all come back. They are taken off the span, not used to discard it:
 * discarding meant any invented name that followed "The" was never checked.
 */
const OPENER =
  /^(?:is|are|was|were|the|a|an|in|on|at|as|if|but|and|or|for|to|by|with|from|important|key|final|main|additional|note|here)(?![\p{L}\p{N}'’-])\s*/iu;
const TRAILER = /\s*(?<![\p{L}\p{N}'’-])(?:and|or|of|the|de|da|do|dos|das|e|&)$/iu;

/** One dash and one apostrophe: a model writes "0–0", the page "0-0". */
const sameMarks = (text: string) => text.replace(/[‐-―−]/g, "-").replace(/[‘’]/g, "'");

/** A span without the sentence words on either side of it. */
function trimmed(span: string): string {
  let out = span;
  for (;;) {
    const next = out.replace(OPENER, "").replace(TRAILER, "").trim();
    if (next === out) return out;
    out = next;
  }
}

const capitalised = (span: string) => span.split(/\s+/).filter((w) => /^\p{Lu}/u.test(w)).length;

/**
 * The words of a span that carry a name: its capitalised words, without
 * joiners and possessives. Lower-case words are the model's own wording
 * ("victory" for the page's "win"), and figures are not names -- every page
 * holds a 2, a 10 and a 2026, so their presence proves nothing, and a
 * figure the page gives in another language ("36ª rodada" for "36th
 * round") is not an invention.
 */
function nameWords(span: string): string[] {
  const out: string[] = [];
  for (const raw of span.split(/\s+/)) {
    const word = raw
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
      .replace(/'s$/i, "")
      .replace(/s'$/i, "s");
    if (!word || /\d/.test(word) || !/^\p{Lu}/u.test(word)) continue;
    if (JOINERS.has(word.toLowerCase())) continue;
    out.push(word.toLowerCase());
  }
  return out;
}

/**
 * Names a reply asserts that the evidence it was given never mentions.
 *
 * Watched happen: asked for the best architecture firm in Recife, the
 * researcher searched, was handed 6,500 characters of results, and named
 * three firms that appear in none of them -- in bold, with specialities.
 * The sources sat under the answer looking like support. A claim and an
 * invention are indistinguishable in prose; the one structural check
 * available is whether the entities the reply commits to exist in what it
 * read. Candidates are bold spans and Title Case runs of two or more
 * words. A name the user typed is theirs, not an invention.
 *
 * A name is known by its words, not by its phrase. The first version
 * wanted the phrase as typed, and on 66 labelled research turns
 * (DECISIONS.md, scripts/names-bench.mjs) that named 227 things as missing
 * of which 153 were not inventions: "South American" against "South
 * America's", "2026 Copa Libertadores" against "Copa Libertadores final
 * 2026", "Dell XPS 13 2026" against "Dell XPS 13 (2026)". It withdrew 16
 * of the 38 sound answers. So a span is supported when every capitalised
 * word in it is somewhere in the evidence, allowing another ending. On
 * the same turns that names 76 things, 24 of them wrongly, and withdraws
 * 4 of the 38.
 *
 * The cost is stated in the same numbers. A name assembled from words the
 * page uses about other things now passes ("Yahoo Finance" where the page
 * has a Yahoo and a finance), and 21 of the 28 answers that held a
 * material invention are withdrawn, where the phrase test withdrew 26.
 *
 * What neither version can see, measured on the same turns: most material
 * inventions are not names. They are specifications, quantities and wrong
 * accounts of what happened, and this check passes them.
 */
export function namesWithoutEvidence(reply: string, evidence: string[], question: string): string[] {
  const hay = sameMarks(evidence.join("\n") + "\n" + question).toLowerCase().replace(/\s+/g, " ");
  const words = new Set<string>();
  for (const w of hay.split(/[^\p{L}\p{N}-]+/u)) {
    if (!w) continue;
    words.add(w);
    for (const part of w.split("-")) {
      if (!part) continue;
      words.add(part);
      // A unit written against its number: "16gb" holds a "gb".
      for (const piece of part.split(/(?<=\d)(?=\p{L})|(?<=\p{L})(?=\d)/u)) if (piece) words.add(piece);
    }
  }
  const wordList = [...words];
  const known = (word: string): boolean => {
    if (words.has(word)) return true;
    if (word.length < 4) return false;
    // The same word with another ending: "american" for "america",
    // "brazilian" for "brazil". One begins the other, three letters apart
    // at most, and neither is short enough to begin half the dictionary.
    return wordList.some((w) => {
      if (w.length < 4) return false;
      const [short, long] = w.length <= word.length ? [w, word] : [word, w];
      return long.length - short.length <= 3 && long.startsWith(short);
    });
  };

  const spans = new Set<string>();
  const add = (text: string, kind: "bold" | "title") => {
    const name = trimmed(
      sameMarks(text)
        // A parenthesised acronym after a name is part of the same claim.
        .replace(/\s*\(\p{Lu}[\p{Lu}\p{N}]{1,5}\)\s*$/u, "")
        .replace(/[*_`"“”().,:;!?]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    // One capitalised word is a sentence start as often as a name, in any
    // alphabet: "Conclusão" is no more a name than "Conclusion".
    if (name.length < 3 || /^\p{Lu}\p{Ll}*$/u.test(name) || NOT_A_NAME.test(name)) return;
    // A run is a name by its capitals; with one left it was a sentence.
    if (kind === "title" && capitalised(name) < 2) return;
    spans.add(name);
  };
  for (const m of reply.matchAll(/\*\*([^*\n]{3,80})\*\*/g)) add(m[1]!.trim(), "bold");
  // No period inside a word: "Arquitetos. Estúdio" must be two runs, not one.
  for (const m of sameMarks(reply).matchAll(TITLE_RUN)) add(m[0]!.trim(), "title");

  const missing: string[] = [];
  for (const name of spans) {
    if (hay.includes(name.toLowerCase())) continue;
    const parts = nameWords(name);
    // No capitalised word at all: emphasis or a figure, not a name.
    if (parts.length === 0) continue;
    if (parts.every(known)) continue;
    missing.push(name);
  }
  return missing;
}

/**
 * Whether missing names withdraw the reply: any one is enough.
 *
 * Measured, because one stray name looked too thin to act on. Of the 25
 * labelled turns the check fires on, 11 have exactly one missing name, and
 * 9 of those 11 answers held a material invention all the same. Written
 * again from the sources, 8 of the 11 came out better, 3 the same and none
 * worse. Under the correction wording this replaced it was 3 better and 6
 * worse, so "two or more" was the right threshold then and is not now. If
 * the wording in agent.ts changes, this is the number to measure again.
 */
export function withdrawsForNames(missing: string[]): boolean {
  return missing.length > 0;
}
