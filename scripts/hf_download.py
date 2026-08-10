#!/usr/bin/env python3
"""Download a model into the Hugging Face cache, reporting bytes as it goes.

Runs under the model runtime's own venv, because that is where huggingface_hub
already lives -- the same library mlx_lm uses to resolve a model id at load
time, so a model this script fetches is by construction one the server can then
find. Shelling out to the `hf` binary would have been shorter and is a trap:
the console script carries an absolute shebang, and moving the runtime
directory (which install.sh supports, and which this machine has done) leaves
it pointing at a python that no longer exists. `python -m` has no shebang to go
stale.

Progress is emitted as JSON lines on stdout, one object per line:

    {"phase": "plan", "total": 4207392768, "files": 13, "cached": 2}
    {"phase": "progress", "done": 16777216}
    {"phase": "done", "path": "/Users/.../snapshots/50d4277"}
    {"phase": "error", "message": "..."}

Anything else on stdout -- hub warnings, a stray tqdm frame -- is not JSON and
the caller skips it, so a chatty library version cannot break the parse.

The size comes from a dry run rather than from a number written down beside the
model id. A hardcoded total is wrong the moment the repo gains a file, and a
progress bar that stops at 94% or sits at 100% while bytes are still arriving
is worse than no progress bar: it reads as a hang.
"""

import json
import os
import sys
import threading

from huggingface_hub import snapshot_download


def emit(**fields):
    sys.stdout.write(json.dumps(fields) + "\n")
    sys.stdout.flush()


def main() -> int:
    if len(sys.argv) < 2:
        emit(phase="error", message="usage: hf_download.py <repo_id>")
        return 2
    repo_id = sys.argv[1]

    try:
        plan = snapshot_download(repo_id, dry_run=True)
    except Exception as err:  # noqa: BLE001 -- the message is the whole point
        emit(phase="error", message=f"{type(err).__name__}: {err}")
        return 1

    pending = [f for f in plan if getattr(f, "will_download", True)]
    total = sum(getattr(f, "file_size", 0) or 0 for f in pending)
    emit(phase="plan", total=total, files=len(plan), cached=len(plan) - len(pending))

    if not pending:
        # Already complete. Say so as a finished download rather than running
        # one: re-resolving the snapshot path is cheap, but a caller that sees
        # no progress at all cannot tell "done instantly" from "stuck".
        try:
            emit(phase="done", path=snapshot_download(repo_id, local_files_only=True))
            return 0
        except Exception as err:  # noqa: BLE001
            emit(phase="error", message=f"{type(err).__name__}: {err}")
            return 1

    done = 0
    lock = threading.Lock()
    devnull = open(os.devnull, "w")  # noqa: SIM115 -- lives for the process

    from tqdm.auto import tqdm as _tqdm

    class Reporting(_tqdm):
        """Aggregate every per-file byte counter into one running total.

        snapshot_download opens one bar per file plus an outer bar counting
        *files*, and downloads several files at once. Summing indiscriminately
        would add a count of files to a count of bytes and race while doing it,
        so only byte-unit bars contribute and the total moves under a lock.

        Xet-backed repos -- which is most of mlx-community now -- open a second
        byte bar for reassembling chunks into files, so every byte gets counted
        twice and the bar reaches 100% at the halfway mark. Only the transfer
        bar counts. Because Xet deduplicates, that number can also come in
        *under* the file total, so the caller gets a final exact value rather
        than being left at 97%.
        """

        def __init__(self, *args, **kwargs):
            kwargs["file"] = devnull
            kwargs["disable"] = False
            desc = str(kwargs.get("desc") or "")
            self._bytes = str(kwargs.get("unit", "")) == "B" and "econstruct" not in desc
            super().__init__(*args, **kwargs)

        def update(self, n=1):
            nonlocal done
            if self._bytes and n:
                with lock:
                    done = min(done + n, total)
                    # Throttled by size rather than by time: no clock to read,
                    # and it scales with the transfer instead of with how long
                    # a slow link takes. Roughly 250 lines over a 4GB model.
                    if done - Reporting.last_emitted[0] >= 16 * 1024 * 1024:
                        Reporting.last_emitted[0] = done
                        emit(phase="progress", done=done)
            return super().update(n)

    Reporting.last_emitted = [0]

    try:
        path = snapshot_download(repo_id, tqdm_class=Reporting)
    except Exception as err:  # noqa: BLE001
        emit(phase="error", message=f"{type(err).__name__}: {err}")
        return 1

    emit(phase="progress", done=total)
    emit(phase="done", path=path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
