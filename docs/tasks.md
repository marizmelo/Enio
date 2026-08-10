---
title: Scheduled tasks
layout: default
nav_order: 10
---

# Scheduled tasks

A task is a prompt plus a cron expression. It runs through the **ordinary turn
path** — same agents, same memory, same tracing — so a scheduled run is
inspectable exactly like a conversation, and anything it learns is remembered.

```sh
enio task add weekly-review --cron "0 9 * * 1" \
  --prompt "Summarise what I worked on this week and what's still open"

enio tasks                    # what's scheduled, and when next
enio task run weekly-review   # run it now, ignoring the schedule
enio task runs weekly-review  # recent runs and their outcomes
enio daemon                   # the scheduler; leave it running
```

The daemon re-reads tasks every 30 seconds, so adding or disabling one takes
effect without a restart.

Overlapping runs are **skipped rather than stacked** — a turn can take tens of
seconds, and a `*/1 * * * *` schedule would otherwise pile up until nothing
finishes. A failing task is recorded and the others keep running.

Bad cron expressions are rejected when you create the task, not at 3am when it
silently fails to fire.

To survive reboots, wrap `enio daemon` in a launchd plist (macOS) or a systemd
user unit (Linux).
