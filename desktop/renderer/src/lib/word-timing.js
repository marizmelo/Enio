/**
 * Where each word falls in a clip whose length is all we know.
 *
 * The voice gives back audio and nothing else: no word boundaries, no
 * phonemes with durations. The face needs word timings to shape its mouth,
 * so they are estimated -- the clip's length shared out across the words by
 * how much there is to say in each, with a breath at punctuation. Sentence-
 * sized clips keep the error small: a word is rarely more than a syllable's
 * worth off, which is below what a watching eye resolves at speech rate.
 *
 * Pure, and separate from the player, so that when the voice can hand back
 * real timings this module simply stops being called.
 */

// Breaths, as a fraction of an average word's time.
const PAUSE_MINOR = 0.35; // , ; :
const PAUSE_MAJOR = 0.7; // . ! ? …

export function estimateWordTimes(text, durationMs, { leadMs = 60, tailMs = 80 } = {}) {
  const words = String(text ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const duration = Math.max(0, Number(durationMs) || 0);
  if (words.length === 0) return { words: [], wtimes: [], wdurations: [] };

  // Letters and digits carry the time; punctuation and symbols do not.
  const weights = words.map((w) => Math.max(1, (w.match(/[\p{L}\p{N}]/gu) ?? []).length));
  const gaps = words.map((w, i) => {
    if (i === words.length - 1) return 0;
    if (/[.!?…]["')\]]*$/.test(w)) return PAUSE_MAJOR;
    if (/[,;:]["')\]]*$/.test(w)) return PAUSE_MINOR;
    return 0;
  });
  const meanWeight = weights.reduce((a, b) => a + b, 0) / weights.length;
  const units = weights.reduce((a, b) => a + b, 0) + gaps.reduce((a, g) => a + g * meanWeight, 0);
  const span = Math.max(0, duration - leadMs - tailMs);
  const unit = units > 0 ? span / units : 0;

  const wtimes = [];
  const wdurations = [];
  let t = Math.min(leadMs, duration);
  words.forEach((w, i) => {
    // Start and end are rounded separately so a word never ends after the
    // next begins: round(t) + round(d) can exceed round(t + d) by one.
    const start = Math.round(t);
    const end = Math.round(t + weights[i] * unit);
    wtimes.push(start);
    wdurations.push(Math.max(0, end - start));
    t += weights[i] * unit + gaps[i] * meanWeight * unit;
  });
  return { words, wtimes, wdurations };
}
