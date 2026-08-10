import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { toolText } from "./types.js";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-integrations-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_MCP_CONFIG = join(scratch, "none.json");

// Configured, but NOT permitted to actually transmit — the shipping default.
process.env.ENIO_SMTP_HOST = "smtp.example.com";
process.env.ENIO_EMAIL_FROM = "me@example.com";
process.env.ENIO_EMAIL_ALLOWED_TO = "team@example.com,@trusted.org";

const { emailTools, emailConfigured } = await import("./tools/email.js");
const { desktopTools, desktopEnabled, DESKTOP_COMMANDS } = await import("./tools/desktop.js");
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

  test("dry run by default — nothing is transmitted", async () => {
    // Sending is irreversible and the model deciding to send is exactly the
    // judgement a small model gets wrong, so this is the shipping default.
    const out = toolText(await tool.run({
      to: "team@example.com",
      subject: "Weekly update",
      body: "All good.",
    }));
    assert.match(out, /DRY RUN/);
    assert.match(out, /Subject: Weekly update/);
  });

  test("the dry run writes a readable .eml so it can be checked", async () => {
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
    assert.match(out, /DRY RUN/, "should have been allowed through to the dry run");
  });

  test("rejects a malformed address and an empty subject", async () => {
    assert.match(toolText(await tool.run({ to: "not-an-address", subject: "x", body: "y" })), /not an email/);
    assert.match(
      toolText(await tool.run({ to: "team@example.com", subject: "", body: "y" })),
      /no subject/,
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

describe("desktop control", () => {
  test("nothing that changes the machine is available unless enabled", () => {
    // The gate is about irreversibility, not about touching apps at all.
    // AppleScript composed by the model can send, delete and reconfigure, so
    // it stays opt-in; a fixed read does not, and gating it identically meant
    // "show my emails" failed by default on a machine that could answer it.
    assert.equal(desktopEnabled(), false);

    const offered = desktopTools.map((t) => t.name);
    for (const mutating of ["run_applescript", "take_screenshot", "propose_plan"]) {
      assert.ok(!offered.includes(mutating), `${mutating} must stay behind ENIO_DESKTOP`);
    }
    // Whatever is offered must be reversible and closed-list. open_app sits
    // here deliberately: the gate is about irreversibility, and opening an
    // app is undone by quitting it -- while the name it launches resolves
    // against the system's installed-apps list, never model text.
    assert.deepEqual(offered, ["mac_recipe", "open_app"]);
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
