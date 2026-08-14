import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-modelset-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
// The bundled skills live in the checkout now, so a suite that redirects
// only the data dir would still load them into every prompt it measures.
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
// Asked for by name: the setting is machine-wide like the registry, and these
// tests write it, so they must not touch the machine's real choice.
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
delete process.env.ENIO_MODEL;
delete process.env.MAPLE_MODEL;

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

const { ensureDirs } = await import("./config.js");
const settings = await import("./model-settings.js");

ensureDirs();
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("the model setting", () => {
  test("defaults to Qwen3 4B, and persists a switch", () => {
    assert.equal(settings.currentModelId(), settings.DEFAULT_MODEL);
    assert.equal(settings.DEFAULT_MODEL, "mlx-community/Qwen3-4B-Instruct-2507-4bit");

    settings.setModelId("mlx-community/some-model-4bit");
    assert.equal(settings.currentModelId(), "mlx-community/some-model-4bit");

    // Back through the Maple sentinel, so it round-trips too.
    settings.setModelId(settings.MAPLE);
    assert.equal(settings.currentModelId(), settings.MAPLE);
  });

  test("the env var wins over the file, without erasing it", () => {
    // The env override is how a one-off experiment points elsewhere; it must
    // not change what the machine boots tomorrow.
    settings.setModelId("mlx-community/persisted-model");
    process.env.ENIO_MODEL = "mlx-community/experiment";
    try {
      assert.equal(settings.currentModelId(), "mlx-community/experiment");
    } finally {
      delete process.env.ENIO_MODEL;
    }
    assert.equal(settings.currentModelId(), "mlx-community/persisted-model");
  });

  test("the available list contains the selected model and never a vision model", () => {
    settings.setModelId(settings.DEFAULT_MODEL);
    const models = settings.availableModels();
    // The selected model is machine state whether or not its weights have
    // landed; a picker that hides the current choice cannot explain it.
    assert.ok(models.includes(settings.DEFAULT_MODEL));
    assert.ok(
      !models.some((m) => /-VL-|vision/i.test(m)),
      "vision models have their own server and do not belong in this list",
    );
    // Maple is offered only while its bundled weights are on disk. This
    // scratch install has none, so offering it would be offering a
    // ninety-second failed load -- and the cache-scan blocklist keeps its HF
    // entry out regardless, so it must not appear at all.
    assert.equal(
      models.filter((m) => /maple/i.test(m)).length,
      0,
      "maple must not be offered without its bundled weights",
    );
  });

  test("requests name the model actually loaded", () => {
    settings.setModelId("mlx-community/some-model-4bit");
    assert.equal(settings.requestModelName(), "mlx-community/some-model-4bit");
    settings.setModelId(settings.MAPLE);
    assert.notEqual(settings.requestModelName(), settings.MAPLE, "the sentinel is not an API id");
  });
});

describe("the context budget follows the model", () => {
  test("Maple keeps its measured band, others get more", () => {
    // 2000 came from a planted-fact test on Maple: 4/4 correct near 1.5k,
    // 0/4 by 12k. Carrying that number to a dense model wastes most of what
    // it can hold; carrying a dense model's number back to Maple degrades
    // answers with nothing visible going wrong.
    settings.setModelId(settings.MAPLE);
    assert.equal(settings.contextBudget(), 2000);
    assert.equal(settings.contextBudgetMeasured(), true);

    settings.setModelId("mlx-community/Qwen3-4B-Instruct-2507-4bit");
    assert.ok(settings.contextBudget() > 2000);
    // Honest about provenance: this one is a step up, not a measurement.
    assert.equal(settings.contextBudgetMeasured(), false);
  });

  test("an unknown model gets a conservative default, not Maple's", () => {
    settings.setModelId("mlx-community/some-unknown-model-4bit");
    const budget = settings.contextBudget();
    assert.ok(budget > 2000, "an unknown model should not inherit Maple's floor");
    assert.equal(settings.contextBudgetMeasured(), false);
  });

  test("the env override wins, and a junk value is ignored", () => {
    settings.setModelId(settings.MAPLE);
    process.env.ENIO_CONTEXT_BUDGET = "5000";
    try {
      assert.equal(settings.contextBudget(), 5000);
      process.env.ENIO_CONTEXT_BUDGET = "not-a-number";
      assert.equal(settings.contextBudget(), 2000, "junk should fall back, not zero the window");
      process.env.ENIO_CONTEXT_BUDGET = "0";
      assert.equal(settings.contextBudget(), 2000, "zero would leave no room at all");
    } finally {
      delete process.env.ENIO_CONTEXT_BUDGET;
    }
    settings.setModelId(settings.MAPLE);
  });
});
