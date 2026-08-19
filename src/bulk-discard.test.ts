import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * Bulk discard, over the same per-id endpoint the single delete uses.
 *
 * The case worth pinning is the partial one: four requests, one refused. The
 * caller has to be able to say which survived, because the alternative — a
 * thrown error halfway through — leaves the user with a list that silently
 * disagrees with what is on disk.
 */
const LIB = "../desktop/renderer/src/lib/conversations.js";

// The module reaches for window.maple for the auth token; in node there is no
// window at all, and an undefined token is a valid state (the header is just
// omitted), so an empty object is the honest stand-in.
(globalThis as unknown as { window: unknown }).window = {};
const { discardConversations } = await import(LIB);

/** Records every DELETE and fails the ones named. */
function stubFetch(failing: string[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const bad = failing.some((id) => String(url).includes(id));
    return new Response(JSON.stringify(bad ? { error: { message: "still open" } } : { ok: true }), {
      status: bad ? 409 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

describe("bulk discard", () => {
  test("deletes each id and reports them all done", async () => {
    const calls = stubFetch([]);
    const { done, failed } = await discardConversations(["a1", "b2", "c3"], { keepFacts: false });
    assert.deepEqual(done, ["a1", "b2", "c3"]);
    assert.deepEqual(failed, []);
    assert.equal(calls.length, 3);
    // The facts decision rides on every request, not just the first: each
    // delete independently decides what happens to what it taught.
    assert.ok(calls.every((u) => u.includes("facts=forget")), calls.join(" "));
  });

  test("keepFacts is carried through", async () => {
    const calls = stubFetch([]);
    await discardConversations(["a1"], { keepFacts: true });
    assert.ok(calls[0]!.includes("facts=keep"));
  });

  test("one refusal does not abandon the rest, and is reported", async () => {
    stubFetch(["b2"]);
    const { done, failed } = await discardConversations(["a1", "b2", "c3"], { keepFacts: false });
    assert.deepEqual(done, ["a1", "c3"], "the others still went");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.id, "b2");
    assert.match(failed[0]!.reason, /still open/, "the server's own words, not a status code");
  });

  test("an empty selection is a no-op rather than an error", async () => {
    const calls = stubFetch([]);
    const { done, failed } = await discardConversations([], { keepFacts: false });
    assert.deepEqual(done, []);
    assert.deepEqual(failed, []);
    assert.equal(calls.length, 0);
  });
});
