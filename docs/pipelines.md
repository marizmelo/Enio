---
title: Launcher and automations
layout: default
nav_order: 5
---

# Launcher and automations

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

## Automations

"Build an automation" — on the launcher, or the workflow button in the top bar
once a conversation is underway — opens a canvas where abilities chain into
one flow:
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
safety gate applies unchanged — a step that writes an email does not send it:
it waits for you, under the run's outcome when you ran it from a conversation
and in the [outbox](accounts.md) (`enio outbox`) otherwise. Mac automations
still arrive as plans you approve, and an automation can never reach a tool
chat could not.

Connections are typed: a step that produces a document can feed one that
accepts documents, and a connection that makes no sense is refused when you
draw it — so a chain that would fail at step three is impossible to build,
rather than discovered at step three.

If a step fails, everything downstream of it is skipped and the partial
results are kept; running again is a fresh run.

**Run first, save after.** A canvas runs without a name — press Run and watch
it work. Save unlocks once a run has executed, because an automation earns its
place by working, not by being written down: the run you just watched comes
along with the save, so the automation arrives already trusted (see below).
After the first save the button reads Update, and the name — any text you
like — can be changed in place. Saving the same name again updates that
automation rather than creating a copy.

**Stop.** A running automation can be stopped at any time. The step in flight
is abandoned mid-stream, nothing after it starts, and the run is recorded as
cancelled — a stopped run never counts as the automation having worked.

**The execution log.** Every run records what each step replied and every
file it produced. Opening a saved automation lays its latest run over the
canvas — the status rings, each step's output (click a step to read it), and
the files the run wrote, listed by path. Documents land in your workspace
(`~/enio-workspace` unless you moved it with `ENIO_WORKSPACE`), or in the
open project's own folder when one is open.

**Whose account a step uses.** A step that reads email, sends email or
works with the calendar has an **Account** choice under its guidance: *Not
set*, *Enio's own*, *Mine*, or one connected account by name. A step runs
with nobody there to ask and no conversation behind it, so this is where
you say whose mailbox it reads or whose address it sends from.

- *Not set* uses what a conversation would: your default account if you
  chose one, otherwise your account for reading and Enio's own for sending.
- *Enio's own* and *Mine* are resolved when the step runs, so they keep
  working after you replace an account.
- The setting is the choice. Guidance that opens "check the work inbox"
  does not switch away from it, and the agent cannot pick another account
  inside the step.
- If the account was removed, or was connected without the permission the
  step needs, the step **fails and says so**. It does not use a different
  account instead.

Each step starts fresh: an account named in one step's guidance applies to
that step, not to the ones after it.

## Prompt steps

Most steps are an ability — search, write, screenshot. A **Prompt** step is
the one that isn't: a plain instruction with no tools of its own, for the
places where a flow needs shaping rather than doing — *"keep only the three
most relevant findings"* between a search step and a document step, or
*"decide whether this needs a reply"* after reading email. It takes whatever
the previous steps produced and hands text onward. You'll find it in the
canvas palette but not on the launcher — on its own it is just chat.

### What it keeps asking for

`enio suggest` also lists a skill the model has reached for in three or
more turns that is not installed: the model already decided that know-how
should exist, and named it.

### What it couldn't answer

A step's prompt may carry `{{gaps}}`, which enio replaces at run time with
the three questions asked most that nothing in memory covered (see
[Memory](memory.md)). The bundled `research-gaps` example is two steps —
research them on the web, then remember what was found — and the pages
the first step read travel with the facts the second step keeps, so each
one lands in memory with its source.

## Enio learns your flows

There is nothing to manage here — no example library, no separate concept.
**An automation that has run successfully teaches the composer.** The next time
you describe a flow, your proven automations are the examples the draft is
shaped by, alongside the few that ship with Enio (`examples/automations/`).
The compose prompt you typed rides along as the automation's description, so
the composer knows what request each flow answers.

An automation that was saved but never ran teaches nothing, and a failed run
doesn't count — abandoned drafts and broken flows must not shape the next
draft. It is the saved-script rule again: reality vouches, not saving.

**Suggest from my history** (in the automations dialog) goes one step further:
Enio mines its own traces for tool sequences you have repeated at least three
times and offers each as a draft graph. The mapping from tools to steps is a
fixed lookup, never a guess, and a draft opens unsaved — you name it, save
it, and one successful run later it too teaches the composer. It runs when
you click, never in the background.

## A plan from chat

Every message goes to one agent, and the agents' tools do not overlap. So a
request like *"search the web for budget laptops and email me a summary"*
has no right agent: the one that can search cannot send, and the one that
can send cannot search. Ask that in chat and Enio does not pick one of them.
It answers with a **plan**: the steps, which agent runs each, and a card that
says nothing has run yet.

The card under that reply is where the plan is run, and the conversation is
where its answer arrives:

1. **Review** the steps in the reply. If the drafter put a price, a year or
   a count into a step that you never gave, the reply says so under that
   step.
2. **Edit**, if a step is wrong: the plan opens on the automation canvas,
   where you change a step's guidance, add or remove steps, or rewire them.
   **Use in chat** brings the changed plan back to the card.
3. **Run** it from the card. Nothing runs before this, and every safety gate
   still applies inside each step. Each step ticks as its agent works, and
   **Stop** ends it at the next safe point.
4. **Read the outcome** as the next reply in the thread: every step, the
   agent that ran it, what that agent said, and the files it made. A step
   that failed says so, and so do the steps left waiting behind it. So does
   a step that finished without making the thing it was for, such as a
   document step that wrote no document. A follow-up message can build on
   that reply like any other.
5. **Save** it from the card once it has run, if you want it again or on a
   schedule. The run you just watched is what vouches for it.

The automation window is for changing a plan and keeping it. A plan opened
from a conversation is not run there, because its answer would never reach
the conversation that asked.

Enio drafts a plan on its own only when a message joins two things ("and",
"then") *and* the steps need more than one agent. Two things for the same
agent are an ordinary turn, since one agent already does several things in a
row. To ask for a plan outright, start the message with `plan:`. To skip one,
start with `@` and an agent's name. `ENIO_FLOW_PLANS=0` turns this off.

The card and the outcome both come back when you reopen the conversation,
and the card remembers that it ran. An edit you did not run is not kept.

## Agents can run your automations

Ask in chat — *"run the ai-news-brief automation"* — and the generalist runs it
with the `run_pipeline` tool. Selection, never authoring: the model picks
from the closed list of **your saved automations that have already run
successfully**, and an unknown or unproven name gets a refusal that lists
what is eligible. Each step still runs as an ordinary turn, so every gate
holds — the tool grants orchestration convenience, not one new capability.
An automation step cannot start another automation; one hop is the rule
everywhere.

**Save as skill** goes one step further: on any proven automation the canvas
offers a button that writes a [skill](skills.md) naming when to use the flow
and how to trigger it. After that, plain words are enough — *"give me my
morning brief"* finds the skill and runs the automation, no automation vocabulary
required. The export never overwrites an existing skill, and if you later
rename or delete the automation the skill's trigger fails honestly (the refusal
lists what is available) rather than improvising the steps by hand.

Steps that need an outside connection get it automatically: an ability that
declares an [MCP server](mcp.md) requirement — home automation and Home
Assistant, today — inherits that server's tools inside its step, exactly the
way `@server` grants them for one chat turn.

## Scripts: saved computer actions

The panel's second tab is **Scripts** — the tested ones Enio picks by name
instead of writing AppleScript from scratch. They live here rather than in a
drawer of their own because they are the same kind of thing as an automation:
something that *runs*, chosen from a list you curate, vouched by having worked
once. A *Control my computer* step reaches for exactly this list, so the tab
is where you see and edit what such a step can do. (The tab appears on macOS
only; the scripts are AppleScript.)

The switch that lets a vouched script run without asking lives on that tab and
governs only that tab. Nothing on the Automations tab, and nothing in
[Skills](skills.md), is covered by it — and a plan Enio has just written still
goes to the approval sheet, whatever the switch says. See
[Controlling your computer](mac-control.md).

## Triggers

A saved automation can fire three ways, and all three are properties of the
same flow rather than separate things to manage:

- **On command** — press Run on the canvas, or ask in chat by name
  (`run_pipeline`, described above).
- **On a schedule** — the clock chip on the automation's row. Pick how it
  repeats (every hour, every day, weekdays, specific days of the week, or
  monthly) and the time of day; the chip then reads back in plain words —
  *Daily at 9:00 AM* — with the next fire in its tooltip, and *Remove* clears
  it. No cron anywhere: the expression is how schedules are stored, not how
  they are shown (the CLI still accepts one for anything exotic, and such a
  schedule reads *Custom schedule* in the panel). The chip stays disabled
  until the automation has run successfully once — a schedule fires
  unattended, so it takes the same vouching as everything else here. Deleting
  a scheduled automation asks twice, because it also stops the standing job.
- **By phrase** — *Save as skill*, described above: plain words in chat find
  and run the flow.

The scheduled trigger is deterministic — when the clock fires, the harness
walks the graph directly, with no model and no routing between the schedule
and the flow you built. The steps inside run as ordinary turns, exactly as
when you press run yourself. Schedules fire while the desktop app is open (or
`enio serve` / `enio daemon` runs); see [when automations run](#when-automations-run) for the
machinery and the CLI, including scheduling a plain prompt rather than an
automation.

Renaming an automation carries its schedule along, and deleting one removes
its schedule with it — a schedule pointing at a flow that no longer exists
could only fail at the exact moment nobody is watching.

## From the CLI

The panel is the place to build a graph, but a one-step automation is often
all you want, and a machine running headless has no panel at all:

```sh
enio automation new morning-brief \
  --prompt "Summarise what is still open" --agent coder --cron "0 9 * * 1"
enio automation new inbox-digest \
  --prompt "Summarise new mail" --agent mail --account mine

enio automations                              # what exists, and when it next runs
enio automation run morning-brief             # now, ignoring the schedule
enio automation schedule morning-brief --cron "30 7 * * *"
enio automation unschedule morning-brief      # keeps the automation
enio automation runs morning-brief            # recent runs and outcomes
enio automation rm morning-brief              # removes it and any schedule
```

`--agent` picks who runs the step, from the same six agents routing uses; the
default is whoever the router would pick. `--account` says whose account the
step uses: `enio`, `mine`, or a connected account by its label or address
(`--account work`). It is the same choice as the Account menu on a step in
the app. Multi-step automations are built in
the panel — a graph is not something to type — and everything above works on
them just the same.

The CLI takes cron because a terminal is where that notation belongs; the app
keeps its calendar and repeat pickers. Either way it is the same automation
and the same schedule, so one shows what the other did.

## When automations run

**The scheduler runs inside the desktop app** (and inside `enio serve`), so a
schedule set in the panel fires while Enio is open — no second process to
remember. `enio daemon` is the headless alternative for a machine where the
app isn't running; to survive reboots, wrap it in a launchd plist (macOS) or
a systemd user unit (Linux).

Running both is safe. A **lease** in the database decides which process fires:
one holds it and schedules, the other stands by and takes over within a couple
of minutes if the holder goes away (about 30 seconds on a clean quit). Fires
that land exactly in a handover gap are dropped, not replayed — a task runs
once or not at all, never twice.

The scheduler re-reads schedules every 30 seconds, so adding or removing one
takes effect without a restart.

Overlapping runs are **skipped rather than stacked** — a turn can take tens of
seconds, and a `*/1 * * * *` schedule would otherwise pile up until nothing
finishes. A failing run is recorded and the others keep running.

A schedule is validated when you set it, not at 3am when it silently fails to
fire.
