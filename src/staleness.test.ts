import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distStaleness } from "./staleness.js";

const scratch = mkdtempSync(join(tmpdir(), "enio-stale-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const at = (file: string, secondsAgo: number) => {
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(file, t, t);
};

describe("the stale-build check", () => {
  test("source newer than the build by more than a minute is stale; within a minute is not; no build is not", () => {
    mkdirSync(join(scratch, "src", "memory"), { recursive: true });
    mkdirSync(join(scratch, "dist"), { recursive: true });
    writeFileSync(join(scratch, "src", "a.ts"), "");
    writeFileSync(join(scratch, "src", "memory", "b.ts"), "");
    writeFileSync(join(scratch, "dist", "index.js"), "");
    at(join(scratch, "src", "a.ts"), 3600);
    at(join(scratch, "src", "memory", "b.ts"), 30);
    at(join(scratch, "dist", "index.js"), 10);
    assert.equal(distStaleness(scratch).stale, false, "built seconds after the last edit");

    at(join(scratch, "src", "memory", "b.ts"), 0);
    at(join(scratch, "dist", "index.js"), 600);
    const s = distStaleness(scratch);
    assert.equal(s.stale, true);
    assert.match(s.newest, /memory\/b\.ts$/);

    rmSync(join(scratch, "dist", "index.js"));
    assert.equal(distStaleness(scratch).stale, false, "no build is a different failure with its own message");
  });
});
