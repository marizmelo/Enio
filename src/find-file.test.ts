import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { findFileTool } from "./tools/find-file.js";
import { toolText } from "./types.js";

/**
 * Spotlight-by-name, with the runner injected: the tests pin the argument
 * contract (execFile array, -onlyin home, no shell) and the output shape,
 * never the machine's actual index.
 */
describe("find_file", () => {
  test("passes the query as an execFile argument, scoped to home", async () => {
    let seen: { bin: string; args: string[] } | null = null;
    const tool = findFileTool({
      run: async (bin, args) => {
        seen = { bin, args };
        return `${homedir()}/Documents/tax-2024.pdf\n`;
      },
    });
    const out = toolText(await tool.run({ query: "tax-2024" }));
    assert.equal(seen!.bin, "mdfind");
    assert.deepEqual(seen!.args, ["-onlyin", homedir(), "-name", "tax-2024"]);
    assert.match(out, /1 match/);
    assert.match(out, /~\/Documents\/tax-2024\.pdf/);
    assert.match(out, /locations only/i);
  });

  test("a hostile query is data, not shell", async () => {
    let args: string[] = [];
    const tool = findFileTool({
      run: async (_bin, a) => {
        args = a;
        return "";
      },
    });
    await tool.run({ query: `"; rm -rf ~; echo "` });
    // The whole string arrives as ONE argv element — execFile, no shell.
    assert.equal(args[3], `"; rm -rf ~; echo "`);
  });

  test("guards refuse before running anything", async () => {
    const tool = findFileTool({
      run: async () => {
        throw new Error("must not run");
      },
    });
    assert.match(toolText(await tool.run({ query: "  " })), /^Error:/);
    assert.match(toolText(await tool.run({ query: "x".repeat(200) })), /^Error:/);
  });

  test("no matches is an honest answer, capped output stays honest too", async () => {
    const none = findFileTool({ run: async () => "" });
    assert.match(toolText(await none.run({ query: "unicorn" })), /No files or folders named like/);

    const many = findFileTool({
      run: async () => Array.from({ length: 60 }, (_, i) => `${homedir()}/f${i}.txt`).join("\n"),
    });
    const out = toolText(await many.run({ query: "f" }));
    assert.match(out, /60 matches/);
    assert.match(out, /…and 20 more\./);
  });

  test("a failed search reports the failure, never throws", async () => {
    const tool = findFileTool({
      run: async () => {
        throw new Error("mdfind not found");
      },
    });
    assert.match(toolText(await tool.run({ query: "x" })), /Spotlight search failed/);
  });
});
