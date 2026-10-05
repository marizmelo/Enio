import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The avatar file and its routes. Served through a real http server so the
 * streamed body is what a client would receive, byte for byte -- a route
 * that pipes a file has nothing to assert on without one.
 */
const scratch = mkdtempSync(join(tmpdir(), "enio-avatar-"));
process.env.ENIO_DATA_DIR = scratch;
process.env.ENIO_WORKSPACE = join(scratch, "ws");
process.env.ENIO_MACHINE_STATE_DIR = join(scratch, "machine");
process.env.ENIO_MCP_CONFIG = join(scratch, "mcp.json");
process.env.ENIO_BUILTIN_SKILLS = join(scratch, "skills");
// Points at a file that does not exist yet: the explicit path must lose
// quietly while absent and win the moment it appears.
const envGlb = join(scratch, "env.glb");
process.env.ENIO_AVATAR = envGlb;

const avatar = await import("./avatar.js");
const { handle } = await import("./routes/avatar-routes.js");

/** A valid glTF binary header followed by a payload of the given length. */
function fakeGlb(payload: string): Buffer {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "latin1");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

let server: Server;
let base = "";
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const owned = await handle(req, res, url);
    if (!owned) {
      res.writeHead(418);
      res.end("not owned");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(() => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

const dir = () => avatar.avatarDir();
/** The route's JSON, loosely typed: these tests assert on fields, not shapes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();

describe("the avatar file", () => {
  test("nothing installed: status says so and the model is 404", async () => {
    const status = await json(await fetch(`${base}/avatar`));
    assert.deepEqual(
      { installed: status.installed, source: status.source, body: status.body },
      { installed: false, source: null, body: "M" },
    );
    const res = await fetch(`${base}/avatar/model`);
    assert.equal(res.status, 404);
  });

  test("a file named .glb that is not a GLB is not served", async () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), "custom.glb"), "<html>not a model</html>");
    assert.equal(avatar.avatarInstalled(), false);
    assert.equal((await fetch(`${base}/avatar/model`)).status, 404);
    rmSync(join(dir(), "custom.glb"));
  });

  test("the default is streamed byte for byte with a validator, and 304 on a match", async () => {
    const bytes = fakeGlb("default-model-payload");
    writeFileSync(join(dir(), "default.glb"), bytes);
    const res = await fetch(`${base}/avatar/model`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "model/gltf-binary");
    assert.equal(res.headers.get("content-length"), String(bytes.length));
    const got = Buffer.from(await res.arrayBuffer());
    assert.ok(got.equals(bytes), "body differs from the file");
    const etag = res.headers.get("etag");
    assert.ok(etag, "an ETag so the renderer can revalidate for free");
    const again = await fetch(`${base}/avatar/model`, { headers: { "If-None-Match": etag! } });
    assert.equal(again.status, 304);
    const status = await json(await fetch(`${base}/avatar`));
    assert.equal(status.source, "default");
    assert.equal(status.bytes, bytes.length);
  });

  test("a custom file beats the default", async () => {
    const custom = fakeGlb("custom-model-payload-longer");
    const src = join(scratch, "mine.glb");
    writeFileSync(src, custom);
    const status = avatar.useAvatarFile(src);
    assert.equal(status.source, "custom");
    const got = Buffer.from(await (await fetch(`${base}/avatar/model`)).arrayBuffer());
    assert.ok(got.equals(custom));
    assert.equal(avatar.removeAvatar("custom").source, "default", "removing the custom file falls back");
  });

  test("ENIO_AVATAR wins once the file exists, and reports as custom with its path", async () => {
    const env = fakeGlb("env-model");
    writeFileSync(envGlb, env);
    const status = await json(await fetch(`${base}/avatar`));
    assert.equal(status.source, "custom");
    assert.equal(status.path, envGlb);
    const got = Buffer.from(await (await fetch(`${base}/avatar/model`)).arrayBuffer());
    assert.ok(got.equals(env));
    rmSync(envGlb);
  });

  test("use refuses a file that is not a GLB", () => {
    const bad = join(scratch, "bad.glb");
    writeFileSync(bad, "nope");
    assert.throws(() => avatar.useAvatarFile(bad), /not a GLB/);
  });

  test("the body form is a closed list, settable over the route", async () => {
    const bad = await fetch(`${base}/avatar/body`, { method: "POST", body: JSON.stringify({ body: "X" }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/avatar/body`, { method: "POST", body: JSON.stringify({ body: "F" }) });
    assert.equal(ok.status, 200);
    assert.equal((await json(ok)).body, "F");
    assert.equal(avatar.avatarBody(), "F");
  });

  test("paths that try to climb out are not owned by the route", async () => {
    for (const p of ["/avatar/model/../../token", "/avatar/model/%2e%2e/%2e%2e/token", "/avatar/../avatar/model"]) {
      const res = await fetch(`${base}${p}`);
      // The URL either normalises to something that is not ours, or stays
      // a literal path the route does not match; either way, not served.
      if (res.status === 200) {
        assert.equal(new URL(p, base).pathname, "/avatar/model", `${p} was served without being the model route`);
      } else {
        assert.notEqual(res.status, 200, p);
      }
    }
  });
});
