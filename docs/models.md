---
title: Models
layout: default
nav_order: 9
---

# Models

## Switching

The model is a **setting**, not a launch flag. The desktop app's status bar has
a picker listing what this machine can serve right now: any MLX chat model
already in your Hugging Face cache, plus Maple when its bundled weights are
installed. One click switches.

Switching restarts the model server underneath the agent — your conversation,
pending approvals and history all stay up. The choice persists in
`~/.enio/model.json`, so it survives a restart.

That menu is deliberately only what is already here, because those switch
instantly and cannot fail on a network. Anything that would have to be fetched
lives one item further down, under **Other models…**.

If a model fails to load, the switch reverts — on disk and running — so a bad
choice cannot become what every boot serves.

To try one without changing what the machine boots tomorrow:

```sh
ENIO_MODEL=mlx-community/Qwen3-4B-Instruct-2507-4bit node dist/index.js start
```

## Getting another model

**Model ▸ Other models…** lists everything Enio offers to fetch, with its size,
what it is good for, and whether it fits in this machine's memory. **Get**
downloads it into your Hugging Face cache with a progress bar, and you can stop
part-way — the cache resumes rather than starting over.

A finished download does not switch to what it just fetched. Those are separate
acts on purpose: switching restarts the model server, and doing that as a side
effect of "get me this one for later" would end a conversation mid-sentence.
The new model simply appears in **On this machine**.

### The list

| Model | Size | Notes |
|---|---|---|
| `mlx-community/Qwen3-4B-Instruct-2507-4bit` | 2.3GB | **The default.** Measured here: routed 8/8 at 426ms median. |
| `deepgrove/maple-preview` | 5.3GB | Optional. 20B total, ~1B active, ternary. Fastest per token. |
| `mlx-community/Qwen3-1.7B-4bit` | 1.0GB | Smallest that still routes and calls tools. For 8GB machines. |
| `mlx-community/Llama-3.2-3B-Instruct-4bit` | 1.8GB | Small and quick. Shorter context than the Qwen3 models. |
| `mlx-community/Mistral-7B-Instruct-v0.3-4bit` | 4.1GB | Strong plain prose. Weaker at picking tools than the Qwen3 models. |
| `mlx-community/Qwen2.5-7B-Instruct-4bit` | 4.3GB | The older generation. Steadier, no thinking mode. |
| `mlx-community/Qwen3-8B-4bit` | 4.6GB | Better at multi-step tool use, at roughly half the speed of 4B. |
| `mlx-community/Qwen3-14B-4bit` | 8.3GB | Noticeably better judgement. Wants 24GB and patience. |
| `mlx-community/Qwen3-30B-A3B-4bit` | 17.2GB | Mixture of experts: 3B active, so quicker than its size suggests. |

Sizes are measured from the repositories, not estimated, so the progress bar
and the fit warning agree with what actually arrives.

{: .note }
Only Maple and Qwen3-4B have been measured *in Enio*. The rest are listed
because they load and call tools, not because their tool use was benchmarked
here — see [the routing comparison](#which-model-to-run) for what "measured"
means.

### Why the list is closed

You cannot type a repository id into the picker. Two reasons, and the second is
the load-bearing one:

- A model id with a typo is a five-gigabyte download of something that may not
  load, and no way to tell which until the ninety seconds are up.
- The download endpoint takes its argument from an HTTP request. Accepting any
  id would make it a general-purpose downloader pointed at your disk, reachable
  by anything that can reach the agent.

Every entry was checked against the Hugging Face API: the repository exists, the
size is its real total, and **its chat template supports tools**. That last
check is the one you cannot see without doing it — a model without tool support
loads fine, chats fine, and never calls a single tool, which reads as Enio being
broken rather than as the wrong model. `gemma-3-4b-it` was dropped from the list
for exactly that reason.

Anything else `mlx_lm` can load still works; it just has to arrive by other
means. Download it however you like and it appears in the picker, because that
list is scanned from your cache:

```sh
~/.enio/runtime/.venv/bin/python scripts/hf_download.py <org>/<repo>
```

Vision, speech and embedding models in your cache are filtered out of the
picker — they have their own servers, and offering one would be offering a
ninety-second failed load.

## Will it fit?

Every downloadable model is marked against **this machine's** memory, because
whether a model fits is a fact about the machine rather than about the model.

| Marking | Meaning |
|---|---|
| *(nothing)* | Comfortable. |
| **tight fit** | Within memory, but close. Expect swapping if much else is open. |
| **too big for this Mac** | Larger than memory. It will load, by swapping to disk. |

The estimate is the weights plus about a quarter again for the prompt cache and
runtime, plus 3GB for everything else the machine is doing. On Apple Silicon all
of it competes for the same unified memory, so a model that fits in RAM on paper
is one that makes the whole desktop swap.

Nothing is blocked. It is a rule of thumb, and you know things it does not —
that you will quit everything else, that the machine is headless, that you want
it anyway. The failure being warned about is gradual rather than loud: a model
slightly too large does not refuse to load, it just makes tokens arrive every
few seconds, which reads as Enio being slow rather than as a choice you can
undo.

## Will it be usable?

Fitting is half the question. On Apple Silicon, **capacity decides whether a
model loads and memory bandwidth decides whether it is usable** — generation
reads every active weight once per token, so tokens-per-second is bounded by
the chip's bandwidth divided by the bytes read per token. The most expensive
mistake in local AI is a model your hardware can hold but cannot run: a dense
70B fits on a big MacBook and then generates about four tokens a second — a
model you watch, not one you use.

Each downloadable model therefore also shows an **estimated speed for this
Mac's chip** — `~30 tok/s · responsive`, or in red, *you'll watch it, not use
it*. Believe these numbers over your instincts; the biggest model in the list
is rarely the one you want. Two things worth knowing:

- **Mixture-of-experts models break the size rule.** Qwen3 30B A3B downloads
  17GB but reads only ~2GB of experts per token, so it generates *faster*
  than dense models a third its size. Speed cannot be read off the download.
- The estimate is theoretical bandwidth times a measured efficiency factor —
  a rule of thumb, like the fit column, and shown only when the chip is one
  Enio knows. An unknown chip gets no number rather than a wrong one.

## The context budget

This is the number the meter measures against, and it is **not** the model's
advertised context length.

It is the band where a model still *recalls* what it was told. Maple was
measured with a planted fact: answered correctly 4 times out of 4 at around 1.5k
tokens, 0 out of 4 by 12k. Filling a declared 128k window would not produce an
error — it would quietly stop remembering, which is the failure you cannot see
from the outside.

| Model | Budget | Where it came from |
|---|---|---|
| Maple | 2,000 | Measured, planted-fact recall |
| Qwen3 family | 12,000 | **Not measured** — a conservative step up |
| Anything else | 8,000 | **Not measured** — a conservative default |

{: .warning }
Only Maple's number is measured. The others are deliberate under-estimates
pending the same test. Guarding the reverse direction matters more than the
forward one: switching *back* to Maple while carrying a larger model's budget
would degrade answers with nothing visibly failing.

Override it per run when you have reason to:

```sh
ENIO_CONTEXT_BUDGET=6000 node dist/index.js chat
```

The budget resolves per model at call time, not once at startup — otherwise
switching models mid-session would keep the old number.

## Which model to run

Qwen3 4B Instruct is the shipped default: it is the entry actually measured
in Enio (routed 8/8 at 426ms median), it is reliable at multi-step tool use,
and its weights are a 2.3GB download.

Maple (20B total, ~1B active, ternary, ~218 tok/s) is the optional
alternative the installer offers: fastest per token and lightest to run given
its capability. Raw decode speed is not the same as finishing a task, though —
on the measured routing comparison both scored 8/8 correct, and the dense 4B
was about twice as fast *per decision*, because a short output is dominated by
prompt processing rather than token generation. Maple also holds far less
context (see the budget table above). Try both — switching costs one click and
a model load.

## When the local model is not enough

A small model has a long tail it cannot do — a 5,000-word memo, a deep
architecture review. The graceful answer is packaging, not pretending: pick
**Ask a cloud AI** on the launcher (or say it in chat), and Enio writes
a *handoff file* — your request restated, plus everything a frontier model
cannot see from here: the relevant context from your conversation, files,
and project, made self-contained.

There is also an ↗ under every reply. An answer that missed is the other
time a bigger model earns its cost, and whether it missed is your call, not
the model's — so the button is always there. When this machine can genuinely
run something bigger, the arrow offers both directions and names the
difference that matters: **package for a cloud AI** (most capable — your
words leave this machine when you paste them) or **try a bigger local
model** (stays private), named concretely — the one model from the
catalogue that is more capable than what is running *and* decodes at a
pace you would sit through, with its estimated speed. On machines where no
such model exists — most hit the bandwidth wall before the capacity wall —
the local option is withheld rather than greyed, and the arrow goes
straight to the cloud handoff.

The reply that wrote a handoff gets an **Ask** button. If you have the
provider's own CLI agent installed — `claude`, `codex` or `gemini` — Enio
runs the handoff through it as a background job: the button shows the
elapsed time, and the answer comes back as a file beside the handoff
(`answer-…-claude.md`), one click from the canvas. The agent runs under
*your* account and *its* sign-in — Enio holds no API keys — and it is
forced into non-interactive, read-only mode, so it can only answer, never
act on your machine. The one you pick becomes the default until you pick
another.

Providers without an installed CLI fall back to the ferry: copy the file,
open their web app, you paste. Labeled as exactly that in the menu.

Either way the payload is the handoff file you can read first, and it
leaves this machine only on your click — which keeps the decision, and
the data, yours.

## A note on Ollama's MLX engine

Since v0.30 (May 2026), Ollama on Apple Silicon can serve **safetensors**
models through its own native MLX engine — roughly double the decode speed of
its llama.cpp path, on the architectures it supports (Qwen3.5/Qwen3 MoE,
Gemma 4, and a growing list). Two things matter if you run
`ENIO_BACKEND=ollama` on a Mac:

- **GGUF tags get none of it.** Most of what `ollama pull` lands, including
  the default `qwen3:8b`, is GGUF and still runs on llama.cpp. To get MLX
  speeds, pick a safetensors tag of a supported architecture, and note the
  MLX preview targeted Macs with more than 32GB of memory.
- **It cannot serve Maple.** Maple's architecture exists only in the mlx-lm
  fork the bundled runtime uses; no upstream MLX stack loads it. Ollama-MLX
  is a faster *Ollama*, not an alternative Maple runtime.

Nothing in enio changes either way — the Ollama backend speaks the same
OpenAI-compatible API whichever engine serves the model.
