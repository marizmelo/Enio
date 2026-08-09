/**
 * Playing replies aloud.
 *
 * The audio is synthesised by the agent rather than the system voice, so every
 * client sounds the same and the model is loaded once in one process. Playback
 * lives here in the renderer because that is where it can be interrupted: a new
 * reply must cut off the previous one rather than talk over it.
 */

let current = null;

export function stopSpeaking() {
  if (!current) return;
  current.pause();
  // Revoked as well as paused: each utterance is a fresh object URL, and
  // leaving them attached leaks the whole conversation's audio into memory.
  URL.revokeObjectURL(current.src);
  current = null;
}

export async function speak(text) {
  stopSpeaking();

  const trimmed = (text ?? "").trim();
  if (!trimmed) return;

  const token = await window.maple?.getToken();
  const res = await fetch("http://127.0.0.1:8787/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ input: trimmed }),
  });

  // 503 means the voice is unavailable, not that anything failed. The reply is
  // already on screen, so silence is the whole of the fallback.
  if (!res.ok) return;

  const url = URL.createObjectURL(await res.blob());
  const audio = new Audio(url);
  current = audio;
  audio.addEventListener("ended", () => {
    if (current === audio) stopSpeaking();
  });
  await audio.play().catch(() => {});
}
