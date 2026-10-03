import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const scratch = mkdtempSync(join(tmpdir(), "enio-portmove-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "no-mcp.json");
process.env.ENIO_BACKEND = "maple";
delete process.env.ENIO_BASE_URL;
delete process.env.MAPLE_BASE_URL;
mkdirSync(join(scratch, "machine"), { recursive: true });
// Written BEFORE config loads: the machine file is the second source.
writeFileSync(join(scratch, "machine", "model.json"), JSON.stringify({ model: "mlx-community/some-4bit", baseUrl: "http://127.0.0.1:8095/v1" }));

const { config, setModelBaseUrl } = await import("./config.js");
const settings = await import("./model-settings.js");
const { freePortFrom, portHolder } = await import("./runtime.js");

after(() => rmSync(scratch, { recursive: true, force: true }));

describe("the model server's address", () => {
  test("resolves explicit env, then the machine file, then the backend default", () => {
    assert.equal(config.modelBaseUrl, "http://127.0.0.1:8095/v1", "the moved address from the machine file");
    setModelBaseUrl("http://127.0.0.1:8096/v1");
    assert.equal(config.modelBaseUrl, "http://127.0.0.1:8096/v1", "a move made in this process wins over the file");
    process.env.ENIO_BASE_URL = "http://127.0.0.1:9000/v1";
    try {
      assert.equal(config.modelBaseUrl, "http://127.0.0.1:9000/v1", "an explicit address is a decision");
    } finally {
      delete process.env.ENIO_BASE_URL;
    }
  });

  test("choosing a model keeps the moved address, and the move can be recorded or cleared", () => {
    settings.setModelId("mlx-community/other-4bit");
    const file = JSON.parse(readFileSync(join(scratch, "machine", "model.json"), "utf8"));
    assert.equal(file.model, "mlx-community/other-4bit");
    assert.equal(file.baseUrl, "http://127.0.0.1:8095/v1", "setModelId must not forget the port");
    assert.equal(settings.machineBaseUrl(), "http://127.0.0.1:8095/v1");
    settings.setMachineBaseUrl(null);
    assert.equal(settings.machineBaseUrl(), null);
    assert.equal(JSON.parse(readFileSync(join(scratch, "machine", "model.json"), "utf8")).model, "mlx-community/other-4bit");
  });

  test("a held port is reported, and the next free one is chosen by binding", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const held = (srv.address() as { port: number }).port;
    try {
      assert.ok(await portHolder(held), "something is listening");
      const chosen = await freePortFrom(held);
      assert.notEqual(chosen, held, "skips the held one");
      assert.ok(chosen > held && chosen < held + 20);
      assert.equal(await portHolder(chosen), null, "and the chosen one is free");
    } finally {
      srv.close();
    }
  });
});
