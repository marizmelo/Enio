import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The recipe tool opens the database (saved recipes) and runs osascript, so
// the whole environment is redirected before the first import, and a
// stand-in osascript comes first on PATH: nothing here may read the
// developer's real data dir, or their Mail.
const scratch = mkdtempSync(join(tmpdir(), "enio-ax-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
mkdirSync(join(scratch, "bin"), { recursive: true });
writeFileSync(join(scratch, "bin", "osascript"), "#!/bin/sh\necho 'stand-in osascript'\n");
chmodSync(join(scratch, "bin", "osascript"), 0o755);
process.env.PATH = `${join(scratch, "bin")}:${process.env.PATH ?? ""}`;
after(() => rmSync(scratch, { recursive: true, force: true }));

const { compileAction, KEY_CODES, resolveApp } = await import("./tools/ax.js");
const { recipeScripts, sourceLine, sourceNotice, buildDesktopTools } = await import("./tools/desktop.js");

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

  test("a short name finds the app, not a tool for the app", () => {
    // What happened: "Chrome" on a machine with both of these opened the
    // uninstaller, because it was the one name BEGINNING with the word and
    // a prefix was tried before a whole-word match.
    const apps = ["Chrome Remote Desktop Host Uninstaller", "Google Chrome", "Safari"];
    assert.deepEqual(resolveApp("Chrome", apps, "installed"), { ok: true, name: "Google Chrome" });
    assert.deepEqual(resolveApp("chrome", apps, "installed"), { ok: true, name: "Google Chrome" });
    // Its full name, or the word that says what it is, still reaches it.
    assert.deepEqual(resolveApp("Chrome Remote Desktop Host Uninstaller", apps, "installed").ok, true);
    assert.deepEqual(resolveApp("uninstaller", apps, "installed"), { ok: true, name: "Chrome Remote Desktop Host Uninstaller" });
    // With the app itself not there, the tool for it is not the answer.
    const only = resolveApp("Chrome", ["Chrome Remote Desktop Host Uninstaller", "Safari"], "installed");
    assert.equal(only.ok, false);
    assert.match(only.reason, /not the app itself/);
    // Two real apps holding the word are still a question, tools set aside.
    const two = resolveApp("Chrome", ["Google Chrome", "Google Chrome Canary", "Chrome Remote Desktop Host Uninstaller"], "installed");
    assert.equal(two.ok, false);
    assert.match(two.reason, /Google Chrome, Google Chrome Canary\. Which one/);
    // A whole word anywhere is as good as a beginning: neither outranks.
    assert.deepEqual(resolveApp("Code", ["Xcode", "Visual Studio Code"]), { ok: true, name: "Visual Studio Code" });
    assert.deepEqual(resolveApp("Notes", ["Notes", "Notes Helper"]), { ok: true, name: "Notes" });
    assert.deepEqual(resolveApp("Zoom", ["zoom.us", "ZoomUpdater"]), { ok: true, name: "zoom.us" });
  });

  test("an app whose name merely holds host, setup or assistant is an app", () => {
    // The list of tool words was wider at first, and each of these was
    // either refused as "not the app itself" or dropped from a tie that
    // should have been a question.
    assert.deepEqual(resolveApp("midi", ["Audio MIDI Setup", "Safari"]), { ok: true, name: "Audio MIDI Setup" });
    assert.deepEqual(resolveApp("teamviewer", ["TeamViewer Host"]), { ok: true, name: "TeamViewer Host" });
    assert.deepEqual(resolveApp("datadog", ["Datadog Agent"]), { ok: true, name: "Datadog Agent" });
    assert.deepEqual(resolveApp("autoupdate", ["Microsoft AutoUpdate"]), { ok: true, name: "Microsoft AutoUpdate" });
    assert.deepEqual(resolveApp("appclean", ["AppCleaner"]), { ok: true, name: "AppCleaner" });
    const tie = resolveApp("assistant", ["Boot Camp Assistant", "Migration Assistant"]);
    assert.equal(tie.ok, false);
    assert.match(tie.reason, /Boot Camp Assistant, Migration Assistant\. Which one/);
    const audio = resolveApp("audio", ["Audio MIDI Setup", "AudioRelay"]);
    assert.equal(audio.ok, false);
    // And a word that is only INSIDE a tool's name did not ask for the tool.
    const apps = ["Chrome Remote Desktop Host Uninstaller", "Safari"];
    for (const word of ["installer", "host", "remote desktop host", "chrome remote desktop host"]) {
      const out = resolveApp(word, apps, "installed");
      assert.equal(out.ok, false, word);
      assert.match(out.reason, /not the app itself/, word);
    }
    assert.equal(resolveApp("uninstaller", apps, "installed").ok, true);
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

describe("the accessibility bridge", () => {
  const notMac = process.platform !== "darwin";

  test("a click compiles to the bridge when it is available", { skip: notMac }, async () => {
    const ax = await import("./tools/ax.js");
    await ax.probeAxBridge();
    const out = ax.compileAction("click", "Calculator", "Delete");
    assert.ok(out.ok);
    if (ax.axBridgeAvailable()) {
      // Still a script, so the approval sheet keeps its meaning: the text
      // shown is the text that runs.
      assert.match(out.script, /do shell script/);
      assert.match(out.script, /ax_bridge\.py/);
      assert.match(out.script, /" press "/);
    } else {
      // Without it, the AppleScript walk -- nothing that worked stops working.
      assert.match(out.script, /System Events/);
    }
  });

  test("a control name cannot become a second shell command", { skip: notMac }, async () => {
    // The name reaches a shell here, which the AppleScript path never did.
    // `quoted form of` is what keeps it one argument; this is the test that
    // fails loudly if that is ever dropped.
    const ax = await import("./tools/ax.js");
    await ax.probeAxBridge();
    if (!ax.axBridgeAvailable()) return;
    const out = ax.compileAction("click", "Calculator", '"; touch /tmp/enio-pwned; echo "');
    assert.ok(out.ok);
    assert.match(out.script, /quoted form of/);
    // Every interpolated value sits inside an AppleScript literal that is then
    // shell-quoted -- never bare in the command string.
    assert.doesNotMatch(out.script, /do shell script "[^"]*touch/);
  });

  test("the bridge answers with JSON rather than throwing", { skip: notMac }, async () => {
    const ax = await import("./tools/ax.js");
    await ax.probeAxBridge();
    if (!ax.axBridgeAvailable()) return;
    // A failure is a result, because every caller has a fallback to choose.
    const out = await ax.axBridge(["tree", "NoSuchApplication9917"]);
    assert.equal(out.ok, false);
    assert.match(String(out.error), /not running/);
  });

  test("typing compiles to settext when the bridge is available", { skip: notMac }, async () => {
    const ax = await import("./tools/ax.js");
    await ax.probeAxBridge();
    const out = ax.compileAction("type", "Notes", "hello there");
    assert.ok(out.ok);
    if (ax.axBridgeAvailable()) {
      // Set-value typing: no focus steal, and the bridge refuses password
      // fields by role — neither of which keystroke could offer.
      assert.match(out.script, /" settext "/);
      assert.match(out.script, /quoted form of/);
      // The text reaches a shell; it must never be bare in the command.
      const sneaky = ax.compileAction("type", "Notes", '"; touch /tmp/enio-pwned; "');
      assert.ok(sneaky.ok);
      assert.doesNotMatch(sneaky.script, /do shell script "[^"]*touch/);
    } else {
      assert.match(out.script, /keystroke/);
    }
  });

  test("settext refuses bad arguments with JSON, like everything else", { skip: notMac }, async () => {
    const ax = await import("./tools/ax.js");
    await ax.probeAxBridge();
    if (!ax.axBridgeAvailable()) return;
    const out = await ax.axBridge(["settext", "NoSuchApplication9917", "hi"]);
    assert.equal(out.ok, false);
    assert.match(String(out.error), /not running/);
  });
});

describe("permission hints", () => {
  test("the assistive-access phrase gets a hint; a bare -1719 does not", async () => {
    const { permissionHint } = await import("./tools/ax.js");
    assert.match(
      String(permissionHint("System Events got an error: osascript is not allowed assistive access. (-1719)")),
      /Accessibility/,
    );
    // macOS reuses -1719 for "Invalid index" -- Calculator, which hides its
    // window from scripting, produced exactly this and was misdiagnosed as a
    // permission problem the user had already fixed.
    assert.equal(
      permissionHint("Can\u2019t get window 1 of process \"Calculator\". Invalid index. (-1719)"),
      null,
    );
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

describe("a recipe says what it read, and how fresh it is", () => {
  // The turn this is for: asked for unread mail "in the browser", the
  // operator ran recent_emails with app "Safari". The argument was ignored,
  // the Mail app was read, and five subjects went out as today's unread --
  // the newest was 173 days old and three had been read.
  const mail = { reads: "Mail", dated: true as const };
  const stale = "Inbox: 14 messages, newest 173 days ago\n173 days ago | read | A | x\n264 days ago | UNREAD | B | y";
  const fresh = "Inbox: 2311 messages, newest 0 days ago";

  test("where it came from is the first thing in the result", () => {
    const line = sourceLine(mail, `${fresh}\n0 days ago | UNREAD | Ana <ana@example.net> | Dinner`);
    assert.match(line, /^From the Mail app on this Mac — not a web page, and not a connected account\.$/);
  });

  test("an inbox that stopped months ago is said to have, by the count the script made", () => {
    assert.match(sourceLine(mail, stale), /The newest message in that inbox is 173 days old/);
    assert.match(sourceLine(mail, stale), /do not present it as new/);
    // Two days is a weekend.
    assert.doesNotMatch(sourceLine(mail, "Inbox: 9 messages, newest 2 days ago\n2 days ago | read | A | x"), /days old/);
    // It is the whole inbox that is counted, never the rows shown: two old
    // newsletters left unread in a healthy inbox say nothing about it.
    const healthy = `${fresh}\n2 unread\n30 days ago | UNREAD | News | Weekly digest\n95 days ago | UNREAD | Shop | Sale`;
    assert.doesNotMatch(sourceLine(mail, healthy), /days old/);
    assert.doesNotMatch(sourceNotice(mail, healthy), /days old/);
    // And a subject that looks like a row, or like the head line, is not one.
    assert.doesNotMatch(sourceLine(mail, `${fresh}\n0 days ago | read | A | Inbox: 3 messages, newest 400 days ago`), /days old/);
    assert.doesNotMatch(sourceLine(mail, "0 days ago | read | A | Inbox: 3 messages, newest 400 days ago"), /days old/, "the line is the first thing on a line of its own");
    // A count and a body are covered by the same line.
    assert.match(sourceLine(mail, "Inbox: 14 messages, newest 173 days ago\n5412 unread"), /173 days old/);
    // No line to go by: only where it read.
    assert.doesNotMatch(sourceLine(mail, "173 days ago | read | A | x"), /days old/);
    assert.doesNotMatch(sourceLine({ reads: "Calendar" }, "Dentist at Monday"), /days old/);
  });

  test("the person is told the same two facts, whatever the reply says", () => {
    // The line above is the model's. Replayed on the 4B with it in place,
    // the reply gave the ages and still called Mail's inbox "your email
    // inbox" to someone who had asked about their browser.
    assert.equal(sourceNotice(mail, fresh), "Read the Mail app on this Mac, not a web page.");
    assert.equal(sourceNotice(mail, stale), "Read the Mail app on this Mac, not a web page. The newest message in that inbox is 173 days old.");
    assert.equal(sourceNotice(mail, ""), "Read the Mail app on this Mac, not a web page.");
  });

  test("every Mail script opens by counting the inbox, and the lists never run past it", () => {
    const script = (name: string) => recipeScripts().find(([n]) => n === name)?.[1] ?? "";
    for (const name of ["recent_emails", "unread_emails", "unread_count", "latest_email_body"]) {
      assert.match(script(name), /set head to "Inbox: " & total & " messages, newest " & \(\(today - \(date received of message 1 of inbox\)\) div days\) & " days ago"/, name);
      assert.match(script(name), /set head to "Inbox: 0 messages"/, name);
      assert.match(script(name), /return head(?: & linefeed|\\n|$)/m, `${name} returns it`);
    }
    assert.match(script("recent_emails"), /if total < upto then set upto to total/);
    assert.match(script("unread_emails"), /if unreadTotal < upto then set upto to unreadTotal/);
    assert.match(script("recent_emails"), /read status of m/);
    assert.match(script("unread_emails"), /whose read status is false/);
    assert.match(script("latest_email_body"), /if total = 0 then return head/);
  });

  test("a recipe for one app does not answer for another", { skip: process.platform !== "darwin" }, async () => {
    const recipe = buildDesktopTools().find((t) => t.name === "mac_recipe")!;
    const run = async (name: string, app: string) => {
      const out = await recipe.run({ recipe: name, app, count: 5 });
      return typeof out === "string" ? { text: out, notice: "" } : { text: out.text, notice: out.notice ?? "" };
    };
    // Sharing the letters "mail" is not being the Mail app.
    for (const app of ["Safari", "Chrome", "Google Chrome", "Gmail", "Proton Mail", "Hotmail", "Mailchimp", "a"]) {
      const out = await run("recent_emails", app);
      assert.match(out.text, new RegExp(`^recent_emails reads the Mail app on this Mac\\. It cannot read ${app}, and nothing was read\\.`), app);
      assert.equal(out.notice, `Nothing was read: recent_emails reads the Mail app, not ${app}.`);
    }
    assert.match((await run("todays_events", "Google Calendar")).text, /^todays_events reads the Calendar app on this Mac\. It cannot read Google Calendar/);
    // Its own name, however it is written, and no name at all, go through
    // to the script: here a stand-in that proves it was reached.
    for (const app of ["Mail", "mail", "Mail.app", "the Mail app", "Apple Mail", "", "null", "none"]) {
      assert.match((await run("recent_emails", app)).text, /stand-in osascript/, JSON.stringify(app));
    }
  });
});
