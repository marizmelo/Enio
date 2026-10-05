#!/usr/bin/env node
/**
 * Measure the mood label's classifier over the held-out replies.
 *
 *   node scripts/mood-bench.mjs
 *
 * Reports accuracy overall and per label, the confusions, the margin
 * distribution of right and wrong answers, and the pair (decided count,
 * accuracy) at a range of margin thresholds. ENIO_MOOD_MARGIN's default is
 * read off that table, not chosen. Needs dist/ and the cached embedding
 * model; no model server.
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(repo, "dist");
if (!existsSync(join(dist, "mood.js"))) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(1);
}
const d = (p) => import(pathToFileURL(join(dist, p)).href);
const { BENCH } = await import(pathToFileURL(join(repo, "scripts", "mood-bench-data.mjs")).href);
const { classifyMood, moodByRule, MOODS } = await d("mood.js");
const { embedBatch } = await d("memory/embed.js");

const rows = [];
for (const [reply, want] of BENCH) {
  const rule = moodByRule(reply, []);
  const n = await classifyMood(reply, { embedder: embedBatch });
  if (!n) {
    console.error("Embeddings unavailable — is the model cached? (any turn that recalls memory downloads it)");
    process.exit(1);
  }
  rows.push({ reply, want, rule, got: n.label, margin: n.margin, runnerUp: n.runnerUp, ms: n.ms });
}

const pct = (a, b) => (b ? `${a}/${b} (${Math.round((100 * a) / b)}%)` : "0/0");
const right = rows.filter((r) => r.got === r.want);
console.log(`classifier alone: ${pct(right.length, rows.length)} right · median ${median(rows.map((r) => r.ms))}ms`);
for (const m of MOODS) {
  const of = rows.filter((r) => r.want === m);
  console.log(`  ${m.padEnd(8)} ${pct(of.filter((r) => r.got === m).length, of.length)}`);
}
const wrong = rows.filter((r) => r.got !== r.want);
if (wrong.length) {
  console.log("\nconfusions:");
  for (const r of wrong) console.log(`  "${r.reply}" → ${r.got} (wanted ${r.want}; margin ${r.margin.toFixed(3)}, runner-up ${r.runnerUp})`);
}
const ruled = rows.filter((r) => r.rule);
console.log(`\nrules alone (no tool steps): ${pct(ruled.filter((r) => r.rule === r.want).length, ruled.length)} of the ${ruled.length} they fire on`);

console.log("\nmargin histogram (right | wrong):");
for (let lo = 0; lo < 0.3; lo += 0.02) {
  const hi = lo + 0.02;
  const inb = (r) => r.margin >= lo && r.margin < hi;
  const okN = right.filter(inb).length;
  const badN = wrong.filter(inb).length;
  if (okN || badN) console.log(`  ${lo.toFixed(2)}–${hi.toFixed(2)}  ${"#".repeat(okN).padEnd(14)} | ${"#".repeat(badN)}`);
}

console.log("\nthreshold  decided  right-of-decided  overall (undecided → neutral)");
for (const t of [0, 0.01, 0.02, 0.03, 0.04, 0.06, 0.08, 0.1]) {
  const decided = rows.filter((r) => r.margin >= t);
  const decidedRight = decided.filter((r) => r.got === r.want).length;
  const overall = rows.filter((r) => (r.margin >= t ? r.got : "neutral") === r.want).length;
  console.log(`  ${t.toFixed(2)}       ${String(decided.length).padStart(2)}/${rows.length}     ${pct(decidedRight, decided.length).padEnd(16)} ${pct(overall, rows.length)}`);
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}
