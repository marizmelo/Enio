/**
 * The microphone's level, from the recorder to whoever draws it.
 *
 * Its own tiny channel rather than React state: the recorder reports about
 * twelve times a second, and App re-rendering at that rate would redraw the
 * whole thread to move one bar. Subscribers write straight to the DOM.
 */
const listeners = new Set();
let level = 0;

export function setVoiceLevel(rms) {
  level = rms;
  for (const fn of listeners) fn(rms);
}

export function onVoiceLevel(fn) {
  listeners.add(fn);
  fn(level);
  return () => listeners.delete(fn);
}

/** RMS to a 0..1 bar. Speech sits around 0.02 to 0.2, so a linear bar would
 *  barely move; the square root spreads the quiet end where it matters. */
export function meterHeight(rms) {
  return Math.max(0, Math.min(1, Math.sqrt(rms) * 2.2));
}
