import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point every path at a scratch dir BEFORE anything imports config.
const scratch = mkdtempSync(join(tmpdir(), "enio-test-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
// Pin the served model so the expected adapter slug is known.
process.env.ENIO_MODEL = "mlx-community/Qwen3-4B-Instruct-2507-4bit";

const { adapterPathFor, deleteModelWeights, modelWeightsDir } = await import("./model-settings.js");
const { complete } = await import("./model.js");

const SLUG = "mlx-community--Qwen3-4B-Instruct-2507-4bit";

/** Lay down a complete-looking adapter for `name` under base-model `slug`. */
function plantAdapter(slug: string, name: string, files = ["adapters.safetensors", "adapter_config.json"]) {
  const dir = join(scratch, "machine", "adapters", slug, name);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "");
  return dir;
}

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe("adapterPathFor", () => {
  test("null when nothing is on disk — a missing adapter degrades, never errors", () => {
    assert.equal(adapterPathFor("coder"), null);
  });

  test("resolves an adapter trained for the currently served base", () => {
    const dir = plantAdapter(SLUG, "coder");
    assert.equal(adapterPathFor("coder"), dir);
  });

  test("ignores an adapter trained for a different base model", () => {
    // A valid-looking adapter for some other base must not be served: LoRA
    // weights are only meaningful over the weights they were trained against.
    plantAdapter("mlx-community--SomeOther-8B-4bit", "researcher");
    assert.equal(adapterPathFor("researcher"), null);
  });

  test("a half-written directory reads as no adapter", () => {
    // A training run killed between file writes must not become a server
    // error on every subsequent turn of that specialist.
    plantAdapter(SLUG, "partial", ["adapters.safetensors"]);
    assert.equal(adapterPathFor("partial"), null);
  });

  test("rejects names that could escape the adapters directory", () => {
    plantAdapter(SLUG, "coder");
    assert.equal(adapterPathFor("../" + SLUG + "/coder"), null);
    assert.equal(adapterPathFor(""), null);
  });
});

/* ------------------------------------------------------------------ */

describe("deleting model weights", () => {
  test("the selected model is refused — the server must never reload into nothing", () => {
    const result = deleteModelWeights("mlx-community/Qwen3-4B-Instruct-2507-4bit");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Switch/);
  });

  test("a model with no weights on disk is an honest miss, not an rm of anything", () => {
    const result = deleteModelWeights("mlx-community/NoSuch-Model-4bit");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /No weights/);
  });

  test("an id that is not org/repo shaped resolves to no directory at all", () => {
    // The id becomes a path component; anything that could escape the cache's
    // own naming convention must resolve to nothing before rm is in sight.
    assert.equal(modelWeightsDir("../../../etc"), null);
    assert.equal(modelWeightsDir("a/b/c"), null);
    assert.equal(modelWeightsDir(""), null);
  });
});

/* ------------------------------------------------------------------ */

describe("complete() adapter field", () => {
  const originalFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = originalFetch;
  });

  /** Capture the request body and answer with an empty stream. */
  function captureBody(): { body: () => Record<string, unknown> } {
    let sent: Record<string, unknown> = {};
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
    return { body: () => sent };
  }

  test("sends adapters only when an adapter is passed", async () => {
    const captured = captureBody();
    await complete([{ role: "user", content: "hi" }], []);
    // Absent, not null/empty: the server treats any adapters value as a
    // model key, and an explicit null would still change the key.
    assert.ok(!("adapters" in captured.body()));

    await complete([{ role: "user", content: "hi" }], [], {}, undefined, {
      adapter: "/somewhere/adapters/base/coder",
    });
    assert.equal(captured.body().adapters, "/somewhere/adapters/base/coder");
  });
});
