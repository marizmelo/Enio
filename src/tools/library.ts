import type { ToolDef } from "../types.js";
import { libraryCategories, libraryRoot, searchLibrary } from "../library.js";

/**
 * The librarian's window into the document library. Results carry the chunk
 * text itself because read_file belongs to the coder and specialists stay
 * disjoint: a hit must be able to answer the question on its own, with the
 * workspace-relative path as provenance the user can @mention to go deeper.
 */
export const libraryTools: ToolDef[] = [
  {
    name: "library_search",
    description:
      "Search the documents in the user's library folders — files they have saved to be searchable, like papers, notes, records, and reference material. Use it when they ask about their saved documents or files. Optionally limit to one category folder.",
    origin: "builtin",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for, in plain words.",
        },
        category: {
          type: "string",
          description:
            "Optional: one of the user's actual library folder names. Omit it unless they named the folder — everything is searched by default.",
        },
      },
      required: ["query"],
    },
    async run(args) {
      const query = String(args.query ?? "").trim();
      if (!query) return "Give library_search a query to look for.";

      let category = args.category ? String(args.category).trim() : undefined;
      let note = "";
      if (category) {
        // The category list is closed, but an unknown name degrades to an
        // unscoped search rather than refusing: a live trace showed the 4B
        // inventing "lease agreements", then "lease", and giving up after two
        // refusals -- the answer sitting unread in the personal folder the
        // whole time. Results with a correction beat a dead end it retries.
        const known = libraryCategories().map((c) => c.name);
        if (!known.includes(category)) {
          note =
            `(No category named "${category}"` +
            (known.length ? ` — the folders are: ${known.join(", ")}` : "") +
            `; searched the whole library instead.)\n\n`;
          category = undefined;
        }
      }

      // Four hits, not eight: chunks are ~1800 chars and tool output clips at
      // 8000, so more would be silently truncated -- and every hit returned
      // is also a cited source, where seven weak rows bury the real one.
      const hits = await searchLibrary(query, { category, limit: 4 });
      if (hits.length === 0) {
        return (
          note +
          `Nothing in the library matches "${query}"` +
          (category ? ` in ${category}` : "") +
          `. Files dropped into ${libraryRoot()} become searchable; subfolders are categories.`
        );
      }
      return (
        note +
        hits.map((h) => `[${h.category}] ${h.path}\n${h.text.trim()}`).join("\n\n---\n\n")
      );
    },
  },
];
