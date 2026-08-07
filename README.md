# maple-agent

A local agent harness for [DeepGrove Maple](https://huggingface.co/deepgrove/maple-preview): tools, MCP servers, and persistent knowledge-graph memory. Everything runs on your machine — no API keys required, no data leaves the box.

## What this is

`mlx_lm.server` gives you a fast local model with an OpenAI-compatible API. It does not give you tools that actually execute, or memory that survives restarting the process. This adds both.

```
┌─────────────┐    ┌──────────────────────────────┐    ┌──────────────────┐
│ REPL        │    │ maple-agent                  │    │ mlx_lm.server    │
│ or any      │───▶│  tool loop · memory · MCP    │───▶│  Maple 20B-A1B   │
│ OpenAI      │    │  :8787                       │    │  :8080  (Python) │
│ client      │    └───────────┬──────────────────┘    └──────────────────┘
└─────────────┘                │
                      ┌────────▼─────────┐
                      │ SQLite           │
                      │  raw transcripts │
                      │  facts + vectors │
                      │  entities/edges  │
                      └──────────────────┘
```

The only Python is the model server itself, started for you as a subprocess. Everything you'd edit is TypeScript.

## Install

```sh
git clone <your-remote> maple-agent && cd maple-agent
```

One command does everything — model runtime, weights, agent, and optional extras:

```sh
bash install.sh          # interactive
bash install.sh --yes    # accept all defaults
bash install.sh --minimal   # core only, no search/browser/desktop
```

It's idempotent: every step checks before doing work, so re-running after a failed download resumes rather than restarting. Optional components that fail are reported at the end and don't block the rest.

Then:

```sh
source ~/.maple-agent/env
node dist/index.js up      # terminal 1 — loads ~5GB, ~30s first time
node dist/index.js chat    # terminal 2
```

Or the desktop app, which starts both servers itself:

```sh
cd desktop && npm start
```

## What's on disk

`install.sh` produces one directory tree:

```
maple-agent/
├── src/  desktop/  searxng/  scripts/   ← tracked in git
├── install.sh  README.md  tunnel.md
├── node_modules/                        ← gitignored
├── dist/                                ← gitignored, built
└── runtime/                             ← gitignored, ~5.5GB
    ├── .venv/                              python + mlx-lm
    └── maple-2bit-mlx/                     the weights
```

Plus two things deliberately kept outside, because they're *yours* rather than the app's:

- `~/.maple-agent/` — memory database, API key, config. Survives deleting and reinstalling the project.
- `~/maple-workspace/` — what the file and shell tools can touch.

### Do you need `runtime/`?

Yes, to run Maple. It holds the Python inference engine and the 5GB of weights — the agent is a client, it doesn't do inference itself. Earlier versions put this at `~/maple`; that still works and is detected automatically, and `install.sh` offers to move it rather than re-download.

It stays out of git on purpose: it's a clone of [someone else's repo](https://github.com/deepgrove-ai/mlx-lm-deepgrove) plus multi-gigabyte binaries. A submodule would be the textbook way to pin an external repo, but you never modify that fork, so it buys nothing and costs every clone a `--recurse-submodules` footgun.

**You can skip it entirely** if you point at a different backend. With Ollama already running, `runtime/` is dead weight:

```sh
bash install.sh --minimal        # then delete runtime/ if you want
MAPLE_BACKEND=ollama MAPLE_MODEL=qwen3:8b maple chat
```

The agent, memory, specialists and tools are all backend-agnostic.

## Specialists

Each turn is routed to one specialist with a narrow, coherent tool set:

| | sees |
|---|---|
| **researcher** | `web_search`, `web_fetch`, `web_fetch_rendered`, `recall` |
| **coder** | `read_file`, `write_file`, `list_dir`, `run_command` |
| **librarian** | `recall`, `remember`, `set_preference` |
| **generalist** | `recall` — the safe fallback |

This exists because of the tool budget, not org-chart aesthetics. Maple picks badly once it can see more than a handful of tools, and 16 is roughly the ceiling. Showing it 4–5 disjoint, coherent tools is the single largest available improvement to small-model tool accuracy — larger than any prompt tweak.

Depth is capped at one hop: router → specialist → answer. No agent-to-agent conversation. Every hand-off compounds error, and at ~1B active parameters that compounds fast. Routing costs one short extra call and nothing else, since specialists are the same weights with a different system prompt. `MAPLE_ROUTING=0` disables it.

The router constrains output to a closed set — same trick as memory extraction — and salvages a bare specialist name when the JSON is malformed, which is the common small-model failure: right answer, wrong envelope.

## Learning over time

Three mechanisms, none of which touch weights.

**Facts** are what's true about you. Covered above.

**Preferences** are how you want it to behave — `/pref "answer concisely"`. Kept apart from facts deliberately: facts compete for space under relevance ranking, and a standing instruction that only fires when it happens to rank well is not a standing instruction. All preferences are injected every turn, capped at 12 because past that a small model starts following whichever it noticed last.

**Exemplars** are the interesting one. After a good answer, `/good` saves the (question, answer) pair. On similar future questions the nearest examples are retrieved and shown as demonstrations. This is the closest thing to learning available without training: it changes behaviour, generalises, works immediately, and is trivially reversible.

The similarity floor is high (0.55) and the cap is two. A loosely-related example is worse than none — the model imitates its shape and answers the example's question instead of yours. When embeddings are unavailable it returns nothing rather than falling back to lexical matching, for the same reason.

If you want it to know about *the world* since its cutoff rather than about you, that's retrieval, not training. Fine-tuning teaches form; retrieval teaches facts. Training on a corpus produces fluent, correctly-shaped, subtly-wrong answers with no provenance.

## Swapping the model

Maple is the default, but anything OpenAI-compatible works:

```sh
maple backends                                       # list them
MAPLE_BACKEND=ollama MAPLE_MODEL=qwen3:8b maple chat
```

Presets exist for `ollama`, `lmstudio`, `llamacpp` and `custom` because the *quirks* differ, not just the URL. mlx-lm reads `max_tokens: -1` as unlimited; Ollama and OpenAI return a 400 for a negative value, so the field is omitted for those. Tool calling also requires a model actually trained for it — most small instruct models aren't, and fail silently by answering in prose instead of calling anything.

## How memory works

Three layers, deliberately kept separate because they fail in different ways.

**Raw transcripts** are the source of truth. Every message is written to SQLite as it happens. Nothing derives from anything else at this layer, so nothing here can be corrupted by a bad extraction.

**Explicit facts** come from the model calling `remember`, or you running `maple remember "..."`. These are the highest-signal memories because someone deliberately chose to store them. Marking one important pins it, and pinned facts are injected into every conversation regardless of relevance ranking — identity, not retrieval.

**The knowledge graph** is *derived*. After a conversation ends, a batch job asks Maple to extract entities and relations, which land in `entities` and `edges` tables. Because it's derived, `maple reindex` throws it all away and rebuilds from the transcripts — including, later, with a better model.

Retrieval blends all three into a `<memory>` block prepended to the system prompt: pinned facts always, plus semantically-matched facts, one-hop graph neighbours of matched entities, and summaries of related past conversations. It's budgeted to ~4000 characters because a small model's attention is the scarce resource — 800 characters of the right context beats 4000 characters of nearly-right context, measurably.

### Why extraction is constrained

Maple is a preview model with ~1B active parameters. Asked to "extract any facts you see," it produces inconsistent relation names (`USES` / `uses` / `USES_TOOL` / `is_using`), entities that are really whole sentences, and near-duplicates that never merge. A graph built that way gets worse as it grows.

So extraction is restricted to a closed vocabulary — nine relations, six entity types, defined in `src/memory/schema.ts`. That turns open-ended generation into something much closer to classification, which small models are far better at. Output is validated with Zod, retried once on failure, and dropped if it fails twice. An empty extraction is treated as a correct answer.

**Keep those lists short.** Every relation you add measurably increases confusion. Anything that doesn't fit the vocabulary should go in `facts` instead, which is free text.

Confidence rises on repeated observation rather than being asserted once. With a single weak extractor, seeing the same claim in a second conversation is the only evidence of correctness available.

Superseded edges get a `valid_to` timestamp instead of being deleted. "You use Hyper" doesn't stop being true about the past when it stops being true about the present, and a memory that silently rewrites history is worse than one that forgets.

## Tools

Built in: `remember`, `recall`, `read_file`, `write_file`, `list_dir`, `run_command`, `web_search`, `web_fetch`, and `web_fetch_rendered` (when Playwright is installed).

Filesystem and shell access are hard-scoped to `MAPLE_WORKSPACE`. Paths are resolved before the containment check, which is what makes it robust against `../` traversal and outward-pointing symlinks. Shell commands go through an allowlist of executables, checked across pipes and `&&` chains rather than just the first word, and command substitution is refused outright.

`MAPLE_ALLOW_ANY_COMMAND=1` disables that. It is a genuinely different risk posture: the model can then run anything your user account can, and it is small enough to be talked into things by content it reads out of a file or a web page.

### Web search without an API key

Search resolves through providers in order: SearXNG, then Brave, then Tavily. SearXNG is a self-hosted metasearch engine that aggregates ~70 engines — no key, no account, nothing leaves your network except the searches themselves.

```sh
cd searxng && docker compose up -d
export SEARXNG_URL=http://127.0.0.1:8888
```

The bundled `settings.yml` already has the one setting everyone gets caught by: **JSON output is disabled in SearXNG by default**, and without it every API call returns a bare `403 Forbidden` that explains nothing. It's the `json` entry under `search.formats`.

Scraping Google or Bing directly isn't offered. It breaks their terms, it breaks constantly because they defend against it, and a headless browser only postpones that.

### JavaScript-rendered pages

`web_fetch` is plain HTTP plus [Readability](https://github.com/mozilla/readability) — Firefox reader mode's algorithm, which scores DOM nodes by text density and link ratio to find the real article. It's fast and handles most of the web.

For pages that render client-side, install Playwright and a second tool appears:

```sh
npm install playwright && npx playwright install chromium
```

It's an optional dependency (~150MB of Chromium), and when absent `web_fetch_rendered` simply isn't offered rather than existing and failing — a tool that always errors just burns the model's attention. `web_fetch` detects thin extractions and tells the model to retry with the rendered version.

### MCP servers

```sh
node dist/index.js mcp-init   # writes ~/.maple-agent/mcp.json
```

The format matches Claude Desktop's, so existing configs copy across unchanged, with one addition — a per-server `tools` allowlist:

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

That allowlist matters more than it looks. A typical MCP server exposes 10–30 tools; two or three servers blow past what a ~1B-active model can choose between. The failure mode isn't an error — it's the model quietly picking the wrong tool. There's a hard ceiling of 16 exposed tools (`MAPLE_MAX_TOOLS`), and anything over budget is dropped with a warning rather than silently truncated.

## As a server

```sh
node dist/index.js serve
maple token                # the API key
```

Exposes an OpenAI-compatible endpoint on `http://127.0.0.1:8787/v1` wrapping the *agent* — tools, memory and specialists included. Point Open WebUI, an editor extension, or your own scripts at it. Different port from the raw model on `:8080`, which has none of that.

Every `/v1/*` request needs `Authorization: Bearer <key>`, which is what OpenAI-compatible clients already send for their API key — paste it into their existing field. The key is generated on first run into `~/.maple-agent/token` (mode 0600).

Auth applies on loopback too, deliberately. A web page you have open can issue requests to `127.0.0.1`, and origin checks aren't a boundary against no-cors posts or DNS rebinding. Since the `coder` specialist has `run_command`, an unauthenticated endpoint here is remote code execution wearing a chat interface.

`/ping` is the one open route, returning `{"ok":true}` and nothing else so clients can check liveness before they have a key.

To reach it from your phone or elsewhere, see **[tunnel.md](tunnel.md)** — Tailscale and Cloudflare Tunnel setups, and why NAT traversal works the way it does.

## Commands

| | |
|---|---|
| `maple up` | start the model server |
| `maple chat [--think]` | interactive chat; `--think` shows reasoning |
| `maple serve` | OpenAI-compatible endpoint on :8787 |
| `maple index` | fold unindexed conversations into memory |
| `maple reindex` | rebuild the graph from raw transcripts |
| `maple stats` | what memory holds |
| `maple graph "topic"` | inspect what the graph knows |
| `maple remember "..."` | pin a fact by hand |
| `maple forget "..."` | remove a fact |
| `maple tools` | list every tool, built-in and MCP |
| `maple backends` | list model backends |
| `maple prefs` / `maple pref "..."` | standing instructions |
| `maple examples` | saved answer exemplars |
| `maple token` | print the API key (`--rotate` to replace it) |

## Configuration

All environment variables, all optional. See `src/config.ts`.

| Variable | Default |
|---|---|
| `MAPLE_DIR` | `~/maple` |
| `MAPLE_WORKSPACE` | `~/maple-workspace` |
| `MAPLE_DATA_DIR` | `~/.maple-agent` |
| `MAPLE_BASE_URL` | `http://127.0.0.1:8080/v1` |
| `MAPLE_MAX_TOOLS` | `16` |
| `MAPLE_MAX_ITERS` | `8` |
| `SEARXNG_URL` | unset — set to `http://127.0.0.1:8888` after starting it |
| `BRAVE_API_KEY` / `TAVILY_API_KEY` | unset — fallbacks if you'd rather not self-host |
| `MAPLE_BROWSER_TIMEOUT` | `30000` |

## Honest limitations

**Multi-step tool chains are unreliable.** Maple handles one or two tool calls well. Past three or four it loses the thread of what it was doing. The loop is capped at 8 rounds and forces an answer on the last one, so it degrades into a partial answer rather than spinning.

**Extraction quality is capped by the model.** Expect noise in the graph. `maple graph "topic"` shows you what it believes; `maple reindex` rebuilds from scratch when you want to start over. If memory quality ever becomes the thing you care about most, pointing extraction at a stronger model is a change to one function in `src/memory/extract.ts` — the transcripts are all still there.

**Embeddings degrade gracefully but noticeably.** If the embedding model can't be downloaded, recall falls back to lexical overlap, which is meaningfully worse at finding things phrased differently. It'll tell you when this happens.

**The tool budget is real.** 16 tools is not a lot if you connect several MCP servers. Use the allowlists.

## Development

```sh
npm run typecheck
npm test          # 98 tests, no model server required — the model is stubbed
```

The test suite covers the parts most likely to break quietly: malformed-JSON repair, `<think>` tags split across stream chunks, sandbox escapes, shell allowlist bypasses via pipes, SSRF-blocked hosts being rejected before any request is made, Readability extraction versus its fallback, and the full tool loop including hallucinated tool names and runaway loops.

MIT.
