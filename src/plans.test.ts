process.env.ENIO_DESKTOP = "1";

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated like every other test file. This one originally forgot, and the
// cost was invisible until pending plans became restorable: every `npm test`
// left four junk plans in the real ~/.enio database.
const scratch = mkdtempSync(join(tmpdir(), "enio-plans-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
after(() => rmSync(scratch, { recursive: true, force: true }));

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

describe("running an approved plan", () => {
  // These execute real osascript, which only exists on a Mac. `return`
  // statements touch no app, so no Automation prompt is ever triggered.
  const notMac = process.platform !== "darwin";

  test("steps run in order and stop at the first failure", { skip: notMac }, async () => {
    const plan = plans.proposePlan({
      summary: "fails in the middle",
      kind: "applescript",
      steps: [
        { summary: "works", script: "return 1" },
        { summary: "broken", script: "this is not applescript" },
        { summary: "never reached", script: "return 3" },
      ],
    });

    const outcome = await plans.approvePlan(plans.getPlan(plan.id)!);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.ranSteps, 2);
    assert.equal(outcome.totalSteps, 3);
    assert.deepEqual(outcome.results.map((r) => r.ok), [true, false]);

    // Settled even though it failed: approval is one-shot, and a retry after
    // a half-run is a new proposal against a machine in a new state.
    assert.equal(plans.getPlan(plan.id)!.status, "approved");
  });

  test("a failing step blocks promotion to a recipe", { skip: notMac }, async () => {
    // The recipe would be offered to the model forever and selected verbatim,
    // so a script that never worked must not become one. Before this ordering
    // was fixed, "Save and run" saved first and ran second.
    const plan = plans.proposePlan({
      summary: "would be a broken recipe",
      kind: "applescript",
      steps: [{ summary: "broken", script: "this is not applescript" }],
    });

    const outcome = await plans.approvePlan(plans.getPlan(plan.id)!, { saveAs: "broken_recipe" });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.savedAs, null);
    assert.ok(
      !plans.listSavedRecipes().some((r) => r.name === "broken_recipe"),
      "a plan that failed must not be saved as a recipe",
    );
  });

  test("a run that worked saves and settles as saved", { skip: notMac }, async () => {
    const plan = plans.proposePlan({
      summary: "works and is kept",
      kind: "applescript",
      steps: [
        { summary: "one", script: "return 1" },
        { summary: "two", script: "return 2" },
      ],
    });

    const outcome = await plans.approvePlan(plans.getPlan(plan.id)!, { saveAs: "Worked Once!" });
    assert.equal(outcome.status, "saved");
    assert.equal(outcome.savedAs, "worked_once");
    assert.equal(outcome.ranSteps, 2);
    assert.equal(plans.getPlan(plan.id)!.status, "saved");

    const recipe = plans.listSavedRecipes().find((r) => r.name === "worked_once");
    assert.ok(recipe);
    assert.equal(recipe.script, "return 1\nreturn 2");
    plans.forgetRecipe("worked_once");
  });
});

describe("restoring pending plans", () => {
  test("pending plans are listable with parsed steps, settled ones are not", () => {
    // The approval card only ever travelled over the live stream, so this
    // listing is the one thing standing between a client restart and a plan
    // nobody can approve or decline any more.
    const plan = plans.proposePlan({
      sessionId: "conv-restore",
      summary: "restore me",
      kind: "applescript",
      steps: [{ summary: "s", script: "return 1" }],
    });

    const found = plans.listPendingPlans().find((p) => p.id === plan.id);
    assert.ok(found, "a fresh proposal must be listed");
    assert.equal(found.sessionId, "conv-restore");
    assert.deepEqual(found.steps, [{ summary: "s", script: "return 1" }]);

    plans.settlePlan(plan.id, "declined");
    assert.ok(!plans.listPendingPlans().some((p) => p.id === plan.id));
  });

  test("recipe names are checked before anything runs", () => {
    assert.equal(plans.normalizeRecipeName("  Note Count!! "), "note_count");
    assert.equal(plans.normalizeRecipeName("a"), null);
    assert.equal(plans.normalizeRecipeName("!!"), null);
  });
});
