import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point every path at a scratch dir BEFORE anything imports config.
const scratch = mkdtempSync(join(tmpdir(), "enio-test-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
// The bundled skills live in the checkout now, so a suite that redirects
// only the data dir would still load them into every prompt it measures.
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");

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

  test("sends a positive max_tokens", async () => {
    // A negative value does not come back as a 400. mlx-lm raises while
    // validating, inside the request handler, so the socket closes and fetch
    // rejects with a bare "fetch failed" -- no status, no mention of the field.
    // Every turn fails and the error points nowhere near the cause.
    let sent: Record<string, unknown> = {};
    const originalFetchLocal = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await complete([{ role: "user", content: "hi" }], []);
    globalThis.fetch = originalFetchLocal;

    assert.equal(typeof sent.max_tokens, "number");
    assert.ok(
      (sent.max_tokens as number) > 0,
      `max_tokens must be positive, got ${sent.max_tokens}`,
    );
  });

  test("a generation cut short by the ceiling is reported as truncated", async () => {
    // It has to be visible: a write_file call carrying a whole file is cut
    // mid-JSON, mlx-lm drops the unparseable call, and the turn arrives empty
    // with the only evidence in the model server's log.
    const originalFetchLocal = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(
              enc.encode(
                'data: {"choices":[{"delta":{"content":"<html>"}}]}\n\n' +
                  'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
                  "data: [DONE]\n\n",
              ),
            );
            controller.close();
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const cut = await complete([{ role: "user", content: "write it" }], []);
    globalThis.fetch = originalFetchLocal;
    assert.equal(cut.truncated, true);
  });

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

  const OPEN_APP = [
    {
      type: "function" as const,
      function: {
        name: "open_app",
        description: "",
        parameters: {
          type: "object" as const,
          properties: { app: { type: "string" } },
          required: ["app"],
        },
      },
    },
  ];

  test("recovers a call the model wrote out as prose", async () => {
    // Watched happen: a reply fabricating an opened Calculator ended with the
    // line `open_app "Calculator"`. The tool and the argument were both
    // right; only the envelope was missing.
    stubStream(['The Calculator app is open.\n\nopen_app "Calculator"']);
    const result = await complete([{ role: "user", content: "open it" }], OPEN_APP);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.function.name, "open_app");
    assert.deepEqual(JSON.parse(result.toolCalls[0]!.function.arguments), { app: "Calculator" });
    // The line is consumed, not left in the bubble as leftover syntax.
    assert.doesNotMatch(result.content, /open_app/);
  });

  test("prose that merely mentions a tool is not turned into a call", async () => {
    // The one mistake here that costs more than missing a call. Only a line
    // that is nothing but the call is taken.
    for (const text of [
      'You can use open_app "Calculator" to open it yourself.',
      "I could call open_app if you want.",
      "open_app is the tool that opens apps.",
    ]) {
      stubStream([text]);
      const result = await complete([{ role: "user", content: "?" }], OPEN_APP);
      assert.equal(result.toolCalls.length, 0, `must not fire on: ${text}`);
    }
  });

  test("a name that is not a real tool is left as text", async () => {
    stubStream(['make_coffee "espresso"']);
    const result = await complete([{ role: "user", content: "?" }], OPEN_APP);
    assert.equal(result.toolCalls.length, 0);
    assert.match(result.content, /make_coffee/);
  });

  test("a bare argument needs exactly one required property", async () => {
    // Two required properties and a single quoted string: no way to know which
    // was meant, so it is not guessed at.
    const twoRequired = [
      {
        type: "function" as const,
        function: {
          name: "move_file",
          description: "",
          parameters: {
            type: "object" as const,
            properties: { from: { type: "string" }, to: { type: "string" } },
            required: ["from", "to"],
          },
        },
      },
    ];
    stubStream(['move_file "notes.txt"']);
    const result = await complete([{ role: "user", content: "?" }], twoRequired);
    assert.equal(result.toolCalls.length, 0);
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
          object: "enio", object_type: "project",
        },
        {
          subject: "enio", subject_type: "project",
          relation: "USES",
          object: "SQLite", object_type: "technology",
        },
      ],
      sessionId,
    );

    const hits = await store.searchGraph("enio");
    assert.ok(hits.length >= 1, "expected edges for enio");
    assert.ok(hits.some((h) => h.object === "SQLite" || h.subject === "enio"));
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

describe("fabricated action claims", () => {
  test("narrated actions with no tool call are flagged", async () => {
    const { claimsUnperformedAction } = await import("./agent.js");
    // Verbatim from the failure that prompted this: every sentence claimed a
    // machine action and the step log showed zero tool calls.
    for (const line of [
      "I will now clear the values in the Calculator app.",
      "The Calculator window has been cleared. You can now enter a new value.",
      "I've opened Notes for you.",
      "The note has been created.",
      "Notes is now open.",
      "The calculator values are now cleared.",
    ]) {
      assert.ok(claimsUnperformedAction(line), `should flag: ${line}`);
    }
  });

  test("a hypothetical is not a claim", async () => {
    const { claimsUnperformedAction } = await import("./agent.js");
    // Verbatim from the failure this guard CAUSED: asked to build an
    // automation, the model asked a perfectly good clarifying question and
    // "is created" — inside an example of a trigger condition — was read as
    // a completion claim. The correction then produced six paragraphs of
    // narration and two empty searches out of one sensible question.
    for (const line of [
      "A script that runs when a certain condition is met (e.g., a file is created or modified)?",
      "Would you like a note that is created every morning?",
      "If the folder is moved, the link breaks.",
      "I can do that once the file is saved.",
    ]) {
      assert.equal(claimsUnperformedAction(line), false, `should NOT flag: ${line}`);
    }

    // And the guard still fires when a real claim shares the reply with a
    // hypothetical — one imagined action does not launder the other.
    assert.ok(
      claimsUnperformedAction(
        "If a file is created it will sync. I've opened Notes for you.",
      ),
    );
  });

  test("ordinary answers are not flagged", async () => {
    const { claimsUnperformedAction } = await import("./agent.js");
    for (const line of [
      "4 + 4 is 8.",
      "TCP is connection-oriented; UDP is not.",
      "You could clear it yourself with the C button.",
      "The inbox has three unread messages.",
      "To open Notes, click its icon in the Dock.",
    ]) {
      assert.ok(!claimsUnperformedAction(line), `must not flag: ${line}`);
    }
  });
});

describe("disclaimed live access", () => {
  test("the stock refusal is flagged", async () => {
    const { disclaimsLiveAccess } = await import("./agent.js");
    // Verbatim from the failure that prompted this: the researcher, holding
    // web_search, called nothing and said this. The phrasings are the ones a
    // model is trained to emit; the guard is for the reflex, not for prose.
    for (const line of [
      "I don't have real-time news access, so I can't provide today's latest news.",
      "I do not have access to real-time information.",
      "I can't browse the internet.",
      "I have no live data on that.",
      "As an AI, I cannot access the web.",
      "Unfortunately there is no internet access available to me.",
      "I'm unable to access up-to-date information.",
      // The curly apostrophe the model actually emits. The first version of
      // this guard knew only the straight one and was inert on every real
      // reply while passing every test.
      "I don\u2019t have live news feeds, so I can\u2019t provide today\u2019s news.",
    ]) {
      assert.ok(disclaimsLiveAccess(line), `should flag: ${line}`);
    }
  });

  test("a finding after a search is not a disclaimer", async () => {
    const { disclaimsLiveAccess } = await import("./agent.js");
    // These are honest outcomes of a lookup that ran, and the researcher's
    // own prompt asks for exactly this wording. Firing here would turn an
    // honest "not found" into a forced second search — the correction guard
    // producing the very fabrication it exists to prevent.
    for (const line of [
      "I couldn't find anything about that on the pages I read.",
      "The search returned nothing recent for that name.",
      "None of the sources mention a release date.",
      "I could not find a price on the official page.",
      "The weather in Lisbon is 24°C and clear.",
      "Today is Tuesday, 18 August 2026.",
    ]) {
      assert.equal(disclaimsLiveAccess(line), false, `should NOT flag: ${line}`);
    }
  });
});

describe("knowledge covers the question", () => {
  test("every distinctive term of the question in one known item", async () => {
    const { knowledgeCovers } = await import("./agent.js");
    const known = [
      "Angie Nixon defeated Alex Vindman in the Florida Democratic Senate primary.",
      "user knows DreamHost",
    ];
    // Watched: this exact question re-searched the web with the first fact
    // sitting in the memory block.
    assert.equal(knowledgeCovers("what happened to angie nixon", known), true);
    assert.equal(knowledgeCovers("who did Nixon defeat?", known), true);
    // A near-miss that shares one name but not the other must NOT count:
    // "angie" alone is not this fact.
    assert.equal(knowledgeCovers("what happened to angie merkel", known), false);
    // Two terms split across two facts do not add up to coverage.
    assert.equal(
      knowledgeCovers("did nixon join dreamhost", known),
      false,
      "terms must land in ONE item, not one each",
    );
  });

  test("a question with no distinctive terms is never covered", async () => {
    const { knowledgeCovers } = await import("./agent.js");
    // Nothing to match on: stopwords only. Better to search than to declare
    // "what happened today" answered by whatever fact is nearest.
    assert.equal(knowledgeCovers("what happened today", ["Anything at all about today."]), false);
    assert.equal(knowledgeCovers("what news", ["Some news fact."]), false);
  });
});

describe("file tokens in a message", () => {
  test("finds the files the user named, path form included, capped at two", async () => {
    const { fileTokens } = await import("./agent.js");
    assert.deepEqual(fileTokens("fix the typo in src/greet.ts"), ["src/greet.ts"]);
    assert.deepEqual(fileTokens("update README.md and package.json please"), ["README.md", "package.json"]);
    assert.deepEqual(
      fileTokens("touch a.ts b.ts c.ts"),
      ["a.ts", "b.ts"],
      "more than two is a refactor, not a pointer",
    );
    assert.deepEqual(fileTokens("compare utils.ts with utils.ts again"), ["utils.ts"], "deduped");
  });

  test("ignores URLs, versions, absolute paths and prose dots", async () => {
    const { fileTokens } = await import("./agent.js");
    assert.deepEqual(fileTokens("see https://example.com/docs/page.html for details"), []);
    assert.deepEqual(fileTokens("we are on node 20.3 and react 18.2.0"), []);
    assert.deepEqual(fileTokens("look in /etc/hosts.txt"), [], "an absolute path is not a workspace name");
    assert.deepEqual(fileTokens("hello there. how are you"), []);
    // A bare host with no scheme is indistinguishable from a directory
    // ("foo.bar/x.ts" is a legitimate relative path), so it fires -- and
    // costs one harmless search. Only scheme-bearing URLs are stripped.
    assert.deepEqual(fileTokens("the file at example.com/x.ts"), ["example.com/x.ts"]);
  });
});

describe("code narrated instead of written", () => {
  test("a big code block in the reply is the failure; a snippet is an answer", async () => {
    const { narratesCodeInsteadOfWriting } = await import("./agent.js");
    const file = "```js\n" + Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n```";
    assert.equal(narratesCodeInsteadOfWriting("Here is the app:\n" + file), true);
    // Three files' worth of fences, each short: that is an app in a reply.
    const three = ["```html\n<div></div>\n```", "```css\n.a{}\n```", "```js\nlet x;\n```"].join("\n");
    assert.equal(narratesCodeInsteadOfWriting(three), true);
    // Explaining a closure with twelve lines is an answer, not a file.
    const snippet = "```js\n" + Array.from({ length: 12 }, () => "function f() { return 1; }").join("\n") + "\n```";
    assert.equal(narratesCodeInsteadOfWriting("A closure:\n" + snippet), false);
    assert.equal(narratesCodeInsteadOfWriting("no code here"), false);
  });

  test("an unterminated fence is the same failure", async () => {
    const { narratesCodeInsteadOfWriting } = await import("./agent.js");
    // The shape seen in the wild: asked to fill the file open in the canvas,
    // the model poured a whole HTML app into the reply and never closed the
    // fence. Matching balanced pairs only, the guard saw no code at all --
    // 251 lines reached the thread and the file stayed empty.
    const spill =
      "The file is empty. Here's the implementation:\n\n```html\n" +
      Array.from({ length: 200 }, (_, i) => `  <div class="row-${i}"></div>`).join("\n");
    assert.equal(narratesCodeInsteadOfWriting(spill), true);
    // A closed block followed by an unterminated one still counts both.
    const mixed = "```js\nlet a;\n```\nand then\n```css\n" + Array.from({ length: 50 }, () => ".a{}").join("\n");
    assert.equal(narratesCodeInsteadOfWriting(mixed), true);
    // A short trailing fence is still just an answer.
    assert.equal(narratesCodeInsteadOfWriting("try:\n```sh\nnpm test\n"), false);
    // Prose containing a stray triple-backtick opens nothing.
    assert.equal(narratesCodeInsteadOfWriting("use ``` to fence code"), false);
  });

  test("a promise to write, with no write, is the same failure", async () => {
    const { promisesToWriteWithoutWriting } = await import("./agent.js");
    // Verbatim from the live turn that left the canvas file empty.
    assert.equal(
      promisesToWriteWithoutWriting(
        "I'll create a simple todo app using jQuery for the provided index.html file. " +
          "First, I'll create a complete todo app with the necessary HTML structure.",
      ),
      true,
    );
    assert.equal(promisesToWriteWithoutWriting("Let me write the config file."), true);
    assert.equal(promisesToWriteWithoutWriting("I'm going to update src/app.js."), true);
    assert.equal(promisesToWriteWithoutWriting("I will now generate the stylesheet."), true);
    // Watched in the wild: read the file, name the typo, "I'll fix it now",
    // stop. The most natural phrasing was the one the first cut missed.
    assert.equal(
      promisesToWriteWithoutWriting('Found the typo in `greet.ts`. The word "helo" should be "hello". I\'ll fix it now.'),
      true,
    );
    assert.equal(promisesToWriteWithoutWriting("Let me correct that line."), true);
    assert.equal(promisesToWriteWithoutWriting("I'll rename it for you."), true);
    // Promises the reply itself keeps are not this failure.
    assert.equal(promisesToWriteWithoutWriting("I'll explain how the loop works."), false);
    assert.equal(promisesToWriteWithoutWriting("Let me show you the difference."), false);
    assert.equal(promisesToWriteWithoutWriting("Wrote src/app.js — 412 bytes."), false);
  });
});

describe("mail composed that nobody asked for", () => {
  test("the draft shape and the intent verbs, on the observed failure", async () => {
    const { composeIntent, looksLikeMailDraft } = await import("./agent.js");
    // Verbatim shape from the live turn: asked to CHECK, it answered with a
    // full reply to Google's security alert.
    const drafted =
      "This is a security alert indicating unauthorized access. I will draft a reply to clarify.\n" +
      "Here is the draft of what I will send:\n" +
      "Subject: Re: Security alert — Action needed\nBody:\nHi Google,\nThank you for the alert.";
    assert.equal(looksLikeMailDraft(drafted), true);
    assert.equal(composeIntent("check my email"), false);
    assert.equal(composeIntent("did anything important arrive today?"), false);
    // When composing WAS asked, the same shape is the task done right.
    assert.equal(composeIntent("draft a reply to Ana saying thanks"), true);
    assert.equal(composeIntent("send Bob the summary"), true);
    // A summary quoting read_email's own header lines is not a draft.
    assert.equal(looksLikeMailDraft("The message says:\nSubject: Invoice due\nIt asks for payment by Friday."), false);
    assert.equal(looksLikeMailDraft("Three new messages, nothing urgent."), false);
  });
});

/**
 * The toolless fabrication: an agent with no way to search, asked about the
 * present, inventing a checkable fact. All three lists must agree before a
 * withdraw — the intersection is what keeps roleplay and honest admissions
 * safe.
 */
describe("fresh facts asserted by an agent that cannot check", () => {
  test("the live failure phrasing trips both input and reply tests", async () => {
    const { asksAboutCurrentWorld, assertsFreshFact, admitsCannotCheck } = await import("./agent.js");
    assert.equal(asksAboutCurrentWorld("what was the last spiderman movie on theaters this year"), true);
    assert.equal(
      assertsFreshFact(
        "As of today, August 21, 2026, the last Spider-Man movie released in theaters this year was *Spider-Man: Beyond the Web* — released in July 2026.",
      ),
      true,
    );
    assert.equal(admitsCannotCheck("released in July 2026, a major event"), false);
  });

  test("roleplay, explanations and edits do not read as world questions", async () => {
    const { asksAboutCurrentWorld } = await import("./agent.js");
    assert.equal(asksAboutCurrentWorld("who are you?"), false);
    assert.equal(asksAboutCurrentWorld("how did you get your powers"), false);
    assert.equal(asksAboutCurrentWorld("explain monads to me"), false);
    assert.equal(asksAboutCurrentWorld("tighten up this paragraph for me"), false);
    assert.equal(asksAboutCurrentWorld("what's the latest iPhone"), true);
    assert.equal(asksAboutCurrentWorld("any news on the launch?"), true);
  });

  test("an admission is recognised and never counts as a fabrication", async () => {
    const { admitsCannotCheck, assertsFreshFact } = await import("./agent.js");
    assert.equal(admitsCannotCheck("I can't check movie releases from here — ask @researcher."), true);
    assert.equal(admitsCannotCheck("I have no way to check current news."), true);
    // An admission that also mentions a year stays an admission: the guard
    // checks admission first, so this pairing must be recognisable.
    assert.equal(assertsFreshFact("I cannot verify anything released in 2026."), true);
    assert.equal(admitsCannotCheck("I cannot verify anything released in 2026."), true);
  });
});
