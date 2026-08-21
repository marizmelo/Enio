# Working on enio

A local AI agent: tools, memory, skills, automations. Runs against Maple
(Apple Silicon) or any OpenAI-compatible server.

```sh
npm run typecheck
npm test          # 524 tests, no model server needed — the model is stubbed
npm run build     # tsc; dist/ is what actually runs
npm run lint      # the renderer only; tsc does not see desktop/renderer
```

Always run the tests. They stub the model, so they're fast and need nothing
running.

The lint exists for one bug class the rest of the toolchain cannot see: the
renderer is plain JSX, esbuild treats a bare identifier as a global, so an
unimported component builds green and throws at render. It runs inside the
desktop build too, so that failure is a build failure rather than a white
window.

---

## The four documents

| | For | Read it when |
|---|---|---|
| `README.md` | Users | The pitch and a quickstart. Keep it short — depth belongs in `docs/`. |
| `docs/` | Users | How to use any feature. GitHub Pages serves this folder. |
| `CLAUDE.md` | You, now | Before changing code — it lists what must not be casually undone |
| `DECISIONS.md` | You, later | Before proposing an architectural change |

`docs/` is checked by `src/docs.test.ts`: every environment variable, tool,
script and agent it names must exist, every page needs Pages front matter, and
internal links must resolve. Prose drifts silently otherwise — the README
accumulated four false claims in a single session before that test existed.

**`DECISIONS.md` is the one that is easy to skip and shouldn't be.** It records
what was *considered and rejected* — which nothing else captures. `git log`
shows what was done, never what was deliberately declined, so without it you
will re-argue settled questions and rediscover dead ends.

It covers: the agent frameworks evaluated and why the loop stayed hand-rolled;
why the knowledge graph is derived rather than authoritative; why skills instead
of more MCP servers; why desktop control is scripting rather than pixel
automation; libraries that turned out to be dead ends (Kùzu, LadybugDB, nut.js);
the bugs that already cost real time; and a list of things deliberately **not**
built, each with the condition under which it would become worth building.

It also ends with genuinely open questions. Those are open, not rhetorical —
treat them as unknowns rather than inheriting them as settled.

**`docs/remote-access.md`** covers reaching the HTTP endpoint from outside the
machine: Tailscale and Cloudflare Tunnel setups, why NAT traversal works the way
it does, and the bearer-token auth. Relevant to code changes in one respect —
anything touching `src/server.ts` or auth should keep it accurate, since the
security model is documented there rather than here.

---

## The constraint everything else follows from

**The model is small.** The default is a 4B (Qwen3 4B Instruct); Maple, the
optional alternative, has ~1B active parameters; everything must still work at
that floor. Nearly every design decision here exists because of that, and most
of them look like over-engineering until you remember it. Never size anything
off model identity — `contextBudget()` is the only knob that follows the
selected model.

Concretely, a ~1B-active model:

- picks tools badly once it can see more than a handful
- emits malformed JSON often enough that repair is a normal path, not an edge case
- loses the thread after three or four tool calls
- produces inconsistent vocabulary when asked to generate freely
- is far better at *classification* than at open generation

If you are about to make something depend on the model reliably making a
judgement call, stop and check whether you can turn it into a choice from a
short closed list instead. That single transformation is behind the specialists,
the router, memory extraction, and skills.

---

## Invariants — do not undo these casually

Each of these was a deliberate decision with a reason. If one is genuinely
wrong, change it and update this file. Do not change one by accident.

**The 16-tool ceiling** (`ENIO_MAX_TOOLS`). Past roughly this many tool
definitions the model picks at random. The failure mode is not an error — it is
quietly choosing wrong tools, which looks like the model being stupid. Every
specialist stays at ≤6 tools; there's a test asserting it. When adding a tool,
ask which specialist owns it, not "where can I fit this".

**Specialists have disjoint tool sets.** That is the whole point. `coder` has no
web access; `researcher` has no shell. Overlap erodes the benefit until you have
one agent with every tool again.

**Users see "agents"; the code says "specialists".** Deliberate, not drift.
"Specialist" describes the architecture accurately and this file, `DECISIONS.md`
and the module names all use it. "Agent" is what anyone who has used an AI
product already understands, so it is what the UI, the CLI help and the
`/capabilities` response say. The line is: anything a user reads says agent,
anything a maintainer reads says specialist. The DB column, the router's own
prompt and its JSON key stay `specialist` — the first needs a migration to
change and the other two are model-facing, where re-wording a working classifier
buys nothing.

**Users see "automations"; the code says "pipelines".** The same split, for
the same reason. "Pipeline" is the accurate word for a graph of nodes the
harness executes, and it is what `src/pipelines.ts`, the DB tables, the HTTP
routes and `docs/pipelines.md` (a published URL) all say. "Automation" is
what someone means when they want a thing that runs itself, so it is what the
UI and the docs prose say. Model-facing text is the exception that proves it:
the tool stays `run_pipeline` — renaming a working classifier's key buys
nothing — but its *description* and the router examples use "automation",
because that is the word arriving in the user's message.

**Users see "scripts"; the code says "recipes".** The third pairing, for the
same reason as the other two. A recipe is a plan the user approved and named,
which enio then selects rather than re-authors; "recipe" describes that
mechanism accurately and is what `plans.ts`, the DB table, the HTTP routes and
`mac_recipe` all say. What the user has is a saved computer script, so the tab
is **Scripts**, the switch says "Run safe scripts automatically", and the docs
say script throughout. `mac_recipe` keeps its name: it is model-facing, and
renaming a working classifier's key buys nothing.

Scheduling is not a separate concept at all. **Tasks were retired as a user
concept** (August 2026): a schedule is a property of an automation, set in the
app or over the API. `src/tasks.ts`, the `tasks` table and `/tasks/schedule`
remain as the machinery, and `enio daemon` still hosts the scheduler — but
there is no `enio task` CLI and no tasks page, because three surfaces
describing a concept the product had stopped presenting is how documentation
starts lying. Watches, which were documented alongside tasks, are their own
thing and kept their own page.

`enio automation` replaced what the task CLI could do, in the automation's own
vocabulary: retiring the old commands had left scheduling reachable only from
the app and the API, which is wrong for something that runs headless. A
CLI-built automation is one step -- a graph is not something to type -- and its
schedule is the same reserved `auto-<pipeline id>` task the panel writes, so
the two surfaces cannot disagree about what is scheduled. The CLI takes cron;
the app keeps its pickers, and the never-show-cron rule stays a *UI* rule.

**One hop only.** Router → specialist → answer. No agent-to-agent conversation.
Every hand-off compounds error and at this model size it compounds fast.

**Memory extraction uses a closed vocabulary** (`src/memory/schema.ts`, nine
relations, six entity types). Open-ended extraction produces `USES` / `uses` /
`USES_TOOL` as three separate relations and a graph that degrades as it grows.
Adding relations measurably increases confusion — anything that doesn't fit
belongs in `facts`, which is free text.

**Raw transcripts are the source of truth; the graph is derived.** That is what
makes `enio reindex` safe and lets a better model rebuild memory later. Never
make the graph authoritative.

**Everything degrades, nothing fails.** No vision model → OCR. No OCR →
dimensions. No embeddings → lexical matching. A tool that can only fail is
*withheld* rather than offered, because a dead-end tool burns the model's
limited attention. An attachment must never be able to fail a turn.

**Irreversible actions are opt-in.** Email is dry-run until `ENIO_EMAIL_SEND=1`.
IMAP opens with `EXAMINE` so the *server* refuses changes. Anything that can
change the machine is off until `ENIO_DESKTOP=1`. Clicking and typing on web
pages is off until `ENIO_BROWSER_ACT=1` — that one gates a *security boundary*,
not just reversibility: a reader that cannot act is immune to a page's
instructions, and with the flag on a hostile page can become clicks in a
possibly-logged-in session. The blast radius stays the browser (no shell, no
filesystem — the disjointness test in web.test.ts still holds), but do not
weaken the default or widen what an acting browse can reach. The model deciding
to do something irreversible is exactly the judgement it gets wrong.

The gate is about irreversibility, not about touching apps at all: `mac_recipe`
runs fixed read-only scripts chosen from a closed list, and needs no flag —
macOS still prompts for Automation access, which is the consent that protects
the data. Gating a read identically to arbitrary AppleScript made the safest
capability carry the cost of the most dangerous one.

**The agent's browser is its own; logins enter it only through `enio login`.**
Session cookies persist in `browser-state.json` (owner-only, `ENIO_BROWSER_PERSIST=0`
to refuse), and the login flow is a *headed* window the user drives — the
password never passes through enio or the model. Never add a path that reads
the user's everyday browser profile or cookie store, and keep `renderPage`
(the stateless fetch) off the state file: a one-shot render carrying logins
would quietly turn every `web_fetch_rendered` into an authenticated request.

**Clicking is by name, never by coordinate.** `window_controls` and
`menu_items` read the macOS accessibility tree, so a plan step says
`click: "Save"` rather than a pixel. This is the same closed-list
transformation as everything else here, and it fails safely: a name that is no
longer there errors, where a coordinate would quietly hit whatever moved into
it. The tree needs Accessibility permission — separate from Automation (-1743) —
and the AX recipes are withheld until it is granted. Match on the *phrase*
"not allowed assistive access", never the bare -1719: macOS reuses that code
for "Invalid index".

Reading, pressing and typing go through `scripts/ax_bridge.py` (pyobjc) when
it is available, with AppleScript as the fallback. This is not a preference
but a capability difference — Calculator reports zero windows to System Events
and twenty-three named buttons to the AX API — and it is faster besides.
Bridge typing sets the field's value rather than synthesizing keystrokes: it
works without fronting the app and *structurally refuses password fields*
(`AXSecureTextField` by role) — do not replace it with an event-posting path,
which would need a third TCC permission for unverifiable delivery (see the
Peekaboo entry in DECISIONS.md). A click still compiles to a script so the
approval sheet keeps showing the text that actually runs, and names reaching
the shell go through `quoted form of`. Actions are compiled at *propose* time
so the sheet shows the text that will actually run.

**A plan step can be AppleScript, shell or Python** (`kind` on the step,
missing means AppleScript). The model writes Python far better than it writes
AppleScript — that asymmetry is the point, since moving work down from GUI
scripting to a library call improves execution *and* authoring. Approving runs
each step under its own interpreter; a recipe must be one kind, because it
becomes a single script.

**Auto-run applies only to recipes a person marked safe.** Two switches:
`ENIO_DESKTOP` says whether this can act at all, auto-run (`~/.enio/automation.json`)
says whether a *vouched* recipe may act without asking. A plan the model has
just composed always goes to the approval sheet, whatever auto-run says — that
line is not negotiable by any setting. An unmarked recipe now proposes rather
than running silently, which is stricter than it used to be.

**A plan can also be revised by prompt** (`POST /plans/:id/revise`). Framed as
a transformation, not an invention: the current steps go in as JSON and revised
steps come back, with an instruction to leave untouched anything the request
did not mention — much closer to the classification this model size is good at
than "write me a plan". It returns the steps rather than storing them, so a bad
rewrite costs a glance and one Undo, never an action.

**The approval sheet is editable, and each step can be tested alone.** What the
user reads is what they consent to, so edits are written back before the run —
the record, the approval and the execution stay one thing. Testing runs the
editor's text without settling the plan.

**The context budget follows the selected model** (`contextBudget()` in
`model-settings.ts`, not a constant on config). It is the band where recall
still holds, not the model's advertised window: Maple measured 4/4 on a
planted fact near 1.5k tokens and 0/4 by 12k, which is where 2000 came from.
It must stay a function, because the model is switchable at runtime and a
constant would keep a large budget after switching *back* to Maple — which
degrades answers with nothing visible going wrong. Numbers for other models
are a conservative step up and explicitly not measured; `contextBudgetMeasured()`
says which is which.

**Compaction folds to 60% of the budget, not to the brim.** Keeping everything
that fits left nothing for the turn's own work — tool results and the reply are
appended after the fold — and made every later turn re-fold at the ceiling, so
the meter sat at 94/95/96% and never fell. The gap between trigger and target
is the hysteresis.

**The tool ceiling belongs per specialist, not to the registry.** With routing
on the model only ever sees one specialist's ≤6, so capping the registry as
well stacked two limits: one extra desktop tool pushed the total past 16 and
silently truncated the end of the list, which is where the web tools live.
Single-agent mode still caps the registry, because there it *is* what the model
sees.

**Projects are defined and opened by the user, never by the model.** No tool
creates a project, attaches a path, or opens one — the only routes in are the
CLI and the authed HTTP endpoints, which is what keeps the sandbox something
the user grants rather than something the model widens. The active project is
process memory: a server restart forgets it, and reopening is a user act —
which includes launching the desktop app, whose boot restore reopens *the
project the user last chose to have open* (recorded in `project-state.json`,
cleared on close, and reopened through the authed endpoint like any other
open). It must never be inferred from data — restoring the newest
conversation's tag instead meant closing a project never survived a relaunch,
and every new chat afterwards silently inherited a project nobody opened.
A conversation *belongs to* the project it was started under, and the desktop
keeps scope and conversation aligned: opening a conversation opens its project
(the history row wears the project's name, which is what makes that click
informed consent), opening an unowned one closes the scope, and leaving a
project lands in a fresh chat rather than stranding the user in a project's
conversation without its scope. That alignment does not soften the
inferred-from-data rule — boot restore still keys off `project-state.json`,
and when it is empty but the newest conversation is owned, the faithful
restore is a fresh chat, because null-while-owned can only mean the user left.
While
one is open the readable roots are the attached paths (addressed by alias as
the first path segment), the project's own out dir (unprefixed paths), and a
read-only fallback to the global workspace for files that already exist there
— conversation attachments must never fail a turn. A project is *contextual*,
not a mode: routing keeps working, the type only biases the router. And every
always-loaded project field (description, instructions, notes) is hard-capped
at save time, sized to the smallest supported context budget — refuse
overflow, never truncate, and never size anything off the model's identity
instead of `contextBudget()`.

**The model proposes scripts; it does not run them.** No specialist has
`run_applescript`. The operator calls `propose_plan`, which stores the script
and stops; execution happens server-side only after the user approves, and
approving is one-shot (a settled plan returns 409 rather than running twice).
Saving promotes it to a named recipe — but only after every step ran
successfully, because a recipe is *selected* rather than re-authored from then
on, and a script that never worked would be re-run verbatim forever. Pending
plans survive restarts: `GET /plans/pending` is how the desktop re-draws
approval cards the live stream would otherwise have been the only carrier of.
This exists because the model reliably fails to write correct AppleScript and
just as reliably keeps trying variations; see DECISIONS.md.

**No network at runtime for local features.** OCR language data ships as an npm
dependency specifically because tesseract.js defaults to a CDN fetch. There is a
test that disables `globalThis.fetch` and requires OCR to still work. Do not
reintroduce a CDN path.

**Untrusted content is defanged of control tokens before it reaches the
model.** `neutralizeControlTokens` (`src/sanitize.ts`) runs on every tool
result at the `executeCall` chokepoint, and on attachment/OCR text which takes a
different path into the prompt. The model server flattens message `content`
straight into the chat template, so a fetched page or file containing a literal
`<|im_start|>` forges a role boundary — a structural attack no `[data, not
instructions]` label defends against. It neutralises in place (`<|im_start|>` →
`⟨im_start⟩`) rather than deleting, so the trace stays honest, and it is
model-agnostic because the model is switchable at runtime. Do not remove it when
adding a tool that returns external content, and do not "clean it up" into a
per-tool call — the whole point is that it is one chokepoint no tool can bypass.

**Auth applies on loopback too.** A web page you have open can POST to
127.0.0.1, and origin checks aren't a boundary. The `coder` specialist has
`run_command`, so an unauthenticated endpoint is remote code execution.

**Tracing must never break a turn.** `recordTurn` is wrapped in try/catch. Losing
a diagnostic is annoying; losing the user's answer to a failed trace insert is
not acceptable.

---

## Layout

```
src/
  agent.ts        the turn loop — tool calls, recovery, prompt assembly
  model.ts        client for the model server; JSON repair, <think> splitting
  specialists.ts  routing and per-specialist tool sets
  skills.ts       SKILL.md loading, progressive disclosure
  mentions.ts     /skill and @mention parsing
  notes.ts        the managed note store: transforms, comment anchors
  tasks.ts        scheduler
  suggest.ts      mines traces for what's worth automating
  vision.ts       images → text
  inspect.ts      the trace/graph UI server
  memory/         db, embeddings, extraction, store, traces, learning
  tools/          one file per tool group
ui/               React inspector (esbuild, no dev server)
desktop/          Electron client
examples/skills/  shipped example skills
```

`config.ts` reads `ENIO_*` with a `MAPLE_*` fallback — the project was renamed
and old env vars still work.

## Conventions

**Comments explain why, not what.** The code says what it does. Comments carry
the reasoning that would otherwise be lost — especially where something looks
wrong and isn't. If a comment restates the line below it, delete it.

**Commit messages do the same.** The diff shows what changed; record the
constraint, the alternative rejected, and the failure it prevents.

**Tests cover what breaks quietly.** JSON repair, `<think>` tags split across
stream chunks, sandbox escapes, allowlist bypasses via pipes, SSRF hosts
rejected *before* any request, constant-time token comparison against
same-length wrong keys. Prefer a test that would catch a silent regression over
one that checks something obvious.

**A test that builds the registry must redirect its whole environment.**
`ENIO_DATA_DIR`, `ENIO_WORKSPACE`, `ENIO_MACHINE_STATE_DIR`, `ENIO_MCP_CONFIG`
*and* `ENIO_BUILTIN_SKILLS` — set before the first import, since config reads them at
module load. The last one is the sharpest: `buildRegistry` connects MCP
servers for real, so a suite that inherits the developer's `~/.enio/mcp.json`
spawns `npx` processes, hangs for minutes, and passes or fails depending on
whose machine it runs on. It stayed invisible while no mcp.json existed;
adding one connection turned the suite from 15 seconds into a hang.
`ENIO_BUILTIN_SKILLS` is the same class: the bundled skills are read from
`examples/skills/` in the checkout, which *every* test inherits, so a suite
that redirects only the data dir loads seven skills into every prompt it
measures — which is how it was caught, by a compaction test that suddenly had
no headroom. A test that writes built-ins must redirect it too, or it writes
into the repo.

**Adding a tool:** define it in `src/tools/`, add it to `buildRegistry`, assign
it to exactly one specialist, keep that specialist ≤6 tools. If it needs config,
withhold the tool entirely when unconfigured.

**Adding a capability:** ask whether it's *know-how* or *capability*. Know-how is
a skill — markdown, no code, one shared tool slot. Capability is a tool or an
MCP server. People reach for MCP when they needed a skill.

## Things that have bitten before

- Backticks inside a SQL comment inside a JS template literal terminate the
  string. `src/memory/db.ts` uses plain words instead.
- tesseract.js reports a missing language file by throwing from inside a worker
  event handler — that escapes the promise chain, so `await` catches nothing and
  the process dies. Availability is checked up front, never attempted-and-caught.
- Maple closes its `<think>` block *inside* the `<tool_call>` block, so the
  JSON is followed by a stray `</think>`. mlx-lm's parser is
  `json.loads(text.strip())`, which rejects that as "Extra data", drops the
  call, and returns empty content — every tool call silently lost, the turn
  looking like the model said nothing, with the only evidence in
  `~/.enio/model-server.log`. enio cannot repair it: its own JSON repair and
  `<tool_call>` scavenging never see the text, because the failed parse
  consumes it first. `scripts/patch-runtime.mjs` makes the parser use
  `raw_decode`; `install.sh` re-applies it after every pull.
- Cosine similarity and lexical-overlap scores are on different scales. They had
  a shared threshold once and keyword search silently returned nothing.
- The lexical fallback needs stemming: people rephrase when they repeat
  themselves, so `summarise`/`summarize`/`summary` and `work`/`worked` must
  collapse or clustering finds nothing.
