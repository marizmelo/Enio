---
title: Meetings
layout: default
nav_order: 14
---

# Meetings

Press the record button (top bar, or the **Record a meeting** tile on a new
chat) and Enio captures the meeting through your Mac's microphone. Press it
again to stop. Everything after that is automatic: the audio is transcribed
locally with Whisper, a structured summary is written — decisions, action
items, open questions — and the result opens beside the chat as
`meeting-<date>.md`. The transcript and summary also enter Enio's
[memory](memory.md), so "what did we decide about the budget last week"
works in any later conversation.

Nothing leaves your machine. Recording, transcription and summarization all
run locally; the audio itself is deleted as soon as each piece is
transcribed.

## What to expect

- **Microphone only.** Enio hears what your Mac's mic hears — you, and
  whoever is audible in the room. The other side of a headphones call is
  not captured.
- **Where the file lands**: your workspace, or the open project's own
  folder — the same rule as every generated document.
- **Silence is reported as silence.** A recording with nothing intelligible
  in it produces a file that says so. It is never summarized — small models
  will confidently turn noise into decisions nobody made, so below a
  threshold no summary is attempted at all.
- **Anything the summary states that the transcript does not support** is
  listed under *Verify (not found in transcript)* rather than silently
  trusted.
- If the app dies mid-recording, the server notices the segments stopping
  and finishes the meeting with what it has, noting the early end.

Requires speech recognition (`enio voice --install`); the record button
only appears once it is installed.
