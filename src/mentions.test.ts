import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-mentions-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_MCP_CONFIG = join(scratch, "none.json");

const { parseMentions, completeMention, invokedSkillBlock, workspaceFiles } =
  await import("./mentions.js");
const { skillsDir } = await import("./skills.js");
const { closeDb } = await import("./memory/db.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

before(() => {
  for (const [name, desc] of ([
    ["commit-message", "Writing a commit message."],
    ["weekly-review", "Reviewing the week."],
  ] as [string, string][])) {
    const dir = join(skillsDir(), name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${desc}\n---\n\nInstructions for ${name}.`,
    );
  }
  mkdirSync(join(process.env.ENIO_WORKSPACE!, "notes"), { recursive: true });
  writeFileSync(join(process.env.ENIO_WORKSPACE!, "notes", "plan.md"), "# Plan");
  writeFileSync(join(process.env.ENIO_WORKSPACE!, "README.md"), "# Readme");
});

const ctx = () => ({
  skillNames: ["commit-message", "weekly-review"],
  specialists: ["researcher", "coder", "librarian", "generalist"],
  servers: ["github", "filesystem"],
  files: workspaceFiles(),
});

describe("slash invocation", () => {
  test("resolves a skill and strips it from the text", () => {
    const m = parseMentions("/commit-message look at what I staged", ctx());
    assert.equal(m.skills.length, 1);
    assert.equal(m.skills[0]!.name, "commit-message");
    assert.equal(m.text, "look at what I staged");
  });

  test("works with no trailing text", () => {
    assert.equal(parseMentions("/weekly-review", ctx()).skills[0]!.name, "weekly-review");
  });

  test("accepts a prefix", () => {
    assert.equal(parseMentions("/commit please", ctx()).skills[0]!.name, "commit-message");
  });

  test("only at the start — a path is not a command", () => {
    // Otherwise every mention of a file path would fire a skill.
    const m = parseMentions("look at src/tools and /etc/hosts", ctx());
    assert.equal(m.skills.length, 0);
    assert.match(m.text, /\/etc\/hosts/);
  });

  test("an unknown slash is left as text", () => {
    const m = parseMentions("/nonexistent do a thing", ctx());
    assert.equal(m.skills.length, 0);
    assert.match(m.text, /^\/nonexistent/);
  });
});

describe("@ mentions", () => {
  test("forces a specialist and removes the token", () => {
    const m = parseMentions("@coder why does this fail", ctx());
    assert.equal(m.specialist, "coder");
    assert.equal(m.text, "why does this fail");
  });

  test("enables an MCP server", () => {
    const m = parseMentions("@github what changed lately", ctx());
    assert.deepEqual(m.servers, ["github"]);
    assert.equal(m.text, "what changed lately");
  });

  test("attaches a file and keeps the name readable in the sentence", () => {
    const m = parseMentions("summarise @notes/plan.md for me", ctx());
    assert.deepEqual(m.files, ["notes/plan.md"]);
    // The filename stays so the sentence still parses and the model knows
    // which attachment is meant.
    assert.match(m.text, /summarise notes\/plan\.md for me/);
  });

  test("handles several mentions at once", () => {
    const m = parseMentions("@coder review @README.md with @github", ctx());
    assert.equal(m.specialist, "coder");
    assert.deepEqual(m.files, ["README.md"]);
    assert.deepEqual(m.servers, ["github"]);
  });

  test("leaves an email address completely alone", () => {
    // The rule that makes this safe to run on every message.
    const raw = "email the result to mariz@example.com please";
    const m = parseMentions(raw, ctx());
    assert.equal(m.text, raw);
    assert.equal(m.specialist, null);
    assert.equal(m.unresolved.length, 0, "an email must not even be reported");
  });

  test("leaves a decorator in code alone", () => {
    const raw = "why does @property break here";
    const m = parseMentions(raw, ctx());
    assert.match(m.text, /@property/);
    assert.equal(m.specialist, null);
  });

  test("reports an unresolved mention instead of silently dropping it", () => {
    const m = parseMentions("@codr why does this fail", ctx());
    assert.deepEqual(m.unresolved, ["codr"]);
    assert.match(m.text, /@codr/, "the typo stays visible in the text");
  });

  test("combines a slash skill with an @ specialist", () => {
    const m = parseMentions("/commit-message @coder for the staged diff", ctx());
    assert.equal(m.skills[0]!.name, "commit-message");
    assert.equal(m.specialist, "coder");
    assert.equal(m.text, "for the staged diff");
  });
});

describe("completion", () => {
  test("lists skills after a slash", () => {
    const [hits] = completeMention("/", ctx());
    assert.ok(hits.includes("/commit-message"));
    assert.ok(hits.includes("/weekly-review"));
  });

  test("narrows on a prefix", () => {
    const [hits] = completeMention("/week", ctx());
    assert.deepEqual(hits, ["/weekly-review"]);
  });

  test("offers specialists, servers and files after @", () => {
    const [hits] = completeMention("@", ctx());
    assert.ok(hits.includes("@coder"));
    assert.ok(hits.includes("@github"));
    assert.ok(hits.some((h) => h.endsWith("plan.md")));
  });

  test("completes mid-sentence", () => {
    const [hits] = completeMention("summarise @notes/", ctx());
    assert.ok(hits.some((h) => h.includes("plan.md")));
  });

  test("offers nothing for ordinary text", () => {
    const [hits] = completeMention("just a normal question", ctx());
    assert.deepEqual(hits, []);
  });
});

describe("invoked skill block", () => {
  test("injects the body outright rather than offering it", () => {
    const skill = {
      name: "x", description: "d", dir: "/tmp", body: "Do the thing.",
      allowedTools: null, manualOnly: false,
    };
    const block = invokedSkillBlock([skill]);
    // Asking explicitly is meant to remove a decision; making the model call
    // read_skill for what it was already handed would put it straight back.
    assert.match(block, /Do the thing\./);
    assert.match(block, /invoked the "x" skill/);
  });

  test("empty when nothing was invoked", () => {
    assert.equal(invokedSkillBlock([]), "");
  });
});

describe("@canvas", () => {
  test("resolves to the pinned file and the agent that can edit it", () => {
    const m = parseMentions("make the summary shorter @canvas", {
      ...ctx(),
      canvasPath: "my resume draft.md",
    });
    // The path replaces the word in the text (the transcript stays readable),
    // the file attaches, and the turn lands on the editor -- including for a
    // path the mention grammar itself could never express.
    assert.deepEqual(m.files, ["my resume draft.md"]);
    assert.equal(m.specialist, "coder");
    assert.match(m.text, /my resume draft\.md/);
  });

  test("an explicit agent wins; without a pinned file the word is left alone", () => {
    const m = parseMentions("@researcher what does @canvas claim?", {
      ...ctx(),
      canvasPath: "notes.md",
    });
    assert.equal(m.specialist, "researcher");
    assert.deepEqual(m.files, ["notes.md"]);

    // No canvas pinned: "@canvas" is somebody's word, not a mention -- the
    // never-eat rule that keeps email addresses safe applies here too.
    const bare = parseMentions("the @canvas element in HTML", ctx());
    assert.match(bare.text, /@canvas/);
    assert.equal(bare.specialist, null);
  });
});
