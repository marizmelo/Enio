import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * The launcher's reading order.
 *
 * Declaration order put "set up" and "soon" tiles among the working ones, so
 * the first read of the page mixed live capability with tiles that do nothing
 * when clicked. Banding is a display decision; the order WITHIN a band is the
 * deliberate one in abilities.ts and must survive untouched.
 */
const LIB = "../desktop/renderer/src/lib/launcher.js";
const { launcherOrder } = await import(LIB);

const tile = (id: string, availability: string, launcherHidden = false) => ({
  id,
  availability,
  launcherHidden,
});

describe("launcherOrder", () => {
  test("available first, then setup, then soon", () => {
    const ordered = launcherOrder([
      tile("email", "setup"),
      tile("chat", "available"),
      tile("video", "future"),
      tile("search", "available"),
      tile("house", "setup"),
    ]).map((a: { id: string }) => a.id);
    assert.deepEqual(ordered, ["chat", "search", "email", "house", "video"]);
  });

  test("order inside a band is left exactly as declared", () => {
    const ordered = launcherOrder([
      tile("c", "available"),
      tile("a", "available"),
      tile("b", "available"),
    ]).map((a: { id: string }) => a.id);
    assert.deepEqual(ordered, ["c", "a", "b"], "not alphabetised, not reversed");
  });

  test("hidden tiles stay hidden", () => {
    const ordered = launcherOrder([tile("secret", "available", true), tile("chat", "available")]);
    assert.deepEqual(ordered.map((a: { id: string }) => a.id), ["chat"]);
  });

  test("an unknown availability sorts with the working ones rather than vanishing", () => {
    // A tile whose state the client does not recognise is still a tile: the
    // failure to avoid is one silently sinking to the bottom of the page.
    const ordered = launcherOrder([tile("later", "future"), tile("odd", "mystery")]).map(
      (a: { id: string }) => a.id,
    );
    assert.deepEqual(ordered, ["odd", "later"]);
  });
});
