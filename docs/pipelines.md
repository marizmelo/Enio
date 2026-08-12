---
title: Launcher and pipelines
layout: default
nav_order: 5
---

# Launcher and pipelines

Two ways to make a small model more accurate by narrowing *before* the model
runs: pick the ability yourself, and chain abilities into a flow the harness
executes.

## The launcher

A new chat opens on a grid of tiles — every ability Enio has, named the way
you think of them. Picking a tile does two things a typed message cannot:

- **It removes the routing guess.** A tile pins the agent through the same
  `@mention` grammar you could type by hand; the classifier never runs.
- **It states the expectation.** "Create document" means a markdown file gets
  saved; "Send email" means a draft (or a send, if you enabled it).

Picking a tile **locks onto that ability**: the grid gives way to that one
ability and three things it is good at, under *Try saying*. The message box
takes focus with the agent already pinned, so you can simply start typing —
or click a suggestion, which fills the rest of the sentence for you. Either
way **nothing sends until you send it**. **← All abilities** goes back to the
grid and unpins.

Unconfigured abilities stay visible, greyed, with the setup path one click
away (an environment variable, `enio login`, an MCP server). The model is
only ever shown tools that work — a dead-end tool burns its attention — but a
*person* is shown what could work, because a person can act on "set
`ENIO_DESKTOP=1`" where a model can only fail. Tiles marked *soon* (images,
video) are honest signposts, not features.

## Pipelines

"Build a pipeline" opens a canvas where abilities chain into one flow:
describe what you want — *"research a topic and write a document about it"* —
and a draft graph appears, ready to edit. Drag steps in from the palette,
rewire the connections, click a step to edit its guidance, then run.

The design rule that makes this work at this model size: **the model never
owns the graph.** Composing is classification into the closed list of
abilities — a step it invents is refused, not improvised around — and what it
produces is a draft on an editable canvas, never something that executes.
When you press run, the *harness* walks the graph in order; each step runs as
one ordinary narrow turn with its agent pinned, and what a step produces
(a document, a screenshot, a draft) flows to the next one.

A step's prompt is **guidance, not a script**: inside a step the agent keeps
its normal tools and judgement, exactly as in chat. Which also means every
safety gate applies unchanged — email stays dry-run until `ENIO_EMAIL_SEND=1`,
Mac automations still arrive as plans you approve, and a pipeline can never
reach a tool chat could not.

Connections are typed: a step that produces a document can feed one that
accepts documents, and a connection that makes no sense is refused when you
draw it — so a chain that would fail at step three is impossible to build,
rather than discovered at step three.

If a step fails, everything downstream of it is skipped and the partial
results are kept; running again is a fresh run.

**Run first, save after.** A canvas runs without a name — press Run and watch
it work. Save unlocks once a run has executed, because a pipeline earns its
place by working, not by being written down: the run you just watched comes
along with the save, so the pipeline arrives already trusted (see below).
After the first save the button reads Update, and the name — any text you
like — can be changed in place. Saving the same name again updates that
pipeline rather than creating a copy.

**Stop.** A running pipeline can be stopped at any time. The step in flight
is abandoned mid-stream, nothing after it starts, and the run is recorded as
cancelled — a stopped run never counts as the pipeline having worked.

**The execution log.** Every run records what each step replied and every
file it produced. Opening a saved pipeline lays its latest run over the
canvas — the status rings, each step's output (click a step to read it), and
the files the run wrote, listed by path. Documents land in your workspace
(`~/enio-workspace` unless you moved it with `ENIO_WORKSPACE`), or in the
open project's own folder when one is open.

## Prompt steps

Most steps are an ability — search, write, screenshot. A **Prompt** step is
the one that isn't: a plain instruction with no tools of its own, for the
places where a flow needs shaping rather than doing — *"keep only the three
most relevant findings"* between a search step and a document step, or
*"decide whether this needs a reply"* after reading email. It takes whatever
the previous steps produced and hands text onward. You'll find it in the
canvas palette but not on the launcher — on its own it is just chat.

## Enio learns your flows

There is nothing to manage here — no example library, no separate concept.
**A pipeline that has run successfully teaches the composer.** The next time
you describe a flow, your proven pipelines are the examples the draft is
shaped by, alongside the few that ship with Enio (`examples/pipelines/`).
The compose prompt you typed rides along as the pipeline's description, so
the composer knows what request each flow answers.

A pipeline that was saved but never ran teaches nothing, and a failed run
doesn't count — abandoned drafts and broken flows must not shape the next
draft. It is the recipes rule again: reality vouches, not saving.

**Suggest from my history** (in the pipelines dialog) goes one step further:
Enio mines its own traces for tool sequences you have repeated at least three
times and offers each as a draft graph. The mapping from tools to steps is a
fixed lookup, never a guess, and a draft opens unsaved — you name it, save
it, and one successful run later it too teaches the composer. It runs when
you click, never in the background.

## Agents can run your pipelines

Ask in chat — *"run the ai-news-brief pipeline"* — and the generalist runs it
with the `run_pipeline` tool. Selection, never authoring: the model picks
from the closed list of **your saved pipelines that have already run
successfully**, and an unknown or unproven name gets a refusal that lists
what is eligible. Each step still runs as an ordinary turn, so every gate
holds — the tool grants orchestration convenience, not one new capability.
A pipeline step cannot start another pipeline; one hop is the rule
everywhere.

## Scheduled pipelines

A [task](tasks.md) can trigger a pipeline instead of a prompt:

```sh
enio task add news-daily --cron "0 9 * * *" --pipeline ai-news-brief
```

The trigger is deterministic — when the clock fires, the harness walks the
graph directly, with no model and no routing between the schedule and the
flow you built. The steps inside run as ordinary turns, exactly as when you
press run yourself.
