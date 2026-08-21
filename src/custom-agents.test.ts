import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-custom-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const { saveCustomAgent, deleteCustomAgent, listCustomAgents } = await import("./custom-agents.js");
const { SPECIALISTS, allSpecialists, getSpecialist, route, toolsFor } = await import("./specialists.js");
const { agentsView } = await import("./agents-view.js");
const { buildRegistry } = await import("./tools/index.js");
const { closeDb } = await import("./memory/db.js");
import type { Specialist } from "./specialists.js";
import type { Registry } from "./tools/index.js";

const BUILTINS = SPECIALISTS.map((s) => s.name);
const KNOWN = ["recall", "weather", "web_search", "current_time", "run_applescript"];
const CTX = { knownTools: KNOWN, builtinNames: BUILTINS, knownSkills: ["weekly-review"] };

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

const valid = () => ({
  name: "editor",
  description: "Proofreading and rewording text the user pastes.",
  systemPrompt: "You edit text. Keep the author's voice.",
  example: "tighten up this paragraph",
  tools: ["recall", "weather"],
});

/** Capture the router's system prompt while answering with fixed content. */
function stubRouter(content: string): { system: () => string } {
  let captured = "";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    captured = body?.messages?.find((m: { role: string }) => m.role === "system")?.content ?? "";
    const frame = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
    return new Response(
      new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode(frame));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { system: () => captured };
}

/**
 * User-defined agents: the built-ins' bargain — a prompt and a description
 * over at most six tools — chosen by the user instead of shipped in code.
 * The ceiling and the closed tool list are enforced at save, refuse-never-
 * truncate, because a silently trimmed agent behaves like a different one.
 */
describe("saving a custom agent", () => {
  test("round-trips, with read_skill riding along like on every built-in", () => {
    const saved = saveCustomAgent(valid(), CTX);
    assert.deepEqual(saved.tools, ["recall", "weather", "read_skill"]);
    assert.equal(listCustomAgents().length, 1);
    assert.equal(listCustomAgents()[0]!.example, "tighten up this paragraph");
  });

  test("a built-in name is refused — shadowing the coder is not creating an agent", () => {
    assert.throws(() => saveCustomAgent({ ...valid(), name: "coder" }, CTX), /built-in/);
  });

  test("names are slugs: no spaces, no capitals, no leading digit", () => {
    for (const name of ["My Agent", "Editor", "1editor", "e", ""]) {
      assert.throws(() => saveCustomAgent({ ...valid(), name }, CTX), /lowercase/);
    }
  });

  test("more than five picked tools is refused, not trimmed", () => {
    const tools = ["a", "b", "c", "d", "e", "f"];
    assert.throws(
      () => saveCustomAgent({ ...valid(), tools }, { ...CTX, knownTools: [...KNOWN, ...tools] }),
      /at most six/,
    );
  });

  test("a tool that does not exist is refused by name", () => {
    assert.throws(() => saveCustomAgent({ ...valid(), tools: ["telepathy"] }, CTX), /telepathy/);
  });

  test("reading the web and acting cannot be combined — same boundary as the built-ins", () => {
    assert.throws(
      () =>
        saveCustomAgent({ ...valid(), tools: ["web_fetch", "run_command"] }, { ...CTX, knownTools: [...KNOWN, "web_fetch", "run_command"] }),
      /read the web.*act/,
    );
    // Either half alone is fine — the refusal is the combination.
    saveCustomAgent({ ...valid(), name: "fetcher", tools: ["web_fetch"] }, { ...CTX, knownTools: [...KNOWN, "web_fetch"] });
    assert.equal(deleteCustomAgent("fetcher"), true);
  });

  test("run_applescript is never held — proposing and running stay separated", () => {
    assert.throws(
      () => saveCustomAgent({ ...valid(), tools: ["run_applescript"] }, CTX),
      /never held/,
    );
  });

  test("an overlong prompt is refused with the actual numbers", () => {
    assert.throws(
      () => saveCustomAgent({ ...valid(), systemPrompt: "x".repeat(2001) }, CTX),
      /2001.*2000/,
    );
  });

  test("no tools at all is refused — an agent that can only read skills does nothing", () => {
    assert.throws(() => saveCustomAgent({ ...valid(), tools: [] }, CTX), /at least one/);
  });

  test("saving the same name replaces: that is the edit path", () => {
    saveCustomAgent({ ...valid(), description: "Only rewording now, nothing else." }, CTX);
    assert.equal(listCustomAgents().length, 1);
    assert.match(listCustomAgents()[0]!.description, /rewording/i);
  });

  test("a tool the agent already holds survives its grant lapsing", () => {
    // The registry no longer knows "weather" (say the config went away);
    // saving an unrelated edit must not force the tool's removal.
    const saved = saveCustomAgent(valid(), { ...CTX, knownTools: ["recall"] });
    assert.ok(saved.tools.includes("weather"));
  });
});

describe("custom agents in the machinery", () => {
  test("allSpecialists appends them after the built-ins, and getSpecialist finds them", () => {
    const names = allSpecialists().map((s) => s.name);
    assert.deepEqual(names.slice(0, BUILTINS.length), BUILTINS);
    assert.ok(names.includes("editor"));
    assert.equal(getSpecialist("editor").tools.includes("read_skill"), true);
  });

  test("the router accepts a custom name, and its example rides the prompt", async () => {
    const stub = stubRouter('{"specialist": "editor"}');
    assert.equal(await route("tighten up this paragraph for me"), "editor");
    assert.match(stub.system(), /"tighten up this paragraph" -> \{"specialist": "editor"\}/);
  });

  test("planner parses directly — the accepted names derive from the live list", async () => {
    // The old hand-written enum omitted planner; routing to it survived only
    // through the fuzzy salvage. Guard the fix: a clean parse must land.
    stubRouter('{"specialist": "planner"}');
    assert.equal(await route("what is on my calendar this week"), "planner");
  });

  test("a deleted custom agent stops being sticky instead of erroring", async () => {
    stubRouter("no json here at all");
    assert.equal(await route("ok", "editor"), "editor"); // short input, sticky holds
    deleteCustomAgent("editor");
    assert.equal(await route("ok", "editor"), "generalist");
    saveCustomAgent(valid(), CTX); // restore for later tests
  });

  test("toolsFor narrows the registry to the picked set, MCP tools matched by name", () => {
    const fake: Registry = {
      all: [
        { name: "recall", description: "", origin: "builtin", parameters: {}, run: async () => ({ text: "" }) },
        { name: "web_search", description: "", origin: "builtin", parameters: {}, run: async () => ({ text: "" }) },
        { name: "slack_post", description: "", origin: "mcp", server: "slack", parameters: {}, run: async () => ({ text: "" }) },
        { name: "slack_read", description: "", origin: "mcp", server: "slack", parameters: {}, run: async () => ({ text: "" }) },
      ],
    } as unknown as Registry;
    const custom: Specialist = {
      name: "editor",
      description: "x",
      systemPrompt: "x",
      tools: ["recall", "slack_post", "read_skill"],
    };
    const names = toolsFor(custom, fake).map((t) => t.name);
    // slack_post by name without dragging in the whole slack server.
    assert.deepEqual(names.sort(), ["recall", "slack_post"]);
  });

  test("the panel marks them custom and hands the editor its stored fields", async () => {
    const registry = await buildRegistry(() => {});
    const view = agentsView(registry);
    const editor = view.find((a) => a.name === "editor")!;
    assert.equal(editor.custom, true);
    assert.equal(editor.systemPrompt, "You edit text. Keep the author's voice.");
    // Built-ins carry their prompt too now, so Duplicate can start from one.
    assert.ok(view.filter((a) => !a.custom).every((a) => a.systemPrompt.length > 0));
  });

  test("no tool creates, edits or deletes agents — that is the user's act alone", async () => {
    const registry = await buildRegistry(() => {});
    const reaching = registry.all.filter((t) =>
      /(create|save|delete|edit)[-_ ]?agent|agent[-_ ]?(create|save|delete)/i.test(
        `${t.name} ${t.description}`,
      ),
    );
    assert.deepEqual(reaching.map((t) => t.name), []);
  });

  test("delete removes exactly the named one and reports a miss honestly", () => {
    assert.equal(deleteCustomAgent("editor"), true);
    assert.equal(deleteCustomAgent("editor"), false);
    assert.equal(listCustomAgents().length, 0);
  });
});

describe("the honesty suffix on custom prompts", () => {
  test("a loaded custom agent carries it; the stored file does not", () => {
    saveCustomAgent(valid(), CTX);
    assert.match(getSpecialist("editor").systemPrompt, /never invent names,\s+dates or numbers/);
    // Stored text stays the user's own — the suffix is applied at load so
    // editing round-trips cleanly and the rule can improve without migration.
    assert.equal(listCustomAgents()[0]!.systemPrompt.includes("never invent"), false);
    deleteCustomAgent("editor");
  });
});

describe("skills on custom agents", () => {
  test("pins are validated against installed skills and stored on the record", () => {
    assert.throws(
      () => saveCustomAgent({ ...valid(), skills: ["nope"] }, CTX),
      /No skill named "nope"/,
    );
    const saved = saveCustomAgent({ ...valid(), skills: ["weekly-review"] }, CTX);
    assert.deepEqual(saved.skills, ["weekly-review"]);
    const view = listCustomAgents().find((a) => a.name === "editor")!;
    assert.deepEqual(view.skills, ["weekly-review"]);
    deleteCustomAgent("editor");
  });
});
