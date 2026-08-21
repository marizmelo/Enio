---
title: Getting started
layout: default
nav_order: 2
---

# Getting started

## Requirements

Everywhere: **Node.js 22+** and **git**.

| Platform | Model | Disk | Notes |
|---|---|---|---|
| **macOS, Apple Silicon** | local, via MLX | ~15GB | The fast path. 16GB RAM recommended; 8GB swaps. |
| **macOS, Intel** | Ollama | ~2GB | MLX needs Apple Silicon. |
| **Linux** | Ollama | ~2GB | Fully supported. |
| **Windows** | Ollama | ~2GB | Use WSL2 — `install.ps1` isn't written yet. |

Optional everywhere: Docker, for keyless web search.

## Install

```sh
git clone https://github.com/marizmelo/Enio enio
cd enio
bash install.sh
```

That's the whole thing. It checks your hardware, installs `uv`, downloads the
model runtime and weights, builds the agent, runs the tests, and offers to set
up web search, browser rendering, and the desktop app.

```sh
bash install.sh --yes        # no prompts, accept every default
bash install.sh --minimal    # core only, skip the optional parts
```

It's idempotent. If the 5GB download dies halfway, re-run and it resumes.
Optional components that fail are listed at the end and don't block anything
else.

**First run takes a while** on Apple Silicon — mostly the weights. Later runs
start in about 30 seconds.

The installer sets up Qwen3 4B Instruct to give you something that works
immediately, and offers Maple as an optional extra. Neither is a commitment:
see [Models](models.md) for what else runs and how to switch, which takes one
click.

## Run it

```sh
node dist/index.js start
```

One command on every platform. It brings the configured backend up, waits for
it, and opens chat. Ctrl-C stops it.

Run `npm link` once to type `enio` instead of `node dist/index.js`.

Or the desktop app, which does the same in a window:

```sh
cd desktop && npm start
```

To let it change things on your computer, launch it with the desktop flag — see
[Controlling your computer](mac-control.md):

```sh
cd desktop && ENIO_DESKTOP=1 npm start
```

It only stops what it started. An Ollama that was already running is left alone
on exit, because it's a shared service and something else may be using it.

## The first conversation

```
› fix the typo in notes.md — it says "recieve"
  → coder
  ⚒ read_file {"path":"notes.md"}
  ⚒ edit_file {"path":"notes.md","old_string":"recieve","new_string":"receive"}

Fixed "recieve" → "receive" in notes.md.
```

`→ coder` is the router choosing an agent. `⚒` lines are tools running.

Files and shell are locked to `~/enio-workspace`. Paths outside it are refused
and shell commands go through an allowlist, so put things you want it to work
on in that folder.

## Permissions, on a Mac

Enio asks macOS for three separate things, and they are genuinely separate —
granting one does not grant another.

| Permission | Needed for | Prompted by |
|---|---|---|
| **Automation** | Reading Mail, Calendar, Notes, Reminders, Finder | macOS, per app, on first use |
| **Accessibility** | Reading a window's buttons, clicking by name | You, in System Settings |
| **Screen Recording** | `take_screenshot` | macOS, on first use |

Accessibility is the one that needs a manual step, because macOS will not
prompt for it the way it prompts for the others. The desktop app shows a notice
with a button that opens the right pane; grant it to **whatever runs Enio** —
the desktop app itself, or your terminal if you use the CLI.

Until it's granted, the two window-reading scripts are simply not offered.
Everything else keeps working.

## Where things live

| | |
|---|---|
| `~/enio-workspace` | Files the agent can read and write |
| `~/.enio` | Database, token, settings, logs |
| `~/.enio/runtime` | The model runtime and weights |
| `~/.enio/model.json` | Which model is selected |
| `~/.enio/automation.json` | Whether safe scripts run automatically |
