#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { ensureToken } from "./auth.js";
import { join } from "node:path";
import { activeBackend, config, ensureDirs, projectRoot } from "./config.js";
import { canRunMaple, whyNoMaple } from "./platform.js";
import { ensureBackend, type RunningBackend } from "./runtime.js";
import { findSkill, loadSkills, skillContents, skillsDir } from "./skills.js";
import {
  addTask, getTask, listTasks, removeTask, runTask, runsFor,
  setTaskEnabled, startScheduler, validateSchedule,
} from "./tasks.js";
import { analyse, draftSkill } from "./suggest.js";
import { cpSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { BACKENDS } from "./backends.js";
import {
  addPreference,
  listExemplars,
  listPreferences,
  removePreference,
} from "./memory/learning.js";
import { repl } from "./repl.js";
import { serve } from "./server.js";
import { inspect } from "./inspect.js";
import { serverIsUp } from "./model.js";
import {
  forgetFact,
  indexPending,
  rememberFact,
  resetDerived,
  searchGraph,
  stats,
} from "./memory/store.js";
import { buildRegistry } from "./tools/index.js";
import { closeMcp } from "./tools/mcp.js";

const [, , command = "chat", ...rest] = process.argv;

async function main(): Promise<void> {
  ensureDirs();

  switch (command) {
    case "start":
      await startEverything(rest.includes("--think"));
      break;

    case "chat":
      await repl({ showThinking: rest.includes("--think") });
      break;

    case "serve":
      await serve();
      break;

    case "inspect":
      await inspect();
      break;

    case "up":
      await startModelServer();
      break;

    case "index": {
      const report = await indexPending((m) => console.log(m));
      console.log(
        `\nIndexed ${report.sessions} session(s): ` +
          `${report.summaries} summaries, ${report.triples} triples.`,
      );
      break;
    }

    case "reindex": {
      console.log("Discarding the derived graph and rebuilding from the raw log...");
      resetDerived();
      const report = await indexPending((m) => console.log(m));
      console.log(
        `\nRebuilt from ${report.sessions} session(s): ${report.triples} triples.`,
      );
      break;
    }

    case "remember": {
      const text = rest.join(" ").trim();
      if (!text) {
        console.error('Usage: enio remember "some durable fact"');
        process.exit(1);
      }
      const result = await rememberFact(text, { pinned: true, source: "cli" });
      console.log(result.stored ? `Remembered: ${text}` : `Not stored (${result.reason}).`);
      break;
    }

    case "forget": {
      const target = rest.join(" ").trim();
      console.log(forgetFact(target) ? "Forgotten." : "No matching fact.");
      break;
    }

    case "graph": {
      const query = rest.join(" ").trim();
      if (!query) {
        console.error('Usage: enio graph "topic"');
        process.exit(1);
      }
      const hits = await searchGraph(query, 30);
      if (hits.length === 0) {
        console.log(`Nothing in the graph about "${query}".`);
        break;
      }
      for (const h of hits) {
        console.log(
          `${h.subject}  --${h.relation}-->  ${h.object}   (${h.confidence.toFixed(2)})`,
        );
      }
      break;
    }

    case "skills": {
      if (rest.includes("--install-examples")) {
        const from = join(projectRoot, "examples", "skills");
        if (!existsSync(from)) {
          console.error(`No bundled examples found at ${from}`);
          process.exit(1);
        }
        mkdirSync(skillsDir(), { recursive: true });
        // force:false so a skill you have edited is never silently overwritten.
        cpSync(from, skillsDir(), { recursive: true, force: false, errorOnExist: false });
        console.log(`Installed examples into ${skillsDir()}`);
        console.log(`Run 'enio skills' to see them.`);
        break;
      }

      const newName = rest[rest.indexOf("--new") + 1];
      if (rest.includes("--new")) {
        if (!newName || newName.startsWith("--")) {
          console.error(`Usage: enio skills --new <name>`);
          process.exit(1);
        }
        const dir = join(skillsDir(), newName);
        if (existsSync(dir)) {
          console.error(`${dir} already exists.`);
          process.exit(1);
        }
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "SKILL.md"),
          `---\nname: ${newName}\ndescription: >-\n  When this skill applies. Be specific and concrete — this single line is\n  the ONLY thing the model sees until it decides to load the skill, so it\n  has to carry the whole decision.\n---\n\n# ${newName}\n\nWrite the instructions here as if briefing a capable new colleague who has\nnever done this task at your organisation.\n\n## Method\n\nThe steps, in order.\n\n## Rules\n\nThe things that are easy to get wrong, and what to do instead.\n`,
        );
        console.log(`Created ${join(dir, "SKILL.md")}`);
        console.log(`Edit it, then run 'enio skills' to check it loads.`);
        break;
      }

      const set = loadSkills();
      const target = rest.find((a) => !a.startsWith("--"));

      if (target) {
        const skill = findSkill(target, set);
        if (!skill) {
          console.error(`No skill named "${target}".`);
          process.exit(1);
        }
        console.log(`${skill.name}\n${"-".repeat(skill.name.length)}`);
        console.log(`${skill.description}\n`);
        console.log(skill.body);
        const extra = skillContents(skill);
        if (extra.length) console.log(`\nFiles: ${extra.join(", ")}`);
        break;
      }

      if (set.skills.length === 0 && set.problems.length === 0) {
        console.log(
          `No skills installed.\n\n` +
            `  enio skills --install-examples   copy the bundled examples\n` +
            `  enio skills --new <name>         scaffold your own\n\n` +
            `They live in ${skillsDir()}`,
        );
        break;
      }

      for (const skill of set.skills) {
        const flags = [
          skill.manualOnly ? "manual-only" : null,
          skill.allowedTools ? `tools: ${skill.allowedTools.join(",")}` : null,
        ].filter(Boolean);
        console.log(`${skill.name}${flags.length ? `  (${flags.join("; ")})` : ""}`);
        console.log(`  ${skill.description}\n`);
      }
      for (const p of set.problems) {
        console.error(`\x1b[33mskipped\x1b[0m ${p.path}\n  ${p.reason}\n`);
      }
      break;
    }

    case "tasks": {
      const tasks = listTasks();
      if (tasks.length === 0) {
        console.log(
          `No tasks.\n\n  enio task add <name> --cron "0 9 * * 1" --prompt "..."\n` +
            `  enio suggest      find candidates in what you have already repeated`,
        );
        break;
      }
      for (const t of tasks) {
        const next = validateSchedule(t.schedule);
        const when = next.ok ? next.next.toISOString().replace("T", " ").slice(0, 16) : "invalid";
        const state = t.enabled ? `next ${when}` : "disabled";
        console.log(`${t.name.padEnd(24)} ${t.schedule.padEnd(16)} ${state}`);
        console.log(`  ${t.prompt.replace(/\s+/g, " ").slice(0, 90)}`);
        if (t.lastStatus) {
          const ago = t.lastRunAt ? new Date(t.lastRunAt).toISOString().slice(0, 16).replace("T", " ") : "?";
          console.log(`  last: ${t.lastStatus} at ${ago}${t.lastError ? ` — ${t.lastError}` : ""}`);
        }
        console.log("");
      }
      break;
    }

    case "task": {
      const [action, name, ...opts] = rest;
      const flag = (f: string) => {
        const i = opts.indexOf(f);
        return i >= 0 ? opts[i + 1] : undefined;
      };

      if (action === "add") {
        if (!name) { console.error(`Usage: enio task add <name> --cron "0 9 * * 1" --prompt "..."`); process.exit(1); }
        try {
          const task = addTask({
            name,
            prompt: flag("--prompt") ?? "",
            schedule: flag("--cron") ?? "0 9 * * 1",
            specialist: flag("--specialist") ?? null,
          });
          const next = validateSchedule(task.schedule);
          console.log(`Added ${task.name}. Next run: ${next.ok ? next.next.toISOString() : "?"}`);
          console.log(`Start the scheduler with: enio daemon`);
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }
        break;
      }

      if (action === "rm" || action === "remove") {
        console.log(removeTask(name ?? "") ? "Removed." : "No such task.");
        break;
      }
      if (action === "enable" || action === "disable") {
        const ok = setTaskEnabled(name ?? "", action === "enable");
        console.log(ok ? `${action}d ${name}` : "No such task.");
        break;
      }
      if (action === "run") {
        const task = getTask(name ?? "");
        if (!task) { console.error("No such task."); process.exit(1); }
        const run = await runTask(task, (m) => console.log(m));
        if (run.output) console.log(`\n${run.output}`);
        break;
      }
      if (action === "runs") {
        for (const r of runsFor(name ?? "")) {
          console.log(
            `${new Date(r.startedAt).toISOString().slice(0, 16).replace("T", " ")}  ` +
              `${r.status.padEnd(6)} ${Math.round(r.durationMs / 1000)}s` +
              `${r.error ? `  ${r.error}` : ""}`,
          );
        }
        break;
      }

      console.error(`Usage: enio task <add|rm|enable|disable|run|runs> <name> [...]`);
      process.exit(1);
      break;
    }

    case "daemon": {
      console.log("Starting the scheduler. Ctrl-C to stop.\n");
      const backend = await ensureBackend({
        log: (m) => console.log(`\x1b[2m${m}\x1b[0m`),
        confirm: async () => false,
      });
      const scheduler = startScheduler((m) =>
        console.log(`\x1b[2m${new Date().toISOString().slice(11, 19)}\x1b[0m ${m}`),
      );
      const shutdown = () => { scheduler.stop(); backend.stop(); process.exit(0); };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise(() => {}); // run until interrupted
      break;
    }

    case "suggest": {
      const { proposals, turnsExamined, usedEmbeddings } = await analyse();
      if (turnsExamined < 5) {
        console.log(
          `Only ${turnsExamined} turns recorded so far — not enough to see a pattern.\n` +
            `Use enio for a while and try again.`,
        );
        break;
      }
      console.log(
        `Examined ${turnsExamined} turns` +
          `${usedEmbeddings ? "" : " (lexical matching — embeddings unavailable)"}.\n`,
      );
      if (proposals.length === 0) {
        console.log(`Nothing repeated often enough to be worth automating yet.`);
        break;
      }

      proposals.forEach((p, i) => {
        console.log(`\x1b[1m${i + 1}. ${p.title}\x1b[0m  \x1b[2m[${p.kind}]\x1b[0m`);
        console.log(`   ${p.reason}`);
        for (const e of p.evidence) console.log(`   \x1b[2m· ${e}\x1b[0m`);
        if (p.cron) console.log(`   suggested schedule: ${p.cron}`);
        if (p.tools?.length) console.log(`   tools: ${p.tools.join(", ")}`);
        console.log("");
      });

      if (rest.includes("--write")) {
        mkdirSync(skillsDir(), { recursive: true });
        for (const p of proposals.filter((p) => p.kind === "skill")) {
          const dir = join(skillsDir(), p.suggestedName);
          if (existsSync(dir)) { console.log(`skipped ${p.suggestedName} (exists)`); continue; }
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "SKILL.md"), draftSkill(p));
          console.log(`drafted ${join(dir, "SKILL.md")}`);
        }
        console.log(`\nThese are starting points. Edit them — you know your method, enio only saw the pattern.`);
      } else {
        console.log(`Run 'enio suggest --write' to scaffold drafts for the skills.`);
      }
      break;
    }

    case "token": {
      if (rest.includes("--rotate")) {
        const path = join(config.dataDir, "token");
        if (existsSync(path)) unlinkSync(path);
        const fresh = ensureToken();
        console.log(`New API key: ${fresh}`);
        console.log(`Any client using the old key must be updated.`);
        break;
      }
      console.log(ensureToken());
      break;
    }

    case "skills-new":
    case "skills-init": {
      console.error(`Use: enio skills --new <name>  /  enio skills --install-examples`);
      process.exit(1);
      break;
    }

    case "backends": {
      const current = activeBackend();
      for (const b of Object.values(BACKENDS)) {
        const mark = b.id === current.id ? "*" : " ";
        console.log(`${mark} ${b.id.padEnd(10)} ${b.label}`);
        console.log(`    ${b.baseUrl}  ·  default model: ${b.model}`);
        console.log(`    ${b.notes}\n`);
      }
      console.log(`Switch with:  ENIO_BACKEND=ollama ENIO_MODEL=qwen3:8b enio chat`);
      break;
    }

    case "prefs": {
      const prefs = listPreferences();
      console.log(
        prefs.length === 0
          ? "No standing instructions set."
          : prefs.map((p) => `${String(p.id).padStart(3)}  ${p.text}`).join("\n"),
      );
      break;
    }

    case "pref": {
      const text = rest.join(" ").trim();
      if (!text) {
        console.error('Usage: enio pref "answer concisely"');
        process.exit(1);
      }
      const result = addPreference(text);
      console.log(result.added ? `Set: ${text}` : `Not set (${result.reason}).`);
      break;
    }

    case "unpref":
      console.log(removePreference(rest.join(" ").trim()) ? "Removed." : "No match.");
      break;

    case "examples": {
      const examples = listExemplars();
      console.log(
        examples.length === 0
          ? "No examples saved. Use /good in chat after a good answer."
          : examples
              .map((e) => `${String(e.id).padStart(3)}  Q: ${e.question}\n     A: ${e.answer.slice(0, 120)}...`)
              .join("\n\n"),
      );
      break;
    }

    case "stats":
      console.log(
        Object.entries(stats())
          .map(([k, v]) => `${k.padEnd(12)} ${v}`)
          .join("\n"),
      );
      break;

    case "tools": {
      const registry = await buildRegistry((m) => console.log(m));
      for (const t of registry.all) {
        const tag = t.origin === "mcp" ? ` [mcp:${t.server}]` : "";
        console.log(`${t.name}${tag}\n  ${t.description.split("\n")[0]}\n`);
      }
      await closeMcp();
      break;
    }

    case "mcp-init": {
      const path = config.mcpConfigPath;
      if (existsSync(path)) {
        console.log(`${path} already exists — leaving it alone.`);
        break;
      }
      writeFileSync(
        path,
        JSON.stringify(
          {
            mcpServers: {
              filesystem: {
                command: "npx",
                args: [
                  "-y",
                  "@modelcontextprotocol/server-filesystem",
                  join(config.workspace),
                ],
                tools: ["read_file", "list_directory", "search_files"],
                disabled: true,
              },
              // Playwright MCP adds real browser interaction — clicking, forms,
              // multi-step navigation — which web_fetch_rendered cannot do.
              //
              // It exposes 60+ tools. Without the allowlist below it alone is
              // roughly four times the entire tool budget, and the failure mode
              // is not an error: the model quietly picks wrong tools. Add to
              // this list one at a time, and only when you hit something the
              // current set can't do.
              playwright: {
                command: "npx",
                args: ["-y", "@playwright/mcp@latest", "--headless"],
                tools: [
                  "browser_navigate",
                  "browser_snapshot",
                  "browser_click",
                  "browser_type",
                ],
                disabled: true,
              },
            },
          },
          null,
          2,
        ) + "\n",
      );
      console.log(
        `Wrote a starter config to ${path}.\n` +
          `It has one example server, disabled. Edit it and set "disabled": false.`,
      );
      break;
    }

    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exit(1);
  }
}

const MODEL_ARGS = (modelPath: string) => [
  "-m", "mlx_lm.server",
  "--model", modelPath,
  "--trust-remote-code",
  "--flash-head",
  "--port", "8080",
];

/** Verify the runtime exists before trying to use it, with an actionable error. */
function requireRuntime(): string {
  // Telling someone on Linux to run install.sh for a runtime that can never
  // exist on their machine wastes their time. Say what is actually true.
  if (!canRunMaple()) {
    console.error(
      `\n${whyNoMaple()}\n\n` +
        `Everything else in enio works here — run it against a local server instead:\n\n` +
        `    ollama serve\n` +
        `    ollama pull qwen3:8b\n` +
        `    ENIO_BACKEND=ollama ENIO_MODEL=qwen3:8b enio chat\n\n` +
        `'enio start' only manages the Maple runtime; use 'enio chat' with any\n` +
        `other backend. See 'enio backends'.\n`,
    );
    process.exit(1);
  }

  const venvPython = join(config.runtimeDir, ".venv", "bin", "python");
  if (!existsSync(venvPython)) {
    console.error(
      `\nNo model runtime found at ${config.runtimeDir}\n\n` +
        `Install it with:   bash install.sh\n` +
        `Point elsewhere:   ENIO_DIR=/path/to/runtime\n` +
        `Or use another engine:\n` +
        `                   ENIO_BACKEND=ollama enio chat\n`,
    );
    process.exit(1);
  }
  return venvPython;
}

/** Foreground model server — logs to this terminal, runs until interrupted. */
async function startModelServer(): Promise<void> {
  if (await serverIsUp()) {
    console.log(`Model server already running at ${config.modelBaseUrl}`);
    return;
  }
  const venvPython = requireRuntime();
  console.log(`Starting mlx_lm.server on ${config.modelBaseUrl} ...`);

  const child = spawn(venvPython, MODEL_ARGS(join(config.runtimeDir, "maple-2bit-mlx")), {
    cwd: config.runtimeDir,
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));

  // First load pages ~5GB off disk, so allow a generous window.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await serverIsUp()) {
      console.log(`\nReady. In another terminal: enio chat\n`);
      return;
    }
  }
  console.error("Server did not become ready within two minutes.");
}

/**
 * `enio start` — bring the configured backend up, then open chat.
 *
 * Backend-agnostic: Maple on Apple Silicon, Ollama elsewhere, with a clear
 * message for engines we can't launch. Only stops what it started, since an
 * already-running server usually belongs to something else.
 */
async function startEverything(showThinking: boolean): Promise<void> {
  let backend: RunningBackend;
  try {
    backend = await ensureBackend({
      log: (m) => console.log(`\x1b[2m${m}\x1b[0m`),
      confirm: askYesNo,
    });
  } catch (err) {
    console.error(`\n${(err as Error).message}`);
    process.exit(1);
  }

  const stop = () => backend.stop();
  process.on("exit", stop);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await repl({ showThinking });
}

/** Yes/no on the terminal. Non-interactive runs decline rather than hang. */
async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function printHelp(): void {
  console.log(`
enio — a local agent with tools and persistent memory

  enio start [--think]    start the backend and open chat — the usual entry point
  enio chat [--think]     chat against an already-running model
  enio up                 run the model server in the foreground
  enio serve              expose an OpenAI-compatible endpoint on :${config.agentPort}
  enio inspect            open the trace + knowledge-graph inspector

  enio index              summarise and extract from unindexed conversations
  enio reindex            rebuild the whole graph from the raw log
  enio stats              what memory currently holds
  enio graph "topic"      show what the graph knows about something
  enio remember "..."     pin a fact by hand
  enio forget "..."       remove a fact

  enio prefs              list standing instructions
  enio pref "..."         add one
  enio unpref ID          remove one
  enio examples           list saved answer examples

  enio tasks               list scheduled tasks
  enio task add NAME --cron "0 9 * * 1" --prompt "..."
  enio task run|rm|enable|disable|runs NAME
  enio daemon              run the scheduler
  enio suggest [--write]   find what is worth automating

  enio skills              list installed skills
  enio skills NAME         show one in full
  enio skills --new NAME   scaffold a new skill
  enio skills --install-examples
  enio token              print the API key for the HTTP endpoint
  enio token --rotate     generate a new one, invalidating the old
  enio backends           list model backends and how to switch
  enio tools              list every tool, built-in and MCP
  enio mcp-init           write a starter mcp.json

Config lives in environment variables — see src/config.ts.
Backend:   ${config.backendId} (${config.modelBaseUrl})
Workspace: ${config.workspace}
Data:      ${config.dataDir}
`);
}

main().catch((err) => {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
});
