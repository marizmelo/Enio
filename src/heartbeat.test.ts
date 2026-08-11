import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The heartbeat: checks run, alerts fire only on new information, and the
 * comparison fails open. The model is stubbed by *routing on the request* —
 * a check turn, the yes/no comparison, and whatever memory indexing asks for
 * are told apart by their prompts — because the number of calls between the
 * ones under test (summarise, extract) is not this test's business and a
 * positional queue would break every time it changed.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-heartbeat-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });

const { addWatch, listWatches, removeWatch, runHeartbeat, isNewInformation } = await import(
  "./heartbeat.js"
);

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  rmSync(scratch, { recursive: true, force: true });
});

function sse(content: string): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Answer by what was asked: the check turn gets `report`, the comparison
 *  gets `verdict`, anything else (router, summarise, extract) gets filler. */
function stubModel(report: string, verdict: string) {
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = String(init?.body ?? "");
    if (body.includes("meaningfully new or different")) return sse(verdict);
    if (body.includes("Check the following")) return sse(report);
    return sse("(irrelevant)");
  }) as typeof fetch;
}

describe("watch bookkeeping", () => {
  test("add, list, remove", () => {
    const w = addWatch("  does example.com have a new post  ");
    assert.equal(w.prompt, "does example.com have a new post");
    assert.ok(listWatches().some((x) => x.id === w.id));
    assert.equal(removeWatch(w.id), true);
    assert.equal(removeWatch(w.id), false);
  });

  test("an empty watch is refused", () => {
    assert.throws(() => addWatch("   "));
  });
});

describe("the heartbeat alerts only on change", () => {
  test("first check is the baseline and always alerts", async () => {
    const w = addWatch("release status of example project");
    const sent: string[] = [];
    stubModel("Version 1.0 is the latest release.", "unasked");
    const [r] = await runHeartbeat(() => {}, async (_t, b) => void sent.push(b));
    assert.equal(r!.alerted, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /Version 1\.0/);
    removeWatch(w.id);
  });

  test("an unchanged report stays quiet; a changed one alerts", async () => {
    const w = addWatch("release status again");
    const sent: string[] = [];
    const notify = async (_t: string, b: string) => void sent.push(b);

    stubModel("Version 1.0 is the latest release.", "unasked");
    await runHeartbeat(() => {}, notify);
    assert.equal(sent.length, 1);

    // Same facts, different words: the comparison says no, nothing is sent —
    // this is the whole point of a watch over a task.
    stubModel("The latest release remains 1.0.", "No.");
    const [quiet] = await runHeartbeat(() => {}, notify);
    assert.equal(quiet!.alerted, false);
    assert.equal(sent.length, 1);

    // The stored report advanced even while quiet, so the next comparison is
    // against the latest state, not the last alert.
    assert.match(listWatches().find((x) => x.id === w.id)!.lastReport!, /remains 1\.0/);

    stubModel("Version 2.0 was released today.", "Yes — a new version.");
    const [loud] = await runHeartbeat(() => {}, notify);
    assert.equal(loud!.alerted, true);
    assert.equal(sent.length, 2);
    assert.match(sent[1]!, /2\.0/);
    removeWatch(w.id);
  });
});

describe("the comparison", () => {
  test("reads a padded yes or no", async () => {
    stubModel("", "Yes, the current report mentions a new version.");
    assert.equal(await isNewInformation("old", "new"), true);
    stubModel("", "no.");
    assert.equal(await isNewInformation("old", "new"), false);
  });

  test("fails open: garbage and errors both mean notify", async () => {
    // Over-notifying is visible and annoying; under-notifying is a watch that
    // silently stopped watching. The worse failure is the invisible one.
    stubModel("", "the difference is subtle");
    assert.equal(await isNewInformation("old", "new"), true);
    globalThis.fetch = (async () => {
      throw new Error("model server down");
    }) as typeof fetch;
    assert.equal(await isNewInformation("old", "new"), true);
  });
});
