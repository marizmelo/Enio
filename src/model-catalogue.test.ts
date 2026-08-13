import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";
import { CATALOGUE, catalogueModel, fitFor, footprint } from "./model-catalogue.js";
import { DownloadRefused, downloadScriptPath, startDownload } from "./model-download.js";

const GB = 1_000_000_000;

test("every catalogue entry is a Hugging Face repo id with a real size", () => {
  for (const model of CATALOGUE) {
    assert.match(model.id, /^[\w.-]+\/[\w.-]+$/, `${model.id} is not an org/repo id`);
    assert.ok(model.bytes > 100_000_000, `${model.id} claims an implausible ${model.bytes} bytes`);
    assert.ok(model.label && model.note, `${model.id} needs a label and a note`);
  }
});

test("catalogue ids are unique", () => {
  const ids = CATALOGUE.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
});

/**
 * The memory advice is the part a person acts on before spending twenty
 * minutes downloading, so the boundaries are pinned rather than left to drift
 * with a tweak to the headroom constant.
 */
test("fit is judged against the machine, not the model alone", () => {
  const eightGb = 8 * GB;
  const sixtyfour = 64 * GB;
  // A 17GB model is hopeless on 8GB and comfortable on 64GB. If either of
  // these flips, the rule has stopped meaning anything.
  assert.equal(fitFor(17 * GB, eightGb), "over");
  assert.equal(fitFor(17 * GB, sixtyfour), "fits");
  // Weights alone fitting is not the question -- 4GB of weights on an 8GB
  // machine leaves nothing for the KV cache, the runtime, or the desktop.
  assert.equal(fitFor(4 * GB, eightGb), "tight");
  assert.equal(fitFor(1 * GB, eightGb), "fits");
});

test("footprint allows for more than the weights", () => {
  assert.ok(footprint(4 * GB) > 4 * GB);
});

test("the download script the runtime is asked to run exists", () => {
  assert.ok(existsSync(downloadScriptPath()), `${downloadScriptPath()} is missing`);
});

/**
 * The closed list is a boundary, not a convenience: the id reaching
 * startDownload came out of an HTTP body, and honouring an arbitrary one makes
 * the endpoint a general downloader aimed at the user's disk.
 */
test("a repo id outside the catalogue is refused before anything is spawned", () => {
  for (const id of ["evil/malware", "", "../../etc/passwd", "mlx-community/Qwen3-4B"]) {
    assert.throws(() => startDownload(id), DownloadRefused, `${id} should be refused`);
  }
});

test("catalogueModel finds by exact id only", () => {
  assert.ok(catalogueModel(CATALOGUE[0]!.id));
  assert.equal(catalogueModel(CATALOGUE[0]!.id.toUpperCase()), undefined);
});

describe("speed estimates", () => {
  test("bandwidth divides by bytes-per-token; MoE reads only its active experts", async () => {
    const { speedFor, CATALOGUE } = await import("./model-catalogue.js");
    const dense8b = CATALOGUE.find((m) => m.label === "Qwen3 8B")!;
    const moe = CATALOGUE.find((m) => m.label === "Qwen3 30B A3B")!;

    // On a base M4 (120 GB/s): the 4.6GB dense model is usable, and the
    // 17GB MoE -- nearly four times the download -- is FASTER, because only
    // ~1.9GB of experts are read per token. Speed cannot be read off size,
    // which is the whole point of estimating it.
    const dense = speedFor(dense8b, "Apple M4");
    const mixture = speedFor(moe, "Apple M4");
    assert.ok(dense.tokensPerSecond! > 10, `dense: ${dense.tokensPerSecond}`);
    assert.ok(
      mixture.tokensPerSecond! > dense.tokensPerSecond!,
      `MoE (${mixture.tokensPerSecond}) should beat dense (${dense.tokensPerSecond})`,
    );
  });

  test("a big dense model on a base chip is called what it is", async () => {
    const { speedFor } = await import("./model-catalogue.js");
    // A dense ~40GB download (70B at 4-bit) on a base M1: loads on a big
    // machine, generates ~1 tok/s -- the trap the estimate exists to name.
    const trap = speedFor({ bytes: 40_000_000_000 }, "Apple M1");
    assert.equal(trap.pace, "slow");
    assert.ok(trap.tokensPerSecond! < 5);
  });

  test("an unknown chip gets no number rather than a wrong one", async () => {
    const { speedFor } = await import("./model-catalogue.js");
    assert.deepEqual(speedFor({ bytes: 2_000_000_000 }, null), {
      tokensPerSecond: null,
      pace: null,
    });
    assert.deepEqual(speedFor({ bytes: 2_000_000_000 }, "Intel Core i9"), {
      tokensPerSecond: null,
      pace: null,
    });
  });
});

describe("recommendUpgrade", () => {
  const QWEN4B = "mlx-community/Qwen3-4B-Instruct-2507-4bit";
  const MOE = "mlx-community/Qwen3-30B-A3B-4bit";
  const GB = 1_000_000_000;

  test("a 32GB M4 running the 4B is pointed at the MoE, not the dense 14B", async () => {
    const { recommendUpgrade } = await import("./model-catalogue.js");
    const up = recommendUpgrade(QWEN4B, 32 * GB, "Apple M4");
    // The 14B fits too but decodes ~9 tok/s on this bandwidth; the MoE is
    // bigger AND faster because only active experts are read per token.
    assert.equal(up?.id, MOE);
    assert.ok(up!.tokensPerSecond! >= 25, `moe tps: ${up!.tokensPerSecond}`);
  });

  test("a machine already on the biggest usable model gets nothing", async () => {
    const { recommendUpgrade } = await import("./model-catalogue.js");
    assert.equal(recommendUpgrade(MOE, 32 * GB, "Apple M4"), null);
  });

  test("a 24GB machine is honestly pointed at the 8B, not the MoE it cannot hold", async () => {
    const { recommendUpgrade } = await import("./model-catalogue.js");
    const up = recommendUpgrade(QWEN4B, 24 * GB, "Apple M4");
    assert.equal(up?.id, "mlx-community/Qwen3-8B-4bit");
    assert.equal(up?.pace, "usable");
  });

  test("an unknown chip withholds rather than recommending an unmeasured wait", async () => {
    const { recommendUpgrade } = await import("./model-catalogue.js");
    assert.equal(recommendUpgrade(QWEN4B, 64 * GB, "Intel Core i9"), null);
  });

  test("a tiny machine that can hold nothing bigger gets nothing", async () => {
    const { recommendUpgrade } = await import("./model-catalogue.js");
    assert.equal(recommendUpgrade(QWEN4B, 8 * GB, "Apple M1"), null);
  });

  test("a current model outside the catalogue compares as smaller than everything", async () => {
    const { recommendUpgrade } = await import("./model-catalogue.js");
    // Maple's id is not in the catalogue; the recommendation floor drops to
    // zero and the best usable model wins.
    const up = recommendUpgrade("maple-1b-ternary", 32 * GB, "Apple M4");
    assert.equal(up?.id, MOE);
  });
});
