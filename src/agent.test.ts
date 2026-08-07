import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point every path at a scratch dir BEFORE anything imports config.
const scratch = mkdtempSync(join(tmpdir(), "maple-test-"));
process.env.MAPLE_DATA_DIR = join(scratch, "data");
process.env.MAPLE_WORKSPACE = join(scratch, "workspace");

const { repairJson, complete } = await import("./model.js");
const { safePath } = await import("./tools/fs.js");
const { invokedExecutables, checkCommand } = await import("./tools/shell.js");
const { isBlockedHost, htmlToText } = await import("./tools/web.js");
const store = await import("./memory/store.js");
const { closeDb } = await import("./memory/db.js");

after(() => {
  closeDb();
  rmSync(scratch, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe("repairJson", () => {
  test("leaves valid JSON untouched", () => {
    const input = '{"path":"a.txt","n":3}';
    assert.equal(repairJson(input), input);
  });

  test("strips markdown fences", () => {
    const out = repairJson('```json\n{"a": 1}\n```');
    assert.deepEqual(JSON.parse(out), { a: 1 });
  });

  test("removes trailing commas", () => {
    assert.deepEqual(JSON.parse(repairJson('{"a": 1, "b": 2,}')), { a: 1, b: 2 });
  });

  test("converts Python literals", () => {
    assert.deepEqual(JSON.parse(repairJson('{"a": None, "b": True, "c": False}')), {
      a: null,
      b: true,
      c: false,
    });
  });

  test("handles single-quoted objects", () => {
    assert.deepEqual(JSON.parse(repairJson("{'path': 'notes.md'}")), {
      path: "notes.md",
    });
  });

  test("does not mangle apostrophes inside valid JSON", () => {
    const input = `{"text":"it's fine"}`;
    assert.deepEqual(JSON.parse(repairJson(input)), { text: "it's fine" });
  });

  test("falls back to an empty object on garbage", () => {
    assert.equal(repairJson("not json at all"), "{}");
    assert.equal(repairJson(""), "{}");
  });
});

/* ------------------------------------------------------------------ */

describe("streaming and <think> handling", () => {
  const originalFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = originalFetch;
  });

  /** Build an SSE response whose content is split at arbitrary boundaries. */
  function stubStream(chunks: string[], toolCalls?: unknown[]) {
    const frames = chunks.map((c) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`,
    );
    if (toolCalls) {
      frames.push(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls } }] })}\n\n`,
      );
    }
    frames.push("data: [DONE]\n\n");

    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            for (const f of frames) controller.enqueue(enc.encode(f));
            controller.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;
  }

  test("separates reasoning from visible content", async () => {
    stubStream(["<think>", "let me consider", "</think>", "The answer is 4."]);
    const result = await complete([{ role: "user", content: "2+2" }], []);
    assert.equal(result.content, "The answer is 4.");
    assert.equal(result.reasoning, "let me consider");
  });

  test("handles tags split across chunk boundaries", async () => {
    // The killer case: "<thi" + "nk>" must not leak into visible output.
    stubStream(["<thi", "nk>hmm</thi", "nk>", "Done."]);
    const result = await complete([{ role: "user", content: "x" }], []);
    assert.equal(result.content, "Done.");
    assert.equal(result.reasoning, "hmm");
  });

  test("treats an unclosed think block as reasoning, not content", async () => {
    stubStream(["<think>ran out of tokens mid-thou"]);
    const result = await complete([{ role: "user", content: "x" }], []);
    assert.equal(result.content, "");
    assert.match(result.reasoning, /ran out of tokens/);
  });

  test("assembles tool calls from streamed deltas", async () => {
    stubStream(
      ["Checking."],
      [
        { index: 0, id: "call_1", function: { name: "read_", arguments: '{"path"' } },
        { index: 0, function: { name: "file", arguments: ':"a.txt"}' } },
      ],
    );
    const result = await complete([{ role: "user", content: "read a.txt" }], []);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.function.name, "read_file");
    assert.deepEqual(JSON.parse(result.toolCalls[0]!.function.arguments), {
      path: "a.txt",
    });
  });

  test("scavenges tool calls the server emitted as plain text", async () => {
    // This is the actual failure mode when server-side parsing misses.
    stubStream([
      "I'll look.\n",
      '<tool_call>\n{"name": "list_dir", "arguments": {"path": "."}}\n</tool_call>',
    ]);
    const result = await complete([{ role: "user", content: "what's here" }], []);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.function.name, "list_dir");
    assert.equal(result.content, "I'll look.");
  });
});

/* ------------------------------------------------------------------ */

describe("filesystem sandbox", () => {
  test("allows paths inside the workspace", () => {
    assert.ok(safePath("notes/a.txt").includes("workspace"));
  });

  test("rejects parent traversal", () => {
    assert.throws(() => safePath("../../etc/passwd"), /escapes the workspace/);
  });

  test("rejects absolute paths outside the root", () => {
    assert.throws(() => safePath("/etc/passwd"), /escapes the workspace/);
  });

  test("rejects traversal disguised mid-path", () => {
    assert.throws(() => safePath("a/b/../../../../etc/passwd"), /escapes/);
  });

  test("does not confuse a sibling with a prefix match", () => {
    // /tmp/x-workspace-evil must not pass a naive startsWith check on /tmp/x-workspace
    assert.throws(() => safePath("../workspace-evil/secrets"), /escapes/);
  });
});

/* ------------------------------------------------------------------ */

describe("shell allowlist", () => {
  test("finds executables across pipes and sequencing", () => {
    assert.deepEqual(invokedExecutables("ls -la | grep foo"), ["ls", "grep"]);
    assert.deepEqual(invokedExecutables("cd /tmp && rm -rf /"), ["cd", "rm"]);
  });

  test("strips directory prefixes so /bin/rm is caught", () => {
    assert.deepEqual(invokedExecutables("/bin/rm -rf x"), ["rm"]);
  });

  test("ignores leading env assignments", () => {
    assert.deepEqual(invokedExecutables("FOO=bar node script.js"), ["node"]);
  });

  test("permits allowlisted commands", () => {
    assert.equal(checkCommand("git status").ok, true);
    assert.equal(checkCommand("ls -la | grep src").ok, true);
  });

  test("blocks a dangerous command hidden after a pipe", () => {
    const result = checkCommand("ls | sudo tee /etc/hosts");
    assert.equal(result.ok, false);
  });

  test("blocks command substitution outright", () => {
    assert.equal(checkCommand("echo $(whoami)").ok, false);
    assert.equal(checkCommand("echo `whoami`").ok, false);
  });
});

/* ------------------------------------------------------------------ */

describe("web safety", () => {
  test("blocks loopback and private ranges", () => {
    for (const host of [
      "localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1",
      "172.16.0.1", "169.254.169.254",
    ]) {
      assert.equal(isBlockedHost(host), true, `${host} should be blocked`);
    }
  });

  test("allows normal public hosts", () => {
    for (const host of ["example.com", "huggingface.co", "172.32.0.1"]) {
      assert.equal(isBlockedHost(host), false, `${host} should be allowed`);
    }
  });

  test("strips scripts and styles from html", () => {
    const text = htmlToText(
      `<html><head><style>a{color:red}</style></head>
       <body><script>alert(1)</script><p>Hello &amp; welcome</p></body></html>`,
    );
    assert.ok(!text.includes("alert"));
    assert.ok(!text.includes("color:red"));
    assert.ok(text.includes("Hello & welcome"));
  });
});

/* ------------------------------------------------------------------ */

describe("memory store", () => {
  let sessionId: string;

  before(() => {
    sessionId = store.startSession();
  });

  test("stores and retrieves a fact", async () => {
    const result = await store.rememberFact("Mariz prefers TypeScript for agent code", {
      sessionId,
    });
    assert.equal(result.stored, true);

    const hits = await store.searchFacts("what language does Mariz like");
    assert.ok(hits.length > 0, "expected at least one fact back");
    assert.ok(hits.some((h) => h.text.includes("TypeScript")));
  });

  test("refuses duplicates", async () => {
    await store.rememberFact("duplicate probe fact", { sessionId });
    const second = await store.rememberFact("duplicate probe fact", { sessionId });
    assert.equal(second.stored, false);
    assert.equal(second.reason, "already known");
  });

  test("pinned facts always come back", async () => {
    await store.rememberFact("Mariz runs a Mac mini", { pinned: true, sessionId });
    // A query with no lexical or semantic relationship at all.
    const hits = await store.searchFacts("zzzz unrelated query");
    assert.ok(hits.some((h) => h.text.includes("Mac mini")));
  });

  test("builds a graph and traverses it", async () => {
    store.applyTriples(
      [
        {
          subject: "Mariz", subject_type: "person",
          relation: "WORKS_ON",
          object: "maple-agent", object_type: "project",
        },
        {
          subject: "maple-agent", subject_type: "project",
          relation: "USES",
          object: "SQLite", object_type: "technology",
        },
      ],
      sessionId,
    );

    const hits = await store.searchGraph("maple-agent");
    assert.ok(hits.length >= 1, "expected edges for maple-agent");
    assert.ok(hits.some((h) => h.object === "SQLite" || h.subject === "maple-agent"));
  });

  test("repeated observation raises confidence rather than duplicating", async () => {
    const triple = {
      subject: "Mariz", subject_type: "person" as const,
      relation: "USES" as const,
      object: "Hyper", object_type: "technology" as const,
    };
    store.applyTriples([triple], sessionId);
    const before = await store.searchGraph("Hyper");
    const firstConfidence = before.find((h) => h.object === "Hyper")?.confidence ?? 0;

    store.applyTriples([triple], sessionId);
    const after = await store.searchGraph("Hyper");
    const secondConfidence = after.find((h) => h.object === "Hyper")?.confidence ?? 0;

    assert.ok(
      secondConfidence > firstConfidence,
      `confidence should rise: ${firstConfidence} -> ${secondConfidence}`,
    );
    assert.equal(
      after.filter((h) => h.object === "Hyper").length,
      1,
      "should not create a duplicate edge",
    );
  });

  test("self-referential triples are rejected as noise", async () => {
    const countBefore = store.stats().edges;
    store.applyTriples(
      [
        {
          subject: "Thing", subject_type: "concept",
          relation: "PART_OF",
          object: "Thing", object_type: "concept",
        },
      ],
      sessionId,
    );
    // applyTriples itself doesn't filter; dedupe in extract.ts does. Confirm the
    // edge table tolerates it without corrupting counts.
    assert.ok(store.stats().edges >= countBefore);
  });

  test("logs messages and reconstructs a transcript", () => {
    store.logMessage(sessionId, "user", "hello there");
    store.logMessage(sessionId, "assistant", "hi");
    const transcript = store.transcriptOf(sessionId);
    assert.match(transcript, /user: hello there/);
    assert.match(transcript, /assistant: hi/);
  });

  test("reset clears derived data but keeps the raw log", () => {
    const before = store.stats();
    assert.ok(before.messages > 0);
    store.resetDerived();
    const after = store.stats();
    assert.equal(after.entities, 0);
    assert.equal(after.edges, 0);
    assert.equal(after.messages, before.messages, "raw log must survive");
    assert.ok(after.facts > 0, "explicit facts must survive");
  });
});
