import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { toolText } from "./types.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const scratch = mkdtempSync(join(tmpdir(), "enio-vision-"));
process.env.ENIO_DATA_DIR = join(scratch, "data");
process.env.ENIO_WORKSPACE = join(scratch, "workspace");
process.env.ENIO_MCP_CONFIG = join(scratch, "none.json");
process.env.ENIO_VISION_MODE = "auto";

const vision = await import("./vision.js");
const { visionTools } = await import("./tools/vision.js");

after(() => rmSync(scratch, { recursive: true, force: true }));

const workspace = () => process.env.ENIO_WORKSPACE!;

/** A real PNG, built by hand so the header parser is tested against bytes. */
function writePng(path: string, width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xff)])),
  );
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

before(() => {
  mkdirSync(workspace(), { recursive: true });
  writePng(join(workspace(), "shot.png"), 1280, 720);
  writePng(join(workspace(), "tiny.png"), 16, 9);
  writeFileSync(join(workspace(), "notes.txt"), "not an image");
});

describe("image detection", () => {
  test("recognises image extensions, case-insensitively", () => {
    for (const name of ["a.png", "b.JPG", "c.jpeg", "d.WebP", "e.gif"]) {
      assert.equal(vision.isImage(name), true, `${name} should be an image`);
    }
  });

  test("rejects everything else", () => {
    for (const name of ["a.txt", "b.md", "c.pdf", "d", "e.png.txt"]) {
      assert.equal(vision.isImage(name), false, `${name} should not be an image`);
    }
  });
});

describe("metadata from the file header", () => {
  test("reads PNG dimensions without decoding the image", async () => {
    const meta = await vision.imageMetadata(join(workspace(), "shot.png"));
    assert.equal(meta.width, 1280);
    assert.equal(meta.height, 720);
    assert.equal(meta.format, "png");
    assert.ok(meta.bytes > 0);
  });

  test("handles a tiny image", async () => {
    const meta = await vision.imageMetadata(join(workspace(), "tiny.png"));
    assert.equal(meta.width, 16);
    assert.equal(meta.height, 9);
  });

  test("still reports size for a format it can't measure", async () => {
    // JPEG dimensions need a marker scan; size and format are still useful.
    const jpeg = join(workspace(), "photo.jpg");
    writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
    const meta = await vision.imageMetadata(jpeg);
    assert.equal(meta.format, "jpg");
    assert.ok(meta.bytes > 0);
    assert.equal(meta.width, undefined);
  });
});

describe("degradation", () => {
  test("off mode reports dimensions and nothing else", async () => {
    const reading = await vision.readImage(join(workspace(), "shot.png"), undefined, "off");
    assert.equal(reading.method, "metadata");
    assert.match(reading.text, /1280×720/);
  });

  test("ocr mode can be forced for one image", async () => {
    // Worth having: on a dense document, OCR beats whatever a small VLM says.
    const reading = await vision.readImage(join(workspace(), "shot.png"), undefined, "ocr");
    assert.equal(reading.method, "ocr");
  });

  test("auto mode always returns something rather than throwing", async () => {
    // There is no Ollama here, so this exercises the fall-through. An
    // attachment must never be able to fail the whole turn.
    const reading = await vision.readImage(join(workspace(), "shot.png"));
    assert.ok(reading.text.length > 0);
    assert.match(reading.text, /1280×720/, "dimensions are always available");
    assert.ok(["vlm", "ocr", "metadata"].includes(reading.method));
  });

  test("the reading names its own method so trust can be calibrated", async () => {
    // An OCR dump and a small VLM's description warrant different confidence.
    const reading = await vision.readImage(join(workspace(), "tiny.png"));
    assert.ok(reading.method);
  });
});

describe("OCR is genuinely offline", () => {
  test("language data resolves to a local file, not a URL", () => {
    const dir = vision.langPath();
    assert.ok(dir, "language data should be found in node_modules");
    assert.ok(!dir!.startsWith("http"), `must not be a URL: ${dir}`);
    assert.ok(
      existsSync(join(dir!, "eng.traineddata.gz")),
      "the traineddata file must exist on disk",
    );
  });

  test("reports ready without any network access", async () => {
    assert.equal(await vision.ocrAvailable(), true);
  });

  test("runs OCR with fetch disabled entirely", async () => {
    // The real guarantee. If anything reaches for a CDN this throws, and the
    // whole point of shipping the language data as a dependency is that
    // nothing does.
    const originalFetch = globalThis.fetch;
    let attempted: string | null = null;
    globalThis.fetch = (async (url: unknown) => {
      attempted = String(url);
      throw new Error("network disabled for this test");
    }) as typeof fetch;

    try {
      const text = await vision.ocrImage(join(workspace(), "shot.png"));
      assert.equal(typeof text, "string");
      assert.equal(attempted, null, `something tried to fetch ${attempted}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("read_image tool", () => {
  const tool = visionTools.find((t) => t.name === "read_image")!;

  test("returns text for a valid image", async () => {
    const out = toolText(await tool.run({ path: "shot.png" }));
    assert.match(out, /1280×720/);
  });

  test("explains itself when handed a non-image", async () => {
    const out = toolText(await tool.run({ path: "notes.txt" }));
    assert.match(out, /not an image/);
    assert.match(out, /read_file/, "should point at the right tool");
  });

  test("refuses to escape the workspace", async () => {
    assert.match(toolText(await tool.run({ path: "../../../etc/shadow.png" })), /escapes the workspace/);
  });

  test("handles a missing file without throwing", async () => {
    assert.match(toolText(await tool.run({ path: "nope.png" })), /Could not read/);
  });

  test("never throws — a bad attachment must not fail the turn", async () => {
    for (const path of ["", "   ", "x".repeat(500) + ".png"]) {
      const out = toolText(await tool.run({ path }));
      assert.equal(typeof out, "string");
      assert.ok(out.length > 0);
    }
  });
});
