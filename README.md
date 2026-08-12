<p align="center">
  <img src="desktop/assets/icon.png" alt="" width="88">
</p>

# Enio

A local AI agent. Runs a model on your own machine and gives it tools, MCP servers, memory that persists across conversations, and — on a Mac — the ability to actually do things in your apps.

No API keys. No account. Nothing leaves your computer.

**📖 [Documentation](docs/)** — installing, using, and every setting.

---

## Install

Requires **Node.js 22+** and **git**. On Apple Silicon the installer sets up a local model to get you started; everywhere else it points at Ollama. Memory, agents, tools and the inspector are identical either way.

```sh
git clone https://github.com/marizmelo/Enio enio
cd enio
bash install.sh
```

Idempotent — if the 5GB download dies halfway, re-run and it resumes. Optional components that fail are listed at the end and don't block anything else.

## Run

```sh
node dist/index.js start          # CLI
cd desktop && npm start           # or the desktop app
```

Run `npm link` once to type `enio` instead of `node dist/index.js`.

```
› what files are in my workspace
  → coder
  ⚒ list_dir {"path":"."}
    ↳ notes.md (1204 bytes)

You have one file, notes.md.
```

`→ coder` is the router choosing an agent. `⚒` lines are tools running.

See **[Getting started](docs/getting-started.md)** for permissions, the workspace, and the first conversation.

---

## What it does

**Remembers you.** Facts, standing preferences, and examples of answers you liked — all from ordinary conversation, none of it training. Raw transcripts stay the source of truth, so memory can be rebuilt from scratch. → [Memory](docs/memory.md)

**Uses your Mac.** Opens apps, reads Mail, Calendar, Notes and Finder, and clicks buttons *by name* from the accessibility tree rather than by pixel. Anything that changes something is written down as a plan you read, edit, test a step at a time, and approve. Approve once and it becomes a recipe it selects rather than rewrites. → [Controlling your Mac](docs/mac-control.md)

**Reads the web.** Search, fetch, and a real browser session that follows links across a site. → [Browsing](docs/browsing.md)

**Runs on schedule.** Cron-driven tasks through the ordinary turn path, so a scheduled run is inspectable exactly like a conversation. → [Scheduled tasks](docs/tasks.md)

**Learns your know-how.** Skills are markdown, not code — a tool lets it send email, a skill tells it how *you* want emails written. → [Skills](docs/skills.md)

**Works in projects.** Attach the folders and files a piece of work is about, each with a note saying what it's for, plus standing instructions — and every conversation under that project carries the context. Not a "code mode": routing keeps working, the project just biases it. → [Projects](docs/projects.md)

**Runs the model you choose.** Any MLX chat model that can call tools — switched from the status bar without losing your conversation, and the context budget follows the model rather than being fixed. Ships with Qwen3 4B Instruct, with [Maple](https://huggingface.co/deepgrove/maple-preview) (20B-A1B ternary, ~218 tok/s) as an optional extra. → [Models](docs/models.md)

---

## How it's built

**One constraint drives the design: the model is small.** Enio is built to run well on a few billion parameters, not a few hundred. A model that size picks tools badly once it can see more than a handful, emits malformed JSON often enough that repair is a normal path, and is far better at *choosing from a short list* than at generating freely.

So nearly everything turns generation into selection. A router picks one of six agents, each with at most six tools. Clicks are names read from the accessibility tree. Memory extraction uses a closed vocabulary of nine relations. Recipes are tested scripts selected rather than written.

**Nothing irreversible happens without you.** Email is dry-run until a flag is set. IMAP opens read-only so the *server* refuses changes. The model proposes scripts and never runs them — the only path from "composed" to "ran" goes through a person reading the exact text.

**It degrades rather than fails.** No vision model → OCR. No OCR → image dimensions. No embeddings → keyword matching. A tool that cannot work is withheld rather than offered, because a dead end costs attention the model doesn't have to spare.

Design decisions, and what was considered and rejected, are in **[DECISIONS.md](DECISIONS.md)**. Working on the code: **[CLAUDE.md](CLAUDE.md)**.

---

## Layout

```
src/              the agent: turn loop, memory, tools, specialists
desktop/          Electron client
ui/               React trace inspector
docs/             documentation
examples/skills/  shipped example skills
```

```sh
npm run typecheck
npm test          # the model is stubbed; no server needed
npm run build
```
