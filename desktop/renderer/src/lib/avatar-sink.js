import { estimateWordTimes } from "./word-timing.js";

/**
 * The speech player's outlet while the face is on screen.
 *
 * TalkingHead plays audio through its own AudioContext and times the mouth
 * off that clock, so while the face is mounted the sentences must go
 * through it rather than through the plain audio element -- otherwise the
 * lips and the sound drift apart. speech.js keeps the queue, the lookahead
 * and the stop semantics; this only answers "play this one, tell me when it
 * is done".
 *
 * Contract with the player: play() may reject only BEFORE anything was
 * queued (a body that is not decodable), so the player can fall back to the
 * element without the sentence ever playing twice. Once queued it always
 * resolves -- stop() settles every pending promise itself, because the
 * library's stopSpeaking() drops queued markers along with the audio and a
 * promise waiting on one would hang forever.
 */
export function createAvatarSink(head, { estimate = estimateWordTimes, graceMs = 2000 } = {}) {
  const pending = new Set();
  let disposed = false;
  let endDisposal;
  const disposal = new Promise((r) => (endDisposal = r));
  const settleAll = () => {
    for (const resolve of pending) resolve();
    pending.clear();
  };
  return {
    async play(blob, text, timing = null) {
      const bytes = await blob.arrayBuffer();
      // Decoding on a context that gets closed mid-way (the pane unmounted
      // between the thumbnail and the panel) can leave the promise unsettled
      // for good; disposal must win that race, or the drain hangs with it.
      const buffer = await Promise.race([head.audioCtx.decodeAudioData(bytes), disposal.then(() => null)]);
      if (!buffer || disposed) return;
      const words = timing?.words ? timing : estimate(text, buffer.duration * 1000);
      const utterance = {
        audio: buffer,
        words: words.words,
        wtimes: words.wtimes,
        wdurations: words.wdurations,
      };
      // Real mouth shapes, when the voice can provide them, replace the
      // estimate without the player knowing.
      if (timing?.visemes) {
        utterance.visemes = timing.visemes;
        utterance.vtimes = timing.vtimes;
        utterance.vdurations = timing.vdurations;
      }
      await new Promise((resolve) => {
        pending.add(resolve);
        let watchdog = null;
        const done = () => {
          clearTimeout(watchdog);
          pending.delete(resolve);
          resolve();
        };
        // The clip's own length bounds the wait. A marker the library drops
        // for any reason -- a context it could not resume, an exception in
        // its own chain -- must not leave the voice loop in "speaking".
        watchdog = setTimeout(() => {
          if (!pending.has(resolve)) return;
          console.warn("[avatar] the clip ended without the head's marker; carrying on without it");
          done();
        }, buffer.duration * 1000 + graceMs);
        try {
          // isRaw: no 300ms break queued after the clip and no scripted glance
          // at the camera -- the player paces sentences, the director the eyes.
          head.speakAudio(utterance, { lipsyncLang: "en", isRaw: true });
          head.speakMarker(done);
        } catch (err) {
          console.warn("[avatar] the head refused the clip", err);
          done();
        }
      });
    },
    stop() {
      try {
        head.stopSpeaking();
      } catch {
        // Already torn down; there is nothing left to stop.
      }
      settleAll();
    },
    dispose() {
      disposed = true;
      endDisposal();
      settleAll();
    },
  };
}
