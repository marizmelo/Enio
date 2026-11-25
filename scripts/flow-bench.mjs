#!/usr/bin/env node
/**
 * Measure the check that turns a multi-agent request into a draft plan.
 *
 *   npm run build && node scripts/flow-bench.mjs     # needs Enio running
 *
 * The check is two stages (src/flow.ts): a grammar test on the message,
 * then the composer, kept only when its steps need two agents. This reports
 * each stage alone and the pair, over requests that belong to one agent
 * (the routing benches, where any plan is a false one) and requests that
 * need several (FLOWS). The pair is what ships; the composer alone is here
 * because it is the tempting simpler design, and the numbers are why not.
 *
 * It asks the running agent to compose, over HTTP with the local token,
 * because composing needs the live registry: building one here would start
 * every MCP server the user has configured.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(repo, "dist");
if (!existsSync(join(dist, "flow.js"))) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(1);
}
const { BENCH, BOUNDARY, FLOWS } = await import(pathToFileURL(join(repo, "scripts", "route-bench-data.mjs")).href);
const { flowCandidate, agentsOf } = await import(pathToFileURL(join(dist, "flow.js")).href);

const base = process.env.ENIO_AGENT_URL ?? "http://127.0.0.1:8787";
const dataDir = process.env.ENIO_DATA_DIR ?? join(homedir(), ".enio");
let token = "";
try {
  token = readFileSync(join(dataDir, "token"), "utf8").trim();
} catch {
  console.error(`No token at ${join(dataDir, "token")} — start Enio once first.`);
  process.exit(1);
}

async function compose(prompt) {
  const started = Date.now();
  const res = await fetch(`${base}/pipelines/compose`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const body = await res.json().catch(() => ({}));
  return { nodes: body.ok ? body.nodes : [], ms: Date.now() - started };
}

try {
  await fetch(`${base}/ping`);
} catch {
  console.error(`Enio is not answering at ${base}.`);
  process.exit(1);
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const rows = [];
for (const [kind, set] of [["single", [...BENCH, ...BOUNDARY].map(([p]) => p)], ["flow", FLOWS]]) {
  for (const prompt of set) {
    const passes = flowCandidate(prompt) !== null;
    const { nodes, ms } = await compose(prompt);
    rows.push({ kind, prompt, passes, steps: nodes.map((n) => n.abilityId), spans: agentsOf(nodes).length >= 2, ms });
  }
}

for (const kind of ["single", "flow"]) {
  const set = rows.filter((r) => r.kind === kind);
  const label = kind === "single" ? "requests for one agent, where any plan is a false one" : "requests for several agents";
  console.log(`\n== ${label} (${set.length})`);
  console.log(`grammar alone passes : ${set.filter((r) => r.passes).length}`);
  console.log(`composer alone plans : ${set.filter((r) => r.spans).length}`);
  console.log(`the pair plans       : ${set.filter((r) => r.passes && r.spans).length}`);
  const shown = kind === "single" ? set.filter((r) => r.passes && r.spans) : set.filter((r) => !(r.passes && r.spans));
  for (const r of shown) console.log(`   "${r.prompt}" → ${r.steps.join(" > ") || "(nothing)"}${r.passes ? "" : "  [grammar did not pass]"}`);
}
const all = rows.length;
const paid = rows.filter((r) => r.kind === "single" && r.passes).length;
console.log(`\ncomposer median ${median(rows.map((r) => r.ms))}ms · paid on ${paid} of ${rows.filter((r) => r.kind === "single").length} ordinary requests (${all} composed here to measure the composer alone)`);
