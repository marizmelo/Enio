import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-probe-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");

const { serverIsUp } = await import("./model.js");
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  rmSync(scratch, { recursive: true, force: true });
});

const answer = (status: number, body: string) => {
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
};

describe("the model-server probe", () => {
  test("a 200 that is not a model list is not a model server", async () => {
    // Docker Desktop on 127.0.0.1:8080 answered every probe with a 200.
    answer(200, "<html>hello</html>");
    assert.equal(await serverIsUp(), false);
    answer(200, "{}");
    assert.equal(await serverIsUp(), false);
  });
  test("the OpenAI-compatible list shape is", async () => {
    answer(200, JSON.stringify({ object: "list", data: [{ id: "m" }] }));
    assert.equal(await serverIsUp(), true);
    answer(503, JSON.stringify({ data: [] }));
    assert.equal(await serverIsUp(), false);
  });
});
