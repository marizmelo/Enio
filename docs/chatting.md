---
title: Chatting
layout: default
nav_order: 3
---

# Chatting

## `/skill` and `@mention`

Two ways to override the model's judgement — useful precisely *because* the
model is small. The router picking a specialist, or the model deciding a skill
applies, are exactly the calls it gets wrong.

```
/commit-message                  run a skill directly, no deciding involved
@coder why does this fail        force a specialist, skipping the router
summarise @notes/plan.md         attach a workspace file
@github what changed this week   allow an MCP server's tools this turn
```

Tab completes all of it — `/` lists skills, `@` lists specialists, MCP servers
and workspace files.

An invoked skill is injected whole rather than offered through `read_skill`.
The point of asking explicitly is to remove a decision; making the model call a
tool to fetch what you already handed it would put the decision straight back.
Same for attached files.

**Unrecognised mentions stay as ordinary text.** `mariz@example.com` and
`@property` in code are never eaten. A mention that looks deliberate but matches
nothing is reported as a hint rather than silently dropped, so a typo reads as a
typo.

This is also how `disable-model-invocation: true` skills are reached — kept out
of the catalogue, run only when you name them.

## Commands in chat

| | |
|---|---|
| `/good` | save the last answer as an example to imitate later |
| `/pref "be concise"` | add a standing instruction |
| `/pref` | list them |
| `/unpref 3` | remove one |
| `/think` | show the model's reasoning |
| `/stats` | what memory holds |
| `/clear` | forget this conversation (not what's on disk) |
| `/quit` | exit and fold this conversation into memory |

## Reading a reply as it arrives

The thread follows the answer while you are at the bottom, and stops following
the moment you scroll up — so you can read back through a long reply while it is
still being written. A **Jump to latest** button appears while you are scrolled
away; sending a message always returns you to the bottom.

## What the context meter means

The bar in the status bar is how full the model's *usable* window is — not its
advertised context length, but the band where it still reliably remembers what
it was told. When a conversation outgrows it, older turns are folded into a
summary and the meter drops back down.

Recent turns are kept whole, because that is where pronouns point: a summary of
"the user asked about the deploy script" cannot resolve "run it again".

See [Models](models.md) for how the size of that window is chosen.

## Conversations

Every message is logged, so restarting the app restores the thread you were in.
A line reading **earlier conversation · 2h ago** marks where restored history
ends and the present begins — without it, a resumed transcript is
indistinguishable from a live reply.

The history icon in the status bar lists past conversations. Discarding one asks
what should happen to the facts learned from it: **Keep** pins them so they
survive without their transcript, **Forget** deletes them with it. There is no
silent default, because a fact whose transcript is gone cannot be rebuilt by a
reindex.
