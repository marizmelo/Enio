import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * What runs after the coder edits code. The detection is a closed list, and
 * the cases that matter are the traps: npm init's placeholder test script,
 * a package.json beside a Cargo.toml, and the pytest spelling the allowlist
 * actually accepts.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-verify-"));
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const { detectVerifyCommand, verificationFor, verifyFailed } = await import("./verify.js");
const project = await import("./project.js");

after(() => rmSync(scratch, { recursive: true, force: true }));

function repo(name: string, files: Record<string, string>): string {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(root, f), body);
  // Attachments store realpaths (/var → /private/var on macOS), and the
  // cwd handed back is the attachment's path -- compare in those terms.
  return realpathSync(root);
}

test("detection: the closed list, first hit wins, package.json settles the ecosystem", () => {
  assert.equal(
    detectVerifyCommand(repo("npm", { "package.json": '{"scripts":{"test":"node test.js"}}' })),
    "npm test",
  );
  // npm init -y's placeholder is NOT a test script: every fresh package
  // would otherwise fail verification by construction.
  assert.equal(
    detectVerifyCommand(
      repo("npm-init", {
        "package.json": '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}',
        "tsconfig.json": "{}",
      }),
    ),
    "npx tsc --noEmit",
  );
  assert.equal(detectVerifyCommand(repo("ts-only", { "package.json": "{}", "tsconfig.json": "{}" })), "npx tsc --noEmit");
  assert.equal(detectVerifyCommand(repo("npm-bare", { "package.json": "{}" })), null, "no script, no tsconfig: nothing to run");
  assert.equal(detectVerifyCommand(repo("broken-pkg", { "package.json": "{not json", "tsconfig.json": "{}" })), "npx tsc --noEmit");
  // A package.json beside a Cargo.toml: the package.json decides, no fall-through.
  assert.equal(detectVerifyCommand(repo("mixed", { "package.json": "{}", "Cargo.toml": "" })), null);
  assert.equal(detectVerifyCommand(repo("rust", { "Cargo.toml": "[package]" })), "cargo check");
  assert.equal(detectVerifyCommand(repo("go", { "go.mod": "module x" })), "go build ./...");
  // The allowlisted spelling: bare `pytest` is not on the list.
  assert.equal(detectVerifyCommand(repo("py", { "pyproject.toml": "" })), "python3 -m pytest -q");
  assert.equal(detectVerifyCommand(repo("py2", { "pytest.ini": "" })), "python3 -m pytest -q");
  assert.equal(detectVerifyCommand(repo("empty", {})), null);
});

test("verificationFor: documents are skipped, the edited file's folder is the cwd, the project field wins", () => {
  const api = repo("api", { "package.json": '{"scripts":{"test":"node -e 0"}}', "index.ts": "" });
  const web = repo("web", { "Cargo.toml": "" , "main.rs": "" });
  const p = project.createProject({ name: "multi", type: "code" });
  project.attachPath(p.id, api, "backend");
  project.attachPath(p.id, web, "frontend");
  project.openProject(p.id);
  try {
    // Two folders attached: `in` names the one the edited file lives in.
    const v = verificationFor([join(api, "index.ts")]);
    assert.deepEqual(v, { command: "npm test", in: "api", cwd: api });
    const w = verificationFor([join(web, "main.rs")]);
    assert.deepEqual(w, { command: "cargo check", in: "web", cwd: web });
    // A document edit runs nothing.
    assert.equal(verificationFor([join(api, "README.md")]), null);
    // A file under the project's out dir: detection there finds nothing.
    assert.equal(verificationFor([join(project.activeProject()!.outDir, "notes.ts")]), null);
    // A path in neither: nothing to verify.
    assert.equal(verificationFor([join(scratch, "elsewhere.ts")]), null);

    // The project's own command overrides detection...
    project.updateProject(p.id, { verifyCommand: "npx tsc --noEmit" });
    project.openProject(p.id);
    assert.deepEqual(verificationFor([join(api, "index.ts")]), { command: "npx tsc --noEmit", in: "api", cwd: api });
  } finally {
    project.closeProject();
  }
});

test("a single attached folder needs no `in`; an unsupported saved command is refused at save", () => {
  const solo = repo("solo", { "go.mod": "module solo", "main.go": "" });
  const p = project.createProject({ name: "solo", type: "code" });
  project.attachPath(p.id, solo, "it");
  project.openProject(p.id);
  try {
    assert.deepEqual(verificationFor([join(solo, "main.go")]), { command: "go build ./...", cwd: solo });
  } finally {
    project.closeProject();
  }
  // Saved command must pass the allowlist on its own -- checked at save,
  // against the base list, so the shell can never refuse what was stored.
  assert.throws(() => project.updateProject(p.id, { verifyCommand: "rm -rf /" }), /Refused: 'rm'/);
  assert.throws(() => project.updateProject(p.id, { verifyCommand: "npm test\nrm -rf /" }), /single line/);
  assert.throws(() => project.updateProject(p.id, { verifyCommand: "x".repeat(201) }), /cap is 200/);
  const ok = project.updateProject(p.id, { verifyCommand: "  npm test  " });
  assert.equal(ok.verifyCommand, "npm test");
  // And it round-trips through project.json.
  assert.equal(project.findProject(p.id)?.verifyCommand, "npm test");
  // Clearing it goes back to detection.
  assert.equal(project.updateProject(p.id, { verifyCommand: "" }).verifyCommand, "");
});

test("verifyFailed reads run_command's failure prefixes", () => {
  assert.equal(verifyFailed("exit 1\nTypeError: x"), true);
  assert.equal(verifyFailed("Timed out after 60s and was killed.\n"), true);
  assert.equal(verifyFailed("Refused: 'rm' is not in the allowed command list"), true);
  assert.equal(verifyFailed("Failed to start: spawn ENOENT"), true);
  assert.equal(verifyFailed("Error: boom"), true);
  assert.equal(verifyFailed("(no output)"), false);
  assert.equal(verifyFailed("  PASS  src/a.test.ts\n"), false);
});
