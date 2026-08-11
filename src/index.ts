#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { ensureToken } from "./auth.js";
import { join } from "node:path";
import { activeBackend, config, ensureDirs, projectRoot } from "./config.js";
import { canRunMaple, whyNoMaple } from "./platform.js";
import { registerModelClient, unregisterModelClient } from "./model-clients.js";
import {
  ensureBackend,
  modelServerArgs,
  modelServerBinary,
  modelServerPid,
  venvPythonPath,
  WAIT_FOR_EXISTING_TICKS,
  type RunningBackend,
} from "./runtime.js";
import { currentModelLabel, currentModelPath } from "./model-settings.js";
import { findSkill, loadSkills, skillContents, skillsDir } from "./skills.js";
import {
  addTask, getTask, listTasks, removeTask, runTask, runsFor,
  setTaskEnabled, startScheduler, validateSchedule,
} from "./tasks.js";
import { analyse, draftSkill } from "./suggest.js";
import { visionStatus } from "./vision.js";
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

    case "chat": {
      const cont = rest.indexOf("--continue");
      await repl({
        showThinking: rest.includes("--think"),
        // Bare --continue resumes the latest; --continue <id-prefix> picks one.
        resume:
          cont === -1
            ? undefined
            : rest[cont + 1] && !rest[cont + 1]!.startsWith("--")
              ? rest[cont + 1]
              : "latest",
      });
      break;
    }

    case "chats": {
      const { listConversations } = await import("./memory/store.js");
      const all = listConversations();
      if (all.length === 0) {
        console.log("No stored conversations yet.");
        break;
      }
      for (const c of all) {
        const when = new Date(c.lastAt).toISOString().replace("T", " ").slice(0, 16);
        console.log(`${c.id.slice(0, 8)}  ${when}  ${String(c.messages).padStart(3)} msgs  ${c.title}`);
      }
      console.log(`\nContinue one:  enio chat --continue <id>`);
      break;
    }

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

    case "voice": {
      const { whisperInstalled } = await import("./voice.js");

      if (rest.includes("--install")) {
        // Shares the vision venv: both are MLX packages pinned to the same
        // stack, and a third venv would be a third copy of mlx to update.
        const { mkdirSync } = await import("node:fs");
        mkdirSync(config.visionVenvDir, { recursive: true });
        if (!existsSync(join(config.visionVenvDir, "bin", "python"))) {
          const venv = spawn("uv", ["venv", "--python", "3.12", config.visionVenvDir], {
            stdio: "inherit",
          });
          const code: number = await new Promise((r) => venv.on("exit", (c) => r(c ?? 1)));
          if (code !== 0) {
            console.error("Could not create the venv. Is uv installed?");
            process.exit(1);
          }
        }
        const pip = spawn(
          "uv",
          ["pip", "install", "--python", join(config.visionVenvDir, "bin", "python"), "mlx-whisper"],
          { stdio: "inherit" },
        );
        const code: number = await new Promise((r) => pip.on("exit", (c) => r(c ?? 1)));
        if (code !== 0) {
          console.error("mlx-whisper install failed.");
          process.exit(1);
        }
        console.log(`\nInstalled. The microphone button appears in the desktop app.`);
        console.log(`${config.voiceModel} downloads on first use (~500MB).`);
        break;
      }

      const file = rest.find((a) => !a.startsWith("--"));
      if (file) {
        const { transcribeWav } = await import("./voice.js");
        const started = Date.now();
        const result = await transcribeWav(file);
        if (result.error) {
          console.error(result.error);
          process.exit(1);
        }
        console.log(result.text);
        console.log(`\x1b[2mtranscribed in ${((Date.now() - started) / 1000).toFixed(1)}s\x1b[0m`);
        break;
      }

      if (rest.includes("--voices")) {
        const { kokoroVoices } = await import("./voice.js");
        const voices = await kokoroVoices();
        if (voices.length === 0) {
          console.log(`No voices — the model could not be loaded.`);
          break;
        }
        console.log(voices.join("\n"));
        console.log(`\nENIO_TTS_VOICE picks one. Currently ${config.kokoroVoice}.`);
        break;
      }

      console.log(`speech in      ${whisperInstalled() ? "ready" : "not installed — enio voice --install"}`);
      console.log(`model          ${config.voiceModel}`);
      console.log(`speech out     ${config.ttsEngine}${config.ttsEngine === "kokoro" ? ` (${config.kokoroVoice})` : ""}`);
      console.log("");
      console.log(`Dictation runs on demand and nothing stays resident. Replies are`);
      console.log(`only spoken when you turn it on in the desktop app.`);
      console.log(`enio voice --voices lists the ${config.ttsEngine === "kokoro" ? "28 Kokoro voices" : "system voices"}.`);
      break;
    }

    case "vision": {
      const target = rest.find((a) => !a.startsWith("--"));
      if (target) {
        const { readImage } = await import("./vision.js");
        const { safePath } = await import("./tools/fs.js");
        const started = Date.now();
        const result = await readImage(safePath(target));
        console.log(`${result.text}\n`);
        console.log(
          `\x1b[2mread by ${result.method} in ${((Date.now() - started) / 1000).toFixed(1)}s\x1b[0m`,
        );
        break;
      }

      // mlx-vlm lives in its own venv, deliberately: it depends on mlx-lm, and
      // installing it beside the Maple runtime risks pip replacing the editable
      // checkout that carries the tool-parser patch.
      if (rest.includes("--install")) {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(config.visionVenvDir, { recursive: true });
        console.log(`Installing mlx-vlm into ${config.visionVenvDir}`);
        const venv = spawn("uv", ["venv", "--python", "3.12", config.visionVenvDir], {
          stdio: "inherit",
        });
        const venvCode: number = await new Promise((r) => venv.on("exit", (c) => r(c ?? 1)));
        if (venvCode !== 0) {
          console.error("Could not create the venv. Is uv installed?");
          process.exit(1);
        }
        const pip = spawn("uv", ["pip", "install", "--python", join(config.visionVenvDir, "bin", "python"), "mlx-vlm"], {
          stdio: "inherit",
        });
        const pipCode: number = await new Promise((r) => pip.on("exit", (c) => r(c ?? 1)));
        if (pipCode !== 0) {
          console.error("mlx-vlm install failed.");
          process.exit(1);
        }
        console.log(`\nInstalled. Start it with:  enio vision --serve`);
        console.log(`The model (${config.visionMlxModel}) downloads on first use.`);
        break;
      }

      if (rest.includes("--serve")) {
        const { mlxVisionPort } = await import("./vision.js");
        const python = join(config.visionVenvDir, "bin", "python");
        if (!existsSync(python)) {
          console.error(`mlx-vlm is not installed.\n  enio vision --install`);
          process.exit(1);
        }
        const port = mlxVisionPort();
        console.log(`Starting mlx-vlm on :${port}`);
        console.log(`  model ${config.visionMlxModel}`);
        console.log(`  first run downloads the weights; later runs load from cache\n`);
        // Foreground on purpose. It holds the model for as long as it runs --
        // there is no per-request unload the way Ollama has -- so stopping it
        // is how the memory comes back, and that should be a visible ctrl-C
        // rather than something buried in a background process.
        const server = spawn(
          python,
          ["-m", "mlx_vlm.server", "--model", config.visionMlxModel, "--port", String(port)],
          { stdio: "inherit" },
        );
        await new Promise((r) => server.on("exit", r));
        break;
      }

      const status = await visionStatus();
      console.log(`mode           ${status.mode}`);
      console.log(`backend        ${status.backend}${status.active ? ` (using ${status.active})` : " (none reachable)"}`);
      console.log(`mlx-vlm        ${status.mlxInstalled ? "installed" : "not installed — enio vision --install"}`);
      console.log(`mlx server     ${status.mlxReachable ? "reachable" : "not running — enio vision --serve"}`);
      console.log(`mlx model      ${status.mlxModel}`);
      console.log(`ollama         ${status.ollamaReachable ? "reachable" : "not running"}`);
      console.log(`ollama model   ${status.model}${status.modelPulled ? " (pulled)" : " (not pulled)"}`);
      console.log(`ocr            ${status.ocrReady ? "ready" : "language data not cached"}`);
      console.log("");
      if (status.active === "mlx") {
        console.log(`Ready. Images are described by mlx-vlm — the same runtime as the`);
        console.log(`chat model. It holds the model while it runs, so stop it when done.`);
      } else if (status.active === "ollama") {
        console.log(`Ready. Images are described on demand and the model unloads`);
        console.log(`immediately after, so nothing sits alongside your chat model.`);
      } else {
        console.log(`No vision server, so images fall back to OCR — no model, no network,`);
        console.log(`and fine for a screenshot of text. To describe what an image shows:`);
        console.log("");
        console.log(`  enio vision --install     # mlx-vlm, same framework as Maple`);
        console.log(`  enio vision --serve       # then leave it running`);
        console.log("");
        console.log(`Or, if you already run Ollama:  ollama pull ${status.model}`);
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

    case "watches": {
      const { listWatches } = await import("./heartbeat.js");
      const watches = listWatches();
      if (watches.length === 0) {
        console.log('No watches. Add one with: enio watch add "does X have a new release"');
        break;
      }
      for (const w of watches) {
        const checked = w.lastCheckedAt ? new Date(w.lastCheckedAt).toLocaleString() : "never";
        console.log(
          `${String(w.id).padStart(3)}  ${w.enabled ? " " : "(off) "}${w.prompt}\n` +
            `     last checked ${checked}` +
            (w.lastReport ? ` — ${w.lastReport.slice(0, 100).replace(/\n/g, " ")}` : ""),
        );
      }
      break;
    }

    case "watch": {
      const { addWatch, removeWatch, runHeartbeat } = await import("./heartbeat.js");
      const sub = rest[0];
      if (sub === "add") {
        const prompt = rest.slice(1).join(" ").trim();
        if (!prompt) {
          console.error('Usage: enio watch add "does X have a new release"');
          process.exit(1);
        }
        const w = addWatch(prompt);
        console.log(
          `Watching (#${w.id}): ${w.prompt}\n` +
            `The daemon checks every "${config.heartbeatSchedule || "(heartbeat is off)"}" and notifies only when something changed.\n` +
            `Run 'enio daemon' if it is not already running, or 'enio watch run' to check now.`,
        );
      } else if (sub === "rm") {
        const id = Number(rest[1]);
        if (!Number.isInteger(id)) {
          console.error("Usage: enio watch rm <id>");
          process.exit(1);
        }
        console.log(removeWatch(id) ? `Removed watch ${id}.` : `No watch ${id}.`);
      } else if (sub === "run") {
        const results = await runHeartbeat((m) => console.log(m));
        const alerts = results.filter((r) => r.alerted);
        console.log(
          results.length === 0
            ? "Nothing to check — add a watch first."
            : alerts.length === 0
              ? `\nAll quiet — ${results.length} watch(es) checked, nothing new.`
              : `\n${alerts.length} of ${results.length} had news:\n` +
                alerts.map((r) => `  #${r.watch.id}: ${r.report.slice(0, 200)}`).join("\n"),
        );
        break;
      } else {
        console.error("Usage: enio watch <add|rm|run> ...");
        process.exit(1);
      }
      break;
    }

    case "login": {
      const raw = rest[0];
      if (!raw) {
        console.error("Usage: enio login <url>    e.g. enio login github.com");
        process.exit(1);
      }
      const { playwrightAvailable, loginBrowser, browserStatePath } = await import(
        "./tools/browser.js"
      );
      if (!playwrightAvailable()) {
        console.error(
          "Needs Playwright:\n\n    npm install playwright && npx playwright install chromium",
        );
        process.exit(1);
      }
      if (!config.browserPersist) {
        console.error("ENIO_BROWSER_PERSIST=0 is set, so a login would not be kept.");
        process.exit(1);
      }
      const target = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      console.log(
        `Opening a browser window at ${target}.\n` +
          `Log in there, then close the window. The session is saved to\n` +
          `${browserStatePath()} (readable only by you), and the agent's\n` +
          `browser will use it. Your everyday browser is never touched.`,
      );
      await loginBrowser(target);
      console.log("Saved.");
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

  const venvPython = venvPythonPath();
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

  // This is the path the desktop app takes, and the one where starting a
  // duplicate hurts most. A server reading 5GB of weights does not answer HTTP
  // for a minute or more, so serverIsUp() alone reports "nothing there" and a
  // second launch adds another five-gigabyte process beside the first.
  const loading = modelServerPid();
  if (loading !== null) {
    console.log(`A model server is already starting (pid ${loading}) — waiting for it`);
    for (let i = 0; i < WAIT_FOR_EXISTING_TICKS; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await serverIsUp()) {
        console.log(`Ready at ${config.modelBaseUrl}`);
        return;
      }
      if (modelServerPid() === null) break; // it died; start our own below
    }
  }

  const venvPython = requireRuntime();
  console.log(`Starting ${currentModelLabel()} on ${config.modelBaseUrl} ...`);

  // Inheriting is right in a terminal, where the whole point of `enio up` is
  // watching the log. It is wrong when the desktop launched us, because then
  // the inherited handles are pipes into that app -- and when the app quits,
  // the model server dies on SIGPIPE at its next log write, however carefully
  // everything upstream decided to leave it running for somebody else.
  const toTerminal = process.stdout.isTTY;
  const log = toTerminal ? null : openSync(join(config.dataDir, "model-server.log"), "a");
  // Through the setting, like every other path that spawns the server. This
  // one had the Maple path written out, so `enio up` -- the path the desktop
  // takes -- quietly ignored a switched model and booted Maple over it.
  const child = spawn(modelServerBinary(), modelServerArgs(currentModelPath()), {
    cwd: config.runtimeDir,
    stdio: toTerminal ? "inherit" : ["ignore", log!, log!],
  });
  child.on("exit", (code) => process.exit(code ?? 0));

  // Node does not pass its own termination on to children. Without this, a
  // SIGTERM to this wrapper leaves the model server running and reparented --
  // several gigabytes still resident with nothing left that knows about it.
  // Ctrl-C in a terminal happens to work anyway, because the tty signals the
  // whole foreground group; a programmatic kill does not.
  // Named for Activity Monitor. Everything enio runs is prefixed "Enio" so one
  // search finds all of it, and each says which part it is.
  process.title = "Enio Launcher";

  // This wrapper is what the desktop launches, so it stands in for the app as
  // a user of the server.
  registerModelClient();

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      // Someone else is still using it -- a CLI session, or another window.
      // Leave it running: it will be adopted by the next launch, and reaped by
      // whichever process turns out to be last.
      if (unregisterModelClient().length > 0) {
        console.log("Leaving the model server up — another enio process is using it");
        process.exit(0);
      }
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
      process.exit(0);
    });
  }

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

  enio watches             list what the heartbeat is watching
  enio watch add "..."     watch for a change — notifies only when something is new
  enio watch rm ID         stop watching
  enio watch run           check every watch right now

  enio skills              list installed skills
  enio skills NAME         show one in full
  enio skills --new NAME   scaffold a new skill
  enio skills --install-examples
  enio vision [IMAGE]      check vision setup, or read one image
  enio login URL          log in to a site in a visible window; the agent's browser keeps the session
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
