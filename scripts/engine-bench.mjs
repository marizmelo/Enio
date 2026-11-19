#!/usr/bin/env node
/**
 * Measure an inference engine as Enio would use it.
 *
 *   node scripts/engine-bench.mjs --base-url http://127.0.0.1:8000/v1 --model <id> [--label name] [--key k]
 *   node scripts/engine-bench.mjs                      # the engine Enio is configured for
 *   ... --speed-only        skip the golden tasks      --tasks N   only the first N
 *
 * "Is engine X a fit" was being answered from the engine's own README:
 * tokens per second on someone else's machine, with someone else's prompt.
 * This asks the three questions Enio's turns actually depend on, against
 * any OpenAI-compatible server, with the material Enio really sends:
 *
 *   1. Speed: time to first token and decode rate on a short chat turn, and
 *      on a turn carrying a full specialist prompt plus tool definitions --
 *      the second is the one a user waits on, and prompt processing
 *      dominates it on slow engines.
 *   2. Tool calling: the coder's golden tasks from the adapter gate, with
 *      its exact system prompt and tools -- tool choice, valid JSON
 *      arguments, and the honest "not here" (abstention).
 *   3. Stability: every request either answers or is counted as a failure,
 *      with the engine's own error text.
 *
 * The router's model tier is measured by scripts/route-bench.mjs under the
 * same ENIO_BASE_URL / ENIO_MODEL; this script prints that command.
 * Nothing here trains, installs or changes configuration.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(repo, "dist");
if (!existsSync(join(dist, "agent.js"))) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(1);
}
const d = (p) => import(pathToFileURL(join(dist, p)).href);
const args = process.argv.slice(2);
const opt = (f, dflt) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const { config } = await d("config.js");
const { currentModelId } = await d("model-settings.js");
const { getSpecialist } = await d("specialists.js");
const { SHARED_RULES } = await d("agent.js");
const { toWireTool } = await d("types.js");
const { abstains } = await d("adapters.js");
const { fsTools } = await d("tools/fs.js");
const { shellTools } = await d("tools/shell.js");
const { searchTools } = await d("tools/search.js");
const { skillTools } = await d("tools/skills.js");
const { goldenTasks } = await import(pathToFileURL(join(repo, "scripts", "adapter-data", "coder.mjs")).href);

const baseUrl = opt("--base-url", config.modelBaseUrl).replace(/\/$/, "");
const model = opt("--model", currentModelId());
const label = opt("--label", model);
const key = opt("--key", process.env.ENIO_MODEL_API_KEY ?? "enio");
const limit = Number(opt("--tasks", "0")) || 0;
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };

const specialist = getSpecialist("coder");
const systemPrompt = `${specialist.systemPrompt}\n\n${SHARED_RULES}`;
const toolPool = [...fsTools, ...shellTools, ...searchTools, ...skillTools];
const wireTools = specialist.tools.map((t) => toolPool.find((x) => x.name === t)).filter(Boolean).map(toWireTool);

/** One streamed completion, timed: first token, total, and what came back. */
async function timed(messages, { tools = null, maxTokens = 160 } = {}) {
  const body = { model, messages, temperature: 0, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } };
  if (tools) body.tools = tools;
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  let first = null;
  let pieces = 0;
  let usage = null;
  let text = "";
  let buf = "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.usage) usage = j.usage;
      const delta = j.choices?.[0]?.delta ?? {};
      const piece = (delta.content ?? "") + (delta.reasoning_content ?? delta.reasoning ?? "") + (delta.tool_calls ? JSON.stringify(delta.tool_calls) : "");
      if (piece) {
        if (first === null) first = performance.now();
        pieces += 1;
        text += delta.content ?? "";
      }
    }
  }
  const t1 = performance.now();
  const out = usage?.completion_tokens ?? pieces;
  const decodeMs = first === null ? 0 : t1 - first;
  return {
    firstMs: first === null ? null : Math.round(first - t0),
    totalMs: Math.round(t1 - t0),
    promptTokens: usage?.prompt_tokens ?? null,
    outTokens: out,
    counted: usage?.completion_tokens != null ? "usage" : "chunks",
    tokPerSec: decodeMs > 0 && out > 1 ? +(((out - 1) * 1000) / decodeMs).toFixed(1) : null,
    text,
  };
}

async function ask(task) {
  const turn = task.messages ?? [{ role: "user", content: task.prompt }];
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    // The body the agent sends, at temperature 0: the gate's own shape.
    body: JSON.stringify({ model, messages: [{ role: "system", content: systemPrompt }, ...turn], tools: wireTools, temperature: 0, max_tokens: 400, stream: false }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const out = await res.json();
  return { msg: out.choices?.[0]?.message ?? {}, ms: Math.round(performance.now() - t0), usage: out.usage ?? null };
}

console.log(`engine bench · ${label}\n  ${baseUrl} · model ${model}\n`);

/* ---------------------------------------------------------------- speed */
const speed = [];
const probes = [
  ["short chat", [{ role: "user", content: "In two sentences, what is a hummingbird?" }], {}],
  ["coder turn (system prompt + tools)", [{ role: "system", content: systemPrompt }, { role: "user", content: "Explain in three sentences what a race condition is. Do not call a tool." }], { tools: wireTools }],
];
for (const [name, messages, o] of probes) {
  try {
    // Twice: the first pays any cold cost (weights paged in, prompt never
    // seen), the second is what a conversation feels like.
    const f = (r) => `first token ${r.firstMs} ms, ${r.outTokens} tokens (${r.counted}) at ${r.tokPerSec ?? "?"} tok/s, total ${(r.totalMs / 1000).toFixed(1)} s${r.promptTokens ? `, prompt ${r.promptTokens} tokens` : ""}`;
    console.log(`speed · ${name}`);
    const cold = await timed(messages, o);
    console.log(`  cold: ${f(cold)}`);
    const warm = await timed(messages, o);
    console.log(`  warm: ${f(warm)}`);
    speed.push({ name, cold, warm });
  } catch (err) {
    speed.push({ name, error: String(err.message ?? err) });
    console.log(`speed · ${name}\n  FAILED: ${err.message ?? err}`);
  }
}

/* --------------------------------------------------------- golden tasks */
// --speed-only: a slow engine can take minutes per task; the two probes
// above are then the whole question.
const tasks = args.includes("--speed-only") ? [] : limit > 0 ? goldenTasks().slice(0, limit) : goldenTasks();
let toolRight = 0, toolTotal = 0, jsonValid = 0, jsonTotal = 0, abstainRight = 0, abstainTotal = 0, failures = 0;
const times = [];
const misses = [];
for (const task of tasks) {
  let r;
  try {
    r = await ask(task);
  } catch (err) {
    failures += 1;
    misses.push(`  "${task.prompt ?? "(recovery probe)"}" → request failed: ${err.message ?? err}`);
    if (task.expect === "abstain") abstainTotal += 1;
    else toolTotal += 1;
    continue;
  }
  times.push(r.ms);
  const calls = r.msg.tool_calls ?? [];
  const first = calls[0]?.function?.name ?? null;
  const spoke = typeof r.msg.content === "string" && r.msg.content.trim().length > 0;
  if (task.expect === "abstain") {
    abstainTotal += 1;
    if (abstains(r.msg.content, calls.length > 0)) abstainRight += 1;
    else misses.push(`  "${task.prompt}" → ${first ? `${first} (kept looking)` : "answered as if it knew"} (wanted "not here")`);
    continue;
  }
  toolTotal += 1;
  if (first === task.expect && (task.expect !== null || spoke)) toolRight += 1;
  else misses.push(`  "${task.prompt ?? "(recovery probe)"}" → ${first ?? (spoke ? "no call" : "empty reply")} (wanted ${task.expect ?? "no call"})`);
  for (const c of calls) {
    jsonTotal += 1;
    try {
      JSON.parse(c.function?.arguments ?? "");
      jsonValid += 1;
    } catch {
      /* counted by omission */
    }
  }
}
const sorted = [...times].sort((a, b) => a - b);
const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
console.log(
  `\ngolden tasks (coder, ${tasks.length}): tool choice ${toolRight}/${toolTotal}, valid JSON ${jsonValid}/${jsonTotal}, ` +
    `abstains ${abstainRight}/${abstainTotal}, failed requests ${failures}\n` +
    `  per task: median ${(median / 1000).toFixed(1)} s, slowest ${((sorted.at(-1) ?? 0) / 1000).toFixed(1)} s, all ${(times.reduce((a, b) => a + b, 0) / 1000).toFixed(0)} s`,
);
if (misses.length) console.log(misses.join("\n"));

console.log(
  `\nrouter model tier, same engine:\n  ENIO_BASE_URL=${baseUrl} ENIO_MODEL=${model} node scripts/route-bench.mjs`,
);
console.log(`\nJSON ${JSON.stringify({ label, baseUrl, model, speed: speed.map((s) => ({ name: s.name, error: s.error, cold: s.cold && { firstMs: s.cold.firstMs, tokPerSec: s.cold.tokPerSec, totalMs: s.cold.totalMs }, warm: s.warm && { firstMs: s.warm.firstMs, tokPerSec: s.warm.tokPerSec, totalMs: s.warm.totalMs, promptTokens: s.warm.promptTokens } })), golden: { toolRight, toolTotal, jsonValid, jsonTotal, abstainRight, abstainTotal, failures, medianMs: median } })}`);
