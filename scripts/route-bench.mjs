#!/usr/bin/env node
/**
 * Measure the router: model tier, fast tier, and the two combined.
 *
 *   node scripts/route-bench.mjs            # both tiers (model needs the server)
 *   node scripts/route-bench.mjs --fast-only
 *
 * Reports accuracy and latency per tier over the held-out set, then the
 * combined router at a range of margin thresholds: how many requests the
 * fast tier would take, and what accuracy the pair would reach. The
 * threshold that ships is read off this table, not chosen.
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(repo, "dist");
if (!existsSync(join(dist, "routing-fast.js"))) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(1);
}
const d = (p) => import(pathToFileURL(join(dist, p)).href);
const { BENCH } = await import(pathToFileURL(join(repo, "scripts", "route-bench-data.mjs")).href);
const { fastRoute } = await d("routing-fast.js");
const { route, allSpecialists } = await d("specialists.js");
const { config } = await d("config.js");
const fastOnly = process.argv.includes("--fast-only");

const specialists = allSpecialists();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// Warm the tier once (embedding model load + exemplar vectors), then time.
await fastRoute("warm up", specialists);
const fast = [];
for (const [prompt, want] of BENCH) {
  const r = await fastRoute(prompt, specialists);
  fast.push({ prompt, want, got: r?.specialist ?? null, margin: r?.margin ?? 0, runnerUp: r?.runnerUp ?? null, ms: r?.ms ?? 0 });
}
const fastRight = fast.filter((r) => r.got === r.want).length;
console.log(`fast tier : ${fastRight}/${BENCH.length} right · median ${median(fast.map((r) => r.ms))}ms`);
for (const r of fast.filter((r) => r.got !== r.want)) {
  console.log(`   "${r.prompt}" → ${r.got} (wanted ${r.want}; margin ${r.margin.toFixed(3)}, runner-up ${r.runnerUp})`);
}

let model = null;
if (!fastOnly) {
  let up = false;
  try {
    const res = await fetch(`${config.modelBaseUrl}/models`);
    const body = res.ok ? await res.json().catch(() => null) : null;
    up = Boolean(body && Array.isArray(body.data));
  } catch { /* down */ }
  if (!up) {
    console.log(`\nmodel tier: server not reachable at ${config.modelBaseUrl} — skipped (use --fast-only to hide this)`);
  } else {
    model = [];
    for (const [prompt, want] of BENCH) {
      const t = Date.now();
      const got = await route(prompt);
      model.push({ prompt, want, got, ms: Date.now() - t });
    }
    const right = model.filter((r) => r.got === r.want).length;
    console.log(`\nmodel tier: ${right}/${BENCH.length} right · median ${median(model.map((r) => r.ms))}ms`);
    for (const r of model.filter((r) => r.got !== r.want)) console.log(`   "${r.prompt}" → ${r.got} (wanted ${r.want})`);
  }
}

// Combined: fast when margin ≥ θ, else the model (or, without the model
// tier measured, count those as unresolved).
console.log(`\ncombined  : θ      fast-handled   accuracy${model ? "" : " (fast-handled only)"}   est. median latency`);
const modelMs = model ? median(model.map((r) => r.ms)) : null;
for (const theta of [0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.15, 0.2]) {
  let right = 0, handled = 0;
  fast.forEach((r, i) => {
    if (r.got && r.margin >= theta) {
      handled++;
      if (r.got === r.want) right++;
    } else if (model) {
      if (model[i].got === r.want) right++;
    }
  });
  const denom = model ? BENCH.length : handled || 1;
  const lat = modelMs == null ? "" : `${Math.round((handled / BENCH.length) * median(fast.map((r) => r.ms)) + (1 - handled / BENCH.length) * modelMs)}ms`;
  console.log(`            ${theta.toFixed(2).padEnd(6)} ${String(handled).padStart(3)}/${BENCH.length}         ${right}/${denom}${" ".repeat(Math.max(1, 18 - `${right}/${denom}`.length))}${lat}`);
}
