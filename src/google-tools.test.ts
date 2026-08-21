import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-gtools-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

// Full grants, written before the module loads: registration is load-time.
writeFileSync(
  join(process.env.ENIO_DATA_DIR, "accounts.json"),
  JSON.stringify({
    client: null,
    accounts: [
      {
        id: "acc1",
        provider: "appsscript",
        email: "enio@example.com",
        grants: ["mail.read", "mail.send", "calendar.read", "calendar.write", "drive.read", "drive.write"],
        addedAt: 1,
        scriptUrl: "https://script.google.com/macros/s/live/exec",
        scriptSecret: "s3cret",
      },
    ],
  }),
);

const { googleTools } = await import("./tools/google.js");
const { SPECIALISTS } = await import("./specialists.js");

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  rmSync(scratch, { recursive: true, force: true });
});

function stubScript(perOp: Record<string, unknown>) {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ op: body.op, args: body.args ?? {} });
    return new Response(JSON.stringify({ ok: perOp[body.op] ?? null }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

/**
 * The planner's tools: the connected account's life beyond mail.
 *
 * A new specialist rather than more tools on mail, because mail had two free
 * slots and this needs four -- and "what's on today" is not a mail question.
 * The ceiling and the read/act line are what these tests hold.
 */
describe("the planner", () => {
  test("exists, stays at six tools, and its tools are registered", () => {
    const planner = SPECIALISTS.find((s) => s.name === "planner");
    assert.ok(planner, "the planner specialist exists");
    assert.ok(planner!.tools.length <= 6, `six-tool ceiling: ${planner!.tools.length}`);
    // With every grant present all five register.
    assert.deepEqual(
      googleTools.map((t) => t.name).sort(),
      ["add_event", "add_todo", "find_contact", "list_todos", "read_calendar"],
    );
  });

  test("read_calendar formats events and never shows a credential", async () => {
    stubScript({
      "calendar.upcoming": [
        { title: "Standup", start: "2026-08-22T09:00:00Z", end: "2026-08-22T09:30:00Z", location: "Meet" },
      ],
    });
    const read = googleTools.find((t) => t.name === "read_calendar")!;
    const out = String(await read.run({ days: 7 }));
    assert.match(out, /Standup/);
    assert.match(out, /enio@example\.com/);
    assert.ok(!out.includes("s3cret") && !out.includes("script.google.com"), "credential leaked into output");
  });

  test("add_event passes the meet flag through and reports the link", async () => {
    const calls = stubScript({
      "calendar.add": { id: "e1", title: "Lunch", meet: "https://meet.google.com/abc" },
    });
    const add = googleTools.find((t) => t.name === "add_event")!;
    const out = String(await add.run({ title: "Lunch", start: "2026-08-22 12:00", end: "2026-08-22 13:00", meet: true }));
    assert.equal(calls[0]!.args.meet, true);
    assert.match(out, /meet\.google\.com\/abc/);
  });

  test("a script failure reads as a sentence, not a stack", async () => {
    // The Tasks advanced-service guard is the common first failure; its
    // instruction has to survive the trip to the reply.
    stubScript({});
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "The Tasks service is not enabled for this script. …" }), { status: 200 })) as typeof fetch;
    const todos = googleTools.find((t) => t.name === "list_todos")!;
    const out = String(await todos.run({}));
    assert.match(out, /Tasks service is not enabled/);
  });
});
