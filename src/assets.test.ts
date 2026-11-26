import { test, describe, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "enio-assets-")));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "none.json");
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const assets = await import("./assets.js");
const { fsTools, safePath } = await import("./tools/fs.js");
const project = await import("./project.js");
const store = await import("./memory/store.js");
const { recordTurn } = await import("./memory/traces.js");
const { closeDb } = await import("./memory/db.js");

const ws = process.env.ENIO_WORKSPACE!;
const tool = (name: string) => fsTools.find((t) => t.name === name)!;
const text = (r: unknown) => (typeof r === "string" ? r : (r as { text: string }).text);
const write = async (path: string, content: string) => text(await tool("write_file").run({ path, content }));
const read = async (path: string) => text(await tool("read_file").run({ path }));
/** A turn of a conversation, as runTurn opens one. */
const turn = (conversationId: string, request: string, agent = "coder") =>
  assets.enterAssetTurn({ request, source: "chat", conversationId, agent });
const ASSET = /^Wrote \d+ bytes to (assets\/\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9-]+\/[^\s(]+)/m;
const pathOf = (result: string) => ASSET.exec(result)?.[1] ?? assert.fail(`not an asset path: ${result}`);
const conversation = (first: string) => {
  const id = store.startSession();
  store.logMessage(id, "user", first);
  return id;
};

afterEach(() => {
  assets.leaveAssetTurn();
  assets.endAssetRun();
  project.closeProject();
});
after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

describe("a new file with no stated home becomes an asset", () => {
  test("one dated folder per turn: an app written as three files is one asset", async () => {
    const c = conversation("build me a tip calculator");
    turn(c, "build me a tip calculator");
    const a = pathOf(await write("index.html", "<title>Tip calculator</title>"));
    const b = pathOf(await write("styles.css", "body{}"));
    const d = pathOf(await write("js/app.js", "1"));
    const folder = a.split("/")[1]!;
    // "index" says nothing, so the folder is named from the request.
    assert.match(folder, /^\d{4}-\d{2}-\d{2}-\d{4}-build-tip-calculator$/);
    assert.equal(b.split("/")[1], folder);
    assert.equal(d, `assets/${folder}/js/app.js`);
    assert.ok(existsSync(join(ws, d)));

    const listed = assets.listAssets().find((x) => x.id === folder)!;
    assert.equal(listed.kind, "app");
    assert.equal(listed.title, "Tip calculator", "read off the page, not written by a model");
    assert.equal(listed.files.length, 3);
    assert.equal(listed.entry, `assets/${folder}/index.html`);
    assert.equal(listed.request, "build me a tip calculator");
    assert.deepEqual(listed.agents, ["coder"]);
    assert.deepEqual(listed.conversation, { id: c, title: "build me a tip calculator", exists: true });
  });

  test("a document is named for itself, and its heading is what it is called", async () => {
    turn(conversation("write up the trails"), "write up the trails");
    const p = pathOf(await write("trails-sintra.md", "# Five trails near Sintra\n\nShort walks first.\n"));
    assert.match(p, /-trails-sintra\/trails-sintra\.md$/);
    const listed = assets.listAssets()[0]!;
    assert.equal(listed.kind, "document");
    assert.equal(listed.title, "Five trails near Sintra");
    assert.equal(listed.description, "Short walks first.");
  });

  test("the next turn finds it by its bare name instead of making a second one", async () => {
    const c = conversation("notes on the launch");
    turn(c, "notes on the launch");
    const first = pathOf(await write("launch.md", "# Launch\n\nv1\n"));
    assets.leaveAssetTurn();

    turn(c, "add the date to it");
    assert.match(await read("launch.md"), /# Launch/, "read by bare name");
    const again = pathOf(await write("launch.md", "# Launch\n\nv2, 3 March\n"));
    assert.equal(again, first, "rewritten where it is");
    await tool("edit_file").run({ path: "launch.md", old_string: "3 March", new_string: "4 March" });
    assert.match(readFileSync(join(ws, first), "utf8"), /4 March/);
    // And the full path a tool printed resolves too: that is what a model copies.
    assert.match(await read(first), /4 March/);
    assert.equal(assets.listAssets().filter((x) => x.title === "Launch").length, 1);
  });

  test("another conversation's file of the same name is not this one's", async () => {
    turn(conversation("first"), "first");
    const mine = pathOf(await write("plan.md", "mine"));
    assets.leaveAssetTurn();
    turn(conversation("second"), "second");
    const theirs = pathOf(await write("plan.md", "theirs"));
    assert.notEqual(theirs, mine);
    assert.equal(readFileSync(join(ws, mine), "utf8"), "mine");
  });

  test("resolving a path writes nothing: an edit that is refused leaves no empty asset", async () => {
    const before = existsSync(join(ws, "assets")) ? readdirSync(join(ws, "assets")).length : 0;
    turn(conversation("fix it"), "fix it");
    await assert.rejects(() => Promise.resolve(tool("edit_file").run({ path: "ghost.md", old_string: "a", new_string: "b" })));
    assert.equal(readdirSync(join(ws, "assets")).length, before);
  });

  test("outside a turn a file goes where it always went", async () => {
    assert.equal(await write("loose.md", "x"), "Wrote 1 bytes to loose.md");
    assert.ok(existsSync(join(ws, "loose.md")));
  });

  test("a path cannot climb out of the asset or the store", async () => {
    turn(conversation("escape"), "escape");
    await assert.rejects(() => write("../../outside.md", "x"), /escapes/);
    assert.throws(() => safePath("assets/../../outside.md"), /escapes/);
  });
});

describe("what made it outlives the conversation", () => {
  test("a discarded conversation leaves the asset with its request and title", async () => {
    const c = conversation("draft the lease summary for the flat in Porto");
    turn(c, "draft the lease summary for the flat in Porto", "coder");
    const p = pathOf(await write("lease-summary.md", "# Lease summary\n\nTwelve months.\n"));
    assets.leaveAssetTurn();
    store.discardConversation(c, { keepFacts: false });

    const listed = assets.listAssets().find((x) => x.entry === p)!;
    assert.deepEqual(listed.conversation, {
      id: c,
      title: "draft the lease summary for the flat in Porto",
      exists: false,
    });
    assert.equal(listed.request, "draft the lease summary for the flat in Porto");
    assert.equal(listed.description, "Twelve months.");
    assert.ok(existsSync(join(ws, p)), "discarding a conversation deletes no asset");
  });

  test("a plan's files are one asset, credited to the conversation that asked", async () => {
    const c = conversation("search for trails and write them up");
    assets.beginAssetRun({ request: "search for trails and write them up", source: "plan", conversationId: c });
    // Two steps, two agents, as the executor runs them.
    assets.enterAssetTurn({ request: "Search the web for trails", source: "chat", conversationId: "the-run's-own-session", agent: "researcher" });
    assets.leaveAssetTurn();
    assets.enterAssetTurn({ request: "Write the document", source: "chat", conversationId: "the-run's-own-session", agent: "coder" });
    const p = pathOf(await write("trails.md", "# Trails\n"));
    assets.leaveAssetTurn();
    assets.endAssetRun();

    const listed = assets.listAssets().find((x) => x.entry === p)!;
    assert.equal(listed.source, "plan");
    assert.equal(listed.request, "search for trails and write them up", "the request, not a step's guidance");
    assert.deepEqual(listed.agents, ["researcher", "coder"]);
    assert.equal(listed.conversation?.id, c);
    // And a follow-up in that conversation finds it by name.
    turn(c, "shorten it");
    assert.match(await read("trails.md"), /# Trails/);
  });
});

describe("with a project open", () => {
  test("a document is an asset tagged with the project, not a file in its hidden folder", async () => {
    const p = project.createProject({ name: "assets-general", type: "general" });
    writeFileSync(join(p.outDir, "..", "placeholder"), "");
    mkdirSync(p.outDir, { recursive: true });
    writeFileSync(join(p.outDir, "old-notes.md"), "from before assets");
    project.openProject(p.id);

    turn(conversation("write the brief"), "write the brief");
    const made = pathOf(await write("brief.md", "# Brief\n"));
    assert.ok(existsSync(join(ws, made)));
    assert.ok(!existsSync(join(p.outDir, "brief.md")), "nothing new lands in out/");
    assert.match(await read(made), /# Brief/, "the printed path resolves with a project open");
    assert.deepEqual(assets.listAssets().find((x) => x.entry === made)!.project, { id: p.id, name: "assets-general" });

    // What was already in out/ is still read and rewritten where it is.
    assert.match(await read("old-notes.md"), /from before assets/);
    assert.equal(await write("old-notes.md", "updated"), `Wrote 7 bytes to old-notes.md (previous version kept: ${stashOf()})`);
    assert.equal(readFileSync(join(p.outDir, "old-notes.md"), "utf8"), "updated");
  });

  test("code goes into the attached folder and the store keeps a pointer, never a copy", async () => {
    const repo = join(scratch, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "existing.js"), "old");
    const p = project.createProject({ name: "assets-code", type: "code" });
    project.attachPath(p.id, repo, "the app");
    project.openProject(p.id);

    const c = conversation("add a settings page");
    turn(c, "add a settings page");
    assert.equal(await write("src/settings.js", "export {}"), "Wrote 9 bytes to repo/src/settings.js");
    assert.ok(existsSync(join(repo, "src", "settings.js")), "in the repo, where it was asked for");
    // Rewriting the user's own file creates nothing.
    await write("existing.js", "new");

    const pointer = assets.listAssets().find((x) => x.kind === "linked" && x.conversation?.id === c)!;
    assert.deepEqual(pointer.files.map((f) => f.path), [join(repo, "src", "settings.js")]);
    assert.equal(pointer.location, repo);
    assert.match(pointer.description, /^In repo: /);
    const dir = join(ws, "assets", pointer.id);
    assert.match(readFileSync(join(dir, "LOCATION.txt"), "utf8"), /settings\.js/);
    assert.deepEqual(readdirSync(dir).sort(), [".asset.json", "LOCATION.txt"], "no copy of the code");

    // A document in a code project is not code: it is an asset in the store.
    const doc = pathOf(await write("design.md", "# Design\n"));
    assert.ok(!existsSync(join(repo, "design.md")));
    assert.ok(existsSync(join(ws, doc)));

    // Removing the pointer never deletes from the attached folder.
    assert.equal(assets.removeAsset(pointer.id), true);
    assert.ok(existsSync(join(repo, "src", "settings.js")));
    assert.ok(!existsSync(dir));
  });

  test("no folder can be attached under the store's name", () => {
    assert.equal(project.dedupedAlias("assets", new Set()), "assets-2");
  });
});

describe("the list", () => {
  test("newest first, and an asset with nothing in it is not listed", async () => {
    turn(conversation("first thing"), "first thing");
    const older = pathOf(await write("older.md", "# Older\n"));
    assets.leaveAssetTurn();
    await new Promise((r) => setTimeout(r, 5));
    turn(conversation("a screenshot that failed"), "a screenshot that failed");
    const shot = assets.placeNewFile("screen-1786307090790.png");
    assets.leaveAssetTurn();
    await new Promise((r) => setTimeout(r, 5));
    turn(conversation("second thing"), "second thing");
    const newer = pathOf(await write("newer.md", "# Newer\n"));

    const entries = assets.listAssets().map((x) => x.entry);
    assert.ok(entries.indexOf(newer) < entries.indexOf(older));
    // The folder was made for the screenshot and nothing was written to it.
    assert.ok(existsSync(join(shot, "..", ".asset.json")));
    assert.ok(!assets.listAssets().some((x) => x.request === "a screenshot that failed"));
    // "screen-<number>" is not a name: the folder takes the request's words.
    assert.match(shot, /-screenshot-failed\/screen-1786307090790\.png$/);
  });

  test("a file from before assets is listed where it sits, with its origin while the trace has one", () => {
    const c = conversation("summarise the coffee notes");
    writeFileSync(join(ws, "coffee-brewing.md"), "# Coffee\n");
    writeFileSync(join(ws, "orphan.png"), "x");
    recordTurn({
      sessionId: c,
      question: "summarise the coffee notes",
      reply: "Done.",
      specialist: "coder",
      systemPrompt: "",
      memoryBlock: "",
      startedAt: 1_700_000_000_000,
      durationMs: 1,
      iterations: 1,
      model: "test",
      steps: [{ seq: 0, kind: "tool", name: "write_file", args: "{}", output: "Wrote 9 bytes to coffee-brewing.md", error: null, durationMs: 1 }],
    });

    const coffee = assets.listAssets().find((x) => x.id === `legacy:${join(ws, "coffee-brewing.md")}`)!;
    assert.equal(coffee.legacy, true);
    assert.equal(coffee.request, "summarise the coffee notes");
    assert.deepEqual(coffee.agents, ["coder"]);
    assert.equal(coffee.conversation?.exists, true);
    assert.equal(coffee.createdAt, 1_700_000_000_000);
    assert.equal(coffee.entry, "coffee-brewing.md", "not moved");

    const orphan = assets.listAssets().find((x) => x.id === `legacy:${join(ws, "orphan.png")}`)!;
    assert.equal(orphan.request, "");
    assert.equal(orphan.conversation, null);
    // Not an asset in the store, so not removable through it.
    assert.equal(assets.removeAsset(`legacy:${join(ws, "orphan.png")}`), false);
    assert.ok(existsSync(join(ws, "orphan.png")));
  });

  test("removing an asset removes its folder", async () => {
    turn(conversation("throwaway"), "throwaway");
    const p = pathOf(await write("throwaway.md", "x"));
    const id = p.split("/")[1]!;
    assert.equal(assets.removeAsset(id), true);
    assert.ok(!existsSync(join(ws, "assets", id)));
    assert.equal(assets.removeAsset("../../etc"), false);
  });
});

function stashOf(): string {
  const dir = join(process.env.ENIO_DATA_DIR!, "stash");
  const names = readdirSync(dir).filter((n) => n.endsWith("-old-notes.md")).sort();
  return `stash/${names[names.length - 1]}`;
}
