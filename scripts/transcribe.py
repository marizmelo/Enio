"""
Transcribe a 16kHz mono WAV with mlx-whisper, and print JSON.

Reads the file with the `wave` module rather than mlx_whisper's own
load_audio, which shells out to ffmpeg. ffmpeg is not a dependency this
project has anywhere else, and adding one that only announces itself when a
user tries to speak — on a machine where it happens to be missing — is the
kind of failure this codebase goes out of its way to avoid. The caller sends
WAV precisely so nothing has to decode anything.

Usage:  python transcribe.py <path.wav> <hf-repo>
"""

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

    # Mixed down rather than rejected: a stereo mic is a normal thing to have,
    # and refusing it would be a worse experience than averaging the channels.
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)

    if rate != 16000:
        # Whisper expects 16kHz. Linear resampling is crude, but the renderer
        # already targets 16kHz, so this only ever runs as a safety net.
        duration = audio.shape[0] / rate
        target = int(duration * 16000)
        audio = np.interp(
            np.linspace(0, audio.shape[0], target, endpoint=False),
            np.arange(audio.shape[0]),
            audio,
        ).astype(np.float32)

    return audio


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: transcribe.py <path.wav> <hf-repo>"}))
        return 1

    path, repo = sys.argv[1], sys.argv[2]
    try:
        import mlx_whisper

        audio = read_wav(path)
        if audio.size < 1600:  # under 0.1s
            print(json.dumps({"text": ""}))
            return 0

        # Whisper hallucinates on silence rather than returning nothing --
        # given a quiet room it will confidently produce repeated glyphs, and
        # that lands in the message box as though it were heard. Gate on
        # loudness before asking: an empty result is the honest answer to an
        # empty recording.
        rms = float(np.sqrt(np.mean(np.square(audio))))
        peak = float(np.max(np.abs(audio)))
        if rms < 0.005 and peak < 0.05:
            print(json.dumps({"text": ""}))
            return 0

        result = mlx_whisper.transcribe(audio, path_or_hf_repo=repo, verbose=False)
        print(json.dumps({"text": (result.get("text") or "").strip()}))
        return 0
    except Exception as err:  # noqa: BLE001 - the caller wants the message, not a trace
        print(json.dumps({"error": f"{type(err).__name__}: {err}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
