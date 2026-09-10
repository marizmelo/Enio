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

/** The shape test the seed search uses: long enough to be about something,
 *  and not a greeting or a thank-you, which would search for nothing. */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  return t.length >= 12 && !/^(hi|hello|hey|thanks|thank you|ok|okay)\b/i.test(t);
}
