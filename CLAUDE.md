# Working on enio

A local AI agent: tools, memory, skills, scheduled tasks. Runs against Maple
(Apple Silicon) or any OpenAI-compatible server.

```sh
npm run typecheck
npm test          # 211 tests, no model server needed — the model is stubbed
npm run build     # tsc; dist/ is what actually runs
```

Always run the tests. They stub the model, so they're fast and need nothing
running.

---

## The four documents

| | For | Read it when |
|---|---|---|
| `README.md` | Users | Someone asks how to install, run or configure it |
| `CLAUDE.md` | You, now | Before changing code — it lists what must not be casually undone |
| `DECISIONS.md` | You, later | Before proposing an architectural change |
| `tunnel.md` | Users | Reaching the agent from a phone or another network |

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

**`tunnel.md`** covers reaching the HTTP endpoint from outside the machine:
Tailscale and Cloudflare Tunnel setups, why NAT traversal works the way it does,
and the bearer-token auth. Relevant to code changes in one respect — anything
touching `src/server.ts` or auth should keep it accurate, since the security
model is documented there rather than here.

---

## The constraint everything else follows from

**The model is small.** Maple has ~1B active parameters. Nearly every design
decision here exists because of that, and most of them look like over-engineering
until you remember it.

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
change the machine is off until `ENIO_DESKTOP=1`. The model deciding to do
something irreversible is exactly the judgement it gets wrong.

The gate is about irreversibility, not about touching apps at all: `mac_recipe`
runs seven fixed read-only scripts chosen from a closed list, and needs no flag
— macOS still prompts for Automation access, which is the consent that protects
the data. Gating a read identically to arbitrary AppleScript made the safest
capability carry the cost of the most dangerous one.

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
