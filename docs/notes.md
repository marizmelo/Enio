---
title: Notes
layout: default
nav_order: 8
---

# Notes

A note-taking surface where the AI helps in place: highlight a passage and
tighten it, expand it, rewrite it to an instruction, continue from the
cursor, or open a comment thread on it and discuss. Notes is the first part
of Enio that behaves like an app rather than a chat — the interface does
the asking, so what reaches the model is a small, bounded request it
answers reliably.

Open Notes from the notebook icon in the top bar. **New note** creates one
and opens it in the canvas immediately with its placeholder title selected —
type to name it. **The first line is the note's name**: the list, the
canvas header, everything follows the `#` heading, so renaming a note is
editing its first line. There is no naming dialog, because the page is
where the name belongs. (The filename underneath never changes — it is a
stable internal id, which is what keeps comment anchors and exports
simple.)

## Where notes live

Notes are markdown files in a managed `.notes/` folder inside your
workspace. Managed means Enio's own surfaces are the only things that
write there: the canvas saves, chat edits a pinned note when you ask, and
the selection verbs splice in what you accept. The folder is deliberately
kept out of file listings and @-mentions, and the canvas never offers
"Open with…" or "Show in Finder" for a note — handing a note to an
external editor is exactly what the convention prevents, because it is
what keeps comment anchors trustworthy.

To take a note elsewhere, use **Save a copy** — the export is yours, the
original stays managed. Discard moves the note (and its comments) to the
macOS Trash, where Put Back restores both.

**Back up `.notes/`.** It is real writing in a hidden folder — include it
when you back up your workspace. (A project's *notes field* is a different
thing: that is project configuration, not this collection.)

## The selection verbs

Select text in the canvas editor and the verb row activates:

- **Tighten** — the same thing in fewer words.
- **Expand** — more detail, built only from what is already there.
- **Rewrite…** — your instruction, applied to the selection and nothing else.
- **Continue** — writes what naturally follows the cursor.

Every verb shows a **preview** — the selection next to its replacement —
and nothing changes until you press Accept. A small local model's rewrite
varies; a bad one should cost a glance, never a keystroke. Accept keeps a
one-step Undo. The verbs work on any text file in the canvas, not only
notes.

## Discussing a passage

**Discuss** opens a comment thread anchored to the selected text, with an
optional opening question — the AI answers in the thread, grounded in the
passage and its surroundings. Threads live under the editor; clicking a
thread's quote selects that passage in the note.

Anchors follow the text: edit around a quoted passage and the thread stays
attached (a `≈` marks an approximate match after heavy reflow). Delete the
passage and the thread shows *passage removed* — it is kept, and restoring
the text re-attaches it. Comments are stored beside the note inside
`.notes/` and travel with your workspace backup.

## Chat still works

A pinned note is still the canvas: *"make the intro shorter"* in the
conversation edits it through the agent, exactly like any other document.
The verbs are for the edits where naming the text beats describing it.
