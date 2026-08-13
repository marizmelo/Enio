import { downsample, encodeWav } from "@/lib/dictation";

/**
 * Long-form recording, in segments.
 *
 * The dictation recorder keeps every Float32 chunk in memory and re-encodes
 * the lot on each pass — right for a twenty-second utterance, fatal for a
 * meeting (~11.5MB per minute of heap, an hour ≈ 700MB). This variant
 * flushes the buffer as a finished WAV segment every `segmentSeconds` and
 * hands it to the caller, so the renderer's memory stays flat at roughly
 * one segment regardless of how long the meeting runs — and each segment
 * is small enough to upload and transcribe in seconds, which is also what
 * keeps the shared whisper queue short enough for dictation to stay usable.
 *
 * A word split across a segment boundary may transcribe imperfectly;
 * accepted — the output feeds a summary, not a court record.
 */
export async function startMeetingRecorder({ onSegment, segmentSeconds = 45 }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);

  let chunks = [];
  let seq = 0;
  let stopped = false;

  processor.onaudioprocess = (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(context.destination);

  const flush = () => {
    if (chunks.length === 0) return;
    const mine = chunks;
    chunks = [];
    const total = mine.reduce((n, c) => n + c.length, 0);
    const joined = new Float32Array(total);
    let at = 0;
    for (const c of mine) {
      joined.set(c, at);
      at += c.length;
    }
    const wav = encodeWav(downsample(joined, context.sampleRate, 16000), 16000);
    onSegment(wav, seq++);
  };

  const timer = setInterval(flush, segmentSeconds * 1000);

  const release = () => {
    clearInterval(timer);
    processor.disconnect();
    source.disconnect();
    // Stopping the tracks is what turns the menu-bar mic indicator off.
    for (const track of stream.getTracks()) track.stop();
    context.close();
  };

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      flush(); // the final partial segment
      release();
    },
    cancel() {
      if (stopped) return;
      stopped = true;
      chunks = [];
      release();
    },
  };
}
