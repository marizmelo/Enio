#!/usr/bin/env node
/**
 * Measure whether the router's own token probabilities are worth acting on.
 *
 *   npm run build && node scripts/route-score.mjs     # needs the model server
 *
 * The router answers from a closed list, so the probability the model puts
 * on each name at the position where it writes one is a score for every
 * option, not just the winner -- available from the same call through
 * `logprobs` / `top_logprobs`. The question this answers is whether that
 * score says anything the answer alone does not: does low confidence mark
 * the wrong routes, and does any rule built on it beat the router as it is?
 *
 * Four measurements over the held-out bench (scripts/route-bench-data.mjs):
 *   1. the router's own request, scored: confidence of right against wrong
 *   2. the same scores with a content-free baseline subtracted
 *   3. rules on the COMBINED router (fast tier, then model), which is what
 *      ships -- a rule that only helps the model tier alone helps nobody
 *   4. a plain one-word question with no worked examples, scored the same
 *      way, and how often the two formats agree
 *
 * It asks the router's identical question by capturing the request route()
 * itself sends and replaying it with scores switched on, so there is no
 * second copy of the prompt here to drift. Nothing in src/ reads scores;
 * see DECISIONS.md for why not, and re-run this when the model or the
 * router prompt changes, since the answer is a property of both.
 *
 * top_logprobs is 10, not 11: mlx-lm documents 11 as the maximum and
 * closes the connection on it, with no status code.
 */
process.env.ENIO_FAST_ROUTE = "0"; // route() must reach the model on every case
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(repo, "dist");
if (!existsSync(join(dist, "specialists.js"))) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(1);
}
const d = (p) => import(pathToFileURL(join(dist, p)).href);
const { BENCH } = await import(pathToFileURL(join(repo, "scripts", "route-bench-data.mjs")).href);
const { route, allSpecialists } = await d("specialists.js");
const { fastRoute } = await d("routing-fast.js");
const { config } = await d("config.js");

const list = allSpecialists();
const names = list.map((s) => s.name);
const N = BENCH.length;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const realFetch = globalThis.fetch;
let served;
try {
  served = (await (await realFetch(`${config.modelBaseUrl}/models`)).json()).data[0].id;
} catch {
  console.error(`Model server not reachable at ${config.modelBaseUrl}.`);
  process.exit(1);
}
console.log(`${served} at ${config.modelBaseUrl}\nagents: ${names.join(", ")}\n`);

let captured = null;
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith("/chat/completions")) captured = JSON.parse(init.body);
  return realFetch(url, init);
};

// A token names an agent when, stripped of the tokenizer's space marker and
// quotes, it begins exactly one name. Every built-in differs in its first
// two letters; a custom agent that does not is simply left unscored.
const clean = (t) => t.replace(/^[Ġ▁\s"']+/, "").replace(/["'\s]+$/, "").toLowerCase();
const nameFor = (tok) => {
  const c = clean(tok);
  if (c.length < 2) return null;
  const hits = names.filter((n) => n.startsWith(c));
  return hits.length === 1 ? hits[0] : null;
};

/** Log-probability per agent at the name position; `floor` bounds the rest. */
async function score(body, afterKey) {
  const t = Date.now();
  const res = await realFetch(`${config.modelBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: false, logprobs: true, top_logprobs: 10 }),
  });
  const toks = (await res.json()).choices?.[0]?.logprobs?.content ?? [];
  let seenKey = !afterKey, at = -1, acc = "";
  for (let i = 0; i < toks.length; i++) {
    acc += toks[i].token;
    if (!seenKey) { if (/special/i.test(acc) && /ist/i.test(toks[i].token)) seenKey = true; continue; }
    if (nameFor(toks[i].token)) { at = i; break; }
  }
  const lp = {};
  let floor = 0;
  if (at >= 0) for (const alt of toks[at].top_logprobs ?? []) {
    floor = Math.min(floor, alt.logprob);
    const n = nameFor(alt.token);
    if (n) lp[n] = Math.max(lp[n] ?? -Infinity, alt.logprob);
  }
  return { lp, floor, ms: Date.now() - t };
}
const ranked = (s, prior = () => 0) =>
  names.map((n) => [n, (s.lp[n] ?? s.floor - 1) - prior(n)]).sort((a, b) => b[1] - a[1]);

async function routerScored(prompt) {
  captured = null;
  const got = await route(prompt);
  return { got, ...(await score({ ...captured, max_tokens: 24 }, true)) };
}

await fastRoute("warm up", list);

// ---- 1. the router's own request, scored
const rows = [];
for (const [prompt, want] of BENCH) {
  const s = await routerScored(prompt);
  const [a, b] = ranked(s);
  const fast = await fastRoute(prompt, list);
  rows.push({ prompt, want, ...s, top: a[0], second: b[0], gap: a[1] - b[1], fast: fast?.specialist ?? null, fastMargin: fast?.margin ?? 0 });
}
const right = rows.filter((r) => r.got === r.want);
const wrong = rows.filter((r) => r.got !== r.want);
const gaps = (xs) => xs.map((r) => r.gap).sort((a, b) => a - b).map((g) => g.toFixed(1)).join(" ");
console.log(`1. router as it is: ${right.length}/${N} right · scored call median ${median(rows.map((r) => r.ms))}ms`);
// Normalised over the names here rather than read off the server: mlx-lm
// reports the winner at exactly 0 and the rest in steps of an eighth of a
// nat, so its numbers are log-odds against the top, not probabilities.
const share = (r) => 1 / names.reduce((sum, n) => sum + Math.exp((r.lp[n] ?? -Infinity) - r.lp[r.top]), 0);
console.log(`   probability of its answer when WRONG: ${wrong.map((r) => share(r).toFixed(3)).join(", ")} (lowest when right: ${Math.min(...right.map(share)).toFixed(3)})`);
console.log(`   gap to runner-up, nats — right: median ${median(right.map((r) => r.gap)).toFixed(1)}, lowest ${gaps(right).split(" ").slice(0, 4).join(" ")} | wrong: ${gaps(wrong)}`);
console.log(`   the runner-up was the right answer in ${wrong.filter((r) => r.second === r.want).length}/${wrong.length} misses; misses went to: ${wrong.map((r) => r.got).join(", ")}`);
for (const th of [6, 10, 12, 14]) {
  console.log(`   gap < ${String(th).padEnd(2)}: catches ${wrong.filter((r) => r.gap < th).length}/${wrong.length} wrong, flags ${right.filter((r) => r.gap < th).length}/${right.length} right`);
}

// ---- 2. contextual calibration: subtract what a request with no content gets
const blanks = [];
for (const blank of ["N/A N/A", "[MASK] [MASK]", "... ..."]) blanks.push(await routerScored(blank)); // two words: one skips the router
const prior = (n) => blanks.reduce((sum, b) => sum + (b.lp[n] ?? b.floor), 0) / blanks.length;
const acc = (pick) => rows.filter((r) => pick(r) === r.want).length;
console.log(`\n2. content-free requests route to: ${blanks.map((b) => b.got).join(", ")}`);
console.log(`   answer after subtracting that baseline: ${acc((r) => ranked(r, prior)[0][0])}/${N}`);

// ---- 3. rules on the combined router
const viaFast = (r) => r.fast && r.fastMargin >= config.fastRouteMargin;
const today = (r) => (viaFast(r) ? r.fast : r.got);
console.log(`\n3. combined router today (fast tier at margin ≥ ${config.fastRouteMargin}, else model): ${acc(today)}/${N}, fast tier takes ${rows.filter(viaFast).length}`);
for (const th of [8, 12, 14]) {
  // Unsure, and the fast tier -- below its own bar -- names the runner-up.
  const pick = (r) => (!viaFast(r) && r.gap < th && r.fast === r.second ? r.second : today(r));
  const changed = rows.filter((r) => pick(r) !== today(r));
  console.log(`   take the runner-up when gap < ${String(th).padEnd(2)} and the fast tier names it: ${acc(pick)}/${N} (${changed.length} changed, ${changed.filter((r) => pick(r) === r.want).length} for the better)`);
}
console.log(`   still wrong today:`);
for (const r of rows.filter((r) => today(r) !== r.want)) {
  console.log(`     "${r.prompt}" → ${today(r)}${viaFast(r) ? " (fast)" : ""}, wanted ${r.want}; model ${r.top} then ${r.second} (gap ${r.gap.toFixed(1)}); fast ${r.fast} at ${r.fastMargin.toFixed(3)}`);
}

// ---- 4. a plain question, no worked examples
const system =
  `Route the user's request to exactly one specialist.\n\n` +
  list.map((s) => `- ${s.name}: ${s.description}`).join("\n") +
  `\n\nReply with ONLY the specialist's name, one word, nothing else.`;
const plain = [];
for (const [i, [prompt, want]] of BENCH.entries()) {
  const s = await score({ model: served, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], temperature: 0, max_tokens: 6 }, false);
  const [a, b] = ranked(s);
  plain.push({ prompt, want, got: a[0], second: b[0], gap: a[1] - b[1], ms: s.ms, few: rows[i].got });
}
const pRight = plain.filter((r) => r.got === r.want);
const pWrong = plain.filter((r) => r.got !== r.want);
const agree = plain.filter((r) => r.got === r.few);
const differ = plain.filter((r) => r.got !== r.few);
console.log(`\n4. plain question, no examples: ${pRight.length}/${N} right · median ${median(plain.map((r) => r.ms))}ms`);
console.log(`   gap — right: median ${median(pRight.map((r) => r.gap)).toFixed(1)} | wrong: ${gaps(pWrong)}`);
console.log(`   the two formats agree on ${agree.length}/${N}, and are right on ${agree.filter((r) => r.got === r.want).length} of those`);
console.log(`   where they differ (${differ.length}): the router is right ${differ.filter((r) => r.few === r.want).length}, the plain question ${differ.filter((r) => r.got === r.want).length}, neither ${differ.filter((r) => r.few !== r.want && r.got !== r.want).length}`);

// onnxruntime aborts on a normal exit after the embedder has loaded.
process.exit(0);
