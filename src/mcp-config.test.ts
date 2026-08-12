import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "enio-mcp-config-"));
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "mcp", "mcp.json");
mkdirSync(process.env.ENIO_WORKSPACE, { recursive: true });
mkdirSync(process.env.ENIO_DATA_DIR, { recursive: true });

const mcp = await import("./mcp-config.js");
const { loadMcpTools, mcpStatus } = await import("./tools/mcp.js");

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("add, list, disable, remove round-trip; the config dir is created", () => {
  assert.equal(mcp.mcpConfigExists(), false);
  mcp.addServer("notes", { command: "npx", args: ["-y", "some-server"], tools: ["read"] });
  assert.equal(mcp.mcpConfigExists(), true);

  let { servers } = mcp.readMcpConfig();
  assert.deepEqual(servers.notes, { command: "npx", args: ["-y", "some-server"], tools: ["read"] });

  mcp.setServerDisabled("notes", true);
  assert.equal(mcp.readMcpConfig().servers.notes!.disabled, true);

  mcp.removeServer("notes");
  assert.equal(Object.keys(mcp.readMcpConfig().servers).length, 0);
});

test("unknown fields survive an edit round-trip", () => {
  // Another client's extension or a future option must not be eaten by an
  // editor that only knows today's shape.
  writeFileSync(
    process.env.ENIO_MCP_CONFIG!,
    JSON.stringify({
      someFutureOption: { keep: "me" },
      mcpServers: {
        existing: { command: "cmd", customField: 42 },
      },
    }),
  );
  mcp.addServer("added", { command: "other" });
  const raw = JSON.parse(readFileSync(process.env.ENIO_MCP_CONFIG!, "utf8"));
  assert.deepEqual(raw.someFutureOption, { keep: "me" });
  assert.equal(raw.mcpServers.existing.customField, 42);
  mcp.removeServer("added");
});

test("name validation refuses what would break wire tool names", () => {
  for (const bad of ["", "a b", "-x", "x".repeat(41), "semi;colon"]) {
    assert.throws(() => mcp.addServer(bad, { command: "cmd" }), /Invalid server name|needs a command/);
  }
  assert.throws(() => mcp.addServer("ok", { command: "  " }), /needs a command/);
  // Leading digit and underscores are fine.
  mcp.addServer("9lives_ok", { command: "cmd" });
  assert.throws(() => mcp.addServer("9lives_ok", { command: "cmd" }), /already exists/);
  mcp.removeServer("9lives_ok");
});

test("writes are atomic: no .tmp file left behind", () => {
  mcp.addServer("tmpcheck", { command: "cmd" });
  assert.equal(existsSync(`${process.env.ENIO_MCP_CONFIG}.tmp`), false);
  mcp.removeServer("tmpcheck");
});

test("status is honest: an unreachable command reports its error, and reloads do not stack connections", async () => {
  mcp.addServer("broken", { command: "/no/such/binary-anywhere" });
  await loadMcpTools();
  let status = mcpStatus().find((s) => s.name === "broken");
  assert.ok(status, "the configured server appears in status");
  assert.equal(status!.connected, false);
  assert.ok(status!.error, "the failure carries its reason");

  // The leak regression: a second load must not report the server twice —
  // loadMcpTools closes what the previous load opened and rebuilds status
  // from scratch.
  await loadMcpTools();
  assert.equal(mcpStatus().filter((s) => s.name === "broken").length, 1);

  mcp.setServerDisabled("broken", true);
  await loadMcpTools();
  status = mcpStatus().find((s) => s.name === "broken");
  assert.equal(status!.disabled, true);
  assert.equal(status!.connected, false);
  mcp.removeServer("broken");
});
