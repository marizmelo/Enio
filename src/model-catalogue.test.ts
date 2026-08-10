import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { test } from "node:test";
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
