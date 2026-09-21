/**
 * What a question is *about*, as words — shared by the seed search's
 * "do we already know this" check, the coverage test, and the gap ledger.
 *
 * One definition on purpose: a gap is recorded with exactly the terms the
 * turn was judged uncovered on, and resolved when a later fact carries all
 * of them. Two slightly different tokenisers here would record gaps that
 * could never be resolved, silently.
 */
const STOPWORDS = new Set(
  "what when where which who whom whose why how does did do is are was were will would could should the this that these those about with from into over under after before then than there here have has had been being tell give show find happened happen happens latest news today year".split(
    " ",
  ),
);

export function distinctiveTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
    ),
  ];
}

/**
 * Whether an earlier reply in this conversation already speaks to the
 * question — the strict form, for the thread. Memory coverage matches on
 * the distinctive terms (four letters and up), which is right for facts
 * that were deliberately kept; a reply the model wrote a minute ago is not
 * knowledge of that standing, so here EVERY word of the question that is
 * not a stopword must appear in one earlier reply, short ones included.
 * Watched happen: "nd studio arquitetura" was judged covered by a reply
 * about architecture firms in Recife, because "nd" is two letters and was
 * dropped — so no search ran, and the researcher declared the firm did
 * not exist.
 */
export function threadCovers(question: string, replies: string[]): boolean {
  const tokens = [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 2 && !STOPWORDS.has(w)),
    ),
  ];
  if (tokens.length === 0) return false;
  return replies.some((r) => {
    const words = new Set(r.toLowerCase().split(/[^a-z0-9]+/));
    return tokens.every((t) => words.has(t));
  });
}

/** The shape test the seed search uses: long enough to be about something,
 *  and not a greeting or a thank-you, which would search for nothing. */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  return t.length >= 12 && !/^(hi|hello|hey|thanks|thank you|ok|okay)\b/i.test(t);
}
