---
title: Scheduled tasks
layout: default
nav_order: 14
---

# Scheduled tasks

The usual way to schedule something is the [Automations panel](pipelines.md):
open an automation's clock chip, pick "Every day at 9:00", done. What that
chip creates is a task — this page is the machinery underneath, and the CLI
for the one thing the panel doesn't do (scheduling a *prompt* rather than an
automation).

A task is a prompt — or an automation — plus a cron expression. A prompt task
runs through the **ordinary turn path** — same agents, same memory, same
tracing — so a scheduled run is inspectable exactly like a conversation, and
anything it learns is remembered.

```sh
enio task add weekly-review --cron "0 9 * * 1" \
  --prompt "Summarise what I worked on this week and what's still open"

enio task add news-daily --cron "0 9 * * *" --pipeline ai-news-brief

enio tasks                    # what's scheduled, and when next
enio task run weekly-review   # run it now, ignoring the schedule
enio task runs weekly-review  # recent runs and their outcomes
```

An automation task fires the saved [automation](pipelines.md)
directly: no model decides whether to run it and no router picks who — the
clock triggers the graph you built, and only the steps inside involve the
model. The automation must already be saved when you create the task, and a
`--prompt` task can pin an agent with `--agent`.

## Who fires them

**The scheduler runs inside the desktop app** (and inside `enio serve`), so a
schedule set in the panel fires while Enio is open — no second process to
remember. `enio daemon` is the headless alternative for a machine where the
app isn't running; to survive reboots, wrap it in a launchd plist (macOS) or
a systemd user unit (Linux).

Running both is safe. A **lease** in the database decides which process fires:
one holds it and schedules, the other stands by and takes over within a couple
of minutes if the holder goes away (about 30 seconds on a clean quit). Fires
that land exactly in a handover gap are dropped, not replayed — a task runs
once or not at all, never twice.

The scheduler re-reads tasks every 30 seconds, so adding or disabling one
takes effect without a restart.

Overlapping runs are **skipped rather than stacked** — a turn can take tens of
seconds, and a `*/1 * * * *` schedule would otherwise pile up until nothing
finishes. A failing task is recorded and the others keep running.

Bad cron expressions are rejected when you create the task, not at 3am when it
silently fails to fire.

## Watches

A task tells you its output every time it runs. A watch is the other thing you
usually want: **tell me only if something changed.**

```sh
enio watch add "is there a new release of mlx-lm"
enio watches        # what's being watched, and what it last saw
enio watch run      # check everything right now
enio watch rm 3     # stop watching
```

While the scheduler runs — the desktop app open, or `enio daemon` — every
watch is checked on one heartbeat — every 30
minutes by default, `ENIO_HEARTBEAT` takes a cron expression, `off` disables
it. Each check runs through the ordinary turn path like a task does, and
reports what it finds. Then a second, separate model call answers one closed
question: *does this report say anything the previous one did not?* If no,
the check ends silently — no notification, nothing to read. If yes, you get a
macOS notification and the alert is kept (`watch_alerts` in the database).

The first check always notifies: it confirms the watch works and shows what
the current state looks like, and later checks compare against it.

Two properties worth knowing. The comparison is against the **last report,
not the last alert**, so slow drift produces one alert per change rather than
compounding into a false "no change". And when the comparison itself fails,
the heartbeat **notifies rather than stays silent** — an extra notification
is visible and annoying; a watch that quietly stopped watching is invisible,
which is worse.
