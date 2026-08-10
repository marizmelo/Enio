import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-modelset-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
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
  test("defaults to the bundled model, and persists a switch", () => {
    assert.equal(settings.currentModelId(), settings.MAPLE);

    settings.setModelId("mlx-community/some-model-4bit");
    assert.equal(settings.currentModelId(), "mlx-community/some-model-4bit");

    // Back, so the sentinel round-trips too.
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

  test("the available list always contains the default and never a vision model", () => {
    const models = settings.availableModels();
    assert.ok(models.includes(settings.MAPLE));
    assert.ok(
      !models.some((m) => /-VL-|vision/i.test(m)),
      "vision models have their own server and do not belong in this list",
    );
  });

  test("requests name the model actually loaded", () => {
    settings.setModelId("mlx-community/some-model-4bit");
    assert.equal(settings.requestModelName(), "mlx-community/some-model-4bit");
    settings.setModelId(settings.MAPLE);
    assert.notEqual(settings.requestModelName(), settings.MAPLE, "the sentinel is not an API id");
  });
});
