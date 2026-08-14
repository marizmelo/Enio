import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

// Only ENIO_DATA_DIR is redirected here, which is the point: this file asserts
// that doing so does NOT drag the machine-wide client registry along with it.
// Nothing below writes to that registry -- the behavioural half lives in
// integration.test.ts, which opts into isolation by name.
const scratch = mkdtempSync(join(tmpdir(), "enio-clients-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
// The bundled skills live in the checkout now, so a suite that redirects
// only the data dir would still load them into every prompt it measures.
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
delete process.env.ENIO_MACHINE_STATE_DIR;
delete process.env.MAPLE_MACHINE_STATE_DIR;

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

const { config } = await import("./config.js");

after(() => rmSync(scratch, { recursive: true, force: true }));

describe("the model-server client count", () => {
  test("does not follow ENIO_DATA_DIR", () => {
    // This bug shut down a running model server twice, both times from a
    // process that had never started one.
    //
    // The count decides when the shared server is killed, and the server is
    // located by scanning the process table -- one per machine, with no path
    // to relocate. The count lived in config.dataDir, so anything with its own
    // ENIO_DATA_DIR (every isolated test, any script redirecting state to a
    // scratch directory) read an empty registry, concluded it was the last one
    // out, and reaped a server other processes were mid-answer on.
    assert.ok(
      !config.machineStateDir.startsWith(scratch),
      "machine-wide state must not follow ENIO_DATA_DIR into a scratch directory",
    );
    assert.notEqual(config.machineStateDir, config.dataDir);
  });

  test("resolves to the machine's own directory", () => {
    // Both spellings are accepted for the same reason everything else here
    // takes two: the project was renamed and old installs still exist.
    assert.ok(
      [join(homedir(), ".enio"), join(homedir(), ".maple-agent")].includes(
        config.machineStateDir,
      ),
      `expected the home data directory, got ${config.machineStateDir}`,
    );
  });
});
