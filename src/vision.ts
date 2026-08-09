import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { config } from "./config.js";

/**
 * Reading images, on a machine that cannot afford a second resident model.
 *
 * The constraint that shapes everything here: Maple holds ~6.9GB, and a 16GB
 * Mac has no room for a vision model sitting alongside it indefinitely. So
 * nothing stays loaded.
 *
 *   Tier 0  OCR via tesseract.js — no model at all, pure WASM, nothing
 *           resident between calls. Handles the common case, which is a
 *           screenshot of text.
 *   Tier 1  A small VLM through Ollama, loaded on demand and unloaded the
 *           instant it answers via keep_alive: 0.
 *
 * Peak memory is therefore Maple + the VLM for the few seconds of a single
 * call — about 8.6GB with moondream — falling straight back to 6.9GB. Nothing
 * accumulates.
 *
 * The other half of the design: the main model never becomes multimodal.
 * Images are turned into text before Maple sees anything, so a text-only model
 * handles them fine and swapping the vision model changes nothing upstream.
 */

export type VisionMode = "auto" | "ocr" | "vlm" | "off";

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];

export const isImage = (path: string) =>
  IMAGE_EXTENSIONS.includes(extname(path).toLowerCase());

/** Ollama's own endpoint, which is where keep_alive lives — /v1 doesn't take it. */
function ollamaRoot(): string {
  return (config.visionBaseUrl || "http://127.0.0.1:11434").replace(/\/v1\/?$/, "");
}

export interface ImageReading {
  text: string;
  method: "vlm" | "ocr" | "metadata";
  note?: string;
}

/**
 * Dimensions straight from the file header.
 *
 * Costs nothing and is worth having even when no model is available — knowing
 * a file is a 3840x2160 PNG is often enough to answer the question, and it
 * gives an "off" mode something useful to say.
 */
export async function imageMetadata(
  path: string,
): Promise<{ width?: number; height?: number; bytes: number; format: string }> {
  const info = await stat(path);
  const head = (await readFile(path)).subarray(0, 64);
  const format = extname(path).slice(1).toLowerCase();

  // PNG: IHDR width/height are big-endian at bytes 16 and 20.
  if (head[0] === 0x89 && head[1] === 0x50) {
    return {
      width: head.readUInt32BE(16),
      height: head.readUInt32BE(20),
      bytes: info.size,
      format: "png",
    };
  }
  // GIF: little-endian at byte 6.
  if (head[0] === 0x47 && head[1] === 0x49) {
    return {
      width: head.readUInt16LE(6),
      height: head.readUInt16LE(8),
      bytes: info.size,
      format: "gif",
    };
  }
  // JPEG dimensions live in a variable-position SOF marker, which needs a real
  // scan; not worth it when the model is about to look at the image anyway.
  return { bytes: info.size, format };
}

async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaRoot()}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function visionModelAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaRoot()}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: { name?: string }[] };
    const wanted = config.visionModel.toLowerCase();
    return (data.models ?? []).some((m) => {
      const name = (m.name ?? "").toLowerCase();
      return name === wanted || name.split(":")[0] === wanted.split(":")[0];
    });
  } catch {
    return false;
  }
}

/**
 * Ask a vision model about an image, then let it go.
 *
 * No resizing: Ollama preprocesses to the model's own input resolution, so
 * doing it here would add an image-processing dependency to duplicate work
 * that already happens downstream.
 */
export async function describeWithVlm(path: string, question?: string): Promise<string> {
  const image = (await readFile(path)).toString("base64");

  const res = await fetch(`${ollamaRoot()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.visionModel,
      messages: [
        {
          role: "user",
          content:
            question ||
            "Describe this image in detail. If it contains text, transcribe it exactly.",
          images: [image],
        },
      ],
      stream: false,
      // The whole memory strategy, in one field: unload the moment it answers.
      keep_alive: config.visionKeepAlive,
      options: { temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(config.visionTimeoutMs),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`vision model returned ${res.status}. ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { message?: { content?: string } };
  return (data.message?.content ?? "").trim();
}

/**
 * OCR with no model at all.
 *
 * tesseract.js is WASM, loads its language data once (~15MB, cached), and holds
 * nothing between calls. On a memory-constrained machine this is the only
 * option that is always affordable, and for the most common attachment — a
 * screenshot of an error or a document — it is also the more accurate one.
 * Small VLMs are specifically weak at dense text.
 */
/**
 * Where the OCR language data lives on disk.
 *
 * tesseract.js defaults to fetching this from a CDN at first use, which is
 * indefensible in something that claims to run entirely on your machine: it
 * fails on a plane, on an air-gapped box, and whenever jsDelivr has a bad day.
 *
 * The data is published to npm as @tesseract.js-data/eng in exactly the layout
 * tesseract expects, so it is a normal dependency installed once by npm and
 * read from node_modules thereafter. No request is ever made at runtime.
 *
 * ENIO_TESSERACT_LANG_PATH overrides it, for a shared or trimmed copy.
 */
export function langPath(): string | null {
  if (config.tesseractLangPath) return config.tesseractLangPath;
  try {
    const require = createRequire(import.meta.url);
    // "_best_int" is the integerised model: 2.9MB against 11MB for the full
    // one, with no meaningful accuracy loss for screen text.
    const pkg = require.resolve("@tesseract.js-data/eng/package.json");
    return join(dirname(pkg), "4.0.0_best_int");
  } catch {
    return null;
  }
}

/**
 * Whether OCR can actually run.
 *
 * Checked up front rather than caught, because tesseract.js reports a missing
 * language file by throwing from inside a worker event handler — that escapes
 * the promise chain entirely, so an await around it catches nothing and the
 * process dies.
 */
export async function ocrAvailable(): Promise<boolean> {
  const dir = langPath();
  return Boolean(dir && existsSync(join(dir, "eng.traineddata.gz")));
}

export async function ocrImage(path: string): Promise<string> {
  const { createWorker } = await import("tesseract.js");

  // Language data is fetched from a CDN on first use and cached. Pointing the
  // cache at the data directory keeps it out of the working directory and
  // means it is downloaded exactly once — after which OCR is fully offline.
  const dir = langPath();
  if (!dir) {
    throw new Error(
      "OCR language data is missing. Reinstall dependencies: npm install",
    );
  }

  const worker = await createWorker("eng", 1, {
    langPath: dir,
    cachePath: join(config.dataDir, "tesseract"),
    // Belt and braces: without a language file this would silently reach for
    // the CDN, which is the entire thing we are avoiding.
    gzip: true,
  });

  try {
    const { data } = await worker.recognize(path);
    return (data.text ?? "").trim();
  } finally {
    // Must terminate: the worker holds the WASM heap open otherwise.
    await worker.terminate();
  }
}

/**
 * The entry point. Picks a method by what's actually available rather than
 * failing when the ideal one isn't.
 */
export async function readImage(
  path: string,
  question?: string,
  /** Overrides the configured mode for one call — forcing OCR on a dense
   *  document is often better than whatever the VLM would have said. */
  modeOverride?: VisionMode,
): Promise<ImageReading> {
  const mode = modeOverride ?? (config.visionMode as VisionMode);
  const meta = await imageMetadata(path);
  const dimensions =
    meta.width && meta.height ? `${meta.width}×${meta.height} ` : "";
  const header = `[${dimensions}${meta.format}, ${Math.round(meta.bytes / 1024)}KB]`;

  if (mode === "off") {
    return { text: header, method: "metadata", note: "vision is disabled" };
  }

  if (mode === "ocr") {
    if (!(await ocrAvailable())) {
      throw new Error(
        `OCR language data is not available and cannot be downloaded.\n` +
          `Connect once to cache it, or set ENIO_TESSERACT_LANG_PATH to a local folder.`,
      );
    }
    const text = await ocrImage(path);
    return {
      text: `${header}\n\n${text || "(no text found in this image)"}`,
      method: "ocr",
    };
  }

  const canUseVlm =
    mode === "vlm" || mode === "auto"
      ? (await ollamaReachable()) && (await visionModelAvailable())
      : false;

  if (canUseVlm) {
    try {
      const description = await describeWithVlm(path, question);
      if (description) return { text: `${header}\n\n${description}`, method: "vlm" };
    } catch (err) {
      if (mode === "vlm") throw err;
      // In auto mode a VLM failure is not fatal — OCR still gets the text out.
    }
  }

  if (mode === "vlm") {
    throw new Error(
      `Vision model "${config.visionModel}" unavailable.\n` +
        `  ollama pull ${config.visionModel}\n` +
        `Or set ENIO_VISION_MODE=ocr to use text extraction only.`,
    );
  }

  // Last resort. Checked rather than attempted, because a tesseract failure
  // takes the whole process down instead of raising something catchable.
  if (await ocrAvailable()) {
    try {
      const text = await ocrImage(path);
      return {
        text: `${header}\n\n${text || "(no text found; no vision model available to describe it)"}`,
        method: "ocr",
        // Actionable, because the person reading it is the only one who can
        // act on it. Nothing is downloaded on their behalf: a 1.7GB pull is
        // not something to start because someone pasted a screenshot.
        note: canUseVlm
          ? undefined
          : `Read with OCR — text only, nothing about what the image looks like. ` +
            `For descriptions: ollama pull ${config.visionModel}`,
      };
    } catch (err) {
      return {
        text: `${header}\n\n(OCR failed: ${(err as Error).message})`,
        method: "metadata",
      };
    }
  }

  // Dimensions are a poor answer, but they are an answer, and returning one
  // beats failing the turn over an attachment.
  return {
    text:
      `${header}\n\n(no way to read this image right now)\n` +
      `A vision model would describe it:  ollama pull ${config.visionModel}\n` +
      `OCR data appears to be missing — try: npm install`,
    method: "metadata",
    note: "neither a vision model nor OCR is available",
  };
}

/** Reported by `enio vision` so the setup is checkable without guessing. */
export async function visionStatus(): Promise<{
  mode: string;
  model: string;
  ollamaReachable: boolean;
  modelPulled: boolean;
  ocrReady: boolean;
}> {
  const reachable = await ollamaReachable();
  return {
    mode: config.visionMode,
    model: config.visionModel,
    ollamaReachable: reachable,
    modelPulled: reachable ? await visionModelAvailable() : false,
    ocrReady: await ocrAvailable(),
  };
}
