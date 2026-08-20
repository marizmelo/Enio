import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "enio-bg-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "builtin-skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-such-mcp.json");
// Long enough for a doomed command to die inside the window, short enough
// that the suite does not wait on it.
process.env.ENIO_BACKGROUND_SETTLE_MS = "700";

const { mkdirSync } = await import("node:fs");
mkdirSync(process.env.ENIO_WORKSPACE!, { recursive: true });

const { shellTools, backgroundCommands, stopAllBackground, stopBackgroundCommand } = await import(
  "./tools/shell.js"
);
const run = shellTools.find((t) => t.name === "run_command")!;

after(() => {
  stopAllBackground();
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Starting something and leaving it running.
 *
 * A web server never exits, so the ordinary path spends the whole shell
 * timeout and then SIGKILLs the thing it was asked to start — which is why a
 * page could be written and never tested. What has to be true of the
 * replacement: a command that dies is reported dead rather than started, a
 * server that binds the world is refused, and nothing outlives the process.
 */
describe("run_command in the background", () => {
  test("a command that keeps running is reported started, with its pid", async () => {
    const out = String(await run.run({ command: "node -e \"setInterval(()=>{},1000)\"", background: true }));
    assert.match(out, /Started in the background \(pid \d+\)/);
    assert.equal(backgroundCommands().length, 1);
    stopAllBackground();
    assert.equal(backgroundCommands().length, 0);
  });

  test("a command that dies immediately says so, and is not tracked", async () => {
    // The failure this prevents: reporting "started" for a server whose port
    // was taken, so the next call curls nothing and blames the page.
    const out = String(await run.run({ command: "node -e \"process.exit(3)\"", background: true }));
    assert.match(out, /Exited immediately with code 3/);
    assert.match(out, /not running/);
    assert.equal(backgroundCommands().length, 0);
  });

  test("its output is captured, not lost", async () => {
    const out = String(
      await run.run({ command: "node -e \"console.log('listening on 8123');setInterval(()=>{},1000)\"", background: true }),
    );
    assert.match(out, /listening on 8123/);
    stopAllBackground();
  });

  test("the allowlist still applies", async () => {
    const out = String(await run.run({ command: "rm -rf /", background: true }));
    assert.match(out, /^Refused:/);
    assert.equal(backgroundCommands().length, 0);
  });

  test("http.server bound to the world is refused, naming the flag", async () => {
    // Its default is 0.0.0.0, which puts the served folder on the local
    // network. The refusal names the fix rather than adding it silently:
    // the trace has to show what actually ran.
    const wide = String(await run.run({ command: "python3 -m http.server 8123", background: true }));
    assert.match(wide, /Refused/);
    assert.match(wide, /--bind 127\.0\.0\.1/);
    assert.equal(backgroundCommands().length, 0);
  });

  test("only a handful run at once — the oldest is replaced", async () => {
    for (let i = 0; i < 4; i++) {
      await run.run({ command: `node -e "setInterval(()=>{},1000)" # ${i}`, background: true });
    }
    const live = backgroundCommands();
    assert.equal(live.length, 3, "the cap holds");
    assert.ok(!live.some((c) => c.command.endsWith("# 0")), "the oldest was the one dropped");
    stopAllBackground();
  });

  test("without the flag, a long command is still bounded by the timeout", async () => {
    // Not re-testing the timeout itself (60s) — only that background is opt
    // in, so nothing starts persisting by accident.
    writeFileSync(join(process.env.ENIO_WORKSPACE!, "quick.js"), "console.log('done');\n");
    const out = String(await run.run({ command: "node quick.js" }));
    assert.match(out, /done/);
    assert.equal(backgroundCommands().length, 0);
  });
});

/**
 * The list and the stop button are what make this the user's capability
 * rather than the model's. The model has no route to either: it cannot see
 * what is running and cannot kill anything, because process control is
 * exactly what a small model should not hold.
 */
describe("what the user can see and stop", () => {
  test("a running command is listed with what it is and where it runs", async () => {
    await run.run({ command: "node -e \"console.log('up on 8123');setInterval(()=>{},1000)\"", background: true });
    const [only] = backgroundCommands();
    assert.ok(only, "nothing listed");
    assert.match(only.command, /console\.log/);
    assert.equal(typeof only.pid, "number");
    assert.ok(only.startedAt <= Date.now());
    assert.ok(only.cwd.length > 0, "where it runs is part of the answer");
    // The first line a server prints is usually "is it up, and on what port".
    assert.match(only.output, /up on 8123/);
    stopAllBackground();
  });

  test("stopping one takes it off the list; stopping something else is refused", async () => {
    await run.run({ command: 'node -e "setInterval(()=>{},1000)"', background: true });
    const [only] = backgroundCommands();
    assert.ok(only, "nothing to stop");
    assert.equal(stopBackgroundCommand(only.pid), true);
    assert.equal(backgroundCommands().length, 0);
    // Not a general-purpose kill: a pid enio did not start is not enio's to
    // signal, whatever asks.
    assert.equal(stopBackgroundCommand(process.pid), false);
    assert.equal(stopBackgroundCommand(only.pid), false, "and stopping twice is not a second kill");
  });

  test("no tool can list or stop them", async () => {
    // The capability is deliberately one-way: an agent may start something,
    // and only a person may see the inventory or end it.
    const { buildRegistry } = await import("./tools/index.js");
    const registry = await buildRegistry();
    const names = registry.all.map((t) => t.name);
    for (const name of names) {
      assert.ok(!/(^|_)(kill|ps|processes)(_|$)/.test(name), `${name} looks like process control`);
    }
    assert.ok(!names.includes("list_commands"));
    assert.ok(!names.includes("stop_command"));
  });
});
