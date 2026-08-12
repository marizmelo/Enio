import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

// Redirected before anything imports config, so nothing here can touch the
// developer's real data dir or workspace.
const scratch = mkdtempSync(join(tmpdir(), "enio-project-"));
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
// Machine-wide state (model choice, desktop-control consent) must never be
// read from or written to the developer's real machine by a test.
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_DATA_DIR = join(scratch, "data");
// The overlay test drives a full turn with a scripted model; routing would
// spend the script on a classification call. Set before any import of config.
process.env.ENIO_ROUTING = "0";
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

let project: typeof import("./project.js");

before(async () => {
  project = await import("./project.js");
});

function fresh(name: string) {
  return project.createProject({ name });
}

test("caps are refused, never truncated", () => {
  assert.throws(() => project.createProject({ name: "x".repeat(61) }), /cap is 60/);
  assert.throws(
    () => project.createProject({ name: "capped", description: "d".repeat(201) }),
    /cap is 200/,
  );
  const p = fresh("caps");
  assert.throws(() => project.updateProject(p.id, { instructions: "i".repeat(601) }), /cap is 600/);
  // A failed update must not half-apply.
  assert.equal(project.findProject(p.id)!.instructions, "");
  const ok = project.updateProject(p.id, { instructions: "keep it short" });
  assert.equal(ok.instructions, "keep it short");
});

test("unknown types and duplicate names are refused", () => {
  assert.throws(() => project.createProject({ name: "typed", type: "gaming" }), /Unknown project type/);
  fresh("Dupe");
  assert.throws(() => project.createProject({ name: "dupe" }), /already exists/);
});

test("attach guards: the roots that would make attachment meaningless", () => {
  const p = fresh("guards");
  assert.throws(() => project.attachPath(p.id, join(scratch, "missing")), /does not exist/);
  assert.throws(() => project.attachPath(p.id, "/"), /filesystem root/);
  assert.throws(() => project.attachPath(p.id, homedir()), /home directory/);
  assert.throws(() => project.attachPath(p.id, process.env.ENIO_DATA_DIR!), /data directory/);
  assert.throws(
    () => project.attachPath(p.id, join(process.env.ENIO_DATA_DIR!, "projects")),
    /data directory/,
  );
  assert.throws(() => project.attachPath(p.id, process.env.ENIO_WORKSPACE!), /already readable/);
  // A symlink to a refused root is the same refusal: the check runs on the
  // realpath, not the name.
  const link = join(scratch, "innocent-looking");
  symlinkSync(homedir(), link);
  assert.throws(() => project.attachPath(p.id, link), /home directory/);
});

test("attachments get deduped aliases and reserved names stay reserved", () => {
  const p = fresh("aliases");
  const a = join(scratch, "src");
  const b = join(scratch, "nested", "src");
  const out = join(scratch, "out");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  mkdirSync(out, { recursive: true });

  assert.equal(project.attachPath(p.id, a, "the code").alias, "src");
  assert.equal(project.attachPath(p.id, b).alias, "src-2");
  // "out" belongs to the project's own output dir; an attachment must not
  // shadow it or unprefixed writes would silently change meaning.
  assert.equal(project.attachPath(p.id, out).alias, "out-2");
  assert.throws(() => project.attachPath(p.id, a), /already attached/);

  project.detachPath(p.id, "src-2");
  assert.equal(project.findProject(p.id)!.attachments.length, 2);
  assert.throws(() => project.detachPath(p.id, "src-2"), /No attachment/);
});

test("files attach as files, with the note capped", () => {
  const p = fresh("filekind");
  const file = join(scratch, "brief.md");
  writeFileSync(file, "hello");
  const att = project.attachPath(p.id, file, "client requirements");
  assert.equal(att.kind, "file");
  assert.throws(() => project.attachPath(p.id, file + "x", "n".repeat(121)), /cap is 120/);
});

test("activation is process memory; the definition persists", () => {
  const p = fresh("activate");
  assert.equal(project.activeProject(), null);
  project.openProject("activate"); // by name, as the CLI does
  assert.equal(project.activeProject()!.id, p.id);
  assert.ok(existsSync(project.activeProject()!.outDir), "open scaffolds out/");
  project.closeProject();
  assert.equal(project.activeProject(), null);
  // Still on disk, still findable -- only the activation was memory.
  assert.ok(project.findProject(p.id));
});

test("closing is remembered, so a relaunch does not silently reopen", () => {
  // The bug: the desktop restored whichever project the newest conversation
  // was tagged with, so closing never survived a relaunch -- and every new
  // chat afterwards inherited a project nobody had opened. What a client
  // restores must be the user's last *choice*, not an inference from data.
  const p = fresh("sticky");
  project.openProject(p.id);
  assert.equal(project.lastOpenedProjectId(), p.id);

  project.closeProject();
  assert.equal(project.lastOpenedProjectId(), null, "closing must survive a restart");

  // Reopening records it again; deleting the project clears the pointer, so a
  // deleted project cannot haunt every launch with a reopen that can only fail.
  project.openProject(p.id);
  assert.equal(project.lastOpenedProjectId(), p.id);
  project.deleteProject(p.id);
  assert.equal(project.lastOpenedProjectId(), null);
});

test("a conversation started with nothing open carries no project tag", async () => {
  const store = await import("./memory/store.js");
  const p = fresh("untagged");

  project.openProject(p.id);
  const inside = store.startSession();
  project.closeProject();
  const outside = store.startSession();
  store.logMessage(inside, "user", "in the project");
  store.logMessage(outside, "user", "not in the project");

  const all = store.listConversations();
  assert.equal(all.find((c) => c.id === inside)?.projectId, p.id);
  assert.equal(
    all.find((c) => c.id === outside)?.projectId,
    null,
    "a chat started after closing must not be tagged",
  );
});

test("unprefixed paths root in out/ only while a project is open", () => {
  const p = fresh("roots");
  project.openProject(p.id);
  assert.equal(project.activeOutRoot(), p.outDir);
  project.closeProject();
  assert.equal(project.activeOutRoot(), join(scratch, "workspace"));
});

test("findMount resolves aliases only while open", () => {
  const p = fresh("mounts");
  const dir = join(scratch, "api");
  mkdirSync(dir, { recursive: true });
  project.attachPath(p.id, dir, "backend");
  assert.equal(project.findMount("api"), null, "closed project mounts nothing");
  project.openProject(p.id);
  // Stored paths are realpathed at attach time (scratch lives under a /var
  // symlink on macOS), so compare realpath with realpath.
  assert.equal(project.findMount("api")!.path, realpathSync(dir));
  assert.equal(project.findMount("nope"), null);
  project.closeProject();
});

test("sessions are tagged with the open project, and only then", async () => {
  const store = await import("./memory/store.js");
  const p = fresh("tagged");

  const untagged = store.startSession();
  store.logMessage(untagged, "user", "hello with no project");

  project.openProject(p.id);
  const tagged = store.startSession();
  store.logMessage(tagged, "user", "hello from the project");
  project.closeProject();

  const all = store.listConversations();
  assert.equal(all.find((c) => c.id === tagged)?.projectId, p.id);
  assert.equal(all.find((c) => c.id === untagged)?.projectId, null);

  const filtered = store.listConversations(50, p.id);
  assert.ok(filtered.some((c) => c.id === tagged));
  assert.ok(!filtered.some((c) => c.id === untagged), "the filter excludes other conversations");

  assert.equal(store.latestSessionForProject(p.id), tagged);
  assert.equal(store.latestSessionForProject("no-such-project"), null);
});

test("safePath: alias mounts, out/ rooting, and the workspace read-fallback", async () => {
  const { safePath } = await import("./tools/fs.js");
  const p = fresh("sandbox");
  const api = join(scratch, "sandbox", "api");
  mkdirSync(join(api, "src"), { recursive: true });
  writeFileSync(join(api, "src", "index.ts"), "export {}");
  const brief = join(scratch, "sandbox", "brief.md");
  writeFileSync(brief, "requirements");
  project.attachPath(p.id, api, "the backend");
  project.attachPath(p.id, brief, "the brief");

  // An attachment that exists only in the global workspace: the read-fallback
  // is what keeps conversation attachments from failing a project turn.
  const conv = join(scratch, "workspace", "attachments", "conv-1");
  mkdirSync(conv, { recursive: true });
  writeFileSync(join(conv, "shot.png"), "png");

  project.openProject(p.id);
  try {
    const opened = project.activeProject()!;
    // Alias paths resolve inside the mount and are confined to it.
    assert.equal(safePath("api/src/index.ts"), join(realpathSync(api), "src", "index.ts"));
    assert.throws(() => safePath("api/../../../etc/passwd"), /escapes the attached folder/);
    // A file attachment is the file; it has no inside.
    assert.equal(safePath("brief.md"), realpathSync(brief));
    assert.throws(() => safePath("brief.md/anything"), /attached file, not a folder/);
    // Unprefixed writes land in the project's out dir...
    assert.equal(safePath("report.md"), join(opened.outDir, "report.md"));
    // ...but an existing workspace file is still readable by its usual path.
    assert.equal(
      safePath("attachments/conv-1/shot.png"),
      join(scratch, "workspace", "attachments", "conv-1", "shot.png"),
    );
    // Escapes stay escapes.
    assert.throws(() => safePath("../secrets"), /escapes the project/);
    assert.throws(() => safePath("/etc/passwd"), /escapes the project/);
  } finally {
    project.closeProject();
  }
  // Closed: byte-for-byte the old behavior.
  assert.ok(safePath("notes/a.txt").startsWith(join(scratch, "workspace")));
  assert.throws(() => safePath("../../etc/passwd"), /escapes the workspace/);
});

test("run_command's `in` picks an attached folder by alias, never a path", async () => {
  const { shellTools } = await import("./tools/shell.js");
  const run = shellTools[0]!.run;
  const p = fresh("shellcwd");
  const web = join(scratch, "shellcwd", "web");
  const docs = join(scratch, "shellcwd", "docs");
  mkdirSync(web, { recursive: true });
  mkdirSync(docs, { recursive: true });
  project.attachPath(p.id, web);
  project.attachPath(p.id, docs);

  project.openProject(p.id);
  try {
    assert.match(String(await run({ command: "pwd", in: "web" })), /shellcwd\/web/);
    assert.match(String(await run({ command: "pwd", in: "nope" })), /No attached folder named "nope"/);
    // Two folders and no `in`: the neutral default is the project's own out
    // dir, not a silent guess between the two.
    assert.match(String(await run({ command: "pwd" })), /\/out$/m);
    assert.match(String(await run({ command: "pwd", in: "docs" })), /shellcwd\/docs/);
  } finally {
    project.closeProject();
  }
  assert.match(String(await run({ command: "pwd", in: "web" })), /No project is open/);
});

test("the index finds, re-finds, and forgets files; search prints copyable paths", async () => {
  const index = await import("./project-index.js");
  const { searchTools } = await import("./tools/search.js");
  const search = searchTools[0]!.run;

  const p = fresh("indexed");
  const repo = join(scratch, "indexed", "engine");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(repo, "src", "retry.ts"), "export function retryWithBackoff() {}\n");
  writeFileSync(join(repo, "node_modules", "junk", "x.ts"), "retryWithBackoff everywhere");
  writeFileSync(join(repo, "big.txt"), "retryWithBackoff ".repeat(40_000)); // > 512KB
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  const notes = join(scratch, "indexed", "notes.md");
  writeFileSync(notes, "remember: retryWithBackoff needs jitter\n");
  project.attachPath(p.id, repo, "the engine");
  project.attachPath(p.id, notes, "loose notes");

  const opened = project.openProject(p.id);
  try {
    const report = await index.refreshIndex(opened);
    assert.ok(report.files >= 2, "tracks the real files");

    const out = String(await search({ query: "retryWithBackoff" }));
    assert.match(out, /engine\/src\/retry\.ts:1/, "hit is alias-prefixed and line-numbered");
    assert.match(out, /notes\.md:1/, "attached single files are searchable");
    assert.doesNotMatch(out, /node_modules/, "ignored dirs stay out");
    assert.doesNotMatch(out, /big\.txt/, "oversized files stay out of the index");
    assert.doesNotMatch(out, /blob\.bin/, "binary files stay out");

    // The printed path is a valid read_file path — copy, don't compose.
    const { safePath } = await import("./tools/fs.js");
    assert.equal(safePath("engine/src/retry.ts"), join(realpathSync(repo), "src", "retry.ts"));

    // Change: a new symbol in an existing file is found after re-index.
    writeFileSync(join(repo, "src", "retry.ts"), "export function retryOnce() {}\n");
    await index.refreshIndex(opened);
    assert.match(String(await search({ query: "retryOnce" })), /engine\/src\/retry\.ts/);

    // Deletion: the row drops out rather than lingering as a ghost hit.
    rmSync(join(repo, "src", "retry.ts"));
    const after = await index.refreshIndex(opened);
    assert.ok(after.removed >= 1, "vanished files are dropped");
  } finally {
    project.closeProject();
    index.closeIndex(p.id);
  }
});

test("search_code answers from the workspace when no project is open", async () => {
  const { searchTools } = await import("./tools/search.js");
  const search = searchTools[0]!.run;
  const ws = join(scratch, "workspace");
  mkdirSync(join(ws, "notes"), { recursive: true });
  writeFileSync(join(ws, "notes", "todo.md"), "call the dentist about the crown\n");
  const out = String(await search({ query: "dentist" }));
  assert.match(out, /notes\/todo\.md:1/);
  assert.match(out, /workspace/);
});

test("the overlay reaches the system prompt for any specialist, capped and user-authored", async () => {
  // Scripted model: no tools called, one plain reply. What matters is the
  // system message the turn assembles.
  const { runTurn } = await import("./agent.js");
  const { buildRegistry } = await import("./tools/index.js");
  const store = await import("./memory/store.js");

  const p = fresh("overlay");
  const dir = join(scratch, "overlay", "api");
  mkdirSync(dir, { recursive: true });
  project.attachPath(p.id, dir, "the backend");
  project.updateProject(p.id, { instructions: "Prefer small diffs." });

  const originalFetch = globalThis.fetch;
  let systemSeen = "";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string }> };
    systemSeen = body.messages?.find((m) => m.role === "system")?.content ?? "";
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    return new Response(frames.join(""), { status: 200 });
  }) as typeof fetch;

  try {
    project.openProject(p.id);
    const registry = await buildRegistry();
    const sessionId = store.startSession();
    await runTurn("hello there project", [], registry, sessionId);
    assert.match(systemSeen, /working on the project "overlay"/);
    // Imperative, not descriptive: bare "Project: X" context lost to stray
    // retrieved memories on ambiguous requests.
    assert.match(systemSeen, /ambiguous references mean this project/);
    assert.match(systemSeen, /Instructions: Prefer small diffs\./);
    assert.match(systemSeen, /api\/ — the backend/);

    project.closeProject();
    systemSeen = "";
    await runTurn("hello there again", [], registry, store.startSession());
    assert.doesNotMatch(systemSeen, /working on the project/, "no overlay without a project");
  } finally {
    globalThis.fetch = originalFetch;
    project.closeProject();
  }
});

test("the router hears the project type as a prior, not an override", async () => {
  const { route } = await import("./specialists.js");
  const p = project.createProject({ name: "prior", type: "code" });

  const originalFetch = globalThis.fetch;
  let routerSystem = "";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string }> };
    routerSystem = body.messages?.find((m) => m.role === "system")?.content ?? "";
    return new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: '{"specialist": "coder"}' } }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    project.openProject(p.id);
    await route("please fix this for me");
    assert.match(routerSystem, /code project.*prefer the coder/i, "the bias line is present");

    project.closeProject();
    routerSystem = "";
    await route("please fix this for me");
    assert.doesNotMatch(routerSystem, /code project/i, "no bias without a project");
  } finally {
    globalThis.fetch = originalFetch;
    project.closeProject();
  }
});

test("the coder swapped read_image for search_code and stayed at six", async () => {
  const { SPECIALISTS } = await import("./specialists.js");
  const coder = SPECIALISTS.find((s) => s.name === "coder")!;
  assert.ok(coder.tools.includes("search_code"));
  assert.ok(!coder.tools.includes("read_image"), "the swap, not an addition");
  assert.equal(coder.tools.length, 6);
  // The product keeps image reading through specialists that still hold it.
  for (const name of ["generalist", "operator"]) {
    assert.ok(SPECIALISTS.find((s) => s.name === name)!.tools.includes("read_image"));
  }
});

test("project skills shadow global ones by name, and vanish on close", async () => {
  const { loadSkills, skillsDir } = await import("./skills.js");

  const globalDir = join(skillsDir(), "greeting");
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(
    join(globalDir, "SKILL.md"),
    "---\nname: greeting\ndescription: Global greeting style.\n---\nSay hello plainly.\n",
  );

  const p = fresh("skilled");
  const projectSkill = join(p.dir, "skills", "greeting");
  mkdirSync(projectSkill, { recursive: true });
  writeFileSync(
    join(projectSkill, "SKILL.md"),
    "---\nname: greeting\ndescription: Project greeting style.\n---\nSay hello formally.\n",
  );
  // A malformed neighbour must cost itself, not the set.
  const broken = join(p.dir, "skills", "broken");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "SKILL.md"), "no frontmatter at all\n");

  const closed = loadSkills();
  assert.equal(closed.skills.find((s) => s.name === "greeting")?.description, "Global greeting style.");

  project.openProject(p.id);
  try {
    const open = loadSkills();
    const greeting = open.skills.filter((s) => s.name === "greeting");
    assert.equal(greeting.length, 1, "one name, one skill — the project's shadows");
    assert.equal(greeting[0]!.description, "Project greeting style.");
    assert.ok(open.problems.some((pr) => pr.path.includes("broken")), "malformed is reported");
  } finally {
    project.closeProject();
  }
  assert.equal(
    loadSkills().skills.find((s) => s.name === "greeting")?.description,
    "Global greeting style.",
    "closing the project restores the global skill",
  );
});

/** A minimal but well-formed one-page PDF whose text layer says `text`.
 *  Assembled with real byte offsets so pdf.js parses it without repair. */
function minimalPdf(text: string): Buffer {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    null, // stream object, built below
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ];
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test("read_file extracts PDFs and refuses binary honestly — never garbage", async () => {
  const { fsTools } = await import("./tools/fs.js");
  const readTool = fsTools.find((t) => t.name === "read_file")!.run;
  const ws = join(scratch, "workspace");

  writeFileSync(join(ws, "resume.pdf"), minimalPdf("GrapheneWidget resume line"));
  writeFileSync(join(ws, "photo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));

  const pdfOut = String(await readTool({ path: "resume.pdf" }));
  assert.match(pdfOut, /PDF, 1 page/);
  assert.match(pdfOut, /GrapheneWidget resume line/, "the text layer is what the model gets");

  const binOut = String(await readTool({ path: "photo.bin" }));
  assert.match(binOut, /binary file/);
  assert.match(binOut, /do not guess|cannot be read as text/i);
  assert.doesNotMatch(binOut, /\x00/, "no raw bytes reach the prompt");
});

test("attached PDFs are searchable through the project index", async () => {
  const index = await import("./project-index.js");
  const { searchTools } = await import("./tools/search.js");
  const search = searchTools[0]!.run;

  const p = fresh("pdfsearch");
  const cv = join(scratch, "pdfsearch-cv.pdf");
  writeFileSync(cv, minimalPdf("ZanzibarSkillset architecture experience"));
  project.attachPath(p.id, cv, "the resume");

  const opened = project.openProject(p.id);
  try {
    await index.refreshIndex(opened);
    const out = String(await search({ query: "ZanzibarSkillset" }));
    assert.match(out, /pdfsearch-cv\.pdf:1/, "the PDF's text layer is indexed");
  } finally {
    project.closeProject();
    index.closeIndex(p.id);
  }
});

test("delete removes the folder and deactivates, but is not history-destroying", () => {
  const p = fresh("gone");
  project.openProject(p.id);
  project.deleteProject(p.id);
  assert.equal(project.activeProject(), null);
  assert.equal(project.findProject("gone"), null);
  assert.ok(!existsSync(p.dir));
});
