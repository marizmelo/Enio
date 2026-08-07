#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { ensureToken } from "./auth.js";
import { join } from "node:path";
import { activeBackend, config, ensureDirs } from "./config.js";
import { BACKENDS } from "./backends.js";
import {
  addPreference,
  listExemplars,
  listPreferences,
  removePreference,
} from "./memory/learning.js";
import { repl } from "./repl.js";
import { serve } from "./server.js";
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
    case "chat":
      await repl({ showThinking: rest.includes("--think") });
      break;

    case "serve":
      await serve();
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
        console.error('Usage: maple remember "some durable fact"');
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
        console.error('Usage: maple graph "topic"');
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
      console.log(`Switch with:  MAPLE_BACKEND=ollama MAPLE_MODEL=qwen3:8b maple chat`);
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
        console.error('Usage: maple pref "answer concisely"');
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

/** Launch mlx_lm.server from the checkout the setup script produced, and wait
 *  until it actually answers before returning. */
async function startModelServer(): Promise<void> {
  if (await serverIsUp()) {
    console.log(`Model server already running at ${config.modelBaseUrl}`);
    return;
  }

  const venvPython = join(config.mapleDir, ".venv", "bin", "python");
  if (!existsSync(venvPython)) {
    console.error(
      `No Python environment at ${venvPython}.\n` +
        `Run the Maple setup script first, or set MAPLE_DIR to your checkout.`,
    );
    process.exit(1);
  }

  const modelPath = join(config.mapleDir, "maple-2bit-mlx");
  console.log(`Starting mlx_lm.server on ${config.modelBaseUrl} ...`);

  const child = spawn(
    venvPython,
    [
      "-m", "mlx_lm.server",
      "--model", modelPath,
      "--trust-remote-code",
      "--flash-head",
      "--port", "8080",
    ],
    { cwd: config.mapleDir, stdio: "inherit" },
  );

  child.on("exit", (code) => process.exit(code ?? 0));

  // First load pages ~5GB off disk, so allow a generous window.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await serverIsUp()) {
      console.log(`\nReady. In another terminal: maple chat\n`);
      return;
    }
  }
  console.error("Server did not become ready within two minutes.");
}

function printHelp(): void {
  console.log(`
maple — a local agent with tools and persistent memory

  maple up                 start the Maple model server (leave running)
  maple chat [--think]     interactive chat with tools and memory
  maple serve              expose an OpenAI-compatible endpoint on :${config.agentPort}

  maple index              summarise and extract from unindexed conversations
  maple reindex            rebuild the whole graph from the raw log
  maple stats              what memory currently holds
  maple graph "topic"      show what the graph knows about something
  maple remember "..."     pin a fact by hand
  maple forget "..."       remove a fact

  maple prefs              list standing instructions
  maple pref "..."         add one
  maple unpref ID          remove one
  maple examples           list saved answer examples

  maple token              print the API key for the HTTP endpoint
  maple token --rotate     generate a new one, invalidating the old
  maple backends           list model backends and how to switch
  maple tools              list every tool, built-in and MCP
  maple mcp-init           write a starter mcp.json

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
