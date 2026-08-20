import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { callDetail, callStatus } from "./tool-detail.js";

/**
 * What a badge says when opened.
 *
 * Shared by the live stream and by restore precisely so the two cannot
 * disagree — a conversation reopened tomorrow has to say what it said while
 * it ran.
 */
describe("callDetail", () => {
  test("names the argument that IS the call", () => {
    assert.equal(
      callDetail("run_command", { command: "python3 -m http.server 8123 --bind 127.0.0.1" }),
      "python3 -m http.server 8123 --bind 127.0.0.1",
    );
    assert.equal(callDetail("read_file", { path: "src/app.js" }), "src/app.js");
    assert.equal(callDetail("web_search", { query: "who won" }), "who won");
  });

  test("a file's contents never become the label", () => {
    // write_file carries the whole file; printing it would push the answer
    // off the screen to say something the path already said.
    const detail = callDetail("write_file", {
      path: "todos/index.html",
      content: "<html>".padEnd(20000, "x"),
    });
    assert.equal(detail, "todos/index.html");
  });

  test("long values are clipped, and newlines flattened", () => {
    const detail = callDetail("run_command", { command: "echo " + "a".repeat(400) });
    assert.ok(detail.length <= 160, detail.length.toString());
    assert.match(detail, /…$/);
    assert.equal(callDetail("run_command", { command: "a\n  b" }), "a b");
  });

  test("an unlisted tool still says something", () => {
    // Every MCP tool is unlisted by definition, and a blank panel would read
    // as a bug rather than as an unknown shape.
    assert.equal(callDetail("github__create_issue", { title: "Bug", repo: "enio" }), "title: Bug, repo: enio");
    assert.equal(callDetail("mystery", {}), "");
  });
});

describe("callStatus", () => {
  test("reads the outcome from the tool's own words", () => {
    // Tools refuse by returning text, never by throwing, so the prefixes they
    // write are the only honest source.
    assert.equal(callStatus("Wrote 412 bytes to a.js"), "ok");
    assert.equal(callStatus("Refused: 'rm' is not allowed."), "refused");
    assert.equal(callStatus("exit 1\nnpm ERR!"), "failed");
    assert.equal(callStatus("Error: no file at x"), "failed");
    assert.equal(callStatus("Timed out after 60s and was killed."), "failed");
    assert.equal(callStatus("Exited immediately with code 3. It is not running."), "failed");
  });

  test("a started server is its own status, not success and not failure", () => {
    assert.equal(
      callStatus("Started in the background (pid 412) and is still running. …"),
      "background",
    );
  });
});
