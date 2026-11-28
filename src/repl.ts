import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { config } from "./config.js";
import { activeProject } from "./project.js";
import { runTurn } from "./agent.js";
import { serverIsUp } from "./model.js";
import { claimModelServer } from "./runtime.js";
import { buildRegistry } from "./tools/index.js";
import { closeMcp } from "./tools/mcp.js";
import { closeBrowser } from "./tools/browser.js";
import { setMemorySession } from "./tools/memory.js";
import { setBrowseSession } from "./tools/browse.js";
import { setConversationSession } from "./conversation-attachments.js";
import { setPlanSession } from "./tools/desktop.js";
import { conversationMessages, endSession, indexPending, listConversations, startSession, stats } from "./memory/store.js";
import { completeMention, mentionContext, parseMentions } from "./mentions.js";
import {
  addExemplar,
  addPreference,
  listPreferences,
  removePreference,
} from "./memory/learning.js";
import type { Message } from "./types.js";
import { discardDraft, listDrafts, recordDraftOutcome, renderDraft, sendDraft } from "./outbox.js";
import { approvePlan, getPlan, listPendingPlans, recordPlanOutcome, settlePlan } from "./plans.js";
import { desktopEnabled } from "./tools/desktop.js";
import { canRunMaple, platformLabel, whyNoMaple } from "./platform.js";

/** The advice differs by platform: telling a Linux user to run `enio up` when
 *  MLX cannot exist on their machine is worse than saying nothing. */
function unreachableMessage(): string {
  const where = `Can't reach a model at ${config.modelBaseUrl}.`;

  if (config.backendId === "maple") {
    if (!canRunMaple()) {
      return (
        `\n${where}\n\n${whyNoMaple()}\n` +
        `On ${platformLabel()}, use another engine:\n\n` +
        `    ollama serve\n` +
        `    ollama pull qwen3:8b\n` +
        `    ENIO_BACKEND=ollama ENIO_MODEL=qwen3:8b enio chat\n`
      );
    }
    return (
      `\n${where}\n\nStart it with:  enio start\n` +
      `Or separately:  enio up\n`
    );
  }

  return (
    `\n${where}\n\n` +
    `The '${config.backendId}' backend is selected but nothing is listening there.\n` +
    (config.backendId === "ollama"
      ? `Start Ollama with 'ollama serve', then check the model is pulled:\n` +
        `    ollama pull ${config.modelName}\n`
      : `Start that server, or run 'enio backends' to see the options.\n`)
  );
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

export async function repl(opts: { showThinking: boolean; resume?: string }): Promise<void> {
  if (!(await serverIsUp())) {
    console.error(unreachableMessage());
    process.exit(1);
  }

  // Count this session among the model server's users, so a desktop quitting
  // mid-conversation leaves the server up instead of taking it with it.
  claimModelServer();

  const registry = await buildRegistry((m) => console.log(dim(m)));
  /**
   * --continue picks up a stored conversation instead of opening a new one:
   * same session id, so new turns log to the same transcript, and the old
   * messages are loaded as context so "as I said earlier" still resolves.
   */
  let sessionId: string;
  let resumed: Message[] = [];
  if (opts.resume) {
    const all = listConversations();
    const match =
      opts.resume === "latest"
        ? all[0]
        : all.find((c) => c.id.startsWith(opts.resume!));
    if (!match) {
      console.error(
        opts.resume === "latest"
          ? "Nothing to continue — no stored conversations."
          : `No conversation starting with "${opts.resume}". Try: enio chats`,
      );
      process.exit(1);
    }
    sessionId = match.id;
    resumed = conversationMessages(sessionId).map((m) => ({
      role: m.role as Message["role"],
      content: m.content,
    }));
    console.log(
      `[2mcontinuing "${match.title}" — ${resumed.length} earlier messages in context[0m`,
    );
  } else {
    sessionId = startSession();
  }
  setMemorySession(sessionId);
  setPlanSession(sessionId);
  setBrowseSession(sessionId);
  setConversationSession(sessionId);

  const s = stats();
  console.log(
    `\n${green("enio")} ${dim(`· ${registry.all.length} tools · ${s.facts} facts · ${s.entities} entities`)}`,
  );
  const project = activeProject();
  if (project) {
    const attached = project.attachments.map((a) => a.alias).join(", ") || "nothing attached yet";
    console.log(dim(`project: ${project.name} (${project.type}) · ${attached}`));
    console.log(dim(`generated files go to the project; conversation attachments stay readable`));
  } else {
    console.log(dim(`workspace: ${config.workspace}`));
  }
  console.log(dim(`/help for commands · tab completes /skills and @mentions · ctrl-C to quit\n`));

  // Tab completion is what makes /skill and @mention discoverable. Without it
  // you have to already know the names, which defeats the point.
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    completer: (line: string) => completeMention(line, mentionContext(registry)),
  });
  const history: Message[] = [...resumed];
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
      const handled = await handleCommand(input, { history, showThinking, lastExchange, sessionId });
      if (handled.exit) break;
      if (handled.toggleThinking !== undefined) showThinking = handled.toggleThinking;
      continue;
    }

    // Resolve /skill and @mentions before the turn. Anything unrecognised stays
    // as literal text, so an email address is never eaten.
    const mentions = parseMentions(input, mentionContext(registry));
    if (mentions.skills.length > 0) {
      stdout.write(dim(`  using skill: ${mentions.skills.map((s) => s.name).join(", ")}\n`));
    }
    if (mentions.files.length > 0) {
      stdout.write(dim(`  attached: ${mentions.files.join(", ")}\n`));
    }
    if (mentions.unresolved.length > 0) {
      stdout.write(
        dim(`  (no skill, agent or file called ${mentions.unresolved.join(", ")} — left as text)\n`),
      );
    }

    let streamedAny = false;
    let inThinking = false;
    const turnStartedAt = Date.now();

    try {
      const turn = await runTurn(mentions.text || input, history, registry, sessionId, {
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
      }, {
        specialist: mentions.specialist,
        skills: mentions.skills,
        files: mentions.files,
        servers: mentions.servers,
      });
      lastExchange = { question: turn.question, answer: turn.reply };
      stdout.write(streamedAny ? "\n\n" : dim("\n(no response)\n\n"));
      // The window has buttons under a written message; this is where the
      // terminal's are.
      if (turn.reply.startsWith("I wrote this message.")) stdout.write(dim("  /send to send it · /drop to discard it\n\n"));
      else if (listPendingPlans().some((p) => p.sessionId === sessionId && p.createdAt >= turnStartedAt)) {
        stdout.write(dim("  /run to see what it would run · /discard to drop it\n\n"));
      }
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
    sessionId: string;
  },
): Promise<{ exit?: boolean; toggleThinking?: boolean }> {
  const [cmd, ...args] = input.split(/\s+/);
  const rest = args.join(" ").trim();

  switch (cmd) {
    case "/help":
      console.log(
        [
          "",
          "  /<skill>    run a skill directly (tab to list them)",
          "  @<name>     send to an agent, attach a file, or allow an MCP server",
          "",
          "  /help       this message",
          "  /send       send the message Enio wrote in this conversation",
          "  /drop       discard it",
          "  /run        run the plan Enio proposed in this conversation",
          "  /discard    discard it",
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

    case "/send":
    case "/drop": {
      // The terminal's Send and Discard. With no card to press, the
      // message is printed again first and the command is the consent --
      // which is why it acts only when exactly one is waiting here, or
      // the one is named: "send" must never mean "whichever".
      const waiting = listDrafts({ status: "pending", sessionId: ctx.sessionId });
      // By id: at least four characters, and only when one waiting
      // message starts that way (findDraft's rule). "/send 1" typed for
      // "the first one" sent whichever id began with a 1.
      const starts = rest.length >= 4 ? waiting.filter((d) => d.id.startsWith(rest.toLowerCase())) : [];
      const draft = rest ? (starts.length === 1 ? starts[0] : undefined) : waiting.length === 1 ? waiting[0] : undefined;
      if (!draft) {
        console.log(
          waiting.length === 0
            ? dim("  no message is waiting in this conversation\n")
            : "\n" + waiting.map((d) => `  ${d.id.slice(0, 8)}  to ${d.to.join(", ")}: ${d.subject}`).join("\n") + dim(`\n  ${rest ? "no one waiting message has that id" : "more than one is waiting"}: ${cmd} ID, with the id as shown\n`),
        );
        return {};
      }
      console.log("\n" + renderDraft(draft).split("\n").map((l) => `  ${l}`).join("\n") + "\n");
      const done = cmd === "/send" ? await sendDraft(draft.id, draft.revision) : discardDraft(draft.id);
      if (!done.ok) {
        console.log(yellow(`  ${done.message}\n`));
        return {};
      }
      const said = recordDraftOutcome(done.draft);
      // The next turn's model reads the thread, so it is told too.
      ctx.history.push({ role: "assistant", content: said });
      console.log(green(`  ${said}\n`));
      return {};
    }

    case "/run":
    case "/discard": {
      // The terminal's Run and Discard for a proposed plan. The window
      // shows each step's script in a sheet before it runs; here they are
      // printed, whole, and running takes the command a second time with
      // the plan's id -- reading what will run comes before consenting to
      // it, and one command cannot be both.
      const waiting = listPendingPlans().filter((p) => p.sessionId === ctx.sessionId);
      const begun = rest.length >= 4 ? waiting.filter((p) => p.id.startsWith(rest.toLowerCase())) : [];
      const plan = rest ? (begun.length === 1 ? begun[0] : undefined) : waiting.length === 1 ? waiting[0] : undefined;
      if (!plan) {
        console.log(
          waiting.length === 0
            ? dim("  no plan is waiting in this conversation\n")
            : "\n" + waiting.map((p) => `  ${p.id.slice(0, 8)}  ${p.summary}`).join("\n") + dim(`\n  more than one is waiting: ${cmd} ID\n`),
        );
        return {};
      }
      if (cmd === "/discard") {
        settlePlan(plan.id, "declined");
        const said = `You discarded the plan: ${plan.summary}. Nothing ran.`;
        ctx.history.push({ role: "assistant", content: said });
        console.log(dim(`  ${said}\n`));
        return {};
      }
      if (!rest) {
        console.log(
          "\n" +
            plan.steps.map((st, i) => `  ${i + 1}. ${st.summary}\n${st.script.split("\n").map((l) => `       ${l}`).join("\n")}`).join("\n") +
            dim(`\n\n  nothing has run. To run exactly this: /run ${plan.id.slice(0, 8)}\n`),
        );
        return {};
      }
      // As the approve route: a composed plan needs desktop control, and
      // the one that only opens an app nobody asked for does not.
      if (!desktopEnabled() && plan.source !== "open") {
        console.log(yellow("  Desktop control is switched off, so this plan cannot run. Start enio with ENIO_DESKTOP=1.\n"));
        return {};
      }
      const stored = getPlan(plan.id);
      if (!stored || stored.status !== "pending") {
        console.log(dim("  that plan is no longer waiting\n"));
        return {};
      }
      const said = recordPlanOutcome(stored, await approvePlan(stored));
      ctx.history.push({ role: "assistant", content: said });
      console.log(`\n${said.split("\n").map((l) => `  ${l}`).join("\n")}\n`);
      return {};
    }

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
