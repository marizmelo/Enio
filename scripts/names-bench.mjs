#!/usr/bin/env node
/**
 * Measure the check that withdraws a research answer for naming things its
 * sources never mention (namesWithoutEvidence in src/grounding.ts).
 *
 *   npm run build
 *   node scripts/names-bench.mjs snapshot   # your stored research turns -> the bench folder
 *   node scripts/names-bench.mjs collect    # run QUESTIONS below in an isolated data folder
 *   node scripts/names-bench.mjs collect-confirm   # the same for CONFIRM, a set to check a finished change
 *   node scripts/names-bench.mjs files      # one file per turn, for labelling
 *   node scripts/names-bench.mjs            # score the check against the labels
 *
 * The turns and their labels are NOT in the repository. A turn is the
 * user's question, the pages the tools returned and the model's reply:
 * the first is private and the second is other people's writing. They live
 * in <data dir>/bench/names/, which is ~/.enio/bench/names unless
 * ENIO_DATA_DIR says otherwise, and this script is how to build them again.
 *
 * Two sets, with different standing:
 *   stored   research turns already in the local database. The rule was
 *            chosen on these.
 *   fresh    the QUESTIONS below, run once through the researcher. Written
 *            before any rule was measured and never tuned against.
 * `collect` uses its own data folder, so nothing it asks reaches the real
 * memory or History. It needs the model server running and takes about a
 * minute a question.
 *
 * Labels are <set>-labels.json: per turn, `withdraw` (does the reply state
 * as fact something material that the evidence does not hold) and, per
 * unfound span, "supported", "invented" or "not_a_claim". The November 2026
 * labels were three independent readers per turn, each required to quote
 * the evidence for every "supported"; the rule they followed is LABELLING
 * below. A reader's own knowledge never decides a label: only the evidence.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = (f) => pathToFileURL(join(repo, "dist", f)).href;
if (!existsSync(join(repo, "dist", "grounding.js"))) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(1);
}
const dataDir = process.env.ENIO_DATA_DIR ?? join(homedir(), ".enio");
const bench = join(dataDir, "bench", "names");
mkdirSync(bench, { recursive: true });

export const QUESTIONS = [
  "who won the last formula 1 race",
  "what are the best coffee shops in porto",
  "which electric cars have the longest range right now",
  "what happened in the latest champions league matches",
  "best noise cancelling headphones under 200 dollars",
  "who is the current ceo of intel and when did they start",
  "what are the top rated restaurants in recife",
  "latest news about the artemis moon mission",
  "which countries joined the european union most recently",
  "what were the biggest tech layoffs this year",
  "best hiking boots for wide feet",
  "who won the latest nobel prize in literature",
  "what is the newest iphone and what does it cost",
  "best architecture schools in brazil",
  "what happened at the last g20 summit",
  "which streaming service has the most subscribers",
  "quais são os melhores restaurantes de lisboa",
  "quem ganhou o campeonato brasileiro este ano",
  "what are the main features of the latest android version",
  "best budget mechanical keyboards",
  "who are the candidates in the next french presidential election",
  "what is the tallest building under construction right now",
  "what are the best museums in sao paulo",
  "which companies make humanoid robots",
  "what did the latest ipcc report say",
  "who won the most recent super bowl and what was the score",
  "best project management tools for small teams",
  "what are the newest james webb telescope discoveries",
  "melhores praias do nordeste do brasil",
  "what are the best local llm models for a macbook",
  "who is the manager of sporting cp and how is the team doing",
  "what are the most popular javascript frameworks this year",
  "latest news on the boeing starliner",
  "best co-working spaces in lisbon",
  "what were the highest grossing films this year",
  "who won the last wimbledon men's final",
];

/**
 * A third set, run once after the rule, the policy and the wording were
 * fixed, through the whole turn as shipped. Nothing was changed after it.
 */
export const CONFIRM = [
  "who won the latest moto gp race",
  "what are the best bakeries in lisbon",
  "which phones have the best battery life this year",
  "what happened in the latest nba games",
  "best robot vacuums under 300 dollars",
  "who is the current president of argentina and when did they take office",
  "what are the top rated hotels in salvador bahia",
  "latest news about the international space station",
  "which countries use the euro",
  "what were the biggest company acquisitions this year",
  "best running shoes for flat feet",
  "who won the latest booker prize",
  "what is the newest playstation and what does it cost",
  "best engineering universities in portugal",
  "what happened at the last cop climate summit",
  "which airline carries the most passengers",
  "quais são os melhores museus do porto",
  "quem ganhou a taça de portugal este ano",
  "what are the main features of the latest macos",
  "best budget 4k monitors",
  "who are the candidates in the next brazilian presidential election",
  "what is the longest bridge in the world",
  "what are the best parks in rio de janeiro",
  "which companies make electric trucks",
];

export const LABELLING = `
For each span, against the evidence only:
  supported    the evidence states the same thing in other words: another
               dash, word order, ending or possessive, a synonym for a
               non-name word, an abbreviation the evidence makes clear, a
               translation, or a name whose parts the evidence shows
               together about the same thing. Quote the evidence.
  invented     a name, entity, number, date, score or event the evidence
               does not state. A composite is invented if any factual part
               is missing. Background added from memory counts.
  not_a_claim  a heading, a sentence fragment, plain emphasis.
For the turn: withdraw is true when the whole reply states as fact
something absent from the evidence that the answer depends on or that
would mislead: a result, a winner, a product offered as the answer, a
specification, a date or number to act on, or an account of what happened
that the evidence contradicts. Gloss and common background do not count.`;

/** Researcher turns that ran a web tool: the evidence, and the first reply written from it. */
function exportTurns(db, out) {
  const sql = `
select t.id, t.question, t.started_at, t.reply as final_reply,
  (select group_concat(coalesce(output,''), char(10)) from turn_steps s where s.turn_id=t.id and s.kind='tool') as evidence,
  (select raw_content from turn_steps s where s.turn_id=t.id and s.kind='model' and coalesce(raw_content,'')<>''
     and s.seq > (select min(seq) from turn_steps x where x.turn_id=t.id and x.kind='tool') order by s.seq limit 1) as first_reply
from turns t
where t.specialist='researcher'
  and exists (select 1 from turn_steps s where s.turn_id=t.id and s.kind='tool' and s.name like 'web%')
order by t.id;`;
  // The sqlite3 command, not the app's own driver: opening the live
  // database through the app's module would run its migrations.
  const json = execFileSync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8", maxBuffer: 1 << 28 });
  writeFileSync(out, json || "[]");
  return JSON.parse(json || "[]").length;
}

const load = (set) => {
  const file = join(bench, `${set}-turns.json`);
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf8"))
    .filter((t) => t.first_reply && t.evidence)
    .map((t) => ({ ...t, key: `${set}-${t.id}` }));
};

/** The strictest reading — every bold span and Title Case run, wanted as typed — so every span any rule could name gets a label. */
function unfound(reply, evidence, question) {
  const marks = (t) => t.replace(/[‐-―−]/g, "-").replace(/[‘’]/g, "'");
  const hay = marks(evidence + "\n" + question).toLowerCase().replace(/\s+/g, " ");
  const out = new Set();
  const add = (text) => {
    const name = marks(text).replace(/[*_`"“”().,:;!?]/g, " ").replace(/\s+/g, " ").trim();
    if (name.length < 3 || /^[A-Z][a-z]*$/.test(name)) return;
    if (!hay.includes(name.toLowerCase())) out.add(name);
  };
  for (const m of reply.matchAll(/\*\*([^*\n]{3,80})\*\*/g)) add(m[1].trim());
  for (const m of marks(reply).matchAll(/(?:\p{Lu}[\p{L}'’-]+)(?:\s+(?:de|da|do|dos|das|e|of|and|the|&|\p{Lu}[\p{L}'’-]+)){1,6}/gu)) {
    if (m[0].trim().split(/\s+/).filter((w) => /^\p{Lu}/u.test(w)).length >= 2) add(m[0].trim());
  }
  return [...out];
}

const mode = process.argv[2] ?? "score";

if (mode === "snapshot") {
  const n = exportTurns(join(dataDir, "memory.db"), join(bench, "stored-turns.json"));
  console.log(`${n} research turns copied to ${join(bench, "stored-turns.json")}`);
} else if (mode === "collect" || mode === "collect-confirm") {
  const set = mode === "collect" ? "fresh" : "confirm";
  const root = join(bench, `collect-env-${set}`);
  process.env.ENIO_DATA_DIR = join(root, "data");
  process.env.ENIO_BUILTIN_SKILLS = join(root, "skills");
  process.env.ENIO_WORKSPACE = join(root, "workspace");
  process.env.ENIO_MCP_CONFIG = join(root, "no-mcp.json");
  mkdirSync(join(root, "machine"), { recursive: true });
  // The isolated folder asks the same model the app is using. Its choice
  // and its address live in the machine-state folder, which is the real
  // ~/.enio whatever ENIO_DATA_DIR says, and is the one this run leaves.
  const chosen = join(process.env.ENIO_MACHINE_STATE_DIR ?? join(homedir(), ".enio"), "model.json");
  if (existsSync(chosen)) writeFileSync(join(root, "machine", "model.json"), readFileSync(chosen));
  process.env.ENIO_MACHINE_STATE_DIR = join(root, "machine");
  const { runTurn } = await import(dist("agent.js"));
  const { buildRegistry } = await import(dist("tools/index.js"));
  const store = await import(dist("memory/store.js"));
  const registry = await buildRegistry();
  for (const q of set === "fresh" ? QUESTIONS : CONFIRM) {
    const started = Date.now();
    try {
      await runTurn(q, [], registry, store.startSession(), {}, { specialist: "researcher" });
      console.log(`${Math.round((Date.now() - started) / 1000)}s  ${q}`);
    } catch (err) {
      console.log(`failed  ${q}: ${err?.message ?? err}`);
    }
  }
  const n = exportTurns(join(root, "data", "memory.db"), join(bench, `${set}-turns.json`));
  console.log(`${n} turns written to ${join(bench, `${set}-turns.json`)}`);
  process.exit(0);
} else if (mode === "files") {
  const dir = join(bench, "to-label");
  mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const set of ["stored", "fresh"]) {
    for (const t of load(set)) {
      writeFileSync(
        join(dir, `${t.key}.json`),
        JSON.stringify({ id: t.key, question: t.question, reply: t.first_reply, spans: unfound(t.first_reply, t.evidence, t.question), evidence: t.evidence }, null, 1),
      );
      n++;
    }
  }
  console.log(`${n} files in ${dir}\n${LABELLING}`);
} else {
  const { namesWithoutEvidence } = await import(dist("grounding.js"));
  const { withdrawsForNames } = await import(dist("grounding.js"));
  let any = false;
  for (const set of ["stored", "fresh"]) {
    const turns = load(set);
    const labelFile = join(bench, `${set}-labels.json`);
    if (turns.length === 0 || !existsSync(labelFile)) continue;
    any = true;
    const labels = JSON.parse(readFileSync(labelFile, "utf8"));
    const rows = {
      "as typed (strictest reading)": (t) => unfound(t.first_reply, t.evidence, t.question),
      "word by word (shipped)": (t) => namesWithoutEvidence(t.first_reply, [t.evidence], t.question),
    };
    const labelled = turns.filter((t) => labels[t.key]);
    const bad = labelled.filter((t) => labels[t.key].withdraw === true).length;
    console.log(`\n${set}: ${labelled.length} labelled turns, ${bad} with a material invention, ${labelled.length - bad} without`);
    console.log("  " + "rule".padEnd(30) + "policy".padEnd(22) + "withdrawn  of bad  of clean  no invented name | named  invented  not");
    for (const [rule, names] of Object.entries(rows)) {
      for (const [policy, fires] of [["shipped policy", withdrawsForNames], ["two or more names", (u) => u.length >= 2]]) {
        let w = 0, wBad = 0, wClean = 0, wrong = 0, named = 0, invented = 0, unlabelled = 0;
        for (const t of labelled) {
          const u = names(t);
          if (!fires(u)) continue;
          w++;
          if (labels[t.key].withdraw === true) wBad++;
          else if (labels[t.key].withdraw === false) wClean++;
          const hits = u.filter((s) => labels[t.key].spans?.[s]?.label === "invented").length;
          unlabelled += u.filter((s) => !labels[t.key].spans?.[s]).length;
          named += u.length;
          invented += hits;
          if (hits === 0) wrong++;
        }
        console.log(
          "  " + rule.padEnd(30) + policy.padEnd(22) + String(w).padStart(9) + String(wBad).padStart(8) + String(wClean).padStart(10) +
            String(wrong).padStart(18) + " |" + String(named).padStart(6) + String(invented).padStart(10) + String(named - invented - unlabelled).padStart(5) +
            (unlabelled ? `   (${unlabelled} with no label)` : ""),
        );
      }
    }
  }
  if (!any) console.log(`No turns with labels in ${bench}. Run snapshot or collect, then files, then label.`);
}
