---
title: Configuration
layout: default
nav_order: 13
---

# Configuration

Every setting is an environment variable read at startup, except the two that
have to outlive the process — the model choice and auto-run — which are stored
in `~/.enio`.

Each also accepts a `MAPLE_` prefix instead of `ENIO_`; the project was renamed
and old variables still work.

## Core

| Variable | Default |
|---|---|
| `ENIO_NAME` | `Enio` — what it calls itself |
| `ENIO_AUTHOR` | the attributed author |
| `ENIO_WORKSPACE` | `~/enio-workspace` — the only writable directory |
| `ENIO_DATA_DIR` | `~/.enio` — database, token, logs |
| `ENIO_MACHINE_STATE_DIR` | `~/.enio` — machine-wide state; ignores `ENIO_DATA_DIR` on purpose |
| `ENIO_DIR` | `~/.enio/runtime` — model runtime and weights |

## Model

| Variable | Default |
|---|---|
| `ENIO_BACKEND` | `maple` — or `ollama`, `lmstudio`, `llamacpp` |
| `ENIO_BASE_URL` | the backend's default endpoint |
| `ENIO_MODEL` | overrides the saved model choice for one run |
| `ENIO_MODEL_LABEL` | what the model is called in the prompt |
| `ENIO_TEMP` | `1.0` — classifiers override this to 0 themselves |
| `ENIO_TOP_P` | backend default |
| `ENIO_MAX_TOKENS` | reply cap |
| `ENIO_CONTEXT_BUDGET` | per model — see [Models](models.md) |
| `ENIO_HISTORY_WINDOW` | `40` messages before folding |
| `ENIO_PROMPT_CACHE_GB` | 1/12th of RAM, clamped 1–4 |

## Agents and tools

| Variable | Default |
|---|---|
| `ENIO_ROUTING` | `1` — set `0` for one agent with every tool |
| `ENIO_MAX_TOOLS` | `16` — the registry cap in single-agent mode |
| `ENIO_MAX_ITERS` | tool rounds per turn |
| `ENIO_MCP_CONFIG` | `~/.enio/mcp.json` |
| `ENIO_ALLOW_ANY_COMMAND` | unset — lifts the shell allowlist |

## Desktop control

| Variable | Default |
|---|---|
| `ENIO_DESKTOP` | unset — plans, AppleScript and screenshots, macOS only |
| `ENIO_AUTO_RUN` | unset — off; overrides the Recipes drawer switch |

## Email

| Variable | Default |
|---|---|
| `ENIO_IMAP_HOST` / `_PORT` / `_USER` / `_PASS` | unset — reading is withheld without them |
| `ENIO_IMAP_FOLDERS` | folders to search |
| `ENIO_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` | unset |
| `ENIO_EMAIL_FROM` | the sending address |
| `ENIO_EMAIL_ALLOWED_TO` | recipient allowlist; addresses or `@domain` |
| `ENIO_EMAIL_SEND` | unset — **dry run until set to `1`** |

## Vision, voice and web

| Variable | Default |
|---|---|
| `ENIO_VISION_MODE` / `_BACKEND` / `_MODEL` / `_URL` | how images become text |
| `ENIO_VISION_KEEP_ALIVE` | `0` — unload immediately after answering |
| `ENIO_VOICE` / `_MODEL` / `_MODEL_FAST` | dictation |
| `ENIO_TTS` / `_MODEL` / `_VOICE` | speech |
| `SEARXNG_URL` | unset — falls back to DuckDuckGo |
| `ENIO_BROWSER_TIMEOUT` | page load timeout |

## Network

| Variable | Default |
|---|---|
| `ENIO_AGENT_HOST` | `127.0.0.1` |
| `ENIO_AGENT_PORT` | `8787` |
| `ENIO_INSPECT_PORT` | `8788` |

{: .warning }
Binding the agent to anything other than loopback exposes an endpoint that can
run shell commands. Auth applies on loopback too — a web page you have open can
POST to `127.0.0.1`, and origin checks are not a boundary. Prefer a tunnel; see
[Remote access](remote-access.md).
