import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { toolText } from "./types.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-skills-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_MCP_CONFIG = join(scratch, "none.json");

const {
  parseSkill, loadSkills, findSkill, skillCatalogue, skillFile, skillContents, skillsDir,
} = await import("./skills.js");
const { skillTools } = await import("./tools/skills.js");

after(() => rmSync(scratch, { recursive: true, force: true }));

function writeSkill(name: string, content: string, extra: Record<string, string> = {}) {
  const dir = join(skillsDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
  for (const [rel, body] of Object.entries(extra)) {
    const target = join(dir, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, body);
  }
  return dir;
}

const VALID = `---
name: tidy
description: Tidying up messy files. Use when asked to organise a folder.
---

# Tidy

Sort things into folders by type.`;

describe("parsing", () => {
  test("reads name, description and body", () => {
    const s = parseSkill(VALID, "/tmp/x", "fallback");
    assert.equal(s.name, "tidy");
    assert.match(s.description, /Tidying up messy files/);
    assert.match(s.body, /Sort things into folders/);
    assert.ok(!s.body.includes("---"), "frontmatter must be stripped from the body");
  });

  test("falls back to the folder name when name is omitted", () => {
    const s = parseSkill(`---\ndescription: Something useful here.\n---\nbody`, "/tmp/x", "from-folder");
    assert.equal(s.name, "from-folder");
  });

  test("rejects a missing description", () => {
    // Without it the model has no basis for picking the skill, so it would sit
    // in the catalogue forever as dead weight.
    assert.throws(() => parseSkill(`---\nname: x\n---\nbody`, "/tmp/x", "x"), /description/);
  });

  test("rejects an unusable name", () => {
    for (const bad of ["Has Spaces", "UPPER", "sym!bol"]) {
      assert.throws(
        () => parseSkill(`---\nname: ${bad}\ndescription: d\n---\n`, "/tmp/x", "x"),
        /invalid name/,
        `${bad} should be rejected`,
      );
    }
  });

  test("rejects missing frontmatter", () => {
    assert.throws(() => parseSkill(`# Just markdown`, "/tmp/x", "x"), /frontmatter/);
  });

  test("reports bad YAML clearly instead of throwing something opaque", () => {
    assert.throws(
      () => parseSkill(`---\nname: [unclosed\n---\nbody`, "/tmp/x", "x"),
      /invalid YAML frontmatter/,
    );
  });

  test("handles a folded multi-line description", () => {
    const s = parseSkill(
      `---\nname: x\ndescription: >-\n  First line\n  and second.\n---\nbody`,
      "/tmp/x", "x",
    );
    assert.equal(s.description, "First line and second.");
  });

  test("reads allowed-tools and disable-model-invocation", () => {
    const s = parseSkill(
      `---\nname: x\ndescription: d\nallowed-tools: [read_file, run_command]\ndisable-model-invocation: true\n---\nbody`,
      "/tmp/x", "x",
    );
    assert.deepEqual(s.allowedTools, ["read_file", "run_command"]);
    assert.equal(s.manualOnly, true);
  });

  test("tolerates a BOM and CRLF line endings", () => {
    const s = parseSkill("﻿---\r\nname: x\r\ndescription: d\r\n---\r\nbody", "/tmp/x", "x");
    assert.equal(s.name, "x");
  });
});

describe("loading", () => {
  before(() => {
    writeSkill("tidy", VALID);
    writeSkill("quiet", `---\nname: quiet\ndescription: Never listed.\ndisable-model-invocation: true\n---\nhidden`);
    writeSkill("broken", `no frontmatter at all`);
    writeSkill("refs", `---\nname: refs\ndescription: Has references.\n---\nbody`, {
      "references/guide.md": "# Guide\nDetail here.",
      "scripts/run.sh": "#!/bin/sh\necho hi",
    });
  });

  test("loads the good ones", () => {
    const names = loadSkills().skills.map((s) => s.name);
    assert.ok(names.includes("tidy"));
    assert.ok(names.includes("refs"));
  });

  test("a broken skill is reported, not fatal", () => {
    // One bad file must not take the whole system down.
    const set = loadSkills();
    assert.ok(set.skills.length >= 3, "good skills should still load");
    assert.ok(set.problems.some((p) => p.path.includes("broken")));
  });

  test("finds by exact name and by prefix", () => {
    // Small models paraphrase; a prefix match recovers the turn.
    assert.equal(findSkill("tidy")?.name, "tidy");
    assert.equal(findSkill("TIDY")?.name, "tidy");
    assert.equal(findSkill("ref")?.name, "refs");
    assert.equal(findSkill("nonexistent"), null);
  });

  test("lists a skill's extra files", () => {
    const skill = findSkill("refs")!;
    const contents = skillContents(skill);
    assert.ok(contents.includes("references/guide.md"));
    assert.ok(contents.includes("scripts/run.sh"));
  });

  test("reads a reference file", () => {
    assert.match(skillFile(findSkill("refs")!, "references/guide.md"), /Detail here/);
  });

  test("refuses to read outside the skill folder", () => {
    assert.throws(
      () => skillFile(findSkill("refs")!, "../../../etc/passwd"),
      /escapes the skill folder/,
    );
  });
});

describe("catalogue", () => {
  test("one line per skill, and it stays small", () => {
    const cat = skillCatalogue();
    assert.match(cat, /- tidy: Tidying up messy files/);
    // The entire point is that this is cheap enough to always include.
    assert.ok(cat.length < 2000, `catalogue got fat: ${cat.length} chars`);
  });

  test("omits manual-only skills", () => {
    assert.ok(!skillCatalogue().includes("quiet"), "manual-only must not be listed");
  });

  test("tells the model to load before acting", () => {
    assert.match(skillCatalogue(), /read_skill.*BEFORE/s);
  });
});

describe("read_skill tool", () => {
  const tool = skillTools.find((t) => t.name === "read_skill")!;

  test("returns the body plus where the files are", async () => {
    const out = toolText(await tool.run({ name: "refs" }));
    assert.match(out, /# Skill: refs/);
    assert.match(out, /references\/guide\.md/);
    // The absolute path is what makes scripts runnable — the shell tool's cwd
    // is the workspace, not the skill folder.
    assert.match(out, /This skill's folder is/);
  });

  test("returns a named reference file", async () => {
    assert.match(toolText(await tool.run({ name: "refs", file: "references/guide.md" })), /Detail here/);
  });

  test("an unknown skill lists what does exist", async () => {
    const out = toolText(await tool.run({ name: "made-up" }));
    assert.match(out, /No skill named "made-up"/);
    assert.match(out, /tidy/);
  });

  test("a bad file path suggests the real ones", async () => {
    const out = toolText(await tool.run({ name: "refs", file: "nope.md" }));
    assert.match(out, /no such file/);
    assert.match(out, /references\/guide\.md/);
  });

  test("surfaces the skill's tool restriction", async () => {
    writeSkill("scoped", `---\nname: scoped\ndescription: d\nallowed-tools: [read_file]\n---\nbody`);
    assert.match(toolText(await tool.run({ name: "scoped" })), /Use only these tools.*read_file/s);
  });

  test("costs exactly one tool slot for any number of skills", () => {
    // The reason skills scale where MCP servers don't.
    assert.equal(skillTools.length, 1);
  });
});
