/**
 * Microphone capture, encoded as 16kHz mono WAV.
 *
 * Not MediaRecorder, which produces webm/opus: decoding that server-side needs
 * ffmpeg, and a feature that works only on machines where ffmpeg happens to be
 * installed is worse than one that never needs it. Raw PCM through an
 * AudioContext and a WAV header written by hand costs about forty lines and
 * removes the dependency entirely.
 */

const TARGET_RATE = 16000;

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  // Clamped before scaling: a sample above 1.0 wraps to a loud click otherwise,
  // and microphone input clips more often than you would think.
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([view], { type: "audio/wav" });
}

/** Average every N input samples into one output sample. */
function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

/**
 * Start recording. Returns a stop() that resolves to a WAV Blob.
 *
 * The track is stopped explicitly on the way out, because leaving it open
 * leaves the operating system's microphone indicator lit — which would be an
 * alarming thing for an app that promises nothing leaves your machine.
 */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks = [];

  processor.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(context.destination);

  return async function stop() {
    processor.disconnect();
    source.disconnect();
    for (const track of stream.getTracks()) track.stop();

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Float32Array(total);
    let at = 0;
    for (const c of chunks) {
      joined.set(c, at);
      at += c.length;
    }

    const rate = context.sampleRate;
    await context.close();
    return encodeWav(downsample(joined, rate, TARGET_RATE), TARGET_RATE);
  };
}

/** Send a WAV to the agent and get the text back. */
export async function transcribe(wav) {
  const token = await window.maple?.getToken();
  const res = await fetch("http://127.0.0.1:8787/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Content-Type": "audio/wav",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: wav,
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.error?.message ?? `transcription failed (${res.status})`);
  }
  return (await res.json()).text ?? "";
}
