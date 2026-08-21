---
title: Watches
layout: default
nav_order: 14
---

# Watches

An automation tells you its output every time it runs. A watch is the other
thing you usually want: **tell me only if something changed.**

```sh
enio watch add "is there a new release of mlx-lm"
enio watches        # what's being watched, and what it last saw
enio watch run      # check everything right now
enio watch rm 3     # stop watching
```

While the scheduler runs — the desktop app open, or `enio daemon` — every
watch is checked on one heartbeat — every 30
minutes by default, `ENIO_HEARTBEAT` takes a cron expression, `off` disables
it. Each check runs through the ordinary turn path, and
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
