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

## Tool calls and sources

Tools that ran appear as badges above the reply. A tool called more than once
in a turn is one badge with a count — `browse ×3` — rather than three identical
badges saying nothing the first did not.

When a turn reads the web, the pages it read are listed under the answer as
**Sources**, deduped: searching and then fetching the top hit is the normal
path, and citing it twice would misstate how much was consulted. Search results
are also shown as they arrive, with titles, snippets and links.

This is worth the space specifically because the model is small. It reads
titles and snippets and writes a paragraph, and in the paragraph a summary and
an invention look identical. The list puts the check one glance away — and
often answers the question outright, since the right link beats a description
of it. Links open in your real browser.

Sources come from what the tools returned, so they are the evidence the model
saw rather than a separate account of it. A fetch that failed is not cited: an
answer that looks sourced when the source is an error message is worse than one
that cites nothing.

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

## Files and attachments

Attach a file with the **+** menu, by dragging it in, or by pasting an image.
The workspace list in that menu shows a thumbnail for anything previewable —
four screenshots are indistinguishable by name and obvious by picture.

**Attachments are stored with the conversation they belong to**, under
`~/enio-workspace/attachments/<conversation>/`. They stay inside the workspace
because the filesystem tools are scoped there and a file outside it cannot be
read at all; the subfolder is what keeps the workspace from becoming a drawer of
`screenshot-7.png` with nothing recording which question any of them went with.

Clicking any attachment — in the thread, or in the Files dialog — opens it.
Images get a viewer with arrow-key navigation through the rest of that
conversation's files, and a fit/actual-size toggle. Documents get a reader:
markdown rendered, CSV and TSV as a table, everything else as monospace text.
PDFs open in a window of their own, because that is where Chromium's real
viewer lives — selectable text, search and page navigation, rather than an
imitation of them.

The set the arrows walk is the set you opened from. Open a screenshot from a
conversation and you step through that conversation; open one from the
workspace list and you step through the workspace.

The **Files** button in the status bar is where storage is managed. It shows
what this conversation attached, what every other conversation attached —
grouped under the question it was asked with, which is the only grouping that
answers "do I still need this" — and the workspace files that belong to no
conversation. Per file:

| | |
|---|---|
| **+** | attach it to the message you are writing, again |
| **Download** | save a copy wherever you like, through the system panel |
| **Reveal** | show it in Finder |
| **Delete** | remove it — the only one of the four that is not reversible |

A whole conversation's attachments can be removed in one go, and **discarding a
conversation removes its files with it**. Keeping them would leave bytes on disk
that nothing can name any more.

Files from a conversation you already discarded are still listed, marked
*discarded conversation*. Hiding them would mean a storage screen that omits
some of what is stored, and this is now the only place they can be found.

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
