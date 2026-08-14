/**
 * The voice conversation state machine: listen → transcribe → think →
 * speak → listen again.
 *
 * Deliberately HALF-DUPLEX: the mic never listens while enio speaks or
 * thinks. Kokoro through speakers into an open mic would hand whisper
 * enio's own sentences and the agent would answer itself — and nothing
 * short of reference-signal echo cancellation actually prevents that.
 * So the recorder is paused the moment an utterance completes and resumed
 * only after the reply has been fully spoken plus a guard delay for the
 * speaker tail. Interruption is a CLICK on the mode pill, not a voice
 * command, for the same reason: the mic is off precisely when barging in
 * matters.
 *
 * Every dependency is injected and every async continuation is fenced by
 * an EPOCH counter: interrupt(), stop() and setHeld(true) bump it, and a
 * continuation that wakes up in a stale epoch abandons silently. The loop
 * therefore survives dependencies that never settle — a hung transcription
 * (the whisper FIFO has no cancel), a speech drain that leaks — which is
 * the difference between a mode that recovers and one that wedges.
 *
 * Entry, exit and interrupt are USER ACTS in the UI. No tool can reach
 * this machine — the same rule meetings established: a model must never
 * be able to open the microphone.
 */

// Speaker tail + room reverb after the drain resolves, before the mic
// re-arms. Too short and the last syllable of the reply becomes the next
// utterance's pre-roll.
export const GUARD_MS = 300;

export function createVoiceLoop({
  startRecorder, // async ({ onUtterance }) => { pause(), resume(), stop() }
  transcribe, // async (wavBlob) => string; "" means silence — keep listening
  sendTurn, // async (text) => void; resolves when the turn's stream has ended
  speakDone, // () => Promise resolving when the speech queue has drained
  isBusy, // () => bool; an external turn is streaming
  interruptTurn, // () => void; abort the turn AND stop speech, together
  onState = () => {},
  onError = () => {},
  guardMs = GUARD_MS,
  delay = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let state = "idle";
  let recorder = null;
  let epoch = 0;
  let held = false;

  const setState = (next) => {
    state = next;
    onState(next);
  };

  /** True when the continuation that captured `mine` should abandon. */
  const stale = (mine) => mine !== epoch || state === "idle";

  const listen = () => {
    if (state === "idle" || held) return;
    recorder?.resume();
    setState("listening");
  };

  const handleUtterance = async (wav) => {
    if (state !== "listening") return; // held/paused race: discard
    const mine = epoch;
    recorder?.pause();
    setState("transcribing");

    let text = "";
    try {
      text = (await transcribe(wav))?.trim() ?? "";
    } catch (err) {
      onError(err);
    }
    if (stale(mine)) return;

    // Silence, an error, or a turn the user started by typing while we
    // transcribed: the utterance is dropped, honestly — queueing words
    // behind someone's typed message would answer out of order.
    if (!text || isBusy()) {
      listen();
      return;
    }

    setState("thinking");
    try {
      await sendTurn(text);
    } catch (err) {
      onError(err);
      if (!stale(mine)) listen();
      return;
    }
    if (stale(mine)) return;

    setState("speaking");
    await speakDone();
    if (stale(mine)) return;

    await delay(guardMs);
    if (stale(mine)) return;
    listen();
  };

  return {
    get state() {
      return state;
    },

    async start() {
      if (state !== "idle") return;
      epoch++;
      try {
        recorder = await startRecorder({ onUtterance: handleUtterance });
      } catch (err) {
        onError(err);
        recorder = null;
        return;
      }
      held = false;
      // Explicit resume rather than trusting the recorder's initial state:
      // the loop's contract is "listening means the mic is armed", whoever
      // built the recorder.
      recorder.resume();
      setState("listening");
    },

    /** Full teardown. Does NOT abort an in-flight turn — matching what a
     *  conversation switch does today: the words keep arriving in text. */
    stop() {
      if (state === "idle") return;
      epoch++;
      recorder?.stop();
      recorder = null;
      held = false;
      setState("idle");
    },

    /** The pill click during thinking/speaking/transcribing: cut speech,
     *  abort the turn, go straight back to listening. */
    interrupt() {
      if (state === "idle" || state === "listening") return;
      epoch++;
      if (state === "thinking" || state === "speaking") interruptTurn();
      held = false;
      listen();
    },

    /**
     * The typed-message gate: a turn the loop did not start is streaming,
     * and with speech forced on its reply will be spoken — into what must
     * not be an open mic. Held pauses the recorder; release waits out the
     * external turn's speech, then re-listens.
     */
    setHeld(next) {
      if (state === "idle") return;
      if (next && !held) {
        held = true;
        epoch++;
        recorder?.pause();
        setState("held");
      } else if (!next && held) {
        held = false;
        const mine = epoch;
        setState("speaking");
        void (async () => {
          await speakDone();
          if (stale(mine)) return;
          await delay(guardMs);
          if (stale(mine)) return;
          listen();
        })();
      }
    },
  };
}
