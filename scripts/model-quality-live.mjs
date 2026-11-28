#!/usr/bin/env node
/**
 * The same everyday requests through Enio's real turn loop, for comparing
 * two models by their answers.
 *
 *   npm run build
 *   ENIO_BASE_URL=http://127.0.0.1:8091/v1 ENIO_MODEL=<id> node scripts/model-quality-live.mjs out.json [id,id,...]
 *
 * Needs a model server at ENIO_BASE_URL. A candidate is served beside the
 * one in use, on its own port, so the app is not disturbed:
 *
 *   ~/.enio/runtime/.venv/bin/python -m mlx_lm.server --model <id> --port 8091
 *
 * Fifteen requests a person might type: summarise, extract, reorder notes,
 * rewrite under a limit, clock arithmetic, a trick question, European
 * Portuguese, a counted constraint, explain code, something it cannot
 * know, a comparison with a trap in it, a two-turn follow-up, and two that
 * go through the router. A scratch data dir, no MCP and no accounts:
 * nothing of the user's is read.
 *
 * It prints what was answered and how long it took; it does not score.
 * Answers are judged afterwards, blind: pair two runs, hide which model
 * wrote which, and give several readers the same key (DECISIONS.md,
 * "Qwen3.5 9B was measured and is not the default"). Speed, tool choice
 * and routing are scripts/engine-bench.mjs and scripts/route-bench.mjs;
 * this is the part those cannot see.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const outFile = process.argv[2];
const scratch = mkdtempSync(join(tmpdir(), "enio-quality-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
for (const d of ["data", "ws", "skills", "machine"]) mkdirSync(join(scratch, d), { recursive: true });
const cache = join(homedir(), ".enio", "embeddings-cache");
if (existsSync(cache)) symlinkSync(cache, join(scratch, "data", "embeddings-cache"));
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { if (/huggingface/.test(String(url))) throw new Error("no network in this run"); return realFetch(url, init); };

const dist = (f) => pathToFileURL(join(repo, "dist", f)).href;
const store = await import(dist("memory/store.js"));
const { buildRegistry } = await import(dist("tools/index.js"));
const { runTurn } = await import(dist("agent.js"));

const ARTICLE = `The city council voted 7 to 4 on Tuesday to close Harbour Street to cars on weekends from 3 May to 28 September. Shop owners on the street were split: the bakers' association backed the plan, saying foot traffic rose 30 percent during last year's two trial weekends, while the two hardware stores said most of their customers arrive by van and that weekend sales fell by a fifth during the trial. The council will pay for 40 extra parking spaces on Mill Lane, a five-minute walk away, and will review the closure in October. Councillor Reyes, who voted against, said the review date was "too late to help a shop that loses a summer".`;
const NOTES = `- call with Dana moved from Wed 10:00 to Thu 14:30\n- send Q3 numbers to finance before Friday noon\n- Lisbon trip: flight TP1352 on 12 Dec, hotel not booked yet\n- renew passport (expires 3 Feb 2027)\n- dentist 9 Dec 08:15, bring x-rays`;
const CODE = "function dedupe(items) {\n  const seen = {};\n  return items.filter((item) => {\n    if (seen[item.id]) return false;\n    seen[item.id] = true;\n    return true;\n  });\n}";

/** [id, agent or null for the router, turns...] */
const TASKS = [
  ["summary", "generalist", `Summarise this in two sentences for someone deciding whether to open a shop there:\n\n${ARTICLE}`],
  ["facts", "generalist", `From this text, list every number with what it measures, one per line:\n\n${ARTICLE}`],
  ["against", "generalist", `Based only on this text, who opposes the plan and what exactly is their argument?\n\n${ARTICLE}`],
  ["notes-order", "generalist", `Here are my notes. Put them in the order I have to act on them, with the date of each, and tell me which one has no date:\n\n${NOTES}`],
  ["rewrite", "generalist", `Rewrite this to be polite and under 40 words, keeping every fact: "You sent the wrong invoice again. It says 1,240 euros and we agreed 1,180. Fix it today or we stop the order."`],
  ["logic", "generalist", "A train leaves at 14:40 and the trip takes 2 hours 35 minutes. I need 25 minutes to get from the station to the office and the meeting starts at 17:30. Do I make it, and by how much?"],
  ["trick", "generalist", "Which weighs more: a kilogram of feathers or a kilogram of steel? Answer in one sentence."],
  ["portuguese", "generalist", "Traduz para português de Portugal, num tom informal: \"I'll be ten minutes late on Friday, start without me and I'll catch up.\""],
  ["constraint", "generalist", "Give me exactly three names for a neighbourhood bakery. Each must be two words, and none may contain the word bread or bakery. Just the list."],
  ["code-explain", "generalist", `What does this do, and what goes wrong if two items have the ids 0 and "0"?\n\n${CODE}`],
  ["unknown", "generalist", "What was the closing price of Northwind Robotics stock yesterday?"],
  ["compare", "generalist", "I can take the 07:10 flight (arrives 09:05, 89 euros, no bag) or the 11:30 (arrives 13:20, 64 euros, bag included). My meeting is at 14:00, 40 minutes from the airport, and I need a bag. Which should I take and why, in three sentences at most."],
  ["two-turn", "generalist", "I'm planning a dinner for six. Two are vegetarian and one cannot eat nuts. Suggest a main course that works for everyone.", "Now a dessert for the same people."],
  ["routed-chat", null, "explain in plain words what a mortgage amortisation schedule is"],
  ["routed-ambiguous", null, "remind me how compound interest works and give one worked example with 1,000 at 5 percent for 3 years"],
];

const registry = await buildRegistry();
const out = [];
const only = (process.argv[3] ?? "").split(",").filter(Boolean);
for (const [id, agent, ...turns] of TASKS) {
  if (only.length && !only.includes(id)) continue;
  const sid = store.startSession();
  const history = [];
  const row = { id, agent, turns: [] };
  for (const text of turns) {
    const t0 = performance.now();
    const tools = [];
    let reply = "", route = agent, error = null;
    try {
      const r = await runTurn(text, history, registry, sid, { onRoute: (s) => (route = s), onToolStart: (n, a) => tools.push({ name: n, args: a }) }, agent ? { specialist: agent } : {});
      reply = r.reply; route = route ?? r.specialist;
    } catch (err) { error = String(err?.message ?? err).slice(0, 300); }
    row.turns.push({ text, reply, route, tools, error, seconds: Math.round((performance.now() - t0) / 100) / 10 });
    console.log(`${id} -> ${route} | ${tools.map((t) => t.name).join(",") || "-"} | ${row.turns.at(-1).seconds}s | ${reply.replace(/\s+/g, " ").slice(0, 80)}`);
  }
  out.push(row);
  writeFileSync(outFile, JSON.stringify(out, null, 2));
}
process.exit(0);
