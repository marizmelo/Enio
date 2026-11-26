/**
 * Keeping an audio output awake, so the first word is heard.
 *
 * Every clip the server synthesises is complete — each one transcribes back
 * to its own first word — and yet the start of a spoken reply went missing,
 * with the face and without it. What the two paths shared was that the
 * output had been idle: the plain path opened a brand-new stream for every
 * sentence (one `new Audio()` each), and an output that has been silent
 * takes a moment to come up, during which what is "playing" is not heard.
 * How long depends on the device; the clip does not wait for it.
 *
 * So the output is opened before there is anything to say and held open
 * while there is: a looped second of noise far below hearing (-80 dBFS)
 * keeps the stream running and the device awake, and speech starts into an
 * output that is already up. Noise rather than digital silence because some
 * outputs treat a run of zero samples as "nothing playing" and go quiet
 * anyway.
 *
 * It is started at the moment speech becomes likely — a message sent with
 * read-aloud on, the read-aloud button, the conversation mode opening —
 * which is always well before the first clip exists, so the warm-up costs
 * no time. It stops itself a few seconds after the last request: an app
 * that holds the audio device forever keeps a Mac from idling its output
 * and shows as "playing" in the system's eyes.
 */

/** How long an output needs before speech is safe to start into it. */
export const WARM_MS = 350;
const LEVEL = 0.0001;

/**
 * A primer for one AudioContext. `now` and `later` are injected for the
 * tests; the context is asked for lazily so that importing this never
 * creates one.
 */
export function createPrimer(getContext, { now = () => performance.now(), later = setTimeout, cancel = clearTimeout } = {}) {
  let source = null;
  let startedAt = 0;
  let until = 0;
  let timer = null;

  const stop = () => {
    cancel(timer);
    timer = null;
    until = 0;
    if (!source) return;
    try {
      source.stop();
      source.disconnect();
    } catch {
      // Already stopped, or its context is gone.
    }
    source = null;
  };

  return {
    /** Keep the output awake for at least `ms` from now. Never throws: a
     *  primer that cannot run leaves speech exactly as it was. */
    prime(ms = 6000) {
      try {
        const ctx = getContext();
        if (!ctx || ctx.state === "closed") return;
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        if (!source) {
          const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
          const samples = buffer.getChannelData(0);
          for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * LEVEL;
          source = ctx.createBufferSource();
          source.buffer = buffer;
          source.loop = true;
          source.connect(ctx.destination);
          source.start();
          startedAt = now();
        }
        const wanted = now() + ms;
        if (wanted > until) {
          until = wanted;
          cancel(timer);
          timer = later(stop, ms);
        }
      } catch {
        source = null;
      }
    },
    /** Milliseconds the output has been held awake; 0 when it is not. */
    warmFor() {
      return source ? now() - startedAt : 0;
    },
    stop,
  };
}

let shared = null;
/** The one output for speech without a face. Null where there is no Web
 *  Audio — the node test suite, and the player then uses an element. */
export function outputContext() {
  if (shared && shared.state !== "closed") return shared;
  if (typeof AudioContext === "undefined") return null;
  shared = new AudioContext({ latencyHint: "interactive" });
  return shared;
}
