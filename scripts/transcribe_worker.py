"""
Long-lived transcription worker.

One JSON request per line on stdin, one JSON response per line on stdout:

    {"path": "/tmp/x.wav", "model": "mlx-community/whisper-tiny"}
    {"text": "what is the current time"}

Exists because starting Python and importing mlx_whisper costs about a second
before any audio is looked at, and live dictation pays that on every pass. A
resident process pays it once, and mlx_whisper keeps the weights loaded between
calls, so a partial goes from roughly three seconds to well under one.

Deliberately dumb about failure: any error is reported as a JSON line and the
loop continues, because a worker that dies on one bad clip takes dictation with
it until something notices.
"""

import contextlib
import json
import sys
import wave

import numpy as np


def read_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as f:
        channels = f.getnchannels()
        width = f.getsampwidth()
        rate = f.getframerate()
        frames = f.readframes(f.getnframes())

    if width != 2:
        raise ValueError(f"expected 16-bit samples, got {width * 8}-bit")

    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)

    if rate != 16000:
        duration = audio.shape[0] / rate
        target = int(duration * 16000)
        audio = np.interp(
            np.linspace(0, audio.shape[0], target, endpoint=False),
            np.arange(audio.shape[0]),
            audio,
        ).astype(np.float32)

    return audio


def is_degenerate(text: str) -> bool:
    """
    True for the repetition loops whisper produces from noise.

    The failure does not look like a wrong word, it looks like "Old Old Old
    Old" or one glyph a thousand times, and it lands in the message box as
    though it had been heard. Real speech has variety; a handful of tokens
    repeated across a long string does not.
    """
    stripped = text.strip()
    if len(stripped) < 24:
        return False

    words = stripped.split()
    if len(words) >= 8 and len(set(words)) <= max(2, len(words) // 8):
        return True

    # Repeated glyphs with no spaces at all: the same check, one level down.
    if len(set(stripped.replace(" ", ""))) <= 3:
        return True

    return False


def transcribe(path: str, repo: str) -> dict:
    import mlx_whisper

    audio = read_wav(path)
    if audio.size < 1600:
        return {"text": ""}

    # Whisper invents text for silence -- a quiet room reliably produces
    # repeated glyphs rather than nothing. Gate before asking.
    rms = float(np.sqrt(np.mean(np.square(audio))))
    peak = float(np.max(np.abs(audio)))
    if rms < 0.005 and peak < 0.05:
        return {"text": ""}

    # mlx_whisper prints "Detected language" and a progress bar to stdout even
    # with verbose=False, and stdout here is the protocol. Anything it writes
    # would be read as a response and every answer after it would belong to the
    # previous question. Pushed to stderr, where it is merely noise.
    with contextlib.redirect_stdout(sys.stderr):
        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=repo,
            verbose=False,
            # Whisper loops when it conditions on its own previous output, and a
            # loop is exactly what a half-finished utterance invites: it emits
            # one token, sees it, and emits it again forever. Each interim pass
            # re-reads the whole clip anyway, so there is nothing to carry over.
            condition_on_previous_text=False,
        )

    text = (result.get("text") or "").strip()
    return {"text": "" if is_degenerate(text) else text}


def main() -> int:
    # Imported up front so the first real request does not pay for it, and so a
    # broken install fails now rather than mid-sentence.
    try:
        import mlx_whisper  # noqa: F401
    except Exception as err:  # noqa: BLE001
        print(json.dumps({"error": f"{type(err).__name__}: {err}"}), flush=True)
        return 1

    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            print(json.dumps(transcribe(request["path"], request["model"])), flush=True)
        except Exception as err:  # noqa: BLE001
            print(json.dumps({"error": f"{type(err).__name__}: {err}"}), flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
