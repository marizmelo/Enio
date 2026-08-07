#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { ensureToken } from "./auth.js";
import { join } from "node:path";
import { activeBackend, config, ensureDirs } from "./config.js";
import { canRunMaple, whyNoMaple } from "./platform.js";
import { ensureBackend, type RunningBackend } from "./runtime.js";
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
