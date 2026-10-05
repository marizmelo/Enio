import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Only Enio's own account connected, from the first load: the tools must
 * still exist (registration is load-time and owner-blind), and a call must
 * name the account rather than read it. Its own file because registration
 * happens at import and the other suite loads an owner-less account.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-gtools-owner-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });
writeFileSync(
  join(process.env.ENIO_DATA_DIR, "accounts.json"),
  JSON.stringify({
    client: null,
    accounts: [
      {
        id: "own",
        provider: "appsscript",
        email: "enio@example.com",
        owner: "agent",
        label: "enio",
        grants: ["mail.read", "mail.send", "calendar.read", "calendar.write", "drive.read", "drive.write"],
        addedAt: 1,
        scriptUrl: "https://script.google.com/macros/s/live/exec",
        scriptSecret: "s3cret",
      },
    ],
  }),
);

const { googleTools } = await import("./tools/google.js");
const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  rmSync(scratch, { recursive: true, force: true });
});

test("the planner's tools register with only Enio's own account, and a read names it instead of using it", async () => {
  assert.deepEqual(
    googleTools.map((t) => t.name).sort(),
    ["add_event", "add_todo", "find_contact", "list_todos", "read_calendar", "read_drive", "search_drive"],
  );
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: [] }), { status: 200 });
  }) as typeof fetch;
  const read = googleTools.find((t) => t.name === "read_calendar")!;
  const out = (await read.run({ days: 7 })) as { text: string; notice?: string };
  assert.match(out.text, /No account of yours is connected/);
  assert.match(out.text, /Enio's own account enio \(enio@example\.com\)|Enio's own account/);
  assert.equal(calls, 0, "Enio's calendar was not read");
  // The remedy is a link the window can open, in the notice the reader sees
  // verbatim and in the text the model paraphrases.
  assert.match(out.notice ?? "", /\[Connections\]\(enio:\/\/panel\/accounts\/add\)/);
  assert.match(out.text, /enio:\/\/panel\/accounts\/add/);
});
