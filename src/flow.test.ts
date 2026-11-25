import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-flow-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_MCP_CONFIG = join(scratch, "none.json");
process.env.ENIO_ROUTING = "1";
// The model tier routes, so every model call a turn makes is one the script
// below can count. The fast tier would need the embedding model.
process.env.ENIO_FAST_ROUTE = "0";
delete process.env.ENIO_FLOW_PLANS;

const flow = await import("./flow.js");
const { runTurn } = await import("./agent.js");
const { buildRegistry } = await import("./tools/index.js");
const store = await import("./memory/store.js");
const { closeDb } = await import("./memory/db.js");
import type { Message, Widget } from "./types.js";

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

/** Scripted model: each call takes the next reply, the last one repeats.
 *  Returns a counter, because what a plan must NOT do is call the model
 *  again after it was drafted. */
function script(...contents: string[]) {
  const queue = [...contents];
  const calls = { n: 0 };
  globalThis.fetch = (async () => {
    calls.n++;
    const content = queue.length > 1 ? queue.shift()! : queue[0] ?? "";
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, {
      status: 200,
    });
  }) as typeof fetch;
  return calls;
}

const TWO_AGENTS =
  '{"nodes": [{"id": "n1", "ability": "web-search", "prompt": "find budget laptops"}, ' +
  '{"id": "n2", "ability": "create-document", "prompt": "write up the three best"}], ' +
  '"edges": [{"from": "n1", "to": "n2"}]}';
const ONE_AGENT =
  '{"nodes": [{"id": "n1", "ability": "create-document", "prompt": "write the letter"}, ' +
  '{"id": "n2", "ability": "create-document", "prompt": "save it"}], "edges": []}';

describe("which messages are shown to the composer", () => {
  test("two things joined in sequence are; one thing is not", () => {
    assert.equal(flowWhy("search the web for budget laptops and email me a summary"), "joined");
    assert.equal(flowWhy("look up the train times, then add the 9am one to my calendar"), "joined");
    assert.equal(flowWhy("what did the fed decide about rates this week"), null);
    assert.equal(flowWhy("add a retry to the fetch call in api/client.ts"), null);
    // A word inside another word is not a connective.
    assert.equal(flowWhy("where is the handler for incoming webhooks defined"), null);
  });

  test("short acknowledgements and pasted pages are left to the router", () => {
    assert.equal(flowWhy("yes and no"), null);
    assert.equal(flowWhy("try again and again"), null);
    assert.equal(flowWhy(`summarise this and tell me what matters: ${"lorem ipsum ".repeat(60)}`), null);
  });

  test("plan: is the explicit door, and the prefix is not part of the request", () => {
    const c = flow.flowCandidate("plan: email me a summary of today's AI news");
    assert.deepEqual(c, { why: "asked", request: "email me a summary of today's AI news" });
    assert.equal(flow.flowCandidate("plan: x"), null, "nothing to plan");
    // "make a plan for..." is also how someone asks for a travel plan.
    assert.equal(flowWhy("make a plan for my week in japan"), null);
  });

  function flowWhy(text: string) {
    return flow.flowCandidate(text)?.why ?? null;
  }
});

describe("a request for more than one agent ends on a draft", () => {
  test("the turn returns the plan, draws its card, runs nothing, and is restorable", async () => {
    const registry = await buildRegistry();
    const sessionId = store.startSession();
    const history: Message[] = [];
    const widgets: Widget[] = [];
    const tools: string[] = [];
    const calls = script(TWO_AGENTS, "THIS MUST NEVER BE ASKED FOR");

    const result = await runTurn(
      "search the web for budget laptops and write up the three best",
      history,
      registry,
      sessionId,
      { onWidget: (w) => widgets.push(w), onToolStart: (name) => tools.push(name) },
    );

    assert.equal(calls.n, 1, "one call drafts the plan; no route, no answer, no step runs");
    assert.deepEqual(tools, []);
    assert.deepEqual(result.toolsUsed, []);
    assert.match(result.reply, /Nothing has run yet/);
    assert.match(result.reply, /1\. \*\*Web search\*\* \(researcher\): find budget laptops/);
    assert.match(result.reply, /2\. \*\*Create document\*\* \(coder\): write up the three best/);

    assert.equal(widgets.length, 1);
    const card = widgets[0]!;
    assert.equal(card.type, "flow");
    if (card.type !== "flow") return;
    assert.deepEqual(card.nodes.map((n) => [n.abilityId, n.agent]), [["web-search", "researcher"], ["create-document", "coder"]]);
    assert.deepEqual(card.edges, [{ from: "n1", to: "n2" }]);

    // The conversation keeps both sides, so "now also email it" has context.
    assert.equal(history.length, 2);
    // And the card survives a restart: it was the only way into the draft.
    const restored = store.conversationMessages(sessionId).find((m) => m.role === "assistant")!;
    assert.deepEqual((restored.flow as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id), ["n1", "n2"]);
  });

  test("steps for one agent are an ordinary turn: the plan is dropped and the router decides", async () => {
    const registry = await buildRegistry();
    const widgets: Widget[] = [];
    const calls = script(ONE_AGENT, '{"specialist": "generalist"}', "Here is the letter.");
    const result = await runTurn(
      "write a cover letter for the analyst role and save it",
      [],
      registry,
      store.startSession(),
      { onWidget: (w) => widgets.push(w) },
    );
    assert.equal(widgets.length, 0);
    assert.equal(result.reply, "Here is the letter.");
    assert.ok(calls.n >= 3, "the composer, then the router, then the answer");
  });

  test("a composer that returns nothing usable costs the turn nothing", async () => {
    const registry = await buildRegistry();
    script("I am not sure what you mean.", '{"specialist": "generalist"}', "An ordinary answer.");
    const result = await runTurn("tell me about rome and its history", [], registry, store.startSession());
    assert.equal(result.reply, "An ordinary answer.");
  });

  test("an @mention is the user choosing the agent: no plan is drafted", async () => {
    const registry = await buildRegistry();
    const widgets: Widget[] = [];
    const calls = script("Answered directly.");
    const result = await runTurn(
      "search the web for budget laptops and write up the three best",
      [],
      registry,
      store.startSession(),
      { onWidget: (w) => widgets.push(w) },
      { specialist: "generalist" },
    );
    assert.equal(result.reply, "Answered directly.");
    assert.equal(widgets.length, 0);
    assert.equal(calls.n, 1, "no composer call, no router call");
  });

  test("asked for with plan:, one agent's steps are still a plan", async () => {
    const registry = await buildRegistry();
    script(ONE_AGENT);
    const draft = await flow.draftFlow("plan: write a cover letter for the analyst role", registry);
    assert.equal(draft?.nodes.length, 2);
    assert.equal(draft?.request, "write a cover letter for the analyst role");
    assert.match(flow.flowReply(draft!), /^Here is the plan\. Nothing has run yet\./);
  });
});
