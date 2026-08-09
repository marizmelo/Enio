/**
 * Playing replies aloud.
 *
 * The audio is synthesised by the agent rather than the system voice, so every
 * client sounds the same and the model is loaded once in one process. Playback
 * lives here because this is where it can be interrupted: a new reply must cut
 * off the previous one rather than talk over it.
 *
 * Utterances are queued rather than played as they arrive. Speech is spoken in
 * sentences as the answer streams, and synthesis of sentence two finishes while
 * sentence one is still being read -- without a queue they would overlap.
 */

let current = null;
let queue = [];
let draining = false;
let generation = 0;

export function stopSpeaking() {
  // Bumped so anything already synthesising resolves into a queue nobody is
  // draining, instead of starting to talk after being told to stop.
  generation += 1;
  queue = [];
  draining = false;

  if (!current) return;
  current.pause();
  // Revoked as well as paused: each utterance is a fresh object URL, and
  // leaving them attached leaks the whole conversation's audio into memory.
  URL.revokeObjectURL(current.src);
  current = null;
}

async function synthesise(text) {
  const token = await window.maple?.getToken();
  const res = await fetch("http://127.0.0.1:8787/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ input: text }),
  });

  // 503 means the voice is unavailable, not that anything failed. The reply is
  // already on screen, so silence is the whole of the fallback.
  return res.ok ? await res.blob() : null;
}

/** Resolves when the current run of the queue has finished, not before. */
let drained = Promise.resolve();

async function drain(mine) {
  // Joining an existing run rather than returning immediately: a caller that
  // awaits speak() is asking to know when the words have been said, and
  // answering "already done" while audio is still queued is a lie the UI then
  // shows as a stuck button.
  if (draining) return drained;

  draining = true;
  let release;
  drained = new Promise((r) => (release = r));

  while (queue.length > 0 && mine === generation) {
    const text = queue.shift();
    const blob = await synthesise(text);
    if (!blob || mine !== generation) continue;

    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    current = audio;

    await new Promise((resolve) => {
      audio.addEventListener("ended", resolve, { once: true });
      audio.addEventListener("error", resolve, { once: true });
      audio.play().catch(resolve);
    });

    if (current === audio) {
      URL.revokeObjectURL(url);
      current = null;
    }
  }

  draining = false;
  release();
}

/**
 * Queue text to be spoken.
 *
 * Called per sentence while the answer streams, so the first words are audible
 * about a second after they appear instead of after the whole reply has
 * finished — which on a long answer was the difference between speech feeling
 * live and feeling like a recording.
 */
export function speak(text) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return Promise.resolve();
  queue.push(trimmed);
  // Awaitable, so a "read aloud" button can show a stop icon for exactly as
  // long as there is something to stop.
  return drain(generation);
}

/**
 * Split streamed text into complete sentences, returning what is ready to
 * speak and what is still being written.
 *
 * Only splits on a terminator followed by a space, so "127.0.0.1" and "e.g."
 * do not become three utterances with pauses in the wrong places.
 */
export function takeSentences(buffer) {
  const match = buffer.match(/^[\s\S]*?[.!?](?=\s)/g);
  if (!match) return { ready: [], rest: buffer };

  let consumed = 0;
  const ready = [];
  for (const sentence of buffer.split(/(?<=[.!?])(?=\s)/)) {
    if (/[.!?]\s*$/.test(sentence) || /[.!?]$/.test(sentence.trim())) {
      ready.push(sentence.trim());
      consumed += sentence.length;
    } else break;
  }

  return { ready: ready.filter(Boolean), rest: buffer.slice(consumed) };
}
