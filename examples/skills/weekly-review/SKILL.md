---
name: weekly-review
agents: [librarian, generalist]
description: Producing a weekly review or summary of what the user has been working on, what changed, and what is unresolved. Use for "what did I do this week", "weekly review", or "catch me up".
allowed-tools: [recall, run_command, read_file]
---

# Weekly review

## Gather before you write

1. `recall` what the user has been working on — projects, blockers, decisions.
2. If they have a code workspace, `git log --since="1 week ago" --oneline` in
   the relevant repositories.
3. Look for things that were open last time and are still open now. Those are
   the most useful items in the whole review and the easiest to miss.

## Structure

Three short sections, prose not bullets, unless the user prefers otherwise:

**Shipped** — what actually got finished. Be specific; "improved the installer"
is worthless next to "installer now detects an existing model instead of
re-downloading 5GB".

**In flight** — started and unfinished, with where it actually stands.

**Stuck** — anything blocked, and on what. Name the blocker explicitly. If
something has been in this section two weeks running, say so plainly; that
pattern is the single most valuable observation a review can make.

## Rules

- If memory holds nothing for the period, say that rather than padding the
  review with generalities. An honest empty review is useful information.
- Never invent progress. If you cannot tell whether something finished, ask.
- Keep it under 300 words. A review nobody rereads has failed at its job.
