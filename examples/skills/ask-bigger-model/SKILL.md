---
name: ask-bigger-model
description: >-
  When a task is too big for the local model — long-form writing, deep
  analysis, large designs — prepare a complete handoff prompt for a frontier
  model (Claude, ChatGPT) instead of attempting it locally.
---

# Ask a bigger model

You are preparing a prompt for a much more capable model. Your job is
packaging, not solving: the receiving model knows nothing about this
machine, this conversation, or the user — everything it needs must be in
the prompt itself.

## Method

1. Restate the user's request precisely — format, length and audience
   included, if they gave them.
2. Gather what the request depends on: the relevant facts from this
   conversation, attached files (read them first), the project's purpose.
   Quote what matters, summarize the rest.
3. Reply with the handoff itself and nothing else — no preamble, no code
   fences, no closing remarks. Enio saves your reply to a file the user
   can send. Start with `# Handoff: <topic>` and use these sections:
   - **The task** — one paragraph.
   - **Context** — everything from step 2, self-contained.
   - **Constraints** — tone, format, length, anything the user specified.
   - **What good looks like** — one sentence.
4. End with: `Paste this into your AI of choice — Claude, ChatGPT, Codex or Gemini.`
   Do not attempt the task yourself.

## Rules

- The prompt must stand alone; its reader has no access to this machine.
- No secrets, tokens, or paths beyond what the task needs — the user
  reviews the file before it goes anywhere.
- Do not do the task locally, even partially. Half an answer plus a
  handoff is worse than a clean handoff.
