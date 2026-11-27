import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// buildRegistry connects MCP servers and reads the data dir for real, so the
// whole environment is redirected before the first import.
const scratch = mkdtempSync(join(tmpdir(), "enio-traits-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");

const { BUILTIN_TOOL_NAMES, BUILTIN_TRAITS, traitsOf, toolsWhere, toolReads, toolActs, toolMakes } =
  await import("./tool-traits.js");
const { buildRegistry } = await import("./tools/index.js");
const { allSpecialists } = await import("./specialists.js");
const { extractArtifacts } = await import("./artifacts.js");
const { callDetail } = await import("./tool-detail.js");
const { closeDb } = await import("./memory/db.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

const ROOT = join(import.meta.dirname, "..");

/**
 * The traits table against the code it describes.
 *
 * That every definition HAS a row is the compiler's job (BuiltinTool takes
 * its names from the table), and it holds for tools this machine withholds,
 * which no test here could reach. These are the things the compiler cannot
 * see: a row left behind by a tool that was removed or renamed, a headline
 * that names an argument the tool does not take, a `makes` that the artifact
 * reader does not agree with.
 */
describe("the traits table", () => {
  /** Every file a built-in is defined in, as one string. Read from the
   *  source, not the registry: a tool withheld on this machine is still
   *  defined. */
  const toolSource = (): string => {
    const toolsDir = join(ROOT, "src", "tools");
    return [
      ...readdirSync(toolsDir)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => readFileSync(join(toolsDir, f), "utf8")),
      readFileSync(join(ROOT, "src", "pipelines.ts"), "utf8"),
    ].join("\n");
  };

  test("every row is a tool that is defined somewhere", () => {
    const source = toolSource();
    const stale = BUILTIN_TOOL_NAMES.filter((name) => !source.includes(`name: "${name}"`));
    assert.deepEqual(stale, [], `rows with no definition: ${stale.join(", ")}`);
  });

  test("every built-in in the registry has a row, and every tool an agent holds is one", async () => {
    const registry = await buildRegistry();
    const builtins = registry.all.filter((t) => t.origin === "builtin");
    assert.ok(builtins.length > 10, "the registry under test is the real one");
    assert.deepEqual(builtins.filter((t) => traitsOf(t.name) === null).map((t) => t.name), []);
    // A specialist naming a tool that does not exist holds nothing, and
    // says nothing about it.
    for (const s of allSpecialists()) {
      const unknown = s.tools.filter((t) => traitsOf(t) === null);
      assert.deepEqual(unknown, [], `${s.name} lists tools that are not built-ins: ${unknown.join(", ")}`);
    }
  });

  test("a headline names an argument the tool takes", () => {
    // find_file's headline once led with `name` and browse's ended with
    // `action`, parameters neither ever had, and nothing failed: the badge
    // fell through to the next key. Read from the source so that a tool
    // this machine withholds is checked too -- browse is one, and its wrong
    // key sat behind exactly that.
    const source = toolSource();
    for (const name of BUILTIN_TOOL_NAMES) {
      const from = source.indexOf(`name: "${name}"`);
      // A definition runs from its name to its run(); the parameters are
      // between the two.
      const definition = source.slice(from, source.indexOf("run(", from));
      const wrong = BUILTIN_TRAITS[name].headline.filter(
        (key) => !new RegExp(`\\b${key}: \\{`).test(definition),
      );
      assert.deepEqual(wrong, [], `${name} has no argument named ${wrong.join(", ")}`);
    }
  });

  test("a headline is never an argument that carries a document", () => {
    // The badge prints it, clipped to a line. A file's contents, a mail
    // body or a script there is the thing the closed list exists to avoid.
    const bulky = ["content", "body", "old_string", "new_string", "script", "steps", "text", "notes", "description"];
    for (const name of BUILTIN_TOOL_NAMES) {
      const carried = BUILTIN_TRAITS[name].headline.filter((key) => bulky.includes(key));
      assert.deepEqual(carried, [], name);
    }
  });

  test("what a tool makes is what the artifact reader finds in its output", () => {
    // `makes` says a tool leaves something behind; artifacts.ts is what
    // reads which thing, from the tool's own line. A tool marked here and
    // unread there would be counted as a write and show no file.
    // Each tool's own success text, as its code prints it.
    const lines: Record<string, string> = {
      write_file: "Wrote 12 bytes to notes.md (previous version kept: stash/2026-11-27T10-00-00-notes.md)",
      edit_file: "Wrote 12 bytes to notes.md\nReplaced 1 passage at line 3.",
      take_screenshot: "Screenshot saved to /tmp/assets/screen-1786307090790.png\n\nA window titled Notes.",
      send_email:
        "DRY RUN — nothing was sent.\n\nTo: a@example.com\nSubject: Hello\n\nHi.\n" +
        "Saved to /tmp/assets/draft-1786307090790.eml\nSet ENIO_EMAIL_SEND=1 to send for real.",
      propose_plan: "Proposed, not run. The user has been shown this plan and must approve it:\n\n1. Open Notes",
    };
    const makers = BUILTIN_TOOL_NAMES.filter((name) => BUILTIN_TRAITS[name].makes !== null);
    assert.deepEqual([...makers].sort(), Object.keys(lines).sort());
    for (const name of makers) {
      const made = extractArtifacts(name, lines[name]!);
      assert.deepEqual(made.map((a) => a.type), [BUILTIN_TRAITS[name].makes], name);
    }
    // And the other way: every name the reader branches on is a maker.
    // Read from its source, because it looks at the name before the text
    // and so returns nothing for any other tool whatever it is handed.
    // handoff_saved is the harness recording its own save, not a tool.
    const reader = readFileSync(join(ROOT, "src", "artifacts.ts"), "utf8");
    const read = [...reader.matchAll(/tool === "([a-z_]+)"/g)].map((m) => m[1]!);
    assert.deepEqual([...new Set(read)].sort(), [...makers, "handoff_saved"].sort());
  });

  test("a tool that makes something acts", () => {
    // Leaving a file behind is changing something. A row that says one and
    // not the other would let a web reader hold it.
    const quiet = BUILTIN_TOOL_NAMES.filter((n) => BUILTIN_TRAITS[n].makes !== null && !BUILTIN_TRAITS[n].acts);
    assert.deepEqual(quiet, []);
  });

  test("a name the table does not hold is nothing, including an MCP tool's", () => {
    for (const name of ["filesystem__write_file", "slack_post", "write_fil", ""]) {
      assert.equal(traitsOf(name), null, name);
      assert.equal(toolActs(name), false);
      assert.equal(toolMakes(name), null);
      assert.equal(toolReads(name, "web", "files", "live", "memory"), false);
    }
  });

  test("a name that is a property of every object is not a tool", () => {
    // The model types tool names, and "constructor" is a key of any plain
    // object. Looked up without an own-property check it came back as a
    // function, and the badge code then tried to iterate it.
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      assert.equal(traitsOf(name), null, name);
      assert.equal(callDetail(name, { query: "x" }), "query: x");
    }
  });

  test("a row cannot be changed after load", () => {
    // The sets the save check reads are computed once. A row flipped later
    // would leave them saying one thing and the table another.
    assert.throws(() => {
      (BUILTIN_TRAITS.run_command as { acts: boolean }).acts = false;
    }, TypeError);
    assert.equal(toolActs("run_command"), true);
  });

  test("the lists the harness asks by name", () => {
    // The label on an answer and the live-access correction are read from
    // these two columns, and nothing else in the suite holds most of their
    // rows. Written out for the reason web.test.ts writes out the boundary:
    // a row changed in the table has to be changed here as well.
    assert.deepEqual(
      [...toolsWhere((t) => t.reads === "files")].sort(),
      [
        "edit_file", "find_file", "library_search", "list_dir", "read_drive", "read_email",
        "read_file", "read_image", "search_code", "search_drive", "search_email",
      ],
    );
    assert.deepEqual([...toolsWhere((t) => t.reads === "live")].sort(), ["current_time", "weather"]);
    assert.deepEqual([...toolsWhere((t) => t.reads === "memory")], ["recall"]);
    assert.ok(toolReads("web_fetch_rendered", "web"), "a rendered fetch reads the web");
    assert.ok(toolReads("recall", "memory") && !toolReads("remember", "memory"));
    // Undecided, and pinned so that deciding it is an edit somebody makes.
    for (const name of ["read_calendar", "list_todos", "find_contact"]) {
      assert.equal(traitsOf(name)?.reads, null, name);
    }
  });
});
