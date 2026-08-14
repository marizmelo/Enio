---
title: Chatting
layout: default
nav_order: 3
---

# Chatting

## `/skill` and `@mention`

Two ways to override the model's judgement — useful precisely *because* the
model is small. The router picking an agent, or the model deciding a skill
applies, are exactly the calls it gets wrong.

```
/commit-message                  run a skill directly, no deciding involved
@coder why does this fail        force an agent, skipping the router
summarise @notes/plan.md         attach a workspace file
@github what changed this week   allow an MCP server's tools this turn
```

Tab completes all of it — `/` lists skills, `@` lists agents, MCP servers
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

Links appear **inside the answer**, on the thing they are about — a product
name, a document, a claim — rather than as a list to cross-reference
afterwards. Bare URLs the model writes become links too, shortened to their
domain and path. All of them open in your real browser.

Under the answer, **Sources** lists every page the turn read, deduped:
searching and then fetching the top hit is the normal path, and citing it twice
would misstate how much was consulted.

Sources come from what the tools returned, so they are the evidence the model
saw rather than a separate account of it. A page that returned 404 is never
cited, and neither is a failed fetch: an answer that looks sourced when the
source is an error message is worse than one that cites nothing.

This is worth the space specifically because the model is small. It reads a
page and writes a paragraph, and in the paragraph a summary and an invention
look identical.

## Reading a reply as it arrives

The thread follows the answer while you are at the bottom, and stops following
the moment you scroll up — so you can read back through a long reply while it is
still being written. A **Jump to latest** button appears while you are scrolled
away; sending a message always returns you to the bottom.

## Voice conversation

Press the waveform button beside the speaker toggle and talk: Enio
transcribes what you said, answers, reads the answer aloud, and listens
again. The pill shows whose turn it is — *listening* (pulsing dot),
*thinking*, *speaking* — and one click does the obvious thing for each:
**click while it thinks or speaks to interrupt** (the reply stops
mid-sentence, kept as text); **click while it listens to exit**.

It never listens while it speaks, on purpose. On speakers, an open
microphone would hear Enio's own voice, transcribe it, and answer itself —
so the microphone is off from the moment you stop talking until the reply
has finished playing. That is also why interruption is a click rather than
a voice command: the mic is closed precisely when you would want to barge
in. Typing a message while the mode listens is fine — the mic pauses,
the typed reply is spoken, and listening resumes.

The mode needs both halves of the voice stack — speech recognition
(`enio voice --install`) and a voice (`ENIO_TTS`) — and the button only
exists when both do. The macOS microphone indicator stays lit for the
whole session: that is the honest signal the mode is on.

## What the context meter means

The bar in the status bar is how full the model's *usable* window is — not its
advertised context length, but the band where it still reliably remembers what
it was told. When a conversation outgrows it, older turns are folded into a
summary and the meter drops back down.

Recent turns are kept whole, because that is where pronouns point: a summary of
"the user asked about the deploy script" cannot resolve "run it again".

See [Models](models.md) for how the size of that window is chosen.

## Start from a tile

A new chat opens on the [launcher](pipelines.md): every ability as a tile.
Picking one locks onto that ability — the right agent is pinned, the message
box takes focus, and three things it is good at appear under *Try saying*.
Type straight away, or click a suggestion; nothing sends until you send it,
and **← All abilities** goes back. Greyed tiles are abilities that need
setup, with the steps one click away.

## Files and attachments

Attach a file with the **+** menu, by dragging it in, or by pasting an image.
An attachment made this way belongs to **one message**.

**Add to conversation…** in the same menu is the standing version: pick any
folder or file on disk and it stays readable for the whole conversation — a
chip above the composer shows it, with an × to detach. The agent addresses it
by its alias as the first path segment (attach `~/Projects/thesis` and
"summarise thesis/chapter2.md" just works), and reopening the conversation
later brings the access back with it. With a [project](projects.md) open the
same item reads **Add to project…** and the grant lands on the project
instead — standing context follows the widest scope you have open. The roots
the agent can read are always ones you granted by hand; nothing the model
does can add one.
The workspace list in that menu shows a thumbnail for anything previewable —
four screenshots are indistinguishable by name and obvious by picture. With a
[project](projects.md) open, **From project…** opens a browser over the
project's attached folders — walk in, search all of them at once, or attach a
whole folder — and picking a file that already lives in the project
references it in place rather than copying it.

**PDFs are read for real.** An attached or referenced PDF has its text layer
extracted before the model sees it, so questions are answered from the actual
document. A scanned PDF with no text layer says so honestly, and other binary
files are named as unreadable rather than decoded into garbage — garbage in
the prompt is what used to invite the model to invent the contents.

**Every reply says who answered and what it read.** The chip above a reply
— `@researcher`, `@coder` — is the agent the router picked, stated by the
harness rather than by the reply, so it stays true even when the text does
not. The sources under a reply now include files as well as pages: a turn
that read `thesis/chapter2.md` lists it, click opens it in the viewer. Both
exist for the same reason as the MCP badge — at this model size the sentence
cannot be trusted to say where its content came from, so the frame says it.

**Specifics are checked against their sources.** On any turn that read
material — files, tool results, attachments — the hard specifics in the reply
(emails, phone numbers, URLs, figures, names) are checked against what the
turn actually saw. Anything unaccounted for surfaces as a notice under the
reply: *"Not found in this turn's sources: … These may be invented."* It
never blocks or rewrites an answer; it tells you which details to verify
before relying on them.

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

## The canvas

When the agent writes a document — *"build me a resume"* ends in `resume.md`
— the file opens in a panel beside the conversation, not just a sentence in
the reply. It stays pinned until you close it, save a copy somewhere, or
discard it.

The split is adjustable by dragging the divider, and the header's expand
button takes the canvas **fullscreen** — the whole window for writing, one
click to bring the conversation back. [Notes](notes.md) open fullscreen by
default, since opening one is choosing to write.

**It is a real file in a real folder.** The panel's header shows the path —
your workspace (`~/enio-workspace`), or the project's own folder when one is
open — and clicking it reveals the file in Finder. Everything else follows
from that: the canvas, the agent, and any editor you open the file in are
all reading and writing the same bytes on disk.

**Edit it anywhere.** Type directly in the panel and press Save (or
⌘S); markdown
gets a Preview toggle. Or hand it to a real editor: **Open in app** launches
the system's default editor for that file type, and Finder's full *Open
With* menu is one Reveal away. Edits made outside show up in the panel
within a couple of seconds.

**Or iterate in chat.** With the canvas pinned, your next message carries
one visible word — `@canvas` — which Enio resolves to the pinned file and
to the agent that can edit it. Ask for the change in plain words; the file
is rewritten and the panel reloads. If you had unsaved edits, it asks
before replacing them. Mentioning an agent explicitly wins: `@researcher
what does @canvas claim?` asks about the document instead of rewriting it.

**Leaving.** *Save a copy…* opens the native save dialog (unsaved edits are
saved first, so the copy matches what you see). *Discard* moves the file to
the macOS Trash — Put Back restores it to its folder. *Close* just unpins;
the file stays where it is.

The canvas auto-opens only for documents (`.md`, `.txt`) the agent writes —
code files during project work don't pop panels. Any other text file, or an
image, opens in it by hand: the pencil button in the file viewer.

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
