#!/usr/bin/env node
/**
 * Measure the step that completes a follow-up question from its thread
 * before the researcher's seeded search (src/followup.ts).
 *
 *   npm run build && node scripts/followup-bench.mjs    # needs the model server
 *
 * Two sets, written before the step was run on anything. FOLLOW_UPS are
 * questions that cannot be searched alone: each lists words the query has
 * to gain from the thread. FRESH are questions asked in a thread about
 * something else: the query has to stay the user's own words. The second
 * set is the one that decides whether this ships, because a wrong
 * completion there searches for a mixture of two subjects, which is worse
 * than the bare question it replaces.
 *
 * None of these threads appears in the step's prompt examples.
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(repo, "dist");
if (!existsSync(join(dist, "followup.js"))) {
  console.error("dist/followup.js is missing — run `npm run build` first.");
  process.exit(1);
}
const { seedQuery } = await import(pathToFileURL(join(dist, "followup.js")).href);

/** [earlier question, last answer, new question, words the query must gain] */
const FOLLOW_UPS = [
  ["weren't there games for the Brazilian Cup yesterday?", "No games took place for the Brazilian Cup on 25 November 2026. The final is set for 6 December between Palmeiras and Grêmio.", "What happened to Flamengo?", ["cup"]],
  ["who won the tour de france this year", "Tadej Pogačar won the 2026 Tour de France, his fifth title.", "who came second?", ["tour", "france"]],
  ["what is the population of portugal", "Portugal has about 10.6 million people.", "and of spain?", ["population"]],
  ["when is the next spacex starship launch", "The next Starship flight is planned for early December from Starbase, Texas.", "what payload will it carry?", ["starship"]],
  ["tell me about the new iphone", "The iPhone 18 Pro was announced in September with a larger battery and a new camera.", "how much is it?", ["iphone"]],
  ["what's the weather in porto this weekend", "Porto will be rainy on Saturday and clear on Sunday, around 15 degrees.", "what about braga?", ["weather"]],
  ["who is the president of brazil", "Luiz Inácio Lula da Silva is the president of Brazil.", "when does his term end?", ["brazil"]],
  ["what did the european central bank decide this month", "The European Central Bank kept its deposit rate at 2 percent.", "what did analysts expect?", ["bank"]],
  ["is the new zelda game out yet", "Yes, the new Zelda game came out for the Switch 2 in October.", "what are the reviews like?", ["zelda"]],
  ["how did benfica do last night", "Benfica beat Sporting 2-1 in the Lisbon derby.", "who scored the goals?", ["benfica"]],
  ["what is the latest macbook air", "The latest MacBook Air uses the M5 chip and comes in 13 and 15 inch sizes.", "is the battery better than before?", ["macbook"]],
  ["what's happening with the writers strike in hollywood", "The writers strike in Hollywood entered its third week with talks stalled.", "which shows are affected?", ["strike"]],
  ["who won the nobel prize in physics this year", "The 2026 Nobel Prize in Physics went to three researchers for work on quantum sensors.", "what are their names?", ["nobel", "physics"]],
  ["what's the price of bitcoin right now", "Bitcoin is trading near 94,000 dollars.", "and ethereum?", ["price"]],
  ["are there train strikes in france next week", "Yes, rail unions in France called a strike for Tuesday and Wednesday.", "will the eurostar run?", ["strike"]],
  ["what was the score in the lakers game", "The Lakers beat the Celtics 112-108.", "who was the top scorer?", ["lakers"]],
  ["what is the new tesla model called", "Tesla's new compact car is called the Model 2.", "when does it go on sale in europe?", ["tesla"]],
  ["did the uk election happen yet", "The UK general election is scheduled for May 2029; none has happened this year.", "who is ahead in the polls?", ["election"]],
  ["what is the tallest building in the world", "The Jeddah Tower in Saudi Arabia became the tallest building in 2026.", "how tall is it?", ["tower"]],
  ["what's new in python 3.15", "Python 3.15 adds lazy imports and a faster interpreter loop.", "when was it released?", ["python"]],
];

/** [earlier question, last answer, new question] — the query must stay the new question. */
const FRESH = [
  ["weren't there games for the Brazilian Cup yesterday?", "No games took place for the Brazilian Cup on 25 November 2026.", "what's the weather in lisbon tomorrow"],
  ["who won the tour de france this year", "Tadej Pogačar won the 2026 Tour de France.", "how much is a train ticket from porto to braga"],
  ["what is the population of portugal", "Portugal has about 10.6 million people.", "who won the champions league final"],
  ["when is the next spacex starship launch", "The next Starship flight is planned for early December.", "find me a good recipe for shakshuka"],
  ["tell me about the new iphone", "The iPhone 18 Pro was announced in September.", "what did the fed decide about rates this week"],
  ["what's the weather in porto this weekend", "Porto will be rainy on Saturday and clear on Sunday.", "who is the prime minister of portugal right now"],
  ["who is the president of brazil", "Luiz Inácio Lula da Silva is the president of Brazil.", "what is the price of gold today"],
  ["what did the european central bank decide this month", "The European Central Bank kept its deposit rate at 2 percent.", "who won the oscar for best picture"],
  ["is the new zelda game out yet", "Yes, it came out for the Switch 2 in October.", "what time does the louvre open on sundays"],
  ["how did benfica do last night", "Benfica beat Sporting 2-1 in the Lisbon derby.", "what is the latest news on the eu ai act"],
  ["what is the latest macbook air", "The latest MacBook Air uses the M5 chip.", "how many people live in tokyo"],
  ["what's happening with the writers strike in hollywood", "The strike entered its third week.", "what is the exchange rate from euros to dollars"],
  ["who won the nobel prize in physics this year", "It went to three researchers for work on quantum sensors.", "when does daylight saving time end in europe"],
  ["what's the price of bitcoin right now", "Bitcoin is trading near 94,000 dollars.", "who directed the new dune film"],
  ["are there train strikes in france next week", "Yes, on Tuesday and Wednesday.", "what is the best budget android phone"],
  ["what was the score in the lakers game", "The Lakers beat the Celtics 112-108.", "how do I renew a portuguese passport"],
  ["what is the new tesla model called", "Tesla's new compact car is called the Model 2.", "what happened in the earthquake in japan"],
  ["did the uk election happen yet", "The UK general election is scheduled for May 2029.", "what are the symptoms of the new flu strain"],
  ["what is the tallest building in the world", "The Jeddah Tower in Saudi Arabia.", "who is playing at glastonbury next year"],
  ["what's new in python 3.15", "Python 3.15 adds lazy imports.", "what is the cheapest flight from lisbon to madrid in june"],
];

const thread = (q, a, next) => [
  { role: "system", content: "x" },
  { role: "user", content: q },
  { role: "assistant", content: a },
  { role: "user", content: next },
];
const has = (query, word) => query.toLowerCase().split(/[^a-z0-9]+/).includes(word);

const times = [];
let gained = 0;
console.log("Follow-ups: the query should gain the thread's subject\n");
for (const [q, a, next, need] of FOLLOW_UPS) {
  const t = Date.now();
  const out = await seedQuery(next, thread(q, a, next));
  times.push(Date.now() - t);
  const ok = need.every((w) => has(out.query, w));
  if (ok) gained++;
  console.log(`${ok ? "ok  " : "MISS"} ${next}\n       -> ${out.query}${out.via === "words" ? "   (unchanged)" : ""}`);
}

let kept = 0;
console.log("\nFresh questions: the query should stay as typed\n");
for (const [q, a, next] of FRESH) {
  const t = Date.now();
  const out = await seedQuery(next, thread(q, a, next));
  times.push(Date.now() - t);
  const ok = out.via === "words";
  if (ok) kept++;
  console.log(`${ok ? "ok  " : "MIXED"} ${next}${ok ? "" : `\n       -> ${out.query}`}`);
}

times.sort((x, y) => x - y);
console.log(`\nfollow-ups completed: ${gained} of ${FOLLOW_UPS.length}`);
console.log(`fresh questions left alone: ${kept} of ${FRESH.length}`);
console.log(`median ${times[Math.floor(times.length / 2)]} ms, slowest ${times.at(-1)} ms`);
