process.env.ENIO_DESKTOP = "1";

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const plans = await import("./plans.js");
const { desktopTools } = await import("./tools/desktop.js");
const { SPECIALISTS } = await import("./specialists.js");

describe("proposed actions", () => {
  test("the operator cannot execute AppleScript it composed", () => {
    // This is the property the whole mechanism exists for. The model writes a
    // script and stops; the only path from "composed" to "ran" is a person
    // approving it through the server. Giving the operator run_applescript
    // again would quietly undo that, and nothing else would notice.
    const operator = SPECIALISTS.find((s) => s.name === "operator")!;
    assert.ok(
      !operator.tools.includes("run_applescript"),
      "the operator must propose scripts, not run them",
    );
    assert.ok(operator.tools.includes("propose_plan"));
    assert.ok(operator.tools.includes("mac_recipe"));
    assert.ok(operator.tools.length <= 6, "the six-tool ceiling still applies");
  });

  test("proposing stores it as pending and runs nothing", async () => {
    const tool = desktopTools.find((t) => t.name === "propose_plan")!;
    const out = await tool.run({
      summary: "Count the notes",
      script: 'tell application "Notes" to get count of notes',
    });
    const widget = (out as { widget: { id: string } }).widget;

    const stored = plans.getPlan(widget.id)!;
    assert.equal(stored.status, "pending");
    assert.equal(stored.payload, 'tell application "Notes" to get count of notes');

    // The text handed back to the model must not read as success, or it
    // reports the work as done and the user never sees the approval.
    const text = String((out as { text: string }).text);
    assert.match(text, /not run/i);
  });

  test("a settled plan cannot be settled twice", () => {
    // Re-approving would run it again, which for anything with a side effect
    // is the difference between one email and two.
    const plan = plans.proposePlan({
      summary: "x",
      kind: "applescript",
      payload: "return 1",
    });
    plans.settlePlan(plan.id, "approved", "1");
    assert.equal(plans.getPlan(plan.id)!.status, "approved");
  });

  test("saved recipe names are normalised, not trusted", () => {
    // The name becomes a selectable option in a tool description; one with
    // spaces or punctuation is one the model will fail to reproduce.
    const ok = plans.saveRecipe({
      name: "  Note Count!! ",
      summary: "counts notes",
      script: "return 1",
    });
    assert.deepEqual(ok, { ok: true, name: "note_count" });

    const tooShort = plans.saveRecipe({ name: "a", summary: "s", script: "return 1" });
    assert.equal(tooShort.ok, false);

    assert.ok(plans.listSavedRecipes().some((r) => r.name === "note_count"));
    plans.forgetRecipe("note_count");
  });
});
