#!/usr/bin/env node
/**
 * Train a LoRA adapter for one specialist, over the model this machine is
 * actually serving, and install it only if it beats the base model on that
 * specialist's held-out tasks.
 *
 * Usage:
 *   node scripts/train-adapter.mjs coder [--iters 400] [--batch-size 2]
 *        [--num-layers 8] [--seeds 7,11] [--stop-weight N] [--from-traces]
 *        [--eval-only] [--no-install]
 *   node scripts/train-adapter.mjs coder --behavior-gate [--only voice=terse,register=expert]
 *
 * The pipeline: authored scenarios (scripts/adapter-data/<name>.mjs), plus
 * optionally the user's own successful turns mined from the trace store, are
 * rendered with the specialist's real system prompt and real tool
 * definitions — the trained form must be the served form — then handed to
 * mlx_lm.lora in the runtime venv. The result lands in a staging directory;
 * a golden-task eval (temperature 0, base vs adapter) decides whether it is
 * promoted into the adapter registry the server actually reads
 * (~/.enio/adapters/<base-model-slug>/<name>/). An adapter that does not
 * beat base stays staged, because installing it would make every routed
 * turn slightly worse in a way nothing visible reports.
 *
 * Run it from the repo root after `npm run build` — it reuses enio's own
 * modules from dist/ rather than duplicating prompts or schemas here.
 */

import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(repo, "dist");
if (!existsSync(join(dist, "model-settings.js"))) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(1);
}

const distImport = (p) => import(pathToFileURL(join(dist, p)).href);

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--")) ?? "coder";
const flag = (f) => args.includes(f);
const opt = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const dataModulePath = join(repo, "scripts", "adapter-data", `${name}.mjs`);
if (!existsSync(dataModulePath)) {
  console.error(`No scenario module for "${name}" — expected ${dataModulePath}`);
  process.exit(1);
}

const { config } = await distImport("config.js");
const { currentModelId } = await distImport("model-settings.js");
const { getSpecialist } = await distImport("specialists.js");
const { SHARED_RULES } = await distImport("agent.js");
const { toWireTool } = await distImport("types.js");
const { venvPythonPath } = await distImport("runtime.js");
const { fsTools } = await distImport("tools/fs.js");
const { shellTools } = await distImport("tools/shell.js");
const { searchTools } = await distImport("tools/search.js");
const { skillTools } = await distImport("tools/skills.js");
const scenarioModule = await import(pathToFileURL(dataModulePath).href);

const { trainerFor, mineableTurns, splitDataset, abstains } = await distImport("adapters.js");
const trainer = trainerFor();
if (!trainer.available && !flag("--eval-only")) {
  console.error(trainer.reason);
  process.exit(1);
}

const modelId = currentModelId();
if (modelId === "maple") {
  // Maple is a ternary-weight MoE the LoRA tuner has never been shown to
  // handle (DECISIONS.md). Training against it would burn an hour to produce
  // a confusing failure; say so instead.
  console.error("The served model is Maple; train adapters against a standard MLX model (switch models first).");
  process.exit(1);
}

const specialist = getSpecialist(name);
if (!specialist || specialist.name !== name) {
  console.error(`No specialist named "${name}".`);
  process.exit(1);
}

const slug = modelId.replace(/\//g, "--");
const adapterDir = join(config.machineStateDir, "adapters", slug, name);
const stagingDir = join(adapterDir, "staging");
const dataDir = join(adapterDir, "data");
mkdirSync(dataDir, { recursive: true });

/* ------------------------------------------------------------------ */
/* The exact material the specialist serves under.                     */

const systemPrompt = `${specialist.systemPrompt}\n\n${SHARED_RULES}`;
const toolPool = [...fsTools, ...shellTools, ...searchTools, ...skillTools];
const wireTools = specialist.tools
  .map((t) => toolPool.find((tool) => tool.name === t))
  .filter(Boolean)
  .map(toWireTool);
if (wireTools.length !== specialist.tools.length) {
  const missing = specialist.tools.filter((t) => !toolPool.some((x) => x.name === t));
  console.error(`Tool definitions not found for: ${missing.join(", ")} — extend the tool pool in this script.`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Dataset                                                             */

function buildRows() {
  // One row per assistant step, not per conversation. The trainer's
  // --mask-prompt treats only the FINAL assistant message as the completion,
  // so a whole conversation as one row trains nothing but its closing prose —
  // the first run of this script produced an adapter that had learned exactly
  // that and stopped calling tools altogether (3/15 against base's 12/15;
  // the gate caught it). Exploding at every assistant message makes each
  // tool-call decision, and the final reply, its own trained target.
  const conversations = scenarioModule.scenarios().map((messages) => ({ messages, mined: false }));
  if (flag("--from-traces")) {
    conversations.push(...minedConversations().map((messages) => ({ messages, mined: true })));
  }

  // The honest stop — a reply, not a call, right after a tool came back
  // empty — is the one form four gated adapters kept losing: tool choice
  // rose every run while "not here" after a miss fell. Exploding a
  // conversation per assistant step gives every look a row of its own and
  // the stop one row; --stop-weight N duplicates the stop rows. Off by
  // default: the one run that tried it (×2) scored 15/19 and 2/4 where the
  // run before scored 18/19 and 3/4 — no evidence for it, and five runs of
  // abstention at 1, 3, 0, 3, 2 out of 4 say the four-probe gate cannot
  // tell a lever from training noise. Kept as a switch for when it can.
  const MISS = /^(Error: no file|No matches for|fatal:|zsh: command not found|old_string was not found)/;
  const stopWeight = Math.max(1, Number(opt("--stop-weight", "1")) || 1);
  let stops = 0;
  const rows = [];
  for (const { messages, mined } of conversations) {
    const full = [{ role: "system", content: systemPrompt }, ...messages];
    for (let i = 0; i < full.length; i++) {
      if (full[i].role !== "assistant") continue;
      const row = { messages: full.slice(0, i + 1), tools: wireTools };
      const prev = full[i - 1];
      const honestStop = !full[i].tool_calls && prev?.role === "tool" && MISS.test(prev.content ?? "");
      const copies = honestStop && !mined ? stopWeight : 1;
      if (honestStop && !mined) stops++;
      for (let c = 0; c < copies; c++) rows.push({ row, mined, chars: JSON.stringify(row).length });
    }
  }
  if (stopWeight > 1) console.log(`honest-stop rows: ${stops}, weighted ×${stopWeight}`);
  // Valid from the curriculum only, over-length rows dropped: see splitDataset.
  return splitDataset(rows);
}

/** The user's own successful turns for this specialist, rebuilt as clean
 *  conversations: question, the tool calls that worked, the reply. Turns
 *  with errors — or where the harness had to repair or scavenge — are
 *  excluded: they are records of the very form the adapter trains away. */
function minedConversations() {
  try {
    // The same list `enio train material` shows: clean, produced by this
    // base, not struck by the user. A turn from another model is not an
    // example of what this base should do.
    const turns = mineableTurns(name).slice(0, 200);
    const db = requireDb.getDb();
    const stepsFor = db.prepare(
      `SELECT kind, name, args, output FROM turn_steps WHERE turn_id = ? ORDER BY seq`,
    );
    const rows = [];
    let callId = 1000;
    for (const t of turns) {
      const steps = stepsFor.all(t.id);
      const toolSteps = steps.filter((s) => s.kind === "tool" && s.name && s.args && s.output);
      if (toolSteps.length === 0 || toolSteps.length > 6) continue;
      if (toolSteps.some((s) => !specialist.tools.includes(s.name))) continue;
      // No system message here — buildRows() prepends it when it explodes
      // the conversation into per-step rows.
      const messages = [{ role: "user", content: t.question }];
      let ok = true;
      for (const s of toolSteps) {
        try {
          JSON.parse(s.args);
        } catch {
          ok = false;
          break;
        }
        callId += 1;
        messages.push(
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: `call_${callId}`, type: "function", function: { name: s.name, arguments: s.args } },
            ],
          },
          { role: "tool", tool_call_id: `call_${callId}`, content: s.output.slice(0, 4000) },
        );
      }
      if (!ok) continue;
      messages.push({ role: "assistant", content: t.reply });
      rows.push(messages);
    }
    console.log(`mined ${rows.length} clean ${name} turns from traces (produced by ${modelId})`);
    return rows;
  } catch (err) {
    console.warn(`trace mining skipped: ${err?.message ?? err}`);
    return [];
  }
}
// Loaded lazily so a missing/locked trace db degrades to synthetic-only.
const requireDb = flag("--from-traces") ? await distImport("memory/db.js") : {};

/* ------------------------------------------------------------------ */
/* Training                                                            */

/**
 * A training-only view of the model: the real weights, but a chat template
 * that renders assistant turns WITHOUT the `<think>\n\n</think>\n\n` prefix
 * the shipped template puts on the final assistant message.
 *
 * That prefix is exactly where the completion starts, so training against
 * the shipped template teaches every reply to open with a think block — and
 * a rank-8 adapter reproduces the rare `</think>` token unreliably. One
 * garbled close tag sends the entire answer down the server's reasoning
 * channel, which the harness correctly reads as "no reply": every final
 * answer of the first installed adapter failed exactly this way in the app.
 * At serving the generation prompt is a bare assistant header, so training
 * without the prefix is the faithful render, not a deviation.
 */
function trainModelDir() {
  const src = execFileSync(
    venvPythonPath(),
    ["-c", `from huggingface_hub import snapshot_download; print(snapshot_download(${JSON.stringify(modelId)}))`],
    { encoding: "utf8" },
  ).trim();
  const dir = join(adapterDir, "train-model");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(src)) {
    symlinkSync(join(src, f), join(dir, f));
  }
  const templatePath = join(dir, "chat_template.jinja");
  const template = readFileSync(join(src, "chat_template.jinja"), "utf8");
  const thinkRender =
    "{{- '<|im_start|>' + message.role + '\\n<think>\\n' + reasoning_content.strip('\\n') + '\\n</think>\\n\\n' + content.lstrip('\\n') }}";
  if (!template.includes(thinkRender)) {
    throw new Error(
      "The model's chat template does not contain the expected think-prefix render — " +
        "inspect chat_template.jinja and update trainModelDir() before training against it.",
    );
  }
  rmSync(templatePath);
  writeFileSync(
    templatePath,
    template.replace(thinkRender, "{{- '<|im_start|>' + message.role + '\\n' + content.lstrip('\\n') }}"),
  );
  return dir;
}

function writeDataset() {
  const { train: trainRows, valid, dropped, mined } = buildRows();
  writeFileSync(join(dataDir, "train.jsonl"), trainRows.map((r) => JSON.stringify(r) + "\n").join(""));
  writeFileSync(join(dataDir, "valid.jsonl"), valid.map((r) => JSON.stringify(r) + "\n").join(""));
  console.log(
    `dataset: ${trainRows.length} train (${mined} from traces) / ${valid.length} valid (curriculum only)` +
      (dropped ? ` · ${dropped} over-length rows dropped` : "") +
      ` → ${dataDir}`,
  );
}

async function train(seed, outDir) {
  const py = venvPythonPath();
  const cmd = [
    "-m", "mlx_lm", "lora",
    "--model", trainModelDir(),
    "--train",
    "--data", dataDir,
    "--mask-prompt",
    "--iters", opt("--iters", "200"),
    "--batch-size", opt("--batch-size", "2"),
    "--num-layers", opt("--num-layers", "8"),
    "--learning-rate", opt("--learning-rate", "5e-5"),
    "--max-seq-length", "3072",
    "--adapter-path", outDir,
    "--seed", String(seed),
  ];
  console.log(`training (seed ${seed}): ${py} ${cmd.join(" ")}`);
  await new Promise((resolve, reject) => {
    const child = spawn(py, cmd, { stdio: "inherit" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`trainer exited ${code}`))));
    child.on("error", reject);
  });
}

/* ------------------------------------------------------------------ */
/* Eval: held-out tasks, base vs staged adapter, temperature 0.        */

async function askOnce(task, adapter, systemSuffix = "") {
  // A task is either a fresh prompt or a mid-flight conversation (a
  // recovery probe: the tool just failed, score the next move). The suffix
  // is the behaviour gate's: a personality rendering appended where the
  // turn loop appends it, after the role material.
  const turn = task.messages ?? [{ role: "user", content: task.prompt }];
  const system = systemSuffix ? `${systemPrompt}\n\n${systemSuffix}` : systemPrompt;
  const body = {
    model: modelId,
    messages: [{ role: "system", content: system }, ...turn],
    tools: wireTools,
    // Temperature 0 for a deterministic comparison, but otherwise the body
    // mirrors what the agent actually sends — no chat_template_kwargs. The
    // first installed adapter passed an eval that set enable_thinking:false
    // while the app does not; the gate must test the served reality.
    temperature: 0,
    max_tokens: 400,
    stream: false,
  };
  if (adapter) body.adapters = adapter;
  const res = await fetch(`${config.modelBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`model server returned ${res.status}`);
  const out = await res.json();
  return out.choices?.[0]?.message ?? {};
}

async function evaluate(label, adapter, systemSuffix = "", quiet = false) {
  const tasks = scenarioModule.goldenTasks();
  let toolRight = 0;
  let jsonValid = 0;
  let jsonTotal = 0;
  let abstainRight = 0;
  let abstainTotal = 0;
  const misses = [];
  // Per-task detail rides along for the behaviour gate, which compares
  // verdicts task by task: an aggregate that stays level can hide a swap.
  const detail = [];
  for (const task of tasks) {
    const msg = await askOnce(task, adapter, systemSuffix);
    const calls = msg.tool_calls ?? [];
    const first = calls[0]?.function?.name ?? null;
    const content = typeof msg.content === "string" ? msg.content : "";
    detail.push({
      prompt: task.prompt,
      expect: task.expect,
      first,
      spoke: content.trim().length > 0,
      content,
      abstained: abstains(msg.content, calls.length > 0),
      calls: calls.length,
      jsonOk: calls.filter((c) => { try { JSON.parse(c.function?.arguments ?? ""); return true; } catch { return false; } }).length,
    });
    // A "no call" verdict must also be a real answer: text that arrived on
    // the reasoning channel instead of content is an empty reply to the
    // harness. The first installed adapter failed the app exactly this way
    // while acing a tool-choice-only version of this eval.
    const spoke = typeof msg.content === "string" && msg.content.trim().length > 0;
    if (task.expect === "abstain") {
      // Humility is its own score, not folded into tool choice: an adapter
      // that answers every not-on-the-map question with a confident
      // invention would otherwise ace the gate.
      abstainTotal += 1;
      if (abstains(msg.content, calls.length > 0)) abstainRight += 1;
      else misses.push(`  "${task.prompt}" → ${first ? `${first} (kept looking)` : `answered as if it knew: ${String(msg.content ?? "").slice(0, 60).replace(/\s+/g, " ")}…`} (wanted an honest "not here")`);
      continue;
    }
    if (first === task.expect && (task.expect !== null || spoke)) toolRight += 1;
    else if (first === task.expect) misses.push(`  "${task.prompt}" → answer landed in reasoning, not content`);
    else misses.push(`  "${task.prompt}" → ${first ?? "no call"} (wanted ${task.expect ?? "no call"})`);
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
  const total = tasks.length - abstainTotal;
  const score = { toolRight, total, jsonValid, jsonTotal, abstainRight, abstainTotal };
  if (!quiet) {
    console.log(
      `${label}: tool choice ${toolRight}/${total}, ` +
        `valid JSON ${jsonValid}/${jsonTotal || 0}, abstains ${abstainRight}/${abstainTotal}`,
    );
    if (misses.length) console.log(misses.join("\n"));
  }
  return { score, detail };
}

/**
 * The behaviour gate: does a personality rendering change HOW the model
 * answers without changing WHAT it does? Baseline plus every non-neutral
 * rendering, over the same golden tasks, at temperature 0.
 *
 * The "what" half must be identical per task, not in aggregate — the tool
 * chosen first, whether a no-tool task still spoke, the abstention verdict,
 * JSON validity. The "how" half must move where the line asks it to, or
 * the line is noise and should not ship: terse lowers length, answer-only
 * lowers follow-up endings, offer-follow-ups raises them, matter-of-fact
 * removes warm openers. Renderings are imported from dist so the text
 * tested is the text served.
 */
async function behaviorGate() {
  const { gateRenderings } = await distImport("personality.js");
  const { adapterPathFor } = await distImport("model-settings.js");
  const adapter = adapterPathFor(name);
  console.log(`behaviour gate for ${name} on ${adapter ? "the installed adapter" : "the base model"} (${modelId})\n`);

  const whatKey = (d) =>
    d.map((t) =>
      t.expect === "abstain"
        ? `${t.prompt}→${t.abstained ? "abstain" : "answer"}`
        : `${t.prompt}→${t.first ?? "-"}${t.expect === null && !t.spoke ? "/silent" : ""}`,
    );
  const how = (d) => {
    const open = d.filter((t) => t.expect === null);
    const last = (s) => (s.trim().split("\n").filter((l) => l.trim()).at(-1) ?? "").trim();
    return {
      meanLen: Math.round(open.reduce((s, t) => s + t.content.length, 0) / Math.max(1, open.length)),
      followUps: open.filter((t) => /\?\s*$/.test(last(t.content)) || /^(next|you could|you might|if you want|from here)\b/i.test(last(t.content))).length,
      warmOpeners: open.filter((t) => /^(sure|great|happy to|of course|absolutely)\b/i.test(t.content.trim())).length,
      jsonRate: (() => { const c = d.reduce((s, t) => s + t.calls, 0); return c ? d.reduce((s, t) => s + t.jsonOk, 0) / c : 1; })(),
    };
  };

  // The noise floor first: the same prompt twice, at temperature 0, on
  // this server. Tasks whose verdict differs between the two runs are
  // ones no rendering can be blamed for — the first run of this gate
  // charged seven renderings with flipping one probe the baseline itself
  // flipped on the next call. What remains is what a line changed.
  const baseline = await evaluate("baseline", adapter, "", true);
  const again = await evaluate("baseline again", adapter, "", true);
  const b = how(baseline.detail);
  const bWhat = whatKey(baseline.detail);
  const noise = new Set(whatKey(again.detail).map((k, i) => (k !== bWhat[i] ? i : -1)).filter((i) => i >= 0));
  const right = (t) => (t.expect === "abstain" ? t.abstained : t.first === t.expect && (t.expect !== null || t.spoke));
  console.log(`baseline                : length ${b.meanLen} · follow-ups ${b.followUps} · warm openers ${b.warmOpeners} · json ${(b.jsonRate * 100).toFixed(0)}%`);
  console.log(`noise floor             : ${noise.size} of ${baseline.detail.length} tasks change verdict between two identical baseline runs${noise.size ? ` (${[...noise].map((i) => JSON.stringify(baseline.detail[i].prompt.slice(0, 40))).join(", ")})` : ""}`);

  let failed = false;
  const only = opt("--only", "").split(",").filter(Boolean);
  for (const r of gateRenderings().filter((r) => only.length === 0 || only.includes(r.id))) {
    const run = await evaluate(r.id, adapter, r.suffix, true);
    const h = how(run.detail);
    const w = whatKey(run.detail);
    const flips = w.filter((k, i) => k !== bWhat[i] && !noise.has(i));
    // Against the golden answers, not only against baseline: a flip that
    // lands on the right tool is still a change, but a flip that leaves
    // the right tool is the one that must not ship.
    const regressions = run.detail.filter((t, i) => !noise.has(i) && right(baseline.detail[i]) && !right(t)).map((t) => t.prompt);
    const jsonOk = h.jsonRate >= b.jsonRate;
    let verdict = "";
    if (r.id === "voice=terse") verdict = h.meanLen < b.meanLen ? "moves" : "DOES NOT MOVE";
    if (r.id === "initiative=answer-only") verdict = h.followUps < b.followUps ? "moves" : b.followUps === 0 ? "nothing to remove" : "DOES NOT MOVE";
    if (r.id === "initiative=offer-follow-ups") verdict = h.followUps > b.followUps ? "moves" : "DOES NOT MOVE";
    if (r.id === "warmth=matter-of-fact") verdict = h.warmOpeners === 0 ? (b.warmOpeners > 0 ? "moves" : "nothing to remove") : "DOES NOT MOVE";
    if (r.id === "voice=conversational") verdict = h.meanLen > b.meanLen ? "moves" : "DOES NOT MOVE";
    const what =
      flips.length === 0 && jsonOk
        ? "what: identical"
        : regressions.length === 0 && jsonOk
          ? `what: ${flips.length} changed, none for the worse`
          : `WHAT REGRESSED (${regressions.length}${jsonOk ? "" : ", json down"})`;
    if (regressions.length > 0 || !jsonOk || verdict.startsWith("DOES NOT")) failed = true;
    console.log(
      `${r.id.padEnd(24)}: length ${h.meanLen} · follow-ups ${h.followUps} · warm openers ${h.warmOpeners} · json ${(h.jsonRate * 100).toFixed(0)}% · ${what}${verdict ? ` · how: ${verdict}` : ""}`,
    );
    for (const f of flips) {
      const i = w.indexOf(f);
      const t = run.detail[i];
      const extra = t.expect === "abstain" ? `  calls=${t.calls} reply: ${t.content.replace(/\s+/g, " ").slice(0, 120)}` : "";
      console.log(`    ${regressions.includes(t.prompt) ? "REGRESSED " : "changed   "}${f}   (baseline: ${bWhat[i]})${extra}`);
    }
  }
  console.log(failed ? "\nGate failed: a rendering made the model worse at what it does, or did not move what it should." : "\nGate passed: no rendering makes the model worse at what it does, and each moves what it names.");
  process.exit(failed ? 1 : 0);
}

async function serverUp() {
  try {
    const res = await fetch(`${config.modelBaseUrl}/models`);
    return res.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */

// --data-only writes train.jsonl/valid.jsonl and stops — for inspecting
// exactly what a run would train on before starting one.
if (flag("--data-only")) {
  writeDataset();
  process.exit(0);
}

if (flag("--behavior-gate")) {
  if (!(await serverUp())) {
    console.error(`Model server is not reachable at ${config.modelBaseUrl}; start enio first.`);
    process.exit(1);
  }
  await behaviorGate();
}

/*
 * Every run keeps its weights under runs/<stamp>-seed<n>/, with its gate
 * numbers beside them, forever: staging/ is a pointer to the newest, not
 * the only copy. The fourth coder run was the best adapter measured and
 * the fifth overwrote it.
 *
 * Seeds: one by default; `--seeds 7,11` trains the same data twice.
 * Five runs on nearly identical data scored abstention 1, 3, 0, 3, 2 of 4
 * with one seed, so a lever cannot be read off a single run. With several
 * seeds the spread between them is printed as the noise floor, and an
 * adapter installs only when EVERY seed passes the gate — a lever that
 * passes with one seed and fails with another is noise, not a lever.
 */
const seeds = opt("--seeds", opt("--seed", "7")).split(",").map((s) => s.trim()).filter(Boolean);
const runsDir = join(adapterDir, "runs");
let candidates = [];
if (flag("--eval-only")) {
  candidates = [{ seed: "staged", dir: stagingDir }];
} else {
  writeDataset();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  for (const seed of seeds) {
    const dir = join(runsDir, `${stamp}-seed${seed}`);
    mkdirSync(dir, { recursive: true });
    await train(seed, dir);
    candidates.push({ seed, dir });
  }
}
const pointStaging = (dir) => {
  if (dir === stagingDir) return;
  mkdirSync(stagingDir, { recursive: true });
  for (const f of ["adapters.safetensors", "adapter_config.json"]) copyFileSync(join(dir, f), join(stagingDir, f));
};

for (const c of candidates) {
  if (!existsSync(join(c.dir, "adapters.safetensors"))) {
    console.error(`nothing trained at ${c.dir}`);
    process.exit(1);
  }
}

if (!(await serverUp())) {
  pointStaging(candidates.at(-1).dir);
  console.log(
    `Model server is not reachable at ${config.modelBaseUrl}; weights kept under ${runsDir}, staged, NOT installed.\n` +
      `Start enio, then re-run with --eval-only to gate and install.`,
  );
  process.exit(0);
}

const rowCount = existsSync(join(dataDir, "train.jsonl"))
  ? readFileSync(join(dataDir, "train.jsonl"), "utf8").split("\n").filter(Boolean).length
  : 0;
const base = (await evaluate("base    ", null)).score;
// Every measured property must hold: an adapter below base on any one of
// them stays staged, whatever its score on the others.
const passes = (t) =>
  t.toolRight >= base.toolRight &&
  t.abstainRight >= base.abstainRight &&
  (t.jsonTotal === 0 || t.jsonValid / t.jsonTotal >= (base.jsonTotal ? base.jsonValid / base.jsonTotal : 1));

const scored = [];
for (const c of candidates) {
  const tuned = (await evaluate(`adapter (seed ${c.seed})`.padEnd(8), c.dir)).score;
  const passed = passes(tuned);
  scored.push({ ...c, tuned, passed });
  if (c.dir !== stagingDir) {
    writeFileSync(
      join(c.dir, "gate.json"),
      JSON.stringify({ seed: c.seed, at: Date.now(), rows: rowCount, base, adapter: tuned, passed }, null, 2) + "\n",
    );
  }
}
if (scored.length > 1) {
  const spread = (k) => { const v = scored.map((s) => s.tuned[k]); return `${Math.min(...v)}–${Math.max(...v)}`; };
  console.log(
    `\nacross ${scored.length} seeds: tool choice ${spread("toolRight")}/${base.total}, ` +
      `abstains ${spread("abstainRight")}/${base.abstainTotal} — the spread is this data's noise floor`,
  );
}
scored.sort((a, b) => b.tuned.toolRight + b.tuned.abstainRight - (a.tuned.toolRight + a.tuned.abstainRight) || b.tuned.abstainRight - a.tuned.abstainRight);
const best = scored[0];
pointStaging(best.dir);

const failed = scored.filter((s) => !s.passed);
if (failed.length > 0) {
  console.log(
    scored.length > 1 && failed.length < scored.length
      ? `${scored.length - failed.length} of ${scored.length} seeds passed the gate — noise, not a lever. Nothing installed; every run's weights are under ${runsDir}.`
      : `Adapter does not beat base on its own tasks — left staged, not installed (weights kept under ${runsDir}).`,
  );
  process.exit(1);
}

if (flag("--no-install")) {
  console.log(`Passed the gate; --no-install left it staged at ${stagingDir}`);
  process.exit(0);
}

const { recordAdapterVersion } = await distImport("adapters.js");
const tuned = best.tuned;
const entry = recordAdapterVersion(name, stagingDir, { trainer: "mlx", rows: rowCount, gate: { base, adapter: tuned } });
console.log(
  `Installed as version ${entry.version}: ${adapterDir}\n` +
    `The ${name} specialist now serves with it (resolves via adapterPathFor at call time).\n` +
    `History and rollback:  enio train history ${name}  ·  enio train rollback ${name}`,
);
