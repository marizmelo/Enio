import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { toolText } from "./types.js";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-integrations-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
// The bundled skills live in the checkout now, so a suite that redirects
// only the data dir would still load them into every prompt it measures.
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
// Machine-wide state (model choice, desktop-control consent) must never be
// read from or written to the developer's real machine by a test.
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_MCP_CONFIG = join(scratch, "none.json");

// Configured, but NOT permitted to actually transmit — the shipping default.
process.env.ENIO_SMTP_HOST = "smtp.example.com";
process.env.ENIO_EMAIL_FROM = "me@example.com";
process.env.ENIO_EMAIL_ALLOWED_TO = "team@example.com,@trusted.org";

const { emailTools, emailConfigured, addressesIn, recipientAllowed } = await import("./tools/email.js");
const { buildDesktopTools, desktopEnabled, DESKTOP_COMMANDS } = await import("./tools/desktop.js");
const desktopTools = buildDesktopTools();
const { checkCommand } = await import("./tools/shell.js");
const { SPECIALISTS, getSpecialist } = await import("./specialists.js");
const { ensureDirs } = await import("./config.js");

ensureDirs();
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("email", () => {
  const tool = emailTools[0]!;

  test("is offered once SMTP is configured", () => {
    assert.equal(emailConfigured(), true);
    assert.equal(tool.name, "send_email");
  });

  test("the tool writes the message and transmits nothing", async () => {
    // Sending is irreversible and the model deciding to send is exactly the
    // judgement a small model gets wrong: the call writes to the outbox,
    // and a person sends.
    const out = toolText(await tool.run({
      to: "team@example.com",
      subject: "Weekly update",
      body: "All good.",
    }));
    assert.match(out, /^Written, not sent\./);
    assert.match(out, /Subject: Weekly update/);
  });

  test("the message is also a readable .eml, so it can be checked with no app running", async () => {
    await tool.run({ to: "team@example.com", subject: "Check me", body: "Body text." });
    const drafts = readdirSync(process.env.ENIO_WORKSPACE!).filter((f) => f.endsWith(".eml"));
    assert.ok(drafts.length > 0, "a draft file should exist");
  });

  test("enforces the recipient allowlist", async () => {
    const out = toolText(await tool.run({
      to: "stranger@elsewhere.com",
      subject: "Hello",
      body: "Hi",
    }));
    assert.match(out, /Refused/);
    assert.match(out, /not in the allowed recipient list/);
  });

  test("a domain rule permits everyone at that domain", async () => {
    const out = toolText(await tool.run({ to: "anyone@trusted.org", subject: "Hi", body: "x" }));
    assert.match(out, /^Written, not sent\./, "should have been allowed through");
  });

  test("the allow-list is asked about every address, in To and in Cc", async () => {
    // What it was: one question of the whole string, "does it end with the
    // rule". A stranger listed first rode in behind a permitted address at
    // the end, and both transports send to a comma-separated list.
    const send = async (to: string, cc?: string) => toolText(await tool.run({ to, cc, subject: "Hi", body: "x" }));
    for (const to of [
      "stranger@elsewhere.com, anyone@trusted.org",
      "stranger@elsewhere.com; team@example.com",
      "anyone@trusted.org, stranger@elsewhere.com",
      "Stranger <stranger@elsewhere.com>, anyone@trusted.org",
    ]) {
      const out = await send(to);
      assert.match(out, /^Refused: stranger@elsewhere\.com is not in the allowed recipient list/, to);
      assert.doesNotMatch(out, /Written, not sent/, to);
    }
    // Cc was not asked at all.
    assert.match(await send("team@example.com", "stranger@elsewhere.com"), /^Refused: stranger@elsewhere\.com is not/);
    assert.match(await send("team@example.com", "a@elsewhere.com, b@elsewhere.com"), /^Refused: a@elsewhere\.com, b@elsewhere\.com are not/);
    // A permitted list goes through, and what is shown is the parsed list.
    const ok = await send('"Team, The" <Team@Example.com>; anyone@trusted.org', "second@trusted.org");
    assert.match(ok, /^Written, not sent\./);
    assert.match(ok, /^To: team@example\.com, anyone@trusted\.org$/m);
    assert.match(ok, /^Cc: second@trusted\.org$/m);
    // A domain rule is the end of an ADDRESS, not of any text that holds it.
    assert.match(await send("anyone@trusted.org.elsewhere.com"), /^Refused/);
    assert.match(await send("stranger@nottrusted.org"), /^Refused/);
  });

  test("a value that is not a list of addresses is refused whole, naming the part", async () => {
    const parsed = (v: string) => addressesIn(v);
    assert.deepEqual(parsed("ana@example.net"), { ok: true, addresses: ["ana@example.net"] });
    assert.deepEqual(parsed(" Ana Costa <Ana@Example.net> ; bob@example.net, ana@example.net "), { ok: true, addresses: ["ana@example.net", "bob@example.net"] });
    assert.deepEqual(parsed('"Costa, Ana" <ana@example.net>'), { ok: true, addresses: ["ana@example.net"] });
    assert.deepEqual(parsed(""), { ok: true, addresses: [] });
    for (const bad of ["Ana", "ana@", "@example.net", "ana@example", "ana@example.net bob@example.net", "ana@@example.net", "<ana@example.net", "ana@example..net"]) {
      assert.equal(parsed(bad).ok, false, bad);
    }
    assert.deepEqual(parsed("team@example.com, Ana"), { ok: false, bad: "Ana" });
    assert.equal(recipientAllowed("x@corp.com", ["@corp.com"]), true);
    assert.equal(recipientAllowed("x@corp.com", ["y@corp.com"]), false);
    assert.equal(recipientAllowed("x@anything.example", []), true);
    // And at the tool: the part that would not parse, in the old words.
    assert.equal(toolText(await tool.run({ to: "Ana", subject: "x", body: "y" })), '"Ana" is not an email address.');
    assert.match(toolText(await tool.run({ to: "team@example.com, Ana", subject: "x", body: "y" })), /^"Ana" is not an email address\.$/);
    assert.match(toolText(await tool.run({ to: "team@example.com", cc: "nobody", subject: "x", body: "y" })), /^"nobody" in the cc is not an email address\.$/);
    assert.match(toolText(await tool.run({ to: " ; ", subject: "x", body: "y" })), /is not an email address/);
  });

  test("a subject is one line, whatever was written into it", async () => {
    const out = toolText(await tool.run({ to: "team@example.com", subject: "Hello\r\nBcc: stranger@elsewhere.com\nX-Extra: 1", body: "y" }));
    assert.match(out, /^Subject: Hello Bcc: stranger@elsewhere\.com X-Extra: 1$/m);
    assert.doesNotMatch(out, /^Bcc:/m);
    assert.doesNotMatch(out, /^X-Extra:/m);
  });

  test("rejects a malformed address and an empty subject", async () => {
    assert.match(toolText(await tool.run({ to: "not-an-address", subject: "x", body: "y" })), /not an email/);
    assert.match(
      toolText(await tool.run({ to: "team@example.com", subject: "", body: "y" })),
      /needs a subject/,
    );
  });
});

describe("the tool budget", () => {
  test("routing means no built-in is dropped for budget", async () => {
    // The ceiling protects the model, and with routing on the model never
    // sees the registry -- only one specialist's few. Capping both stacked
    // the limits: adding one desktop tool pushed the total past 16 and
    // silently truncated the end of the list, which is where the web tools
    // are, leaving the researcher with no web access at all.
    const { buildRegistry } = await import("./tools/index.js");
    const registry = await buildRegistry();
    assert.deepEqual(registry.dropped, [], "nothing should be withheld for budget");
  });

  test("every specialist still sees at most six", async () => {
    // This is the limit that actually governs a prompt, and the one that
    // matters now the registry no longer caps itself.
    const { buildRegistry } = await import("./tools/index.js");
    const { toolsFor } = await import("./specialists.js");
    const registry = await buildRegistry();
    for (const s of SPECIALISTS) {
      assert.ok(
        toolsFor(s, registry).length <= 6,
        `${s.name} sees ${toolsFor(s, registry).length} tools`,
      );
    }
  });
});

test("no built-in tool name contains the MCP separator", async () => {
  // The desktop names the server on an MCP badge by splitting `server__tool`
  // (wireName in tools/mcp.ts). A built-in with a double underscore would be
  // drawn as if it came from a connection the user never made -- provenance
  // that lies is worse than none.
  const { buildRegistry } = await import("./tools/index.js");
  const registry = await buildRegistry();
  const offenders = registry.all.filter(
    (t: { origin: string; name: string }) => t.origin === "builtin" && t.name.includes("__"),
  );
  assert.deepEqual(offenders.map((t: { name: string }) => t.name), []);
});

describe("desktop control", () => {
  test("nothing that changes the machine is available unless enabled", () => {
    // The gate is about irreversibility, not about touching apps at all.
    // AppleScript composed by the model can send, delete and reconfigure, so
    // it stays opt-in; a fixed read does not, and gating it identically meant
    // "show my emails" failed by default on a machine that could answer it.
    assert.equal(desktopEnabled(), false);

    const offered: string[] = desktopTools.map((t) => t.name);
    for (const mutating of ["run_applescript", "take_screenshot", "propose_plan"]) {
      assert.ok(!offered.includes(mutating), `${mutating} must stay behind ENIO_DESKTOP`);
    }
    // Whatever is offered must be reversible and closed-list. open_app sits
    // here deliberately: the gate is about irreversibility, and opening an
    // app is undone by quitting it -- while the name it launches resolves
    // against the system's installed-apps list, never model text.
    assert.deepEqual(offered, ["mac_recipe", "open_app"]);
  });

  test("the app name enio hides cannot break out of the AppleScript string", async () => {
    // The name is interpolated into `set visible of process "<name>"`, and it
    // arrives from the environment. A quote in it would end the string and
    // whatever follows would be AppleScript the desktop app chose, not a
    // name -- so the sanitiser keeps only what a real app name contains.
    const { ownAppName } = await import("./tools/desktop.js");
    const original = process.env.ENIO_APP_NAME;
    try {
      process.env.ENIO_APP_NAME = 'Enio" to false\ntell application "Finder" to empty trash\n"';
      const cleaned = ownAppName();
      assert.ok(!cleaned.includes('"'), `quote survived: ${cleaned}`);
      assert.ok(!/[\n\\]/.test(cleaned), `escape survived: ${cleaned}`);
      assert.match(cleaned, /^[A-Za-z0-9 ._-]+$/);

      // Unset falls back to the shipped name rather than an empty process
      // reference, which would make the hide fail on every capture.
      delete process.env.ENIO_APP_NAME;
      assert.equal(ownAppName(), "Enio");
      // A name that sanitises away entirely falls back too.
      process.env.ENIO_APP_NAME = "!!!";
      assert.equal(ownAppName(), "Enio");
    } finally {
      if (original === undefined) delete process.env.ENIO_APP_NAME;
      else process.env.ENIO_APP_NAME = original;
    }
  });

  test("a saved recipe will not run with desktop mode off", async () => {
    // Built-ins need no flag because they are audited reads. A saved recipe is
    // neither: it is arbitrary AppleScript a person wrote or approved, and now
    // that plans carry clicks and keystrokes it may well change something.
    // Running it ungated would leave an irreversible action behind no switch,
    // which is the one thing this whole gate exists to prevent.
    const { saveRecipe, forgetRecipe } = await import("./plans.js");
    saveRecipe({ name: "gate_probe", summary: "probe", script: "return 1" });

    const tool = desktopTools.find((t) => t.name === "mac_recipe")!;
    const out = String(await tool.run({ recipe: "gate_probe" }));
    assert.match(out, /ENIO_DESKTOP/);

    // And it is not advertised either — a name in the description the model
    // cannot use is a dead end that costs a turn to discover.
    assert.ok(!tool.description.includes("gate_probe"));
    forgetRecipe("gate_probe");
  });

  test("the shell allowlist blocks automation commands while it's off", () => {
    // This is what was actually stopping shell-based computer use, rather than
    // any missing library.
    for (const command of ["osascript -e 'tell app \"Finder\"'", "screencapture x.png", "shortcuts run Thing"]) {
      assert.equal(checkCommand(command).ok, false, `${command} should be refused`);
    }
  });

  test("the desktop command set covers the useful macOS surface", () => {
    for (const expected of ["osascript", "shortcuts", "open", "screencapture", "pbpaste", "mdfind"]) {
      assert.ok(DESKTOP_COMMANDS.includes(expected), `missing ${expected}`);
    }
  });

  test("stays off on non-macOS even when the flag is set", async () => {
    // The tools are AppleScript and screencapture. Enabling them on Linux
    // would offer the model commands that cannot exist there.
    process.env.ENIO_DESKTOP = "1";
    const fresh = await import("./tools/desktop.js");
    const { detectPlatform } = await import("./platform.js");
    if (!detectPlatform().startsWith("macos")) {
      assert.equal(fresh.desktopEnabled(), false, "must stay off away from macOS");
    }
    delete process.env.ENIO_DESKTOP;
  });

  test("ordinary commands are unaffected either way", () => {
    assert.equal(checkCommand("git status").ok, true);
    assert.equal(checkCommand("ls | grep src").ok, true);
  });
});

describe("the operator specialist", () => {
  const operator = getSpecialist("operator");

  test("exists and is routable", () => {
    assert.equal(operator.name, "operator");
    assert.ok(SPECIALISTS.some((s) => s.name === "operator"));
  });

  test("holds the machine-facing tools and nothing else", () => {
    // It proposes AppleScript rather than running it: run_applescript stays in
    // the registry as the approval endpoint's execution path, and is given to
    // no specialist, so composing a script and running one are separated by a
    // person. Handing it back here would undo that silently.
    assert.ok(!operator.tools.includes("run_applescript"), "the operator proposes, it does not run");
    assert.ok(operator.tools.includes("propose_plan"));
    assert.ok(operator.tools.includes("mac_recipe"));
    assert.ok(operator.tools.includes("take_screenshot"));
    // Disjoint tool sets are the entire reason specialists exist.
    assert.ok(!operator.tools.includes("run_command"), "shell belongs to coder");
    assert.ok(!operator.tools.includes("web_search"), "search belongs to researcher");
    assert.ok(!operator.tools.includes("send_email"), "email belongs to the mail specialist");
  });

  test("mail is its own specialist, and read-only about reading", () => {
    const mail = getSpecialist("mail");
    assert.equal(mail.name, "mail");
    assert.ok(mail.tools.includes("search_email"));
    assert.ok(mail.tools.includes("read_email"));
    assert.ok(mail.tools.includes("send_email"));
    // No tool exists that could mutate the mailbox, by design.
    assert.ok(!mail.tools.some((t) => /delete|move|archive|mark/.test(t)));
    assert.match(mail.systemPrompt, /read-only/i);
    assert.match(mail.systemPrompt, /cannot be recalled|agreement first/i);
  });

  test("is told to confirm before anything irreversible", () => {
    assert.match(operator.systemPrompt, /cannot be undone|irreversible/i);
  });

  test("stays within the per-specialist tool budget", () => {
    for (const s of SPECIALISTS) {
      assert.ok(s.tools.length <= 6, `${s.name} exposes ${s.tools.length} tools`);
    }
  });
});
