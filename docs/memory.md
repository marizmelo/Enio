---
title: Memory
layout: default
nav_order: 6
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
working — but retrieval quality drops with nothing visibly failing, so the
state is surfaced rather than silent: `/capabilities` reports
`memory.semanticRecall` (`true`, `false`, or `null` before anything has tried
to embed this session). The embedding model lives in
`~/.enio/embeddings-cache`, downloaded once on first use.

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

## Seeing what it knows

The desktop app has a **Memory** button in the top bar. It lists everything
memory holds and lets you prune it in place:

- **Facts** — pin, unpin, or forget each one. Pinned facts ride in every
  turn; the rest only when they look related.
- **Preferences** — the standing instructions injected into every turn.
- **Conversation summaries** — what past conversations contribute to new
  ones. Forgetting a summary removes it from context but keeps the
  conversation itself (that lives in History). A full `enio reindex`
  re-derives all summaries from the transcripts — they are derived data,
  and rebuildability is the point.

The **Graph** tab draws the knowledge graph — the people, projects and
tools Enio has heard about and the relations between them, sized by how
often each is mentioned. The same graph is behind `enio graph "topic"` and
the inspector.

Worth knowing while pruning: the conversation you are in is the authority
on *what you are asking*; memory is background about *you*; files are
evidence a tool reads and cites. When an answer seems steered by something
from another conversation, the summaries list is where to look.
