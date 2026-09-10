import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-personality-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
delete process.env.ENIO_CONTEXT_BUDGET;

const p = await import("./personality.js");
const { addPreference, listPreferences } = await import("./memory/learning.js");
const { ensureDirs } = await import("./config.js");
const { closeDb } = await import("./memory/db.js");
ensureDirs();

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

const empty = () => ({ preferences: [], exemplars: [], entities: [] });
const tech = (name: string, degree: number) => ({ name, type: "technology", degree });
const proj = (name: string, degree: number) => ({ name, type: "project", degree });
const person = (name: string, degree: number) => ({ name, type: "person", degree });
const workingGraph = () => [
  tech("TypeScript", 9), tech("SQLite", 7), tech("MLX", 5), tech("React", 3), tech("Electron", 2),
  proj("enio", 8), proj("Maple", 2), person("Sam", 2),
];

describe("personality: derived from memory, rendered as constraints", () => {
  test("nothing known: every axis neutral, no block, sources say so", () => {
    const v = p.personalityView(empty(), 12000);
    assert.equal(v.block, "");
    for (const axis of p.AXIS_NAMES) {
      assert.equal(v.effective[axis], p.NEUTRAL[axis]);
      assert.equal(v.sources[axis], "none");
      assert.equal(v.levels[axis], "auto");
    }
  });

  test("a preference derives a level but renders nothing — it is already in the prompt", () => {
    const v = p.personalityView({ ...empty(), preferences: [{ id: 7, text: "Answer concisely, please" }] }, 12000);
    assert.equal(v.effective.voice, "terse");
    assert.equal(v.sources.voice, "preference:7");
    assert.equal(v.block, "", "a paraphrase of the user's own instruction is duplication");
  });

  test("a scoped request for detail never becomes a global conversational voice", () => {
    const v = p.personalityView({ ...empty(), preferences: [{ id: 1, text: "explain errors in detail" }] }, 12000);
    assert.equal(v.effective.voice, "plain");
    // And "friendly" needs to be about the assistant, not a neighbour.
    const w = p.personalityView({ ...empty(), preferences: [{ id: 2, text: "my friendly neighbour is called Ann" }] }, 12000);
    assert.equal(w.effective.warmth, "friendly");
    const w2 = p.personalityView({ ...empty(), preferences: [{ id: 3, text: "be friendly" }] }, 12000);
    assert.equal(w2.effective.warmth, "warm");
  });

  test("three short exemplars derive terse and render the two-sentence rule; two are an anecdote", () => {
    const short = { answer: "Yes. Use the second one." };
    const two = p.personalityView({ ...empty(), exemplars: [short, short] }, 12000);
    assert.equal(two.effective.voice, "plain");
    const three = p.personalityView({ ...empty(), exemplars: [short, short, short] }, 12000);
    assert.equal(three.effective.voice, "terse");
    assert.equal(three.sources.voice, "exemplars:3");
    assert.match(three.block, /^Reply shape:\n- Keep each reply to two sentences/);
  });

  test("exemplars that end by offering a next step derive follow-ups — by the last line only", () => {
    const ex = (answer: string) => ({ answer });
    const v = p.personalityView(
      {
        ...empty(),
        exemplars: [
          ex("Run the build first.\nYou could also clear the cache."),
          ex("It is in config.yaml.\nWant me to change it?"),
          ex("The port is 8443.\nNext, restart the server."),
          ex("Two files match.\nDone."),
        ],
      },
      12000,
    );
    assert.equal(v.effective.initiative, "offer-follow-ups");
    assert.match(v.block, /End with one next step/);
    // A question in the middle of an answer is not an offer at the end.
    const mid = p.personalityView(
      { ...empty(), exemplars: [ex("Why? Because.\nDone."), ex("Ready? Yes.\nDone."), ex("Ok? Sure.\nDone.")] },
      12000,
    );
    assert.equal(mid.effective.initiative, "suggest-next-step");
  });

  test("a working graph derives expert and names the top three technologies, in degree order", () => {
    const v = p.personalityView({ ...empty(), entities: workingGraph() }, 12000);
    assert.equal(v.effective.register, "expert");
    assert.deepEqual(v.expertTerms, ["TypeScript", "SQLite", "MLX"]);
    assert.match(v.block, /works with TypeScript, SQLite and MLX; use their exact terms/);
    assert.ok(!/^-?\s*you are\b/im.test(v.block), "never an adjective about the assistant");
  });

  test("a graph full of people is not a technical person, and thin technologies are not expertise", () => {
    const people = Array.from({ length: 30 }, (_, i) => person(`P${i}`, 3));
    const v = p.personalityView({ ...empty(), entities: [...people, tech("Excel", 5), tech("Word", 4)] }, 12000);
    assert.equal(v.effective.register, "technical");
    const thin = workingGraph().map((e) => (e.name === "MLX" ? { ...e, degree: 3 } : e));
    assert.equal(p.personalityView({ ...empty(), entities: thin }, 12000).effective.register, "technical");
  });

  test("an explicit level renders, auto restores derivation, and the file round-trips", () => {
    p.setAxis("warmth", "matter-of-fact");
    let v = p.personalityView(empty(), 12000);
    assert.equal(v.levels.warmth, "matter-of-fact");
    assert.equal(v.sources.warmth, "explicit");
    assert.equal(v.block, "Reply shape:\n- Start with the answer: no greeting, no acknowledgement, no closing line.");
    assert.ok(existsSync(join(scratch, "data", "personality.json")));
    assert.equal(JSON.parse(readFileSync(join(scratch, "data", "personality.json"), "utf8")).warmth, "matter-of-fact");

    p.setAxis("warmth", "auto");
    v = p.personalityView(empty(), 12000);
    assert.equal(v.levels.warmth, "auto");
    assert.equal(v.block, "");
  });

  test("an unknown level or axis is refused, never coerced", () => {
    assert.throws(() => p.setAxis("voice", "chatty"), /not a voice level/);
    assert.throws(() => p.setAxis("humour", "dry"), /No axis named/);
    assert.throws(() => p.setCuriosity("loud"), /quiet.*flag/);
    assert.equal(p.readPersonality().voice, "auto");
  });

  test("an explicit choice against a preference is reported as a conflict, not hidden", () => {
    p.setAxis("voice", "conversational");
    const v = p.personalityView({ ...empty(), preferences: [{ id: 4, text: "Answer concisely" }] }, 12000);
    assert.equal(v.effective.voice, "conversational");
    assert.deepEqual(v.conflicts, ["Answer concisely"]);
    p.setAxis("voice", "auto");
  });

  test("on the smallest window only explicit levels spend tokens", () => {
    const short = { answer: "Yes." };
    p.setAxis("warmth", "matter-of-fact");
    const v = p.personalityView({ ...empty(), exemplars: [short, short, short] }, 2000);
    assert.match(v.block, /Start with the answer/);
    assert.ok(!/two sentences/.test(v.block), "the derived terse line is dropped at 2k");
    const roomy = p.personalityView({ ...empty(), exemplars: [short, short, short] }, 12000);
    assert.match(roomy.block, /two sentences/);
    p.setAxis("warmth", "auto");
  });

  test("the block stays inside its caps whatever is set", () => {
    p.setAxis("voice", "conversational");
    p.setAxis("warmth", "warm");
    p.setAxis("initiative", "offer-follow-ups");
    p.setAxis("register", "expert");
    const v = p.personalityView({ ...empty(), entities: workingGraph() }, 12000);
    const lines = v.block.split("\n");
    assert.equal(lines[0], "Reply shape:");
    assert.ok(lines.length - 1 <= 4);
    assert.ok(v.block.length <= 320, `${v.block.length} chars`);
    for (const l of lines) assert.ok(!/^-?\s*you are\b/i.test(l));
    for (const axis of p.AXIS_NAMES) p.setAxis(axis, "auto");
  });

  test("the live inputs are memory's own: a stored preference is read without being passed in", () => {
    addPreference("no small talk, just the answer");
    const v = p.personalityView();
    assert.equal(v.effective.warmth, "matter-of-fact");
    assert.equal(v.sources.warmth, `preference:${listPreferences()[0]!.id}`);
  });

  test("the gate's renderings are the served lines, expert over fixed names", () => {
    const r = p.gateRenderings();
    assert.equal(r.length, 8);
    assert.ok(r.every((x) => x.suffix.startsWith("Reply shape:\n- ")));
    assert.ok(r.find((x) => x.id === "register=expert")!.suffix.includes("TypeScript, SQLite and MLX"));
  });
});
