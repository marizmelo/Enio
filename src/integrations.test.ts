import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
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
    const out = await tool.run({
      to: "team@example.com",
      subject: "Weekly update",
      body: "All good.",
    });
    assert.match(out, /DRY RUN/);
    assert.match(out, /Subject: Weekly update/);
  });

  test("the dry run writes a readable .eml so it can be checked", async () => {
    await tool.run({ to: "team@example.com", subject: "Check me", body: "Body text." });
    const drafts = readdirSync(process.env.ENIO_WORKSPACE!).filter((f) => f.endsWith(".eml"));
    assert.ok(drafts.length > 0, "a draft file should exist");
  });

  test("enforces the recipient allowlist", async () => {
    const out = await tool.run({
      to: "stranger@elsewhere.com",
      subject: "Hello",
      body: "Hi",
    });
    assert.match(out, /Refused/);
    assert.match(out, /not in the allowed recipient list/);
  });

  test("a domain rule permits everyone at that domain", async () => {
    const out = await tool.run({ to: "anyone@trusted.org", subject: "Hi", body: "x" });
    assert.match(out, /DRY RUN/, "should have been allowed through to the dry run");
  });

  test("rejects a malformed address and an empty subject", async () => {
    assert.match(await tool.run({ to: "not-an-address", subject: "x", body: "y" }), /not an email/);
    assert.match(
      await tool.run({ to: "team@example.com", subject: "", body: "y" }),
      /no subject/,
    );
  });
});

describe("desktop control", () => {
  test("off unless explicitly enabled", () => {
    // AppleScript can do anything the user can, so this stays opt-in.
    assert.equal(desktopEnabled(), false);
    assert.equal(desktopTools.length, 0, "no desktop tools without ENIO_DESKTOP=1");
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
    assert.ok(operator.tools.includes("run_applescript"));
    assert.ok(operator.tools.includes("send_email"));
    // Disjoint tool sets are the entire reason specialists exist.
    assert.ok(!operator.tools.includes("run_command"), "shell belongs to coder");
    assert.ok(!operator.tools.includes("web_search"), "search belongs to researcher");
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
