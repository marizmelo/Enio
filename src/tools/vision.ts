import type { ToolDef } from "../types.js";
import { readImage, isImage, IMAGE_EXTENSIONS } from "../vision.js";
import { safePath } from "./fs.js";

/**
 * Images reach the model as text, always.
 *
 * That keeps the main model text-only — Maple has no vision path and never
 * needs one — and means the vision model can be swapped, or absent entirely,
 * without anything upstream noticing.
 */
export const visionTools: ToolDef[] = [
  {
    name: "read_image",
    description:
      "Look at an image file in the workspace and get back a description and any text it contains. Use for screenshots, photos, diagrams and scanned documents.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Image path, relative to the workspace." },
        question: {
          type: "string",
          description:
            "Optional. What specifically to look for — 'what error is shown?' gets a far more useful answer than a general description.",
        },
      },
      required: ["path"],
    },
    async run(args) {
      const path = String(args.path ?? "").trim();
      if (!path) return "Error: which image?";

      if (!isImage(path)) {
        return `"${path}" is not an image. Supported: ${IMAGE_EXTENSIONS.join(", ")}. Use read_file for text.`;
      }

      try {
        const result = await readImage(
          safePath(path),
          args.question ? String(args.question) : undefined,
        );
        // Naming the method matters: a small VLM's description and an OCR dump
        // warrant different levels of trust, and the model should know which
        // it is holding.
        const provenance =
          result.method === "ocr"
            ? "\n\n(text extracted by OCR; nothing was visually described)"
            : "";
        // The provenance line above is for the MODEL (how much to trust what
        // it holds); the note is for the USER (why nothing described the
        // picture, and the one command that changes it). Different audiences,
        // different sentences -- see the notice channel in types.ts.
        return { text: `${result.text}${provenance}`, ...(result.note ? { notice: result.note } : {}) };
      } catch (err) {
        return `Could not read the image: ${(err as Error).message}`;
      }
    },
  },
];
