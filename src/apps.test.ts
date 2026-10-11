import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The editor mapping: a closed list, found by probing, chosen once, opened
 * by a command built per editor. What breaks quietly: a phrase that reads
 * as an editor request when it is not, a launcher given the wrong line
 * syntax, and a saved choice outliving its uninstall.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-apps-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "mcp.json");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

import type { InstalledEditor, Probe } from "./apps.js";

const apps = await import("./apps.js");
after(() => rmSync(scratch, { recursive: true, force: true }));

const probe = (found: Record<string, { app?: boolean; cli?: boolean }>): Probe => ({
  appDirs: ["/Apps"],
  pathDirs: ["/bin"],
  exists: (p) => Object.entries(found).some(([id, f]) => f.app && p === `/Apps/${apps.EDITORS.find((e) => e.id === id)!.bundle}`),
  executable: (p) =>
    Object.entries(found).some(([id, f]) => {
      const e = apps.EDITORS.find((x) => x.id === id)!;
      return (f.cli && p === `/bin/${e.cli}`) || (f.app && e.bundleCli !== undefined && p === `/Apps/${e.bundle}/${e.bundleCli}`);
    }),
});

describe("the editor phrase", () => {
  test("names a target and an editor, or nothing", () => {
    assert.deepEqual(apps.editorRequest("open the project in cursor"), { target: "project", editor: "cursor" });
    assert.deepEqual(apps.editorRequest("open src/app.js in my editor"), { target: "src/app.js", editor: null });
    assert.deepEqual(apps.editorRequest("Open todos/index.html with VS Code."), { target: "todos/index.html", editor: "vscode" });
    assert.deepEqual(apps.editorRequest("open this project in zed"), { target: "project", editor: "zed" });
    assert.equal(apps.editorRequest("open the window in the morning"), null, "not an editor word");
    assert.equal(apps.editorRequest("open safari"), null, "that is open <app>");
    assert.equal(apps.editorRequest("what is open in cursor"), null);
  });
});

describe("finding and choosing", () => {
  test("an installed editor is one with a bundle or a launcher; the bundle's own launcher counts", () => {
    const found = apps.installedEditors(probe({ vscode: { app: true }, zed: { cli: true } }));
    assert.deepEqual(found.map((e) => e.id), ["vscode", "zed"]);
    assert.equal(found[0]!.cliPath, "/Apps/Visual Studio Code.app/Contents/Resources/app/bin/code", "the CLI inside the bundle, never installed on PATH");
    assert.equal(found[1]!.appPath, null);
    assert.equal(found[1]!.cliPath, "/bin/zed");
  });

  test("one found is used without asking, several is a question, a choice wins while it is installed", () => {
    assert.equal(apps.effectiveEditor(probe({})).choice, "none");
    const one = apps.effectiveEditor(probe({ cursor: { app: true } }));
    assert.equal(one.choice, "detected");
    assert.equal(one.editor!.id, "cursor");
    const two = probe({ cursor: { app: true }, vscode: { app: true } });
    assert.equal(apps.effectiveEditor(two).choice, "ambiguous");
    assert.equal(apps.effectiveEditor(two).editor, null, "two editors is not a guess");
    apps.setEditor("vscode");
    assert.equal(apps.effectiveEditor(two).editor!.id, "vscode");
    assert.equal(apps.appsStatus(two).choice, "set");
    // Uninstalled since: the saved choice no longer applies, and with one left it is that one.
    assert.equal(apps.effectiveEditor(probe({ cursor: { app: true } })).editor!.id, "cursor");
    apps.setEditor(null);
    assert.equal(apps.effectiveEditor(two).choice, "ambiguous");
    assert.throws(() => apps.setEditor("emacs"), /Unknown editor/);
  });
});

describe("opening", () => {
  const ed = (id: string, cliPath: string | null, appPath: string | null = null): InstalledEditor => ({
    ...apps.EDITORS.find((e) => e.id === id)!,
    cliPath,
    appPath,
  });
  test("each launcher gets its own line syntax, and a folder gets none", () => {
    assert.deepEqual(apps.editorCommand(ed("vscode", "/bin/code"), "/p/a.js", 12), { bin: "/bin/code", args: ["-g", "/p/a.js:12"] });
    assert.deepEqual(apps.editorCommand(ed("zed", "/bin/zed"), "/p/a.js", 12), { bin: "/bin/zed", args: ["/p/a.js:12"] });
    assert.deepEqual(apps.editorCommand(ed("nova", "/bin/nova"), "/p/a.js", 12), { bin: "/bin/nova", args: ["-l", "12", "/p/a.js"] });
    assert.deepEqual(apps.editorCommand(ed("bbedit", "/bin/bbedit"), "/p/a.js", 12), { bin: "/bin/bbedit", args: ["+12", "/p/a.js"] });
    assert.deepEqual(apps.editorCommand(ed("vscode", "/bin/code"), "/p"), { bin: "/bin/code", args: ["/p"] });
    assert.equal(apps.editorCommand(ed("nova", null), "/p"), process.platform === "darwin" ? null : null, "no launcher and no bundle: nothing to run");
  });

  test("openInEditor launches the chosen editor and refuses honestly otherwise", () => {
    const launched: Array<{ bin: string; args: string[] }> = [];
    const launch = (bin: string, args: string[]) => launched.push({ bin, args });
    const two = probe({ cursor: { app: true }, vscode: { app: true } });
    const ambiguous = apps.openInEditor("/p/a.js", { probe: two, launch });
    assert.equal(ambiguous.ok, false);
    assert.match((ambiguous as { reason: string }).reason, /pick one under Settings/);
    const named = apps.openInEditor("/p/a.js", { probe: two, launch, editorId: "cursor", line: 3 });
    assert.equal(named.ok, true);
    assert.deepEqual(launched.at(-1), { bin: "/Apps/Cursor.app/Contents/Resources/app/bin/cursor", args: ["-g", "/p/a.js:3"] });
    const missing = apps.openInEditor("/p/a.js", { probe: two, launch, editorId: "zed" });
    assert.match((missing as { reason: string }).reason, /Zed is not installed/);
    const none = apps.openInEditor("/p/a.js", { probe: probe({}), launch });
    assert.match((none as { reason: string }).reason, /No code editor was found/);
  });
});
