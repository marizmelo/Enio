# enio

A local AI agent. Runs a model on your own machine and gives it tools, MCP servers, and memory that persists across conversations.

No API keys. No account. Nothing leaves your computer.

**enio runs anywhere. [Maple](https://huggingface.co/deepgrove/maple-preview) requires Apple Silicon.** On a Mac with an M-series chip the installer sets up Maple — a 20B-A1B ternary model that decodes at ~218 tok/s. Everywhere else, point it at Ollama; memory, specialists, tools and the inspector are identical.

---

## Requirements

Everywhere: **Node.js 22+** and **git**.

| Platform | Model | Disk | Notes |
|---|---|---|---|
| **macOS, Apple Silicon** | Maple, local | ~15GB | The fast path. 16GB RAM recommended; 8GB swaps. |
| **macOS, Intel** | Ollama | ~2GB | MLX needs Apple Silicon. |
| **Linux** | Ollama | ~2GB | Fully supported. |
| **Windows** | Ollama | ~2GB | Use WSL2 — `install.ps1` isn't written yet. |

Optional everywhere: Docker, for keyless web search.

## Install

```sh
git clone <your-remote> enio
cd enio
bash install.sh
```

That's the whole thing. It checks your hardware, installs `uv`, downloads the model runtime and weights, builds the agent, runs the tests, and offers to set up web search, browser rendering, and the desktop app. At the end it offers to launch.

```sh
bash install.sh --yes        # no prompts, accept every default
bash install.sh --minimal    # core only, skip the optional parts
```

It's idempotent. If the 5GB download dies halfway, re-run and it resumes. Optional components that fail are listed at the end and don't block anything else.

The installer detects your platform. On Apple Silicon it installs the Maple runtime and weights; elsewhere it skips all of that, checks for Ollama, and offers to pull a model that can actually do tool calling.

**First run takes a while** on Apple Silicon — mostly the weights. Later runs start in about 30 seconds.

## Run it

```sh
node dist/index.js start
```

One command on every platform. It brings the configured backend up, waits for it, and opens chat. Ctrl-C stops it.

- **Apple Silicon** — starts the Maple runtime (~30s on first load).
- **Everywhere else** — starts Ollama if it isn't already running, and checks the model is pulled, offering to pull it if not. Usually Ollama is already up (desktop app on macOS/Windows, systemd on Linux), in which case it just connects.
- **LM Studio / llama.cpp** — can't be launched programmatically, so `start` tells you how and you use `enio chat` once it's running.

It only stops what it started. An Ollama that was already running is left alone on exit, because it's a shared service and something else may be using it.

Or the desktop app, which does the same in a window:

```sh
cd desktop && npm start
```

Run `npm link` once to type `enio` instead of `node dist/index.js`.

---

## Using it

```
› what files are in my workspace
  → coder
  ⚒ list_dir {"path":"."}
    ↳ notes.md (1204 bytes)

You have one file, notes.md.
```

`→ coder` is the router choosing a specialist. `⚒` lines are tools running.

### Commands in chat

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

### Teaching it

Three mechanisms, none involving training:

**Facts** — say "I'm working on a deploy tool for Acme" and it stores that. Extraction also runs automatically over each finished conversation.

**Preferences** — `/pref "no bullet points"` applies to every future conversation. Different from a fact: facts inform answers, preferences shape them.

**Examples** — after a response you like, `/good`. On similar questions later that exchange is shown as a demonstration. The fastest way to change how it writes.

```sh
enio stats              # counts
enio graph "acme"       # what it knows about something
enio remember "..."     # pin a fact by hand
enio prefs              # standing instructions
enio examples           # saved examples
enio reindex            # rebuild memory from raw transcripts
```

### Tools

`read_file`, `write_file`, `list_dir`, `run_command`, `web_search`, `web_fetch`, `web_fetch_rendered`, `remember`, `recall`, `set_preference`.

Files and shell are locked to `~/enio-workspace`. Paths outside it are refused and shell commands go through an allowlist. Put things you want it to work on in that folder.

### Web search without a key

```sh
cd searxng && docker compose up -d
export SEARXNG_URL=http://127.0.0.1:8888
```

[SearXNG](https://docs.searxng.org/) is a self-hosted metasearch engine aggregating ~70 sources. `install.sh` sets it up if you say yes. Brave and Tavily work too — set `BRAVE_API_KEY` or `TAVILY_API_KEY`.

For pages that need JavaScript:

```sh
npm install playwright && npx playwright install chromium
```

### MCP servers

```sh
enio mcp-init      # writes ~/.enio/mcp.json
```

Same format as Claude Desktop, so existing configs copy across. One addition — a per-server `tools` allowlist:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/notes"],
      "tools": ["read_file", "list_directory"]
    }
  }
}
```

Use it. A typical MCP server exposes 10–30 tools and the model degrades badly past ~16 total. The starter config includes Playwright MCP, disabled, with an allowlist ready.

### Seeing what it did

```sh
enio inspect
```

Opens a local web UI showing every turn: which specialist was chosen, **the exact system prompt that was sent with the injected memory highlighted**, each tool call with arguments and results, and the raw model output before any repair.

That highlighted memory block is the point. When a small model answers oddly, the cause is usually what it was shown rather than the model itself — a stale fact retrieved, a preference that didn't fire, an exemplar that pulled the answer sideways. Prompt-in/completion-out logging can't show you that.

Turns where output had to be salvaged are flagged: `repaired` means the tool-call JSON was malformed and got fixed, `scavenged` means the call was recovered from plain text because the server didn't parse it. One is noise. A run of them means something about the prompt is confusing the model, and you can filter the timeline to just those.

The second tab is an interactive knowledge graph — entities and relations as a force-directed layout, sized by mention count, filtered by confidence. Click an edge to delete it. This is where extraction quality becomes visible: a 1B-active model produces wrong triples, and pruning them by hand is faster than trying to prompt around them. It's the only write operation in the inspector.

Bound to loopback and key-protected like the API, because it exposes prompts and memory. The URL it prints contains the key.

### Using it from other apps

```sh
enio serve
enio token          # the API key
```

An OpenAI-compatible endpoint on `http://127.0.0.1:8787/v1` wrapping the full agent. Point Open WebUI, an editor extension, or a script at it — paste the token where the client asks for an API key.

To reach it from your phone or another network, see **[tunnel.md](tunnel.md)**.

### Using a different model

```sh
enio backends
ENIO_BACKEND=ollama ENIO_MODEL=qwen3:8b enio chat
```

Works with Ollama, LM Studio, llama.cpp, or any OpenAI-compatible endpoint. Everything above the model — memory, specialists, tools, inspector — is backend-agnostic, so you can delete the Maple runtime entirely if you go this route.

The default is `maple` on Apple Silicon and `ollama` everywhere else. Defaulting to a backend the machine can't run would produce a confusing connection error rather than a useful one.

**Tool calling needs a model actually trained for it.** Most small instruct models aren't, and the failure is quiet: instead of erroring, they answer in prose and never emit a call, so it looks like the tools are broken. qwen3 and recent Llama variants work. If tools seem inert, check this before anything else.

---

## What goes where

The repo stays small — a clone is well under a megabyte:

```
enio/
├── src/           the agent
├── ui/            inspector (React + ReactFlow)
├── desktop/       Electron client
├── searxng/  scripts/
├── install.sh  README.md  tunnel.md
└── node_modules/  dist/  ui/dist/   ← gitignored
```

Everything large or personal lives outside it:

```
~/.enio/
├── runtime/          ← python env + weights, ~5.5GB
├── memory.db         ← conversations, facts, knowledge graph
├── token             ← API key for the HTTP endpoint
└── mcp.json  env

~/enio-workspace/    ← what the file and shell tools can reach
```

The runtime is out of the project on purpose. It was always gitignored, but "not in the repo" and "not in the folder" are different problems — Time Machine and iCloud crawl the folder, IDE indexers try to walk it, and `rm -rf` on the project would cost you a 5GB re-download. Keeping it in `~/.enio/` means you can delete and re-clone the project freely; the expensive part and everything it has learned both survive.

Set `ENIO_DIR` to put it elsewhere. Earlier layouts (`<repo>/runtime`, `~/maple`) are detected automatically, and `install.sh` offers to move rather than re-download.

## All commands

| | |
|---|---|
| `enio start` | model + chat, the usual entry point |
| `enio chat` | chat against an already-running model |
| `enio up` | model server in the foreground |
| `enio serve` | OpenAI-compatible endpoint on :8787 |
| `enio inspect` | trace viewer + knowledge graph on :8788 |
| `enio token` | print the API key (`--rotate` to replace) |
| `enio stats` / `graph` / `remember` / `forget` | memory |
| `enio prefs` / `pref` / `unpref` / `examples` | learned behaviour |
| `enio index` / `reindex` | fold conversations into memory |
| `enio tools` / `backends` / `mcp-init` | configuration |

## Configuration

Environment variables, all optional. See `src/config.ts`.

| | |
|---|---|
| `ENIO_WORKSPACE` | `~/enio-workspace` |
| `ENIO_DIR` | `~/.enio/runtime` |
| `ENIO_DATA_DIR` | `~/.enio` |
| `ENIO_BACKEND` | `maple` |
| `ENIO_ROUTING` | `1` — set `0` for one agent with every tool |
| `ENIO_MAX_TOOLS` | `16` |
| `ENIO_INSPECT_PORT` | `8788` |
| `SEARXNG_URL` | unset |
| `ENIO_ALLOW_ANY_COMMAND` | unset — see below |

---

## How it works

### Specialists

Every turn is routed to one specialist with a narrow tool set:

| | sees |
|---|---|
| **researcher** | `web_search`, `web_fetch`, `web_fetch_rendered`, `recall` |
| **coder** | `read_file`, `write_file`, `list_dir`, `run_command` |
| **librarian** | `recall`, `remember`, `set_preference` |
| **generalist** | `recall` — the safe fallback |

This exists because of the tool budget, not org-chart aesthetics. Maple picks badly once it sees more than a handful of tools. Showing it 4–5 disjoint, coherent tools is the single largest available improvement to small-model tool accuracy — larger than any prompt tweak.

Depth is capped at one hop: router → specialist → answer. No agent-to-agent conversation. Every hand-off compounds error, and at ~1B active parameters that compounds fast.

The router constrains output to a closed set — the same trick as memory extraction — and salvages a bare specialist name when the JSON is malformed, which is the characteristic small-model failure: right answer, wrong envelope.

### Memory

Three layers that fail differently, so they're kept apart.

**Raw transcripts** are the source of truth, written as they happen. Nothing derives from anything else here, so nothing can be corrupted by a bad extraction.

**Explicit facts** come from `remember`. Someone deliberately chose to store these, so they're the highest-signal memories. Pinned ones are injected every conversation regardless of ranking — identity, not retrieval.

**The knowledge graph** is *derived*. A batch job extracts entities and relations after each conversation. Because it's derived, `enio reindex` discards and rebuilds it from the transcripts — including, later, with a better model.

Retrieval blends all three into a `<memory>` block budgeted to ~4000 characters. A small model's attention is the scarce resource: 800 characters of the right context beats 4000 of nearly-right, measurably.

### Why extraction is constrained

Asked to "extract any facts you see," a ~1B-active model produces inconsistent relation names (`USES` / `uses` / `USES_TOOL` / `is_using`), entities that are really sentences, and near-duplicates that never merge. A graph built that way degrades as it grows.

So extraction is restricted to nine relations and six entity types (`src/memory/schema.ts`). That turns open-ended generation into something close to classification, which small models handle far better. Output is validated, retried once, dropped if it fails twice. An empty extraction is a correct answer.

**Keep those lists short.** Every added relation measurably increases confusion. Anything that doesn't fit belongs in `facts`, which is free text.

Confidence rises on repeated observation rather than being asserted once — with a single weak extractor, seeing a claim again is the only evidence of correctness available. Superseded edges get a `valid_to` timestamp instead of being deleted; a memory that silently rewrites history is worse than one that forgets.

### Learning without training

Fine-tuning teaches form. Retrieval teaches facts. People get this backwards, train on a corpus expecting recall, and get fluent, correctly-shaped, subtly-wrong answers with no provenance.

So: preferences and exemplars, not weights. Preferences are injected every turn, capped at 12 — past that a small model follows whichever it noticed last. Exemplars use a high similarity floor (0.55) and a cap of two, because a loosely-related example is worse than none: the model imitates its shape and answers the example's question instead of yours. When embeddings are unavailable it returns none rather than falling back to lexical matching, for the same reason.

### Security

Files and shell are scoped to the workspace. Paths are resolved *before* the containment check, which is what makes it robust against `../` traversal and outward-pointing symlinks — checking the string first, the common mistake, catches neither. Shell commands go through an allowlist checked across pipes and `&&` chains rather than just the first word, and command substitution is refused.

`ENIO_ALLOW_ANY_COMMAND=1` removes that. It's a genuinely different risk posture: the model can then run anything your account can, and it's small enough to be talked into things by content it reads from a file or a web page.

The HTTP endpoint requires a bearer token, including on loopback. A web page you have open can issue requests to `127.0.0.1`, and origin checks aren't a boundary against no-cors posts or DNS rebinding. Since the `coder` specialist has `run_command`, an unauthenticated endpoint here is remote code execution wearing a chat interface.

---

## Troubleshooting

**"No model runtime found"** — run `bash install.sh`, or set `ENIO_DIR`, or switch backends with `ENIO_BACKEND=ollama`.

**Model won't start** — `tail -50 ~/.enio/model-server.log`. Usually a half-finished weight download; re-run `install.sh` to resume.

**Slow, or the fans spin up** — check RAM. Maple wants ~7GB; if other apps hold most of yours, it swaps.

**"Maple runs through MLX, which is macOS-only"** — expected on Linux, Windows or an Intel Mac. Use Ollama; everything except the local Maple runtime works identically.

**Tools never fire on Ollama** — your model probably wasn't trained for tool calling. It answers in prose instead of emitting a call, which reads like a bug. Try `qwen3:8b`.

**"Model isn't pulled yet"** — `enio start` checks before connecting, because a missing model 404s in a way that looks like enio is broken. Accept the prompt, or run `ollama pull <name>` yourself. A bare name like `qwen3` matches any tag you already have; `qwen3:32b` is treated as specific and won't be satisfied by `qwen3:8b`.

**Search returns 403** — SearXNG ships with JSON output off. The bundled `settings.yml` enables it; on your own instance, add `json` under `search.formats`.

**A page comes back empty** — it renders with JavaScript. Install Playwright and the model will retry with `web_fetch_rendered`.

**It picks the wrong tool** — probably over the tool budget. `enio tools` shows the count; add allowlists to your MCP servers. `enio inspect` shows exactly which tools the specialist could see and what it was told.

**Answers seem to ignore what it knows about you** — open `enio inspect` and check the system prompt for that turn. Either the memory wasn't retrieved (nothing relevant scored high enough) or it was retrieved and ignored. Those are different problems and the prompt panel tells you which.

**It forgot something** — `enio stats` shows whether anything is unindexed; `enio index` folds it in. Memory is written at the end of a conversation, so a hard kill can lose the last one.

## Development

```sh
npm run typecheck
npm test               # 98 tests, no model server needed — the model is stubbed
cd ui && npm run build # rebuild the inspector UI after changing it
```

Tests cover what breaks quietly: JSON repair, `<think>` tags split across stream chunks, sandbox escapes, allowlist bypasses via pipes, SSRF hosts rejected before any request is made, constant-time token comparison, and the full tool loop including hallucinated tool names and runaway loops.

MIT.
