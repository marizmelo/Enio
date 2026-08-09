#!/usr/bin/env node
/**
 * Patches the vendored mlx-lm checkout so a tool call survives trailing junk.
 *
 * The bug, in full: Maple closes its reasoning block *inside* the tool-call
 * block, so the text handed to mlx-lm's parser looks like
 *
 *     {"name": "current_time", "arguments": {}}
 *     </think>
 *
 * mlx-lm's json_tools parser is `json.loads(text.strip())`, which rejects that
 * as "Extra data: line 2 column 1". The caller logs a warning, drops the call,
 * and returns empty content. From the client's side the model simply said
 * nothing -- no error, no tool, no text, with the only evidence in a log file.
 *
 * enio cannot repair this itself. Its own JSON repair and <tool_call>
 * scavenging never get a chance, because the text is consumed by the failed
 * parse before any of it reaches the client.
 *
 * raw_decode reads the first complete JSON value and ignores what follows,
 * which is what json.loads should have been doing for generated text all along.
 *
 * This is a local patch to someone else's checkout, so it is written to be
 * boring: idempotent, reversible with `git -C <runtime> checkout .`, and it
 * refuses to touch a file it does not recognise rather than guessing.
 *
 * Report upstream: https://github.com/deepgrove-ai/mlx-lm-deepgrove
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const runtimeDir =
  process.env.ENIO_DIR ??
  process.env.MAPLE_DIR ??
  join(process.env.ENIO_DATA_DIR ?? join(homedir(), ".enio"), "runtime");

/**
 * Apply one idempotent patch: skip if the marker is present, refuse if the
 * original text is not, so upstream changes surface as a message rather than
 * being pattern-matched into a shape they were never in.
 */
function applyPatch({ target, label, marker, original, patched, note }) {
  if (!existsSync(target)) {
    console.log(`  no ${label} at ${target} — nothing to patch`);
    return;
  }

  const source = readFileSync(target, "utf8");

  if (source.includes(marker)) {
    console.log(`  already patched: ${label}`);
    return;
  }

  if (!source.includes(original)) {
    console.log(
      `  ${label} does not match the version this patch was written for.\n` +
        `  Skipping. Check whether it changed upstream:\n    ${target}`,
    );
    return;
  }

  writeFileSync(target, source.replace(original, patched));
  console.log(`  patched: ${note}`);
}

applyPatch({
  target: join(runtimeDir, "mlx_lm", "tool_parsers", "json_tools.py"),
  label: "json_tools.py",
  marker: "# enio: tolerate trailing text after the JSON object",
  original: `def parse_tool_call(text, tools=None):
    return json.loads(text.strip())`,
  // Maple closes its <think> block inside the tool-call block, so the JSON is
  // frequently followed by a stray "</think>". json.loads rejects the whole
  // string as "Extra data", the caller drops the call, and the turn comes back
  // empty -- a valid tool call lost to trailing junk. raw_decode reads the
  // first complete JSON value and ignores the rest.
  patched: `def parse_tool_call(text, tools=None):
    # enio: tolerate trailing text after the JSON object
    return json.JSONDecoder().raw_decode(text.strip())[0]`,
  note: "tool calls now survive a trailing </think>",
});

/**
 * Maple's chat template opens a <think> block on every generation with no way
 * to decline, and on some prompts the model reasons until it hits max_tokens
 * and never writes an answer at all. The turn comes back empty, which reads as
 * being ignored.
 *
 * This makes thinking declinable per request, the way Qwen3's own template
 * does it: when chat_template_kwargs carries enable_thinking: false, the
 * generation prompt PRE-CLOSES the think block, so the model starts where the
 * answer goes rather than where the reasoning does. Default behaviour is
 * untouched — thinking stays on unless a request says otherwise.
 *
 * Lives in the model directory rather than the git checkout, so a weights
 * re-download restores the original; install.sh re-runs this script after
 * both.
 */
applyPatch({
  target: join(runtimeDir, "maple-2bit-mlx", "chat_template.jinja"),
  label: "chat_template.jinja",
  marker: "enable_thinking",
  original: `{%- if add_generation_prompt %}
    {{- '<|im_start|>assistant\\n<think>\\n' }}
{%- endif %}`,
  patched: `{%- if add_generation_prompt %}
    {%- if enable_thinking is defined and not enable_thinking %}
        {{- '<|im_start|>assistant\\n<think>\\n\\n</think>\\n\\n' }}
    {%- else %}
        {{- '<|im_start|>assistant\\n<think>\\n' }}
    {%- endif %}
{%- endif %}`,
  note: "thinking is now declinable via chat_template_kwargs",
});
