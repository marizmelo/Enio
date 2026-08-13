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
 *
 * Synthesis runs ahead of playback, which is the whole reason the queue holds
 * pending blobs rather than strings. Draining used to synthesise and play in
 * lockstep, so every full stop cost a silent round trip to the server -- about
 * a second and a half each, which on a long answer is most of what you hear.
 * Now the next sentences are already being made while the current one is being
 * read, and the gap is whatever is left of the last one when playback ends.
 */

/**
 * How many sentences to synthesise ahead.
 *
 * Two is enough to cover the round trip for anything longer than a few words,
 * and small enough that stopping mid-answer does not waste much: everything in
 * flight is discarded, and the server synthesises one at a time regardless, so
 * queueing the whole reply would only move the wait rather than remove it.
 */
const LOOKAHEAD = 2;

let current = null;
let queue = [];
let draining = false;
let generation = 0;

/**
 * Ask the agent to load the voice model now.
 *
 * Fire and forget: the answer is 202 the moment the load starts, and there is
 * nothing to do with the result. Called when speech is switched on, so the
 * model is ready by the time there is a sentence to say -- otherwise the first
 * spoken reply of a session waits about four and a half seconds for a load
 * that could have happened while the user was still reading.
 */
export function warmVoice() {
  (async () => {
    try {
      const token = await window.maple?.getToken();
      await fetch("http://127.0.0.1:8787/v1/audio/warm", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      // The voice still works, it is just cold. Nothing to report.
    }
  })();
}

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

/**
 * Start synthesis for the next few queued sentences.
 *
 * Idempotent per item -- an item that already has a request in flight keeps it
 * -- so this is safe to call on every enqueue and on every turn of the drain
 * loop, which is what keeps the pipeline full without tracking state.
 */
function pump(mine) {
  if (mine !== generation) return;
  let started = queue.filter((item) => item.blob !== null).length;
  for (const item of queue) {
    if (started >= LOOKAHEAD) break;
    if (item.blob === null) {
      item.blob = synthesise(item.text);
      started += 1;
    }
  }
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
    // Fill the pipeline before waiting on the head of it, so the sentences
    // after this one are already being synthesised while it plays.
    pump(mine);

    const item = queue.shift();
    const blob = await item.blob;
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
/**
 * Markdown, as a person would read it aloud.
 *
 * The voice was performing the notation: "hash hash Cold Brew asterisk
 * asterisk" -- reading the source instead of the document. This mirrors the
 * grammar renderMarkdownish renders (headings, bold, bullets, inline code,
 * links) and sits inside speak() itself, so every utterance passes through
 * whether it came from the stream splitter or the read-aloud button. URLs
 * become their host: nobody wants a path read out character by character.
 */
export function spokenText(raw) {
  return String(raw ?? "")
    // A whole fenced block is named, not performed; a stray fence from a
    // block split across streamed sentences is dropped.
    .replace(/```[a-z]*\n[\s\S]*?```/gi, " code block. ")
    .replace(/```[a-z]*\n?/gi, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\|/g, " ")
    .replace(/https?:\/\/\S+/g, (u) => {
      try {
        return new URL(u).hostname.replace(/^www\./, "");
      } catch {
        return "a link";
      }
    })
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function speak(text) {
  const trimmed = spokenText(text);
  if (!trimmed) return Promise.resolve();
  queue.push({ text: trimmed, blob: null });
  // Kicked off here rather than only in the drain loop, so the first sentence
  // starts being made the moment it is known, and the second while the first
  // is still playing.
  pump(generation);
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

/**
 * Speak a complete piece of text, a sentence at a time.
 *
 * For the read-aloud button under an answer, where the whole reply is known up
 * front. Handing it over as one utterance meant one synthesis request for the
 * entire thing and silence until it finished -- synthesis runs at roughly a
 * fifth of real time, so a reply that reads for a minute sat quiet for twelve
 * seconds before the first word. Split into sentences it uses the same
 * pipeline as streamed speech: the first sentence starts after its own
 * synthesis, and the rest are made while it plays.
 */
export function speakAll(text) {
  const { ready, rest } = takeSentences(String(text ?? ""));
  // takeSentences leaves the final sentence in `rest`, since it only splits on
  // a terminator followed by whitespace and the last one ends the string.
  const parts = [...ready, rest].map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return Promise.resolve();

  let done = Promise.resolve();
  for (const part of parts) done = speak(part);
  // Every speak() joins the same drain, so the last is as good as all of them.
  return done;
}
