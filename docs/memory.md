---
title: Memory
layout: default
nav_order: 5
---

# Memory

Three mechanisms, none of which involve training the model.

**Facts** — say "I'm working on a deploy tool for Acme" and it stores that.
Extraction also runs automatically over each finished conversation.

**Preferences** — `/pref "no bullet points"` applies to every future
conversation. Different from a fact: facts *inform* answers, preferences *shape*
them.

**Examples** — after a response you like, `/good`. On similar questions later
that exchange is shown as a demonstration. The fastest way to change how it
writes.

```sh
enio stats              # counts
enio graph "acme"       # what it knows about something
enio remember "..."     # pin a fact by hand
enio prefs              # standing instructions
enio examples           # saved examples
enio reindex            # rebuild memory from raw transcripts
```

## How it is stored

Three layers, and the ordering between them is the important part.

1. **Raw transcripts** — every message, in SQLite. The source of truth.
2. **Facts** — extracted statements, each tied to the conversation it came from.
3. **A knowledge graph** — entities and relations, *derived* from the above.

The graph is never authoritative. That is what makes `enio reindex` safe: the
graph can be thrown away and rebuilt, and a better model can rebuild it better
later. If the graph were the source of truth, a bad extraction would be
permanent.

Extraction uses a **closed vocabulary** — nine relations, six entity types.
Open-ended extraction from a small model produces `USES`, `uses` and `USES_TOOL`
as three separate relations and a graph that degrades as it grows. Anything that
does not fit goes into `facts`, which is free text.

## Recall

Retrieval is embeddings-first with a lexical fallback, and the fallback stems
words — people rephrase when they repeat themselves, so `summarise`,
`summarize` and `summary` have to collapse to the same thing or clustering finds
nothing.

If embeddings are unavailable, keyword matching takes over and the agent keeps
working.

Alongside similarity there is one channel of pure **recency**: the last two
days' session summaries ride into every conversation, labelled *today* or
*yesterday*. "What was I doing yesterday" resembles yesterday's summary only
by accident — the day boundary is the actual relation, and similarity search
cannot express it.

Long conversations get one more protection. When a session outgrows the
context window, the older part is folded into a running summary; that fold is
now also kept, and when the session is later summarised into memory, the
summariser reads the fold plus the transcript's tail — so both ends of a long
session reach its durable summary, instead of only the first part.

## Forgetting

Discarding a conversation asks what happens to the facts learned from it,
because a fact whose transcript is deleted cannot survive a reindex:

- **Keep** pins them, so they stand alone — the same standing `enio remember` grants
- **Forget** deletes them with the transcript

There is no silent default. `/clear` only clears the conversation on screen; it
does not touch what is on disk.
