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

What rides into a turn depends on what kind of thing it is. **Facts and the
knowledge graph are ambient** — they describe you durably, and the ones that
look relevant accompany every question. **Conversation summaries are not**:
a summary records what happened once, and injected ambiently a small model
can mistake last week's topic for today's task. Summaries appear only when
the question actually refers to the past — "yesterday", "last time",
"remind me", "what did we…" — or when the agent looks them up deliberately
with its `recall` tool.

Within that gate there is one channel of pure **recency**: the last two
days' session summaries, labelled *today* or *yesterday*. "What was I doing
yesterday" resembles yesterday's summary only by accident — the day
boundary is the actual relation, and similarity search cannot express it.

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

## Knowing what it doesn't know

Every turn carries a compact map of what memory has *anything* on — the
people, projects, technologies and so on it has learned about, most
connected first — with the rule that anything not on it and not among the
facts is something it does not remember. So "do you know X?" is a lookup
against a list rather than the model's own guess, which at this model size
is the difference between "I have nothing on that" and a confident
invention. The map is derived from memory and sized to the selected model's
context budget, so it stays a few percent of the window.

The misses are kept. When a question is answered from nothing — no memory,
no file, no search behind it — it lands in a **gap ledger**: what was asked,
how often, and when. A gap closes by itself once a remembered fact carries
its words, and stays visible dimmed as something it learned later. It is
derived from the traces like the graph, so `enio reindex` replays it. See
it under **What it lacked** in the Memory panel or with `enio gaps`; a gap
asked three times shows up in `enio suggest` as research worth doing once.

## Correcting what it knows

Tell it the change — "actually, I switched to Ghostty", "I don't work at
Acme anymore" — and the new fact **closes** the one it replaces rather than
sitting beside it. Nothing is deleted: the old fact stays in the Memory
panel struck through and marked *superseded*, so history is never silently
rewritten and a wrong replacement is visible. Only an explicit correction
does this; a plain "remember that…" never closes anything. From the
terminal, `enio remember "..." --corrects` does the same and prints what it
replaced. Saying the old thing again later reopens it.

## Shaping how it answers

Four axes, three levels each — length (terse, plain, conversational),
warmth (matter-of-fact, friendly, warm), initiative (answer only, suggest a
next step, offer follow-ups) and register (everyday, technical, expert).
Each is **derived** from what memory holds: a preference like "answer
concisely" sets length, three good answers that all end by offering a next
step set initiative, and a graph full of the technologies you work with
sets register to expert, naming the top three. Every axis shows what it was
derived from, and any of them can be set by hand or returned to auto, in
the Memory panel's **Behavior** tab or with `enio personality`.

A level is one line in the prompt, and it is a constraint on the reply's
shape — "start with the answer", "end at the answer", "use plain words" —
never a description of the assistant, because at this model size a
personality adjective is ignored and a rule is followed. The middle level
of each axis adds nothing, and a level that came from a preference adds
nothing either: the preference is already in the prompt, in your words.
Three levels have no line at all — terse, warm, and offer follow-ups —
because every line is measured before it ships, and those three changed
*what* the model did, not just how: a length rule made it write a letter
inline instead of to a file, and "end with a next step" made it take the
step. They still show as the derived or chosen level; they just send
nothing. The tab shows the exact block the next turn carries. Curiosity is a switch rather than an
axis: with it on, a question that lands in the gap ledger says so in the
app. It is never a line in the prompt, because the rule to say "I don't
remember that" rather than guess is not something a setting should soften.

If a custom agent's instructions say one thing and an axis says another,
both are in the prompt and the axis, coming later, tends to win at this
model size; the tab lists any standing preference a choice argues with.

## Seeing what it knows

The desktop app has a **Memory** button in the top bar. It lists everything
memory holds and lets you prune it in place:

- **Facts** — pin, unpin, or forget each one. Pinned facts ride in every
  turn; the rest only when they look related.
- **Preferences** — the standing instructions injected into every turn.
- **What it lacked** — the gap ledger: questions nothing covered, most
  asked first, closed on their own once a fact answers them.
- **Behavior** — how replies are shaped (see below).
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
