import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const { compileAction, KEY_CODES, resolveApp } = await import("./tools/ax.js");
const { recipeScripts } = await import("./tools/desktop.js");

describe("reading a window", () => {
  const script = (name: string) => recipeScripts().find(([n]) => n === name)?.[1] ?? "";

  test("window_controls does not use entire contents either", () => {
    // Same trap as the click compiler, and the one that actually shipped
    // broken: it returned nothing at all for a real Notes window.
    const s = script("window_controls");
    assert.doesNotMatch(s, /entire contents/);
    // Batched per parent: one Apple Event per sibling row, not three per
    // element -- the per-element walk died on the shell timeout against a
    // real Notes window.
    assert.match(s, /name of every UI element of p/);
    assert.match(s, /visited/);
  });

  test("menu_items skips the Apple menu", () => {
    // Menu bar item 1 is Apple's: identical for every app, not the app's own
    // commands, and home to Shut Down and Restart. Offering those inside a
    // closed list meant for choosing from is how a request to save a note gets
    // answered by ending the user's session.
    const s = script("menu_items");
    assert.match(s, /from 2 to \(count of bar\)/);
  });
});

const RUNNING = ["Google Chrome", "Finder", "Notes", "VSCodium", "Enio"];

describe("resolving an app name", () => {
  test("matches by substring, not edit distance", () => {
    // The reason this is not Levenshtein: the model says "Chrome" and means
    // "Google Chrome", which is seven edits away while being unambiguous as a
    // substring. An edit-distance matcher rejects the commonest case there is.
    assert.deepEqual(resolveApp("Chrome", RUNNING), { ok: true, name: "Google Chrome" });
    assert.deepEqual(resolveApp("notes", RUNNING), { ok: true, name: "Notes" });
    assert.deepEqual(resolveApp("  Finder ", RUNNING), { ok: true, name: "Finder" });
  });

  test("an exact name wins over a longer one containing it", () => {
    // "Notes" must not become "Notes Helper" because both contain it.
    const apps = ["Notes", "Notes Helper"];
    assert.deepEqual(resolveApp("Notes", apps), { ok: true, name: "Notes" });
  });

  test("ambiguity is refused rather than guessed", () => {
    // Clicking in the wrong window is the expensive mistake here, so a tie
    // asks instead of picking. Both candidates are named so the model can.
    const out = resolveApp("Not", ["Notes", "Notion", "Finder"]);
    assert.equal(out.ok, false);
    assert.match(out.reason, /which one/i);
    assert.match(out.reason, /Notes, Notion/);
  });

  test("a prefix beats a mere substring", () => {
    // "Code" prefixes nothing here but is inside VSCodium, so it resolves;
    // were something actually named Code, that would win instead.
    assert.deepEqual(resolveApp("Cod", RUNNING), { ok: true, name: "VSCodium" });
    assert.deepEqual(resolveApp("Fin", ["Finder", "Refinder"]), { ok: true, name: "Finder" });
  });

  test("an app that is not running names the ones that are", () => {
    const out = resolveApp("Photoshop", RUNNING);
    assert.equal(out.ok, false);
    assert.match(out.reason, /not running/);
    assert.match(out.reason, /Google Chrome/);
  });

  test("resolving against the installed list says installed, not running", () => {
    // open_app's whole point is launching what is NOT running; an error
    // claiming the app "is not running" would be telling the user the tool's
    // own precondition is the problem.
    const out = resolveApp("Photoshop", ["Calendar", "Spotify"], "installed");
    assert.equal(out.ok, false);
    assert.match(out.reason, /not installed/);
    assert.match(out.reason, /Installed apps: Calendar, Spotify/);
  });

  test("an empty app asks, rather than defaulting to something", () => {
    assert.equal(resolveApp("", RUNNING).ok, false);
  });
});

describe("compiling an action into AppleScript", () => {
  test("a menu step is written the way menu_items prints it", () => {
    const out = compileAction("menu", "Notes", "File > New Note");
    assert.ok(out.ok);
    assert.match(out.script, /click menu item "New Note" of menu "File"/);
    assert.match(out.script, /of menu bar item "File" of menu bar 1/);
    assert.match(out.script, /tell process "Notes"/);
  });

  test("a menu step that is not two halves is refused with the shape", () => {
    const out = compileAction("menu", "Notes", "Save");
    assert.equal(out.ok, false);
    assert.match(out.reason, /File > Save/);
  });

  test("a click walks the tree level by level, not via entire contents", () => {
    // `entire contents` reads like the way to search a whole window and
    // returns an empty list on real ones -- Notes answers 0 for it while
    // button 1 of window 1 is right there, so a click compiled that way could
    // never match anything. This is the regression that would be silent.
    const out = compileAction("click", "Notes", "Save");
    assert.ok(out.ok);
    assert.doesNotMatch(out.script, /entire contents/);
    assert.match(out.script, /name of every UI element of p/);
    assert.match(out.script, /visited/);
    assert.match(out.script, /if match is missing value then error/);
  });

  test("only named keys press, and the message says where to go instead", () => {
    const ok = compileAction("key", "Notes", "Return");
    assert.ok(ok.ok);
    assert.match(ok.script, new RegExp(`key code ${KEY_CODES.return}`));

    // No modifier combinations on purpose: anything worth a shortcut has a
    // menu item, and "File > Save" reads better in an approval sheet than
    // "cmd+s" does.
    const no = compileAction("key", "Notes", "cmd+s");
    assert.equal(no.ok, false);
    assert.match(no.reason, /menu item/);
  });

  test("typing brings the app forward first, and waits for it", () => {
    // Focus changes asynchronously; keystrokes sent before it lands go to
    // whatever was in front a moment ago, which is the worst way to fail.
    const out = compileAction("type", "Notes", "hello");
    assert.ok(out.ok);
    assert.match(out.script, /set frontmost to true/);
    assert.match(out.script, /delay/);
    assert.match(out.script, /keystroke "hello"/);
  });

  test("quotes and newlines cannot break out of the string literal", () => {
    // What the user approves is the script text, so a name that ends the
    // literal early would mean approving one thing and running another.
    const out = compileAction("type", "Notes", 'he said "hi"\nthen left');
    assert.ok(out.ok);
    assert.match(out.script, /keystroke "he said \\"hi\\"\\nthen left"/);
    // Exactly one keystroke line: nothing escaped onto a line of its own.
    assert.equal(out.script.split("\n").filter((l) => l.includes("keystroke")).length, 1);
  });

  test("control characters are dropped rather than left invisible", () => {
    const out = compileAction("click", "Notes", "Save");
    assert.ok(out.ok);
    assert.match(out.script, /is "Save" then/);
  });

  test("an empty target is refused", () => {
    assert.equal(compileAction("click", "Notes", "   ").ok, false);
  });

  test("open launches through LaunchServices, not an Apple Event", () => {
    // `tell application to activate` fails with -600 in any context not
    // allowed to launch via Apple Events -- discovered when the first
    // approved plan's very first step failed on it. `open -a` works there
    // and everywhere else.
    const out = compileAction("open", "Calendar", "Calendar");
    assert.ok(out.ok);
    assert.equal(out.script, 'do shell script "open -a " & quoted form of "Calendar"');

    const sneaky = compileAction("open", "x", 'Cal" & (do shell script "id') ;
    assert.ok(sneaky.ok);
    assert.match(sneaky.script, /\\"/, "quotes in the name must be escaped, not literal");
  });
});

describe("every shipped script is valid AppleScript", () => {
  // osacompile parses without executing, so this needs no permission and
  // touches no app. It cannot tell you a recipe returns the right thing --
  // only a real machine does, and that remains the rule for adding one -- but
  // it does catch a malformed script, which otherwise surfaces as the model
  // being blamed for a tool that was broken before it ever chose it.
  const notMac = process.platform !== "darwin";

  const compiles = (script: string): string | null => {
    try {
      execFileSync("osacompile", ["-o", "/dev/null", "-e", script], { stdio: "pipe" });
      return null;
    } catch (err) {
      return String((err as { stderr?: Buffer }).stderr ?? err).trim();
    }
  };

  for (const [name, script] of recipeScripts()) {
    test(`recipe ${name}`, { skip: notMac }, () => {
      assert.equal(compiles(script), null, `${name} is not valid AppleScript`);
    });
  }

  for (const [kind, value] of [
    ["click", "Save"],
    ["menu", "File > New Note"],
    ["type", 'quoted "text" and\na newline'],
    ["key", "return"],
    ["open", "Calendar"],
  ] as const) {
    test(`${kind} action`, { skip: notMac }, () => {
      const out = compileAction(kind, "Finder", value);
      assert.ok(out.ok);
      assert.equal(compiles(out.script), null, `the ${kind} template is not valid AppleScript`);
    });
  }
});
