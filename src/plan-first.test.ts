process.env.ENIO_DESKTOP = "1";

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Plan first: what Enio would do to the machine is shown before it is
 * done. An app the person did not ask to have opened is proposed, not
 * opened; a proposed plan ends the turn; a plan can be set aside and
 * written again; a saved script comes back for the same request without a
 * model; and what a run did is said in the thread.
 *
 * Nothing here may open an app or drive one. `open`, `pgrep` and
 * `osascript` are stand-ins first on PATH: `open` writes down what it was
 * asked to open, and `pgrep` answers from a file this test controls.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-plan-first-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });
const bin = join(scratch, "bin");
mkdirSync(bin);
const openedLog = join(scratch, "opened.log");
const runningFlag = join(scratch, "running");
const script = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
// Opening makes the app "run", as the real one would.
script("open", `echo "$@" >> "${openedLog}"\ntouch "${runningFlag}"`);
script("pgrep", `[ -f "${runningFlag}" ] && exit 0\nexit 1`);
// The system's default browser is Safari here (asked of NSWorkspace);
// every other script answers with nothing, so nothing is "running".
script("osascript", `case "$*" in *NSWorkspace*) echo "/Applications/Safari.app";; *) echo "";; esac`);
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;

const notMac = process.platform !== "darwin";
const plans = await import("./plans.js");
const store = await import("./memory/store.js");
const { getDb, closeDb } = await import("./memory/db.js");
const { runTurn, openAsked } = await import("./agent.js");
const { buildDesktopTools, setPlanSession, planReply } = await import("./tools/desktop.js");
const { SPECIALISTS } = await import("./specialists.js");
after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

const opened = () => (existsSync(openedLog) ? readFileSync(openedLog, "utf8").trim().split("\n").filter(Boolean) : []);
const machine = (running: boolean) => {
  rmSync(openedLog, { force: true });
  if (running) writeFileSync(runningFlag, "");
  else rmSync(runningFlag, { force: true });
};

type Call = { name: string; args: unknown };
type Reply = { content?: string; tool?: Call };
// A reply may carry both: the model narrating beside its call.
const realFetch = globalThis.fetch;
/** A scripted model: each request takes the next reply. */
function scripted(replies: Reply[]) {
  const queue = [...replies];
  const asked: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (/huggingface/.test(String(url))) throw new Error("no network in tests");
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: unknown }> };
    asked.push(String([...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? ""));
    const next = queue.shift() ?? { content: "(done)" };
    const delta = next.tool
      ? { ...(next.content ? { content: next.content } : {}), tool_calls: [{ index: 0, id: "call_0", function: { name: next.tool.name, arguments: JSON.stringify(next.tool.args) } }] }
      : { content: next.content };
    return new Response(
      new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return asked;
}

const tools = notMac ? [] : buildDesktopTools();
const registry = { all: tools, byName: new Map(tools.map((t) => [t.name, t])), dropped: [] };

function conversation() {
  const sid = store.startSession();
  let history: Parameters<typeof runTurn>[1] = [];
  const turn = async (text: string, replies: Reply[], overrides: Record<string, unknown> = { specialist: "operator" }) => {
    const asked = scripted(replies);
    const widgets: Array<{ type: string; id?: string; source?: string | null; request?: string | null }> = [];
    setPlanSession(sid);
    try {
      const result = await runTurn(text, history, registry as never, sid, { onWidget: (w) => widgets.push(w as never) }, overrides);
      history = result.messages;
      return { reply: result.reply, asked, widgets };
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const waiting = () => plans.listPendingPlans().filter((p) => p.sessionId === sid);
  const thread = () =>
    (getDb().prepare(`SELECT role, content FROM messages WHERE session_id = ? ORDER BY id`).all(sid) as Array<{ role: string; content: string }>);
  return Object.assign(turn, { sid, waiting, thread });
}

describe("whether the person asked for an app to be opened", () => {
  test("a word for opening, and the app by name", () => {
    const asked: Array<[string, string]> = [
      ["open chrome", "Google Chrome"],
      ["Open Chrome and check my mail", "Google Chrome"],
      ["launch spotify please", "Spotify"],
      ["can you start the Notes app", "Notes"],
      ["switch to Visual Studio Code", "Visual Studio Code"],
      ["bring up the calendar", "Calendar"],
      ["open my browser", "Safari"],
      ["open the browser and go to the news", "Google Chrome"],
      ["go to System Settings", "System Settings"],
      // A name with no long word, and a long name the way it is typed.
      ["open TV and play the next episode", "TV"],
      ["open vscode and show me the diff", "Visual Studio Code"],
      ["launch visualstudiocode", "Visual Studio Code"],
    ];
    for (const [message, app] of asked) assert.equal(openAsked(message, app), true, `${message} / ${app}`);

    const unasked: Array<[string, string]> = [
      ["check browser for my email and give me a summary", "Safari"],
      ["check browser for my email and give me a summary", "Google Chrome"],
      ["what's on my calendar today", "Calendar"],
      ["write a note with my grocery list", "Notes"],
      ["play some jazz", "Music"],
      // A word for opening, about something else.
      ["open the pod bay doors", "Terminal"],
      ["start a timer for ten minutes", "Clock"],
      ["run the numbers on this", "Numbers"],
      // The app named before the word, about something else.
      ["is Chrome the reason my laptop won't start", "Google Chrome"],
      // The maker's name is not the app.
      ["open google", "Google Chrome"],
      ["open the browser", "Notes"],
      ["what is on tv tonight", "TV"],
      ["", "Notes"],
    ];
    for (const [message, app] of unasked) assert.equal(openAsked(message, app), false, `${message} / ${app}`);
  });

  test('"open it" is asked only when the reply before named the app', () => {
    assert.equal(openAsked("yes, open it", "Notes", "To do that I would open Notes. It is not open."), true);
    assert.equal(openAsked("yes, open it", "Notes", "Here is the weather."), false);
    assert.equal(openAsked("yes, open it", "Notes"), false);
    assert.equal(openAsked("go on", "Notes", "To do that I would open Notes."), false);
  });
});

describe("the same request again finds the script saved for it", () => {
  const recipe = (name: string, request: string | null) => ({ name, summary: name, script: "true", kind: "shell" as const, safe: false, request });
  const saved = [
    recipe("morning_music", "play my morning playlist in Music"),
    recipe("alarm_7", "set an alarm for 7 tomorrow morning"),
    recipe("note_groceries", 'make a note called "Groceries" with milk and eggs'),
    recipe("by_hand", null),
  ];
  test("the same words that matter in the same order, and every number and quoted phrase the same", () => {
    const hit = (request: string) => plans.matchSavedRecipe(request, saved)?.name ?? null;
    assert.equal(hit("play my morning playlist in Music"), "morning_music");
    // Only the dressing differs: politeness, an article, a plural, case.
    assert.equal(hit("Please play the morning playlist in music"), "morning_music");
    assert.equal(hit("can you play morning playlists in Music?"), "morning_music");
    assert.equal(hit("set an alarm for 7 tomorrow morning"), "alarm_7");
    assert.equal(hit('make a note called "Groceries" with milk and eggs'), "note_groceries");
    assert.equal(hit('Make a note called “groceries” with milk and eggs'), "note_groceries");

    // A different number or a different quoted phrase is a different request.
    assert.equal(hit("set an alarm for 8 tomorrow morning"), null);
    assert.equal(hit("set an alarm tomorrow morning"), null);
    assert.equal(hit('make a note called "Hardware" with milk and eggs'), null);
    // One word changed, added or left out is a different request.
    assert.equal(hit("play my evening playlist in Music"), null);
    assert.equal(hit("play my morning jazz playlist in Music"), null);
    assert.equal(hit("play my playlist in Music"), null);
    assert.equal(hit("play my morning playlist in Music on repeat"), null);
    assert.equal(hit("stop the music"), null);
    assert.equal(hit("what is my morning playlist"), null);
    // Too short to mean one thing.
    assert.equal(hit("music"), null);
    assert.equal(hit(""), null);
  });

  test("a request turned around is not the same request", () => {
    // Each pair shares every word but the one that reverses it, or shares
    // them all in another order. The first version of this match offered
    // the script saved for the first to someone asking for the second.
    const pairs: Array<[string, string]> = [
      ["turn on dark mode in system settings", "turn off dark mode in system settings"],
      ["turn the volume up on my mac speakers", "turn the volume down on my mac speakers"],
      ["export the keynote deck with speaker notes as pdf", "export the keynote deck without speaker notes as pdf"],
      ["move the report from Desktop to Documents", "move the report from Documents to Desktop"],
      ["zoom in on the map", "zoom out on the map"],
      ["do not disturb me after ten", "disturb me after ten"],
      ["rename report to summary", "rename summary to report"],
    ];
    for (const [savedFor, asked] of pairs) {
      const one = [recipe("the_first", savedFor)];
      assert.equal(plans.matchSavedRecipe(savedFor, one)?.name, "the_first", savedFor);
      assert.equal(plans.matchSavedRecipe(asked, one), null, `${savedFor} / ${asked}`);
    }
  });

  test("accents and capitals are not differences, and a request is kept as it was typed", () => {
    const typed = 'Crie uma nota chamada "Relatório São Paulo" para a Reunião';
    const one = [recipe("nota", typed)];
    assert.equal(plans.matchSavedRecipe('crie uma nota chamada "relatorio sao paulo" para a reuniao', one)?.name, "nota");
    assert.equal(plans.matchSavedRecipe('Crie uma nota chamada "Relatório Rio" para a Reunião', one), null);
    // The plan row holds the person's own words, which is what Try again asks again.
    const sid = store.startSession();
    const plan = plans.proposePlan({ sessionId: sid, summary: "Nota", kind: "shell", steps: [{ summary: "x", script: "true", kind: "shell" }], request: typed });
    assert.deepEqual(plans.retryPlan(plan.id), { ok: true, request: typed });
  });

  test("a script written by hand is never matched, and two that fit equally are no match", () => {
    assert.equal(plans.matchSavedRecipe("by hand", saved), null);
    // One word is not a request, even when a script was saved for exactly it.
    assert.equal(plans.matchSavedRecipe("music", [recipe("just_music", "music")]), null);
    assert.equal(plans.matchSavedRecipe("play music", [recipe("play_music", "play music")])?.name, "play_music");
    const twins = [recipe("one", "play my morning playlist in Music"), recipe("two", "play the morning playlist in music")];
    assert.equal(plans.matchSavedRecipe("play my morning playlist in Music", twins), null);
  });
});

describe("try again, and what a run did", () => {
  test("a plan set aside is found for the same request in the same conversation only", () => {
    const sid = store.startSession();
    const other = store.startSession();
    const steps = [{ summary: "say hi", script: "echo hi", kind: "shell" as const }];
    const plan = plans.proposePlan({ sessionId: sid, summary: "Say hi", kind: "shell", steps, request: "say hi to the terminal" });
    assert.deepEqual(plans.plansSetAside(sid, "say hi to the terminal"), []);

    assert.deepEqual(plans.retryPlan(plan.id), { ok: true, request: "say hi to the terminal" });
    assert.equal(plans.getPlan(plan.id)!.status, "declined");
    assert.deepEqual(plans.plansSetAside(sid, "say hi to the terminal").map((p) => p.id), [plan.id]);
    assert.deepEqual(plans.plansSetAside(other, "say hi to the terminal"), []);
    assert.deepEqual(plans.plansSetAside(sid, "say something else"), []);
    assert.deepEqual(plans.plansSetAside(sid, ""), []);

    // Once only, and only what can be asked again.
    assert.deepEqual(plans.retryPlan(plan.id), { ok: false, reason: "This plan was already declined." });
    assert.equal(plans.retryPlan("00000000-0000-4000-8000-000000000000").ok, false);
    const unrecorded = plans.proposePlan({ sessionId: sid, summary: "No request", kind: "shell", steps });
    const refused = plans.retryPlan(unrecorded.id);
    assert.ok(!refused.ok && /does not record what was asked/.test(refused.reason));
    assert.equal(plans.getPlan(unrecorded.id)!.status, "pending", "a plan that cannot be retried is left waiting");
    // A plan discarded outright is not one set aside.
    const discarded = plans.proposePlan({ sessionId: sid, summary: "x", kind: "shell", steps, request: "discard me" });
    plans.settlePlan(discarded.id, "declined");
    assert.deepEqual(plans.plansSetAside(sid, "discard me"), []);
  });

  test("the outcome is written into the conversation from the steps' own results", async () => {
    const sid = store.startSession();
    const steps = [
      { summary: "say hi", script: "echo hello from step one", kind: "shell" as const },
      { summary: "count", script: "echo 42", kind: "shell" as const },
    ];
    const plan = plans.proposePlan({ sessionId: sid, summary: "Say hi and count", kind: "shell", steps, request: "say hi and count" });
    const outcome = await plans.approvePlan(plan);
    const reply = plans.recordPlanOutcome(plan, outcome);
    assert.equal(reply, "You ran the plan: Say hi and count\n\n1. say hi — done\n   hello from step one\n2. count — done\n   42");
    const thread = getDb().prepare(`SELECT role, content FROM messages WHERE session_id = ? ORDER BY id`).all(sid) as Array<{ role: string; content: string }>;
    assert.deepEqual(thread.at(-1), { role: "assistant", content: reply });
    const turn = getDb().prepare(`SELECT specialist, system_prompt AS prompt FROM turns WHERE session_id = ?`).get(sid) as { specialist: string; prompt: string };
    assert.deepEqual(turn, { specialist: "operator", prompt: "(harness: plan_run)" });
  });

  test("a plan that stops says where, what already ran and what did not", async () => {
    const sid = store.startSession();
    const steps = [
      { summary: "first", script: "echo one", kind: "shell" as const },
      { summary: "second", script: "echo broke >&2; exit 3", kind: "shell" as const },
      { summary: "third", script: "echo never", kind: "shell" as const },
    ];
    const plan = plans.proposePlan({ sessionId: sid, summary: "Three steps", kind: "shell", steps, request: "do three things" });
    const outcome = await plans.approvePlan(plan);
    const reply = plans.planOutcomeReply(plan, outcome);
    assert.match(reply, /^The plan stopped at step 2 of 3: Three steps\n\n1\. first — done\n {3}one\n2\. second — failed\n/);
    assert.match(reply, /The steps before it already ran\. The step after it did not run\.$/);
    assert.doesNotMatch(reply, /never/);
  });

  test("an opened app says the rest is still owed; a saved one says how it comes back", () => {
    const results = [{ step: 1, summary: "Open Chess", output: "", ok: true }];
    const base = { id: "p", sessionId: "s", summary: "Open Chess", kind: "applescript" as const, payload: "[]", status: "approved" as const, result: null, createdAt: 0 };
    const ran = { status: "approved" as const, savedAs: null, results, ranSteps: 1, totalSteps: 1, output: "" };
    assert.match(plans.planOutcomeReply({ ...base, source: "open", request: "check the board" }, ran), /That was the first step of what you asked\. Say "go on" and I will carry on with it\.$/);
    assert.doesNotMatch(plans.planOutcomeReply({ ...base, source: null, request: "open chess" }, ran), /go on/);
    // "Ask again and it is offered" only when it will be: the script kept
    // a request, and one long enough to be matched.
    const saved = { ...ran, status: "saved" as const, savedAs: "open_chess" };
    assert.match(plans.planOutcomeReply({ ...base, request: "open chess for me" }, saved), /Saved as the script "open_chess"\. Ask for the same thing again and it is offered/);
    assert.match(plans.planOutcomeReply(base, saved), /Saved as the script "open_chess"\.$/);
    assert.match(plans.planOutcomeReply({ ...base, request: "mute" }, saved), /Saved as the script "open_chess"\.$/);
    assert.match(plans.planOutcomeReply({ ...base, source: "open", request: "check the chess board" }, saved), /Saved as the script "open_chess"\.\n\nThat was the first step/);
  });

  test("a script saved from a plan keeps what the plan was asked for, and an edit does not forget it", async () => {
    const sid = store.startSession();
    const plan = plans.proposePlan({ sessionId: sid, summary: "Count", kind: "shell", steps: [{ summary: "count", script: "echo 1", kind: "shell" }], request: "count to one for me" });
    await plans.approvePlan(plan, { saveAs: "count_one" });
    assert.equal(plans.listSavedRecipes().find((r) => r.name === "count_one")!.request, "count to one for me");
    plans.saveRecipe({ name: "count_one", summary: "Count", script: "echo 1 # edited", kind: "shell" });
    const after = plans.listSavedRecipes().find((r) => r.name === "count_one")!;
    assert.deepEqual({ script: after.script, request: after.request }, { script: "echo 1 # edited", request: "count to one for me" });
    plans.forgetRecipe("count_one");

    // An app Enio went to open is a first step, not the answer: saved, it
    // does not keep the request, or the same question would be answered
    // from then on by an offer to open the app.
    const first = plans.proposePlan({ sessionId: sid, summary: "Say one", kind: "shell", steps: [{ summary: "one", script: "echo 1", kind: "shell" }], request: "what does the chess board look like", source: "open" });
    await plans.approvePlan(first, { saveAs: "say_one" });
    assert.equal(plans.listSavedRecipes().find((r) => r.name === "say_one")!.request ?? null, null);
    assert.equal(plans.matchSavedRecipe("what does the chess board look like"), null);
    plans.forgetRecipe("say_one");
  });

  test("the plan that runs with desktop control off is exactly an app being opened", () => {
    const sid = store.startSession();
    const open = 'do shell script "open -a " & quoted form of "Chess"';
    const make = (steps: Array<{ summary: string; script: string; kind?: "applescript" | "shell" | "python" }>, source: string | null) =>
      plans.proposePlan({ sessionId: sid, summary: "Open Chess", kind: "applescript", steps, source });
    assert.equal(plans.opensAnAppOnly(make([{ summary: "Open Chess", script: open }], "open")), true);
    // The label alone is not enough.
    assert.equal(plans.opensAnAppOnly(make([{ summary: "Open Chess", script: open }], null)), false);
    assert.equal(plans.opensAnAppOnly(make([{ summary: "Open Chess", script: open }], "saved:open_chess")), false);
    // Nor is the label with other text under it: the steps of a pending
    // plan can be replaced, and the label stays.
    const edited = make([{ summary: "Open Chess", script: open }], "open");
    plans.replacePlanSteps(edited.id, [{ summary: "Open Chess", script: `${open}\ndo shell script "rm -rf ~/x"` }]);
    assert.equal(plans.opensAnAppOnly(plans.getPlan(edited.id)!), false);
    assert.equal(plans.opensAnAppOnly(make([{ summary: "x", script: "open -a Chess", kind: "shell" }], "open")), false);
    assert.equal(plans.opensAnAppOnly(make([{ summary: "x", script: 'do shell script "open -a " & quoted form of "Chess" & "; rm -rf ~"' }], "open")), false);
    assert.equal(plans.opensAnAppOnly(make([{ summary: "a", script: open }, { summary: "b", script: open }], "open")), false);
  });
});

describe("a turn ends on the plan, and an unasked open is one", () => {
  test("the operator's prompt says what open_app does when the open was not asked for", () => {
    const operator = SPECIALISTS.find((s) => s.name === "operator")!;
    assert.match(operator.systemPrompt, /open_app opens an app the user asked to open\./);
    assert.doesNotMatch(operator.systemPrompt, /that alone needs no plan/);
  });

  test("an app nobody asked to open is proposed, and nothing opens", { skip: notMac }, async () => {
    machine(false);
    const chat = conversation();
    const out = await chat("what does the chess board look like right now", [{ tool: { name: "open_app", args: { app: "Chess" } } }, { content: "I opened Chess." }]);
    assert.deepEqual(opened(), [], "nothing was opened");
    assert.equal(out.asked.length, 1, "the turn ends on the plan: the model is not asked again");
    assert.match(out.reply, /^To do that I would open Chess\. It is not open, and you did not ask me to open it, so nothing has run/);
    const [plan] = chat.waiting();
    assert.deepEqual(
      { summary: plan!.summary, source: plan!.source, request: plan!.request, steps: plan!.steps.length },
      { summary: "Open Chess", source: "open", request: "what does the chess board look like right now", steps: 1 },
    );
    assert.match(plan!.steps[0]!.script, /open -a " & quoted form of "Chess"/);
    assert.deepEqual(out.widgets.map((w) => [w.type, w.id, w.source]), [["plan", plan!.id, "open"]]);
    assert.deepEqual(chat.thread().at(-1), { role: "assistant", content: out.reply });
  });

  test("the model cannot say it was asked", { skip: notMac }, async () => {
    machine(false);
    const chat = conversation();
    const out = await chat("what does the chess board look like right now", [{ tool: { name: "open_app", args: { app: "Chess", asked: true } } }]);
    assert.deepEqual(opened(), []);
    assert.match(out.reply, /^To do that I would open Chess\./);
  });

  test('"open it" does not mean an app the model names beside its own call', { skip: notMac }, async () => {
    // "The reply before" is the turn before. Read off the transcript in
    // the middle of the turn it was the model's own sentence.
    machine(false);
    const chat = conversation();
    const out = await chat("find the invoice from Acme and open it", [{ content: "I will open Chess to look for it.", tool: { name: "open_app", args: { app: "Chess" } } }]);
    assert.deepEqual(opened(), []);
    assert.match(out.reply, /^To do that I would open Chess\./);
    // After that reply, "open it" is about Chess.
    const then = await chat("yes, open it", [{ tool: { name: "open_app", args: { app: "Chess" } } }, { content: "Chess is open." }]);
    assert.deepEqual(opened(), ["-a Chess"]);
    assert.equal(then.reply, "Chess is open.");
  });

  test("an app that is already open is neither opened nor proposed, and the turn goes on", { skip: notMac }, async () => {
    machine(true);
    const chat = conversation();
    const out = await chat("what does the chess board look like right now", [{ tool: { name: "open_app", args: { app: "Chess" } } }, { content: "Chess is open; I cannot see the board." }]);
    assert.deepEqual(opened(), [], "not brought to the front either");
    assert.equal(chat.waiting().length, 0);
    assert.equal(out.asked.length, 2);
    assert.equal(out.reply, "Chess is open; I cannot see the board.");
  });

  test("an app the person asked to open is opened, as before", { skip: notMac }, async () => {
    machine(false);
    const chat = conversation();
    const out = await chat("open chess and tell me whose move it is", [{ tool: { name: "open_app", args: { app: "Chess" } } }, { content: "Chess is open." }]);
    assert.deepEqual(opened(), ["-a Chess"]);
    assert.equal(chat.waiting().length, 0);
    assert.equal(out.reply, "Chess is open.");
  });

  test("a step of an automation opens what its prompt leads to: the person ran it", { skip: notMac }, async () => {
    machine(false);
    const chat = conversation();
    await chat("what does the chess board look like right now", [{ tool: { name: "open_app", args: { app: "Chess" } } }, { content: "Opened." }], { specialist: "operator", assembled: true });
    assert.deepEqual(opened(), ["-a Chess"]);
    assert.equal(chat.waiting().length, 0);
  });

  test("a proposed plan ends the turn on the harness's account of it", { skip: notMac }, async () => {
    machine(false);
    const chat = conversation();
    const steps = [
      { summary: "Open Chess", open: "chess" },
      { summary: "Start a new game", shell: "echo new game" },
    ];
    const out = await chat("Start a new game of Chess for João", [
      { tool: { name: "propose_plan", args: { summary: "Start a new chess game", steps } } },
      { content: "Done! I started a new game." },
    ]);
    assert.equal(out.asked.length, 1, "the model does not get to report on a plan that has not run");
    assert.equal(out.reply, planReply("Start a new chess game", steps));
    assert.match(out.reply, /^Here is what I would do\. Nothing has run yet\.\n\nStart a new chess game\n1\. Open Chess\n2\. Start a new game\n\nIt is waiting for you: run it, change it, discard it, or have me try again\.$/);
    assert.deepEqual(opened(), []);
    const [plan] = chat.waiting();
    assert.equal(plan!.request, "Start a new game of Chess for João");
    assert.equal(plan!.source, null);
    assert.deepEqual(out.widgets.map((w) => [w.type, w.request]), [["plan", "Start a new game of Chess for João"]]);
  });
});

describe("a plan that opens the browser opens the person's", () => {
  test("the step says which browser will open, and a plan written for another is sent back", { skip: notMac }, async () => {
    machine(false);
    // The person said "the browser"; the model picked one. The open step
    // is resolved to theirs, and says so in the harness's words.
    const chat = conversation();
    const out = await chat("open the browser and go to example.com", [
      { tool: { name: "propose_plan", args: { summary: "Go to example.com", steps: [{ summary: "Open Firefox", open: "Firefox" }, { summary: "Load the page", shell: "open https://example.com" }] } } },
    ]);
    const [plan] = chat.waiting();
    assert.equal(plan!.steps[0]!.summary, "Open Safari (your default browser, not Firefox)");
    assert.match(plan!.steps[0]!.script, /quoted form of "Safari"/);
    assert.match(out.reply, /1\. Open Safari \(your default browser, not Firefox\)/);

    // A later step that still drives the browser the model wrote would
    // open both. Not stored: the model is told which browser to write for.
    const split = conversation();
    const refused = await split("open the browser and go to example.com", [
      {
        tool: {
          name: "propose_plan",
          args: {
            summary: "Go to example.com",
            steps: [
              { summary: "Open Firefox", open: "Firefox" },
              { summary: "Load the page", script: 'tell application "Firefox" to open location "https://example.com"' },
            ],
          },
        },
      },
      { content: "I could not write that plan." },
    ]);
    assert.equal(split.waiting().length, 0);
    assert.equal(refused.reply, "I could not write that plan.");
  });
});

describe("a saved script is offered for its request without a model", () => {
  test("offered for one press, never run; set aside, the request reaches the model with what was set aside", { skip: notMac }, async () => {
    machine(false);
    const ranLog = join(scratch, "script-ran.log");
    plans.saveRecipe({
      name: "morning_music",
      summary: "Play the morning playlist",
      script: `echo ran >> "${ranLog}"`,
      kind: "shell",
      request: "play my morning playlist in Music",
    });
    try {
      const chat = conversation();
      // No agent is named: this path comes before routing.
      const out = await chat("Please play the morning playlist in music", [{ content: "should not be asked" }], {});
      assert.equal(out.asked.length, 0, "no model round");
      assert.match(out.reply, /^You saved a script for this: morning_music\. Nothing has run yet\.\n\nPlay the morning playlist\n\n/);
      assert.equal(existsSync(ranLog), false, "a match on words never runs anything");
      const [plan] = chat.waiting();
      assert.deepEqual(
        { source: plan!.source, request: plan!.request, script: plan!.steps[0]!.script },
        { source: "saved:morning_music", request: "Please play the morning playlist in music", script: `echo ran >> "${ranLog}"` },
      );
      assert.deepEqual(out.widgets.map((w) => [w.type, w.id, w.source]), [["plan", plan!.id, "saved:morning_music"]]);

      // Try again: set aside, and the same words now go to the model.
      assert.equal(plans.retryPlan(plan!.id).ok, true);
      const again = await chat("Please play the morning playlist in music", [{ content: "I can write a new plan for that." }], { specialist: "operator" });
      assert.equal(again.asked.length, 1);
      assert.match(again.asked[0]!, /Please play the morning playlist in music/);
      assert.match(again.asked[0]!, /\(You proposed this plan before and I set it aside: 1\. Play the morning playlist Propose a different way to do it\.\)/);
      assert.equal(chat.waiting().length, 0, "the script is not offered a second time for a request it was set aside for");
      assert.equal(existsSync(ranLog), false);

      // Another conversation has set nothing aside: offered there.
      const elsewhere = conversation();
      assert.equal((await elsewhere("play my morning playlist in Music", [], {})).asked.length, 0);
      // An @agent is the person choosing who answers.
      const named = conversation();
      const viaMail = await named("play my morning playlist in Music", [{ content: "That is not mail." }], { specialist: "mail" });
      assert.equal(viaMail.asked.length, 1);
      assert.equal(named.waiting().length, 0);
    } finally {
      plans.forgetRecipe("morning_music");
    }
  });
});
