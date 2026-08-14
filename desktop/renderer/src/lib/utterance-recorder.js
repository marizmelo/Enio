// Relative, not the @/ alias: this module is also imported by the node
// test suite (src/utterance-vad.test.ts), which has no bundler to resolve
// aliases. dictation.js is top-level-safe outside a browser.
import { downsample, encodeWav } from "./dictation.js";

/**
 * Listening for utterances, not recording a session.
 *
 * The third recorder variant, and the first with endpointing: dictation
 * keeps everything and re-encodes on demand; the meeting recorder flushes
 * on a timer; this one detects when the user STARTS and STOPS talking and
 * emits one WAV per utterance. The voice-conversation loop is its only
 * customer, and the loop's whole rhythm — listen, answer, listen again —
 * hangs on the endpointing being honest.
 *
 * The VAD is deliberately dumb: RMS per audio block against a threshold,
 * with an onset debounce and a silence hangover. No spectral features, no
 * model — a wrong "utterance ended" costs one awkward turn boundary, and
 * the server-side worker already rejects silence and degenerate text, so
 * the failure the tracker must actually prevent is CHATTER: turns firing
 * off door slams and coughs.
 *
 * Buffering is gated: chunks accumulate only while an utterance is live,
 * plus a small always-maintained pre-roll ring — onset detection lags real
 * speech by ONSET_BLOCKS, and without the ring the first syllable of every
 * utterance would be clipped, which is exactly the part whisper needs.
 * Idle listening therefore stays flat in memory for hours.
 *
 * pause() mutes at the track and resets the tracker rather than tearing
 * the graph down: re-running getUserMedia per turn would flash the OS mic
 * indicator every cycle and add latency. The indicator staying lit for the
 * whole session is the honest signal — the mode is on.
 */

/* VAD parameters. Exported for the tests, named for the reasoning. */
// Above the transcribe worker's silence floor (0.005) and below quiet
// speech (~0.02+); noiseSuppression keeps a normal room well under it.
export const SPEECH_RMS = 0.015;
// ~256ms sustained at 48kHz/4096-sample blocks — a door slam is one block.
export const ONSET_BLOCKS = 3;
// Mid-sentence pauses run 300–600ms; ending there would split clauses
// into separate turns and answer half a question.
export const HANG_MS = 1000;
// Voiced time below this is a blip — a cough transcribes as garbage the
// worker's degenerate gate may still let through.
export const MIN_UTTERANCE_MS = 400;
// The transcriptions route is uncapped and the whisper FIFO is serial
// with no cancel; this cap is what protects both from a monologue.
export const MAX_UTTERANCE_MS = 30000;
// The onset debounce lags real speech; the ring covers the gap.
export const PREROLL_MS = 430;

/** RMS of one Float32 block — the only signal the tracker sees. */
export function blockRms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/**
 * Pure endpointing math: fed one RMS per block, answers with what just
 * happened. No AudioContext, no time source of its own (block count IS the
 * clock) — which is what makes it testable from node.
 *
 * Events: "start" (speech confirmed, begin capturing), "end" (utterance
 * complete, ≥ minMs voiced), "drop" (fell silent before minMs — discard),
 * "flush" (maxMs cap hit — emit what exists; the tracker stays in-speech
 * so the continuation becomes a new utterance with no lost audio).
 */
export function createVadTracker({
  blockMs,
  speechRms = SPEECH_RMS,
  onsetBlocks = ONSET_BLOCKS,
  hangMs = HANG_MS,
  minMs = MIN_UTTERANCE_MS,
  maxMs = MAX_UTTERANCE_MS,
} = {}) {
  let loudRun = 0;
  let inSpeech = false;
  let voicedBlocks = 0;
  let silentBlocks = 0;
  let totalBlocks = 0;

  const reset = () => {
    loudRun = 0;
    inSpeech = false;
    voicedBlocks = 0;
    silentBlocks = 0;
    totalBlocks = 0;
  };

  return {
    reset,
    push(rms) {
      const loud = rms >= speechRms;
      if (!inSpeech) {
        loudRun = loud ? loudRun + 1 : 0;
        if (loudRun >= onsetBlocks) {
          inSpeech = true;
          voicedBlocks = loudRun;
          silentBlocks = 0;
          totalBlocks = loudRun;
          return "start";
        }
        return null;
      }

      totalBlocks++;
      if (loud) {
        voicedBlocks++;
        silentBlocks = 0;
      } else {
        silentBlocks++;
      }

      if (totalBlocks * blockMs >= maxMs) {
        // Stay in-speech: the monologue continues, only the WAV is cut.
        voicedBlocks = 0;
        silentBlocks = 0;
        totalBlocks = 0;
        return "flush";
      }
      if (silentBlocks * blockMs >= hangMs) {
        const voicedMs = voicedBlocks * blockMs;
        reset();
        return voicedMs >= minMs ? "end" : "drop";
      }
      return null;
    },
  };
}

export async function startUtteranceRecorder({ onUtterance, onLevel }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    // echoCancellation stays on: it is free residual-echo insurance for the
    // guard window after enio stops speaking, even though the loop's real
    // echo answer is half-duplex, not this.
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);

  const blockMs = (4096 / context.sampleRate) * 1000;
  const preRollBlocks = Math.max(1, Math.round(PREROLL_MS / blockMs));
  const tracker = createVadTracker({ blockMs });

  let preRoll = [];
  let chunks = null; // null = not in an utterance
  let paused = false;
  let stopped = false;

  const emit = () => {
    const mine = chunks ?? [];
    chunks = null;
    if (mine.length === 0) return;
    const total = mine.reduce((n, c) => n + c.length, 0);
    const joined = new Float32Array(total);
    let at = 0;
    for (const c of mine) {
      joined.set(c, at);
      at += c.length;
    }
    onUtterance(encodeWav(downsample(joined, context.sampleRate, 16000), 16000));
  };

  processor.onaudioprocess = (event) => {
    if (paused || stopped) return;
    const block = new Float32Array(event.inputBuffer.getChannelData(0));

    if (chunks === null) {
      preRoll.push(block);
      if (preRoll.length > preRollBlocks) preRoll.shift();
    } else {
      chunks.push(block);
    }

    const verdict = tracker.push(blockRms(block));
    if (verdict === "start") {
      chunks = [...preRoll, ...(chunks ?? [])];
      preRoll = [];
      onLevel?.(true);
    } else if (verdict === "end") {
      emit();
      onLevel?.(false);
    } else if (verdict === "drop") {
      chunks = null;
      onLevel?.(false);
    } else if (verdict === "flush") {
      // Cut the WAV, keep capturing: the tracker stayed in-speech, so the
      // continuation lands in a fresh chunk list with no lost audio.
      emit();
      chunks = [];
    }
  };
  source.connect(processor);
  processor.connect(context.destination);

  const release = () => {
    processor.disconnect();
    source.disconnect();
    // Stopping the tracks is what turns the menu-bar mic indicator off.
    for (const track of stream.getTracks()) track.stop();
    context.close();
  };

  return {
    /** The half-duplex gate: mute at the source, forget everything heard. */
    pause() {
      paused = true;
      for (const track of stream.getTracks()) track.enabled = false;
      preRoll = [];
      chunks = null;
      tracker.reset();
    },
    resume() {
      if (stopped) return;
      paused = false;
      for (const track of stream.getTracks()) track.enabled = true;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      release();
    },
  };
}
