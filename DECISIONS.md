# Design record

How enio came to be, what was considered and rejected, and what is deliberately
missing. `CLAUDE.md` says what the rules are; this says why they exist and what
the alternatives were.

Written at v1.6, after the session that built it.

---

## How it started

The first question was literally "how do I run this" about a 404'd URL for
DeepGrove's Maple model. The model turned out to live on Hugging Face, needed a
forked mlx-lm to run at all, and worked — 218 tok/s on an M4, 20B parameters
with ~1B active.

Everything after that came from one observation: a fast local model that can't
*do* anything and doesn't remember you is a demo, not a tool.

---

## Decisions, and what was rejected

### No agent framework

**Chose:** a hand-rolled tool loop, ~150 lines in `src/agent.ts`.

**Rejected:** Pydantic AI, LangGraph, Genkit, Mastra.

Every framework's loop assumes the model returns well-formed tool calls. The
bulk of what makes this work is the recovery paths — scavenging `<tool_call>`
blocks the server failed to parse, repairing single-quoted JSON, feeding the
real tool list back on a hallucinated name, forcing an answer on the last
iteration. Inserting those means fighting the abstraction.

Genkit came up repeatedly and deserved a fairer hearing than it first got. Its
dev UI is the best in the TS space. The synthesis that would work: Genkit as an
*orchestration* layer above the OpenAI-compatible endpoint on `:8787`, with the
hardened loop still underneath. That remains available and unbuilt.

### Specialists over one agent

**Chose:** a router picking one of six specialists with disjoint tool sets.

The reason is the tool budget, not org-chart aesthetics. Past ~16 tools the
model picks at random, and the failure is silent rather than an error. Showing
it 4–6 coherent tools is the single largest available improvement to
small-model tool accuracy — larger than any prompt tweak.

Counterintuitively this helps a *small* model more than a large one, which is
the opposite of how multi-agent setups are usually pitched.

### Memory: transcripts authoritative, graph derived

**Chose:** three layers — raw transcripts, explicit facts, derived knowledge
graph.

**Rejected:** making the graph the source of truth; open-ended triple
extraction; a real graph database.

Open-ended extraction from a ~1B-active model produces `USES` / `uses` /
`USES_TOOL` as three separate relations and a graph that degrades as it grows.
Constraining it to nine relations and six entity types turns generation into
near-classification, which small models handle far better.

Kùzu was the obvious embedded-graph pick and is dead — Apple acquired the team,
repo archived. LadybugDB (the community fork) was evaluated and rejected: one
star, no tagged releases, may compile from source on install. SQLite with
entities and edges tables is no worse at personal scale.

### Skills over more MCP servers

**Chose:** the SKILL.md format, one shared tool slot for any number of skills.

The distinction that matters: **MCP gives a model new capability; skills give it
know-how.** A tool lets it send email; a skill tells you how you want emails
written. People reach for MCP when they need a skill, get something generic, and
then re-explain their preferences every time.

Four skills cost ~230 tokens of prompt, measured. The same capability via MCP
would cost a tool slot per server against a 16-tool ceiling.

### Learning without training

**Chose:** preferences and exemplars.

**Rejected:** LoRA fine-tuning; training on a corpus.

The distinction people get backwards: **fine-tuning teaches form, retrieval
teaches facts.** Training on documents makes a model sound right about a domain
and reliably wrong about its specifics — fluent, correctly-shaped, subtly-wrong
answers with no provenance.

LoRA on Maple specifically is likely infeasible (custom 256-expert MoE, ternary
weights that are quantisation-aware from the start of training), but untested.

### A trace inspector, not a node canvas

**Chose:** a timeline view for runs; ReactFlow only for the knowledge graph.

**Rejected:** Genkit/Mastra/LangGraph Studio; Langfuse; a visual task builder.

Every framework dev UI only auto-discovers its own primitives, so adopting one
means rewriting the loop into its abstractions. Langfuse is framework-agnostic
but sees prompt-in/completion-out — it cannot show which memories were retrieved
or which specialist was picked, which is exactly what matters here.

The topology is fixed: router → one of six → tool loop. A canvas rendering a
static graph is decoration. The knowledge graph is the one genuinely
graph-shaped thing, and it's where node-link layout earns its place.

### Computer use by scripting, not pixels

**Chose:** opening the shell allowlist to `osascript`, `shortcuts`, `open`,
`mdfind`, `screencapture`, plus two wrapper tools.

**Rejected:** nut.js and pixel-level automation.

The observation that prompted this was correct: the terminal already reaches
almost everything on a Mac. The blocker was the allowlist refusing those
commands, not a missing library. Pixel automation only adds clicking in apps
with no scripting interface, and it needs a vision model that can ground
coordinates — which small local VLMs cannot do.

nut.js is also no longer freely installable; its packaged builds moved to a paid
private registry in 2025.

### Vision that never stays resident

**Chose:** images converted to text before the chat model sees them; the vision
model loaded on demand and unloaded via `keep_alive: 0`.

The constraint was 16GB with Maple holding ~6.9GB. Peak is ~8.6GB for the few
seconds of one call. The main model stays text-only forever, which means the
vision model is swappable or absent without anything upstream changing.

### IMAP, never POP3

POP3 is a single-device protocol that downloads and traditionally deletes: no
folders, no flags, no server-side search. Pointed at an agent it could pull mail
off the server so your phone never sees it again.

---

## Bugs that testing found

Recorded because each cost real time and could recur.

- **Backticks inside a SQL comment inside a JS template literal** terminated the
  string. Silent until tsc complained about something unrelated.
- **tesseract.js throws from inside a worker event handler** on a failed language
  fetch. That escapes the promise chain — `await` catches nothing and the process
  dies. Availability must be checked up front, never attempted-and-caught.
- **Cosine and lexical scores shared one threshold.** Fine for embeddings,
  silently returned nothing for keyword search. Surfaced only because the
  sandbox blocked the embedding download and forced the fallback path.
- **The lexical fallback had no stemming**, so `summarise`/`summarize`/`summary`
  and `work`/`worked` read as different requests — precisely the rephrasings
  people produce when they repeat themselves.
- **The rename missed `package.json`'s `bin` key**, so `npm link` would have
  installed the command as `maple`.
- **`mcpConfigPath` hardcoded `~/.enio`** instead of deriving from `dataDir`,
  silently ignoring a custom data directory.

---

## Deliberately not built

**Pixel-level desktop automation.** See above. Would need a VLM that can ground
coordinates.

**A plugin bundle format.** enio already has four extension points — skills, MCP
servers, built-in tools, specialists. A "plugin" would just bundle them, which is
worth doing when there are several to distribute together and not before.

**A visual task builder.** Tasks are prompt + schedule + specialist, which is a
form. ReactFlow earns its place when tasks *chain*, because that is genuinely a
DAG. Build the canvas then, not to justify it.

**Windows `install.ps1`.** The agent code is Windows-capable; the installer is
not. WSL2 works today and is what most Windows developers use.

**OAuth2 for mail.** App-specific passwords work now. OAuth is a real project —
registered app, token refresh, browser flow — and worth it only if Gmail becomes
the primary target.

**Multi-user anything.** Single user, single machine, throughout.

---

## Next: the coder specialist as a real code tool

Recorded before it is built, because each piece collides with something already
decided and those collisions are the whole discussion.

### Reading a whole codebase

Today `coder` reads one file at a time inside a single workspace. Pointing it at
a project folder is the ask, and it runs straight into the invariant that every
filesystem and shell tool is hard-scoped to `~/enio-workspace` — which is what
makes an agent with `run_command` safe to hand a model that gets judgement calls
wrong.

So the question is not "how do we read more files", it is **how a second root
gets opened deliberately**. A per-session opened folder, consented to once and
scoped to that session, keeps the property that the sandbox is something the
user grants rather than something the model widens. A permanent list of allowed
roots does not.

The second constraint is attention, not permission. Sixteen tools is the
ceiling and `coder` already holds six, so "search the codebase" cannot arrive as
four new tools. One tool that takes a query and returns ranked locations is the
shape that fits; a file-tree walker plus a grepper plus a symbol index is not.

Graphify was considered here and not adopted — see below.

### Monaco, and rich code output

Monaco is the editor from VS Code and would give real syntax highlighting, a
diff view, and eventually editing in place. The costs are concrete: it is
megabytes rather than kilobytes, it wants web workers, and the renderer is
currently one esbuild bundle with no code splitting and a CSP that allows no
remote anything. None of that is prohibitive, but it is a different class of
front end from what is there now, and the first version should probably be
read-only — a diff is worth far more than an editor, and costs much less.

The channel for it already exists. Tools can return `{ text, widget }`, and a
`diff` widget was already the second type on the list after `clock`. That path
keeps the CLI honest for free: the text stays the answer, and the diff is a
second view of it for a client that can draw one.

### Graphify

[Graphify](https://github.com/Graphify-Labs/graphify) turns a codebase and its
docs into a queryable knowledge graph — Tree-sitter for structure, a model for
prose, no vector store. Apache-2.0, Python, widely used.

**Not adopted, for now.** Two reasons, and neither is about quality. It solves
navigation of large unfamiliar codebases, and this repo is ninety-nine files
with four hundred lines of hand-written CLAUDE.md and DECISIONS.md already doing
the expensive half — recording *why*. And its LLM-driven concept extraction
assumes a capable model, where memory extraction here is a closed vocabulary of
nine relations precisely because a ~1B-active model produces `USES` / `uses` /
`USES_TOOL` as three relations when left open.

**What would change the answer:** pointing enio at a large third-party codebase
it did not write. Then a code graph is capability rather than restatement, and
it arrives the way anything external does — as a skill or an MCP server, not as
a Python stack beside the TypeScript one.

Worth stealing regardless: its no-vector-store stance. Deterministic parsing for
structure, the model only for prose. That is already the direction here.

---

## Open questions

- Does LoRA work at all on Maple's architecture? Ten minutes to test, never done.
- Is `enio suggest`'s clustering threshold right? Tuned by reasoning, not by
  running it against a real history.
- Does the router actually pick well in practice? Only `enio inspect` on real
  usage answers this.
- At what point does the knowledge graph become noise? Extraction is imperfect
  by design; there may be a size where pruning stops being worth it.
- If a folder can be opened outside the workspace, what stops a prompt-injected
  file in that folder from being read as an instruction? The sandbox currently
  answers this by being small.
