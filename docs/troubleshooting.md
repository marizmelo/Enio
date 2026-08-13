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

## Where to look

```sh
enio inspect            # trace UI: every turn, tool call and timing
~/.enio/model-server.log
```

The inspector shows which agent was picked, what was retrieved from memory, and
every tool call with its arguments and result — which is usually enough to see
why an answer went the way it did.
