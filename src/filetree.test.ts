import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * The Browse tree's derivation, tested from the Node suite.
 *
 * Both rules here failed silently in the app before they were pinned: a file
 * listing that omits a folder produces a tree that omits it too, and nothing
 * throws — the folder is simply not there, in the one place that tells
 * someone which files Enio can reach.
 */
const LIB = "../desktop/renderer/src/lib/filetree.js";
const { childrenAt, groupRoots } = await import(LIB);

const folder = (alias: string) => ({ alias, kind: "folder" as const, note: "", path: `/tmp/${alias}` });

describe("childrenAt", () => {
  test("an attached folder is listed even when it holds no files", () => {
    // The reported bug: a freshly created repo, attached and empty, appeared
    // nowhere — so there was no way to walk in and start writing in it.
    const { folders } = childrenAt([], [folder("todos")], []);
    assert.deepEqual(folders, ["todos"]);
  });

  test("an attached folder is listed once, not twice, when it does hold files", () => {
    const { folders, here } = childrenAt(["todos/index.html"], [folder("todos")], []);
    assert.deepEqual(folders, ["todos"]);
    assert.deepEqual(here, []);
  });

  test("a file attachment is a file row, not a folder", () => {
    const { folders, here } = childrenAt([], [{ alias: "lease.pdf", kind: "file" }], []);
    assert.deepEqual(folders, []);
    assert.deepEqual(here, ["lease.pdf"]);
  });

  test("inside a folder, only its own children — and no alias rows", () => {
    const { folders, here } = childrenAt(
      ["todos/src/app.js", "todos/index.html", "other/x.md"],
      [folder("todos"), folder("other")],
      ["todos"],
    );
    assert.deepEqual(folders, ["src"]);
    assert.deepEqual(here, ["index.html"]);
  });

  test("an empty attached folder walked into reports nothing, which is what shows 'empty'", () => {
    const { folders, here } = childrenAt([], [folder("todos")], ["todos"]);
    assert.deepEqual(folders, []);
    assert.deepEqual(here, []);
  });
});

describe("groupRoots", () => {
  const split = (files: string[], attachments: { alias: string; kind: "folder" | "file" }[], generated: string[]) => {
    const { folders, here } = childrenAt(files, attachments, []);
    return groupRoots({ folders, here, files, attachments, generated });
  };

  test("attachments and generated files sit with the project, the rest with the workspace", () => {
    const g = split(
      ["todos/index.html", "notes.md", "reports/q3.md", "coffee.md", "library/loose.txt"],
      [folder("todos")],
      ["notes.md", "reports/q3.md"],
    );
    assert.deepEqual(g.projectFolders, ["todos", "reports"].sort());
    assert.deepEqual(g.projectHere, ["notes.md"]);
    assert.deepEqual(g.wsFolders, ["library"]);
    assert.deepEqual(g.wsHere, ["coffee.md"]);
  });

  test("an empty attached folder still groups under the project", () => {
    const g = split(["coffee.md"], [folder("todos")], []);
    assert.deepEqual(g.projectFolders, ["todos"]);
    assert.deepEqual(g.wsHere, ["coffee.md"]);
  });

  test("a folder holding both generated and workspace files stays with the workspace", () => {
    // The collision belongs to the workspace's namespace. Calling it the
    // project's would hide that two different files answer to one path.
    const g = split(["docs/gen.md", "docs/mine.md"], [], ["docs/gen.md"]);
    assert.deepEqual(g.projectFolders, []);
    assert.deepEqual(g.wsFolders, ["docs"]);
  });
});
