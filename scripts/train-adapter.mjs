#!/usr/bin/env node
/**
 * Train a LoRA adapter for one specialist, over the model this machine is
 * actually serving, and install it only if it beats the base model on that
 * specialist's held-out tasks.
 *
 * Usage:
 *   node scripts/train-adapter.mjs coder [--iters 400] [--batch-size 2]
 *        [--num-layers 8] [--from-traces] [--eval-only] [--no-install]
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

  const rows = [];
  for (const { messages, mined } of conversations) {
    const full = [{ role: "system", content: systemPrompt }, ...messages];
    for (let i = 0; i < full.length; i++) {
      if (full[i].role !== "assistant") continue;
      const row = { messages: full.slice(0, i + 1), tools: wireTools };
      rows.push({ row, mined, chars: JSON.stringify(row).length });
    }
  }
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

async function train() {
  writeDataset();

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
    "--adapter-path", stagingDir,
    "--seed", "7",
  ];
  console.log(`training: ${py} ${cmd.join(" ")}`);
  await new Promise((resolve, reject) => {
    const child = spawn(py, cmd, { stdio: "inherit" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`trainer exited ${code}`))));
    child.on("error", reject);
  });
}

/* ------------------------------------------------------------------ */
/* Eval: held-out tasks, base vs staged adapter, temperature 0.        */

async function askOnce(task, adapter) {
  // A task is either a fresh prompt or a mid-flight conversation (a
  // recovery probe: the tool just failed, score the next move).
  const turn = task.messages ?? [{ role: "user", content: task.prompt }];
  const body = {
    model: modelId,
    messages: [{ role: "system", content: systemPrompt }, ...turn],
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

async function evaluate(label, adapter) {
  const tasks = scenarioModule.goldenTasks();
  let toolRight = 0;
  let jsonValid = 0;
  let jsonTotal = 0;
  let abstainRight = 0;
  let abstainTotal = 0;
  const misses = [];
  for (const task of tasks) {
    const msg = await askOnce(task, adapter);
    const calls = msg.tool_calls ?? [];
    const first = calls[0]?.function?.name ?? null;
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
  console.log(
    `${label}: tool choice ${toolRight}/${total}, ` +
      `valid JSON ${jsonValid}/${jsonTotal || 0}, abstains ${abstainRight}/${abstainTotal}`,
  );
  if (misses.length) console.log(misses.join("\n"));
  return score;
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

if (!flag("--eval-only")) await train();

if (!existsSync(join(stagingDir, "adapters.safetensors"))) {
  console.error(`nothing staged at ${stagingDir}`);
  process.exit(1);
}

if (!(await serverUp())) {
  console.log(
    `Model server is not reachable at ${config.modelBaseUrl}; adapter is staged but NOT installed.\n` +
      `Start enio, then re-run with --eval-only to gate and install.`,
  );
  process.exit(0);
}

const base = await evaluate("base    ", null);
const tuned = await evaluate("adapter ", stagingDir);

// Every measured property must hold: an adapter below base on any one of
// them stays staged, whatever its score on the others.
const better =
  tuned.toolRight >= base.toolRight &&
  tuned.abstainRight >= base.abstainRight &&
  (tuned.jsonTotal === 0 || tuned.jsonValid / tuned.jsonTotal >= (base.jsonTotal ? base.jsonValid / base.jsonTotal : 1));

if (!better) {
  console.log("Adapter does not beat base on its own tasks — left staged, not installed.");
  process.exit(1);
}

if (flag("--no-install")) {
  console.log(`Passed the gate; --no-install left it staged at ${stagingDir}`);
  process.exit(0);
}

const { recordAdapterVersion } = await distImport("adapters.js");
const rowCount = existsSync(join(dataDir, "train.jsonl"))
  ? readFileSync(join(dataDir, "train.jsonl"), "utf8").split("\n").filter(Boolean).length
  : 0;
const entry = recordAdapterVersion(name, stagingDir, { trainer: "mlx", rows: rowCount, gate: { base, adapter: tuned } });
console.log(
  `Installed as version ${entry.version}: ${adapterDir}\n` +
    `The ${name} specialist now serves with it (resolves via adapterPathFor at call time).\n` +
    `History and rollback:  enio train history ${name}  ·  enio train rollback ${name}`,
);
