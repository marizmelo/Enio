import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-handoffs-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });

const handoffs = await import("./handoffs.js");

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A stand-in agent: a shell script standing where a real CLI would. */
function fakeAgent(script: string): { bin: string; args: string[] } {
  const bin = join(scratch, `agent-${Math.random().toString(36).slice(2, 8)}.sh`);
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return { bin, args: [] };
}

const workspace = () => process.env.ENIO_WORKSPACE!;

function writeHandoff(name: string, body = "# Handoff: Test\n\nThe task."): string {
  writeFileSync(join(workspace(), name), body);
  return name;
}

async function settled(id: string) {
  for (let i = 0; i < 300; i++) {
    const run = handoffs.handoffRun(id);
    if (run && run.status !== "running") return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("run never settled");
}

describe("handoff runs", () => {
  test("stdout becomes an answer file named after the handoff and the agent", async () => {
    const file = writeHandoff("handoff-quarterly-memo.md");
    // The fake echoes stdin back upper-cased — proof the PROMPT travelled.
    const agent = fakeAgent(`tr '[:lower:]' '[:upper:]'`);
    const run = handoffs.startHandoffRun(file, "claude", { resolve: () => agent });
    const done = await settled(run.id);
    assert.equal(done.status, "done");
    assert.equal(done.answerFile, "answer-quarterly-memo-claude.md");
    const saved = readFileSync(join(workspace(), done.answerFile!), "utf8");
    assert.match(saved, /THE TASK/);
  });

  test("a failing agent surfaces its own stderr, not a generic shrug", async () => {
    const file = writeHandoff("handoff-fails.md");
    const agent = fakeAgent(`echo "auth expired, run login" >&2; exit 1`);
    const run = handoffs.startHandoffRun(file, "claude", { resolve: () => agent });
    const done = await settled(run.id);
    assert.equal(done.status, "failed");
    assert.match(done.error!, /auth expired/);
    assert.ok(!done.answerFile);
  });

  test("an agent that says nothing is a failure, not an empty answer file", async () => {
    const file = writeHandoff("handoff-silent.md");
    const agent = fakeAgent(`exit 0`);
    const run = handoffs.startHandoffRun(file, "claude", { resolve: () => agent });
    const done = await settled(run.id);
    assert.equal(done.status, "failed");
    assert.match(done.error!, /returned nothing/);
  });

  test("a hung agent is killed at the deadline", async () => {
    const file = writeHandoff("handoff-hangs.md");
    const agent = fakeAgent(`sleep 30`);
    const run = handoffs.startHandoffRun(file, "claude", {
      resolve: () => agent,
      timeoutMs: 100,
    });
    const done = await settled(run.id);
    assert.equal(done.status, "failed");
    assert.equal(done.error, "timed out");
  });

  test("unknown agents and missing CLIs are refused before anything spawns", () => {
    const file = writeHandoff("handoff-refusals.md");
    assert.throws(
      () => handoffs.startHandoffRun(file, "skynet"),
      handoffs.HandoffRefused,
    );
    assert.throws(
      () => handoffs.startHandoffRun(file, "claude", { resolve: () => null }),
      /not installed/,
    );
    assert.throws(
      () => handoffs.startHandoffRun("no-such-handoff.md", "claude", { resolve: () => fakeAgent("cat") }),
      /No such file/,
    );
  });

  test("the same file cannot be sent to the same agent twice at once", async () => {
    const file = writeHandoff("handoff-concurrent.md");
    const slow = fakeAgent(`sleep 1; cat`);
    const run = handoffs.startHandoffRun(file, "claude", { resolve: () => slow });
    assert.throws(
      () => handoffs.startHandoffRun(file, "claude", { resolve: () => slow }),
      /already running/,
    );
    handoffs.cancelHandoffRun(run.id);
    const done = await settled(run.id);
    assert.equal(done.error, "cancelled");
  });

  test("a second answer dedupes instead of overwriting the first", async () => {
    const file = writeHandoff("handoff-twice.md");
    const agent = fakeAgent(`cat`);
    const first = handoffs.startHandoffRun(file, "claude", { resolve: () => agent });
    await settled(first.id);
    const second = handoffs.startHandoffRun(file, "claude", { resolve: () => agent });
    const done = await settled(second.id);
    assert.equal(done.answerFile, "answer-twice-claude-2.md");
    assert.ok(existsSync(join(workspace(), "answer-twice-claude.md")));
  });
});

test("an auth wall on stdout with exit 0 is a failure with sign-in guidance, not an answer", async () => {
  const file = writeHandoff("handoff-authwall.md");
  // claude's real behavior when signed out: the message goes to STDOUT and
  // the exit code is 0 — saved verbatim, it would read as the reply.
  const agent = fakeAgent(`echo "Not logged in · Please run /login"`);
  const run = handoffs.startHandoffRun(file, "claude", { resolve: () => agent });
  const done = await settled(run.id);
  assert.equal(done.status, "failed");
  assert.match(done.error!, /not signed in/i);
  assert.ok(!done.answerFile);
});

test("sign-in writes a .command that execs the resolved CLI, and launches it", async () => {
  let opened = "";
  const file = await handoffs.openSignin("claude", {
    resolve: () => ({ bin: "/fake/bin/claude" }),
    launch: (f) => {
      opened = f;
    },
  });
  assert.equal(opened, file);
  assert.match(file, /signin-claude\.command$/);
  const body = readFileSync(file, "utf8");
  assert.match(body, /^#!\/bin\/sh/);
  // Sign-in and headless runs share one empty cwd, so a folder-trust
  // prompt answered here covers every later run — and covers nothing.
  assert.match(body, /cd ".*agent-scratch" \|\| exit 1/);
  assert.match(body, /exec "\/fake\/bin\/claude"/);
  const { statSync } = await import("node:fs");
  assert.ok(statSync(file).mode & 0o100, "executable");
  await assert.rejects(() => handoffs.openSignin("skynet"), handoffs.HandoffRefused);
});
