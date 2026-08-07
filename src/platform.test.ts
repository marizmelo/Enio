import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  canRunMaple,
  defaultBackendId,
  platformLabel,
  shellFor,
  whyNoMaple,
  WINDOWS_COMMANDS,
  type PlatformId,
} from "./platform.js";

const ALL: PlatformId[] = ["macos-arm64", "macos-intel", "linux", "windows", "unknown"];

describe("Maple availability", () => {
  test("only Apple Silicon can run it", () => {
    assert.equal(canRunMaple("macos-arm64"), true);
    for (const p of ALL.filter((p) => p !== "macos-arm64")) {
      assert.equal(canRunMaple(p), false, `${p} must not claim Maple support`);
    }
  });

  test("an Intel Mac is rejected, not treated as 'a Mac'", () => {
    // The tempting bug: checking platform() === "darwin" and forgetting arch.
    assert.equal(canRunMaple("macos-intel"), false);
    assert.match(whyNoMaple("macos-intel"), /Apple Silicon/);
  });

  test("every platform explains itself", () => {
    for (const p of ALL) {
      assert.ok(whyNoMaple(p).length > 20, `${p} needs a real explanation`);
      assert.ok(platformLabel(p).length > 3);
    }
  });
});

describe("default backend", () => {
  test("maple on Apple Silicon", () => {
    assert.equal(defaultBackendId("macos-arm64"), "maple");
  });

  test("ollama everywhere else", () => {
    // Defaulting to a backend the machine can't run produces a confusing
    // connection error instead of a useful one.
    for (const p of ALL.filter((p) => p !== "macos-arm64")) {
      assert.equal(defaultBackendId(p), "ollama", `${p} should default to ollama`);
    }
  });
});

describe("shell selection", () => {
  test("uses bash on this POSIX host", () => {
    const { file, args } = shellFor("ls -la");
    assert.equal(file, "bash");
    assert.deepEqual(args, ["-c", "ls -la"]);
  });

  test("passes the command through untouched", () => {
    // Quoting is the shell's problem; mangling it here would break commands
    // in ways the model cannot diagnose.
    const tricky = `echo "a b" | grep 'a'`;
    assert.equal(shellFor(tricky).args.at(-1), tricky);
  });

  test("windows equivalents cover the basics", () => {
    for (const expected of ["dir", "type", "findstr", "where"]) {
      assert.ok(WINDOWS_COMMANDS.includes(expected), `missing ${expected}`);
    }
  });
});
