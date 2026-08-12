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

Tiles **prefill the composer and hand you the caret** — nothing is ever sent
by clicking a tile. You finish the sentence. Picking a tile also opens three
worked examples *for that ability* — each one fills the tile's own template,
so clicking a suggestion produces exactly what typing it would have.

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

## Examples teach the composer

The composer learns the *shape* of good pipelines from examples — a few ship
with Enio (`examples/pipelines/`), and **Save as example** adds your own,
stored under `~/.enio/pipelines/examples/`. Examples are guidance: the
composer adapts them to the request at hand, it never replays them. If the
composer keeps drafting a flow wrong, saving one corrected example of that
flow is the fix — the same way a saved recipe stops AppleScript from being
re-invented.

Saved pipelines are run again by name from the same dialog — selected, never
re-composed, the recipes rule applied to flows.
