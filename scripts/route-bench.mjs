#!/usr/bin/env node
/**
 * Measure the router: model tier, fast tier, and the two combined.
 *
 *   node scripts/route-bench.mjs            # both tiers (model needs the server)
 *   node scripts/route-bench.mjs --fast-only
 *
 * Reports accuracy and latency per tier, then the combined router at a
 * range of margin thresholds: how many requests the fast tier would take,
 * and what accuracy the pair would reach. The threshold that ships is read
 * off this table, not chosen. It runs once per set in route-bench-data.mjs:
 * the held-out one, then the boundary one.
 *
 * The answer depends on the install: custom agents join the list, and a
 * calendar or todo change belongs to the planner or the operator according
 * to what is connected (the script says which it measured).
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
const { BENCH, BOUNDARY } = await import(pathToFileURL(join(repo, "scripts", "route-bench-data.mjs")).href);
const { fastRoute, calendarChanger } = await d("routing-fast.js");
const { route, allSpecialists } = await d("specialists.js");
const { config } = await d("config.js");
const fastOnly = process.argv.includes("--fast-only");

const specialists = allSpecialists();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

let up = false;
if (!fastOnly) {
  try {
    const res = await fetch(`${config.modelBaseUrl}/models`);
    const body = res.ok ? await res.json().catch(() => null) : null;
    up = Boolean(body && Array.isArray(body.data));
  } catch { /* down */ }
}
console.log(`agents: ${specialists.map((s) => s.name).join(", ")}`);
console.log(`calendar and todo changes belong to: ${calendarChanger()}`);

// Warm the tier once (embedding model load + exemplar vectors), then time.
await fastRoute("warm up", specialists);

async function measure(name, set) {
  console.log(`\n== ${name} (${set.length})`);
  const fast = [];
  for (const [prompt, want] of set) {
    const r = await fastRoute(prompt, specialists);
    fast.push({ prompt, want, got: r?.specialist ?? null, margin: r?.margin ?? 0, runnerUp: r?.runnerUp ?? null, ms: r?.ms ?? 0 });
  }
  const fastRight = fast.filter((r) => r.got === r.want).length;
  console.log(`fast tier : ${fastRight}/${set.length} right · median ${median(fast.map((r) => r.ms))}ms`);
  for (const r of fast.filter((r) => r.got !== r.want)) {
    console.log(`   "${r.prompt}" → ${r.got} (wanted ${r.want}; margin ${r.margin.toFixed(3)}, runner-up ${r.runnerUp})`);
  }

  let model = null;
  if (!fastOnly && !up) {
    console.log(`\nmodel tier: server not reachable at ${config.modelBaseUrl} — skipped (use --fast-only to hide this)`);
  } else if (!fastOnly) {
    // The model tier alone: route() with the fast tier switched off for the
    // loop. Left on, the fast tier answered half of these and the line
    // below reported the combined router under the model's name.
    const was = config.fastRoute;
    config.fastRoute = false;
    model = [];
    try {
      for (const [prompt, want] of set) {
        const t = Date.now();
        const got = await route(prompt);
        model.push({ prompt, want, got, ms: Date.now() - t });
      }
    } finally {
      config.fastRoute = was;
    }
    const right = model.filter((r) => r.got === r.want).length;
    console.log(`\nmodel tier: ${right}/${set.length} right · median ${median(model.map((r) => r.ms))}ms`);
    for (const r of model.filter((r) => r.got !== r.want)) console.log(`   "${r.prompt}" → ${r.got} (wanted ${r.want})`);
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
    const denom = model ? set.length : handled || 1;
    const lat = modelMs == null ? "" : `${Math.round((handled / set.length) * median(fast.map((r) => r.ms)) + (1 - handled / set.length) * modelMs)}ms`;
    const mark = theta === config.fastRouteMargin ? " ← ships" : "";
    console.log(`            ${theta.toFixed(2).padEnd(6)} ${String(handled).padStart(3)}/${set.length}         ${right}/${denom}${" ".repeat(Math.max(1, 18 - `${right}/${denom}`.length))}${lat}${mark}`);
  }
}

await measure("held-out", BENCH);
await measure("boundary", BOUNDARY);
// onnxruntime aborts on a normal exit after the embedding model has loaded.
process.exit(0);
