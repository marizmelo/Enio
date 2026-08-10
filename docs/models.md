---
title: Models
layout: default
nav_order: 6
---

# Models

## Switching

The model is a **setting**, not a launch flag. The desktop app's status bar has
a picker showing what this machine can serve: the bundled default plus any MLX
chat model already in your Hugging Face cache.

Switching restarts the model server underneath the agent — your conversation,
pending approvals and history all stay up. The choice persists in
`~/.enio/model.json`, so it survives a restart.

The list is closed on purpose: it is scanned from what is present, never typed.
A model id with a typo in it is ninety seconds of loading followed by a download
of several gigabytes nobody asked for. Switching is *choosing*; downloading is a
separate decision made deliberately, elsewhere.

If a model fails to load, the switch reverts — on disk and running — so a bad
choice cannot become what every boot serves.

To try one without changing what the machine boots tomorrow:

```sh
ENIO_MODEL=mlx-community/Qwen3-4B-Instruct-2507-4bit node dist/index.js start
```

## Adding a model

Anything `mlx_lm` can load that is a **chat model** and can **call tools**.
Download it once and it appears in the picker — the list is scanned from your
Hugging Face cache, so nothing else is needed.

```sh
# Downloads on first use, then serves it. Ctrl-C once it has finished
# fetching; the picker will list it from then on.
~/.enio/runtime/.venv/bin/python -m mlx_lm.server \
  --model mlx-community/Qwen3-4B-Instruct-2507-4bit --port 8099
```

### Models worth trying

Every entry below was checked against the Hugging Face API — they exist and are
MLX 4-bit builds. Sizes are the download; resident memory is roughly the same
plus the prompt cache.

| Model | Size | Notes |
|---|---|---|
| `deepgrove/maple-preview` | ~5GB | The bundled default. 20B total, ~1B active, ternary. Fastest per token. |
| `mlx-community/Qwen3-1.7B-4bit` | ~1GB | The small option. Fits anywhere; weakest at multi-step tool use. |
| `mlx-community/Qwen3-4B-Instruct-2507-4bit` | ~2.3GB | Measured here: routing 8/8, and it produces valid plans. A good default on 16GB. |
| `mlx-community/Qwen3-8B-4bit` | ~4.5GB | More capable, still comfortable on 16GB. |
| `mlx-community/Qwen3-14B-4bit` | ~8GB | Wants 24GB or more. |
| `mlx-community/Qwen3-30B-A3B-4bit` | ~17GB | Mixture-of-experts: 30B total, 3B active. Wants 32GB+. |
| `mlx-community/Llama-3.2-3B-Instruct-4bit` | ~1.8GB | Small and widely supported. |
| `mlx-community/Mistral-7B-Instruct-v0.3-4bit` | ~4GB | Solid general model. |

{: .note }
Only Maple and Qwen3-4B have been measured *in Enio*. The rest are listed
because they load and speak the right protocol, not because their tool-calling
was benchmarked here — see [the routing comparison](#which-model-to-run) for
what "measured" means.

**Whether a model can call tools matters more than its size.** A model that
cannot will chat happily and never use a single tool, which looks like Enio
being broken rather than the model being unsuitable. Instruct-tuned models from
the families above all can; base models generally cannot.

Vision, speech and embedding models in your cache are filtered out of the
picker — they have their own servers, and offering one would be offering a
ninety-second failed load.

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

Maple is the shipped default on Apple Silicon: 20B total, ~1B active, ternary
weights, ~218 tok/s, about 6.9GB resident. It decodes very fast.

Raw decode speed is not the same as finishing a task, though. On one measured
comparison of routing — the classification that picks a specialist — both
scored 8/8 correct, and the dense 4B was about twice as fast *per decision*
because a short output is dominated by prompt processing rather than token
generation.

The honest summary: Maple is fastest per token and lightest to run given its
capability; a dense 4B is more reliable at multi-step tool use and holds far
more context. Try both — switching costs one click and a model load.
