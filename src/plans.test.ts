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
      steps: [
        { summary: "count", script: 'tell application "Notes" to get count of notes' },
      ],
    });
    const widget = (out as { widget: { id: string } }).widget;

    const stored = plans.getPlan(widget.id)!;
    assert.equal(stored.status, "pending");
    assert.deepEqual(plans.planSteps(stored).map((s) => s.script), [
      'tell application "Notes" to get count of notes',
    ]);

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
      steps: [{ summary: "one", script: "return 1" }],
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

describe("multi-step plans", () => {
  test("steps survive storage, and the old single-script shape still reads", () => {
    const plan = plans.proposePlan({
      summary: "two things",
      kind: "applescript",
      steps: [
        { summary: "first", script: "return 1" },
        { summary: "second", script: "return 2" },
      ],
    });
    assert.deepEqual(
      plans.planSteps(plans.getPlan(plan.id)!).map((s) => s.script),
      ["return 1", "return 2"],
    );

    // A plan written before steps existed holds a bare script. Reading it as a
    // one-step plan is what lets an approval sitting in the database across an
    // upgrade still work, rather than throwing on a JSON parse.
    const legacy = {
      id: "x",
      sessionId: null,
      summary: "old style",
      kind: "applescript" as const,
      payload: 'tell application "Notes" to get count of notes',
      status: "pending" as const,
      result: null,
      createdAt: 0,
    };
    assert.deepEqual(plans.planSteps(legacy), [
      { summary: "old style", script: 'tell application "Notes" to get count of notes' },
    ]);
  });

  test("a bare script is accepted as a one-step plan", async () => {
    // The model reaches for the simpler shape whatever the schema says, and
    // rejecting it would waste a turn over a formatting preference.
    const tool = desktopTools.find((t) => t.name === "propose_plan")!;
    const out = await tool.run({ summary: "count", script: "return 1" });
    const widget = (out as { widget: { steps: unknown[] } }).widget;
    assert.equal(widget.steps.length, 1);
  });

  test("a plan with no runnable step is refused", async () => {
    const tool = desktopTools.find((t) => t.name === "propose_plan")!;
    const out = await tool.run({ summary: "nothing", steps: [{ summary: "empty", script: "  " }] });
    assert.match(String(out), /needs a summary and at least one step/);
  });
});
