---
title: Troubleshooting
layout: default
nav_order: 18
---

# Troubleshooting

## The status bar says the server is down

The desktop app polls both the model server and the agent every few seconds and
reports transitions, so a backend that comes back clears the error on its own
within about five seconds. If it does not:

```sh
curl -s localhost:8080/v1/models   # the model server
curl -s localhost:8787/ping        # the agent
```

The model server is shared by reference count — the last process to stop using
it shuts it down. If you have a CLI session open, quitting the desktop app
leaves the model running on purpose.

## It says it did something, but nothing happened

Enio catches this: a reply that claims an action in a turn where **no tool ran**
is flagged, corrected, and if the correction still claims it, replaced with an
honest sentence saying nothing ran.

If you see that message, the usual cause is the model narrating instead of
calling `propose_plan`. Say **"propose a plan to …"** — that phrasing reliably
produces the approval card.

## Clicking does not work in one specific app

Some apps hide their windows from AppleScript's System Events entirely —
Calculator is one. The accessibility bridge reaches them; check it is installed:

```sh
~/.enio/runtime/.venv/bin/python -c "import ApplicationServices; print('ok')"
```

If that fails, re-run `bash install.sh`, or fall back to `type_text` and
`press` steps, which reach the frontmost app without needing to enumerate a
window.

## "not allowed assistive access"

Accessibility permission, not Automation. System Settings → Privacy & Security →
Accessibility, for whatever runs Enio. If it is already listed, toggle it off
and on — a stale grant looks exactly like no grant.

Note that macOS reuses error `-1719` for "Invalid index" too, so that number
alone does not mean a permission problem.

## An app will not open from a plan

`open` steps use LaunchServices (`open -a`) rather than an Apple Event, because
Apple-Event launching is refused in some contexts with error `-600`. If you see
`-600` from something else, that is the same class of problem.

## The reply was empty, or repeated itself

Both are caught and retried automatically — an empty reply means the model spent
its budget thinking, and the retry declines thinking structurally rather than
asking it not to. If both attempts fail you get an honest sentence saying which
happened, rather than an empty bubble.

Raising `ENIO_MAX_TOKENS` helps the first case. The second usually means the
question needs a tool that is not available to the agent it was routed to — try
`@agent` to force a different one.

## A Python process is using many gigabytes

That is `mlx_lm.server`, the local model. It holds the weights (a few GB) plus
a KV cache, and the cache is what grows: mlx-lm keeps ten conversation slots,
and MLX's own buffer pool does not hand memory back to the system quickly once
a long generation has claimed it. Long answers and large written files are what
make it climb, because both extend the cache the same way.

Two levers, both env vars:

- `ENIO_MAX_TOKENS_WRITE` (default 8192) caps a turn that writes files. It is
  high because a whole file travels inside one tool call and a truncated call
  is dropped entirely — but every token of it is cache. Lower it if memory
  matters more than writing large files in one go, and ask for files in
  sections instead.
- `ENIO_PROMPT_CACHE_SLOTS` (default: an eighth of installed RAM in GB,
  clamped 2–10) is how many conversations keep a cache at once, and it is the
  one that actually bounds memory. Qwen3 4B costs 144KB of KV per token, so a
  slot holding a long thread is well over a gigabyte and the count multiplies
  it. mlx-lm's own default is ten, which is how a 24GB machine ran out.
- `ENIO_PROMPT_CACHE_GB` (default: a twelfth of installed RAM, 1–4) is the byte
  ceiling. Lowering either costs speed on follow-up turns, which re-prefill
  instead of resuming.

Quitting Enio releases all of it: the model server is stopped by whoever
started it, and nothing survives the app.

## A file was asked for and nothing was written

When the agent writes a file, the whole file travels inside a single tool call,
so a very large one can run past the generation cap and be cut off mid-way —
the server cannot parse a half-finished call, and the turn arrives empty. Enio
says so when it happens. Ask for the file in smaller pieces (one file, or one
section at a time), or raise `ENIO_MAX_TOKENS_WRITE`, which is the cap for
turns that can write and is already well above the ordinary reply cap.

If instead the code came back *in the chat*, that is caught: the reply is
withdrawn and the agent is made to write the files, which is what the amber
"writing the files" note above a retry means.

## Where to look

```sh
enio inspect            # trace UI: every turn, tool call and timing
~/.enio/model-server.log
```

The inspector shows which agent was picked, what was retrieved from memory, and
every tool call with its arguments and result — which is usually enough to see
why an answer went the way it did.
