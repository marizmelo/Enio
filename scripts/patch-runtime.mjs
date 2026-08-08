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

const target = join(runtimeDir, "mlx_lm", "tool_parsers", "json_tools.py");

const MARKER = "# enio: tolerate trailing text after the JSON object";

const ORIGINAL = `def parse_tool_call(text, tools=None):
    return json.loads(text.strip())`;

const PATCHED = `def parse_tool_call(text, tools=None):
    ${MARKER}
    #
    # Maple closes its <think> block inside the tool-call block, so the JSON is
    # frequently followed by a stray "</think>". json.loads rejects the whole
    # string as "Extra data", the caller drops the call, and the turn comes back
    # empty -- a valid tool call lost to trailing junk. raw_decode reads the
    # first complete JSON value and ignores the rest.
    return json.JSONDecoder().raw_decode(text.strip())[0]`;

if (!existsSync(target)) {
  console.log(`  no mlx-lm checkout at ${runtimeDir} — nothing to patch`);
  process.exit(0);
}

const source = readFileSync(target, "utf8");

if (source.includes(MARKER)) {
  console.log("  already patched: json_tools.py");
  process.exit(0);
}

if (!source.includes(ORIGINAL)) {
  // Upstream changed. Say so loudly rather than pattern-matching something
  // else into a shape it was never in.
  console.log(
    "  json_tools.py does not match the version this patch was written for.\n" +
      "  Skipping. Check whether the trailing-text bug is fixed upstream:\n" +
      `    ${target}`,
  );
  process.exit(0);
}

writeFileSync(target, source.replace(ORIGINAL, PATCHED));
console.log("  patched: tool calls now survive a trailing </think>");
