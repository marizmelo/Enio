import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { config } from "./config.js";
import { runTurn } from "./agent.js";
import { serverIsUp } from "./model.js";
import { buildRegistry } from "./tools/index.js";
import { closeMcp } from "./tools/mcp.js";
import { closeBrowser } from "./tools/browser.js";
import { setMemorySession } from "./tools/memory.js";
import { endSession, indexPending, startSession, stats } from "./memory/store.js";
import {
  addExemplar,
  addPreference,
  listPreferences,
  removePreference,
} from "./memory/learning.js";
import type { Message } from "./types.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

export async function repl(opts: { showThinking: boolean }): Promise<void> {
  if (!(await serverIsUp())) {
    console.error(
      `\nCan't reach the model at ${config.modelBaseUrl}.\n` +
        `Start it with:  enio up\n` +
        `Or manually:    cd ${config.runtimeDir} && source .venv/bin/activate && ` +
        `python -m mlx_lm.server --model ./maple-2bit-mlx --trust-remote-code --flash-head --port 8080\n`,
    );
    process.exit(1);
  }

  const registry = await buildRegistry((m) => console.log(dim(m)));
  const sessionId = startSession();
  setMemorySession(sessionId);

  const s = stats();
  console.log(
    `\n${green("enio")} ${dim(`· ${registry.all.length} tools · ${s.facts} facts · ${s.entities} entities`)}`,
  );
  console.log(dim(`workspace: ${config.workspace}`));
  console.log(dim(`/help for commands, ctrl-C to quit\n`));

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const history: Message[] = [];
  let showThinking = opts.showThinking;
  /** Kept so /good can turn the last exchange into a training exemplar. */
  let lastExchange: { question: string; answer: string } | null = null;

  const shutdown = async () => {
    endSession(sessionId);
    rl.close();
    console.log(dim("\nIndexing this conversation into memory..."));
    try {
      const report = await indexPending((m) => console.log(dim(`  ${m}`)));
      console.log(dim(`Done: ${report.triples} facts extracted.\n`));
    } catch (err) {
      console.log(dim(`Indexing failed: ${(err as Error).message}\n`));
    }
    await closeMcp();
    await closeBrowser();
    process.exit(0);
  };

  rl.on("SIGINT", () => void shutdown());

  for (;;) {
    let input: string;
    try {
      input = (await rl.question(cyan("› "))).trim();
    } catch {
      break; // stream closed
    }
    if (!input) continue;

    if (input.startsWith("/")) {
      const handled = await handleCommand(input, { history, showThinking, lastExchange });
      if (handled.exit) break;
      if (handled.toggleThinking !== undefined) showThinking = handled.toggleThinking;
      continue;
    }

    let streamedAny = false;
    let inThinking = false;

    try {
      const turn = await runTurn(input, history, registry, sessionId, {
        onRoute(specialist) {
          stdout.write(dim(`  → ${specialist}\n`));
        },
        onReasoning(delta) {
          if (!showThinking) return;
          if (!inThinking) {
            stdout.write(dim("\n  thinking: "));
            inThinking = true;
          }
          stdout.write(dim(delta));
        },
        onContent(delta) {
          if (inThinking) {
            stdout.write("\n\n");
            inThinking = false;
          }
          streamedAny = true;
          stdout.write(delta);
        },
        onToolStart(name, args) {
          if (inThinking) {
            stdout.write("\n");
            inThinking = false;
          }
          const preview = JSON.stringify(args);
          stdout.write(
            yellow(`\n  ⚒ ${name}`) +
              dim(` ${preview.length > 120 ? preview.slice(0, 120) + "…" : preview}\n`),
          );
        },
        onToolEnd(_name, result) {
          const firstLine = result.split("\n")[0] ?? "";
          stdout.write(
            dim(`    ↳ ${firstLine.slice(0, 120)}${result.length > 120 ? "…" : ""}\n`),
          );
        },
        onNotice(text) {
          stdout.write(yellow(`\n  ! ${text}\n`));
        },
      });
      lastExchange = { question: turn.question, answer: turn.reply };
      stdout.write(streamedAny ? "\n\n" : dim("\n(no response)\n\n"));
    } catch (err) {
      stdout.write(`\n${yellow("Error:")} ${(err as Error).message}\n\n`);
    }
  }

  await shutdown();
}

async function handleCommand(
  input: string,
  ctx: {
    history: Message[];
    showThinking: boolean;
    lastExchange: { question: string; answer: string } | null;
  },
): Promise<{ exit?: boolean; toggleThinking?: boolean }> {
  const [cmd, ...args] = input.split(/\s+/);
  const rest = args.join(" ").trim();

  switch (cmd) {
    case "/help":
      console.log(
        [
          "",
          "  /help       this message",
          "  /good       save the last answer as an example to imitate",
          "  /pref TEXT  add a standing instruction (no TEXT lists them)",
          "  /unpref ID  remove one",
          "  /clear      forget the current conversation (memory on disk is kept)",
          "  /think      toggle showing the model's reasoning",
          "  /stats      what's in memory",
          "  /quit       exit and index this conversation",
          "",
        ].join("\n"),
      );
      return {};

    case "/good": {
      if (!ctx.lastExchange) {
        console.log(dim("  nothing to save yet\n"));
        return {};
      }
      const result = await addExemplar(ctx.lastExchange.question, ctx.lastExchange.answer);
      console.log(
        result.added
          ? green("  saved — similar questions will follow this example\n")
          : dim(`  not saved (${result.reason})\n`),
      );
      return {};
    }

    case "/pref": {
      if (!rest) {
        const prefs = listPreferences();
        console.log(
          prefs.length === 0
            ? dim("  no standing instructions set\n")
            : "\n" + prefs.map((p) => `  ${String(p.id).padStart(3)}  ${p.text}`).join("\n") + "\n",
        );
        return {};
      }
      const result = addPreference(rest);
      console.log(result.added ? green(`  set: ${rest}\n`) : dim(`  not set (${result.reason})\n`));
      return {};
    }

    case "/unpref":
      console.log(removePreference(rest) ? dim("  removed\n") : dim("  no match\n"));
      return {};

    case "/clear":
      ctx.history.length = 0;
      console.log(dim("  conversation cleared\n"));
      return {};

    case "/think":
      console.log(dim(`  thinking ${ctx.showThinking ? "hidden" : "shown"}\n`));
      return { toggleThinking: !ctx.showThinking };

    case "/stats": {
      const s = stats();
      console.log(
        "\n" +
          Object.entries(s)
            .map(([k, v]) => `  ${k.padEnd(12)} ${v}`)
            .join("\n") +
          "\n",
      );
      return {};
    }

    case "/quit":
    case "/exit":
      return { exit: true };

    default:
      console.log(dim(`  unknown command ${cmd} — try /help\n`));
      return {};
  }
}
