import { readFile } from "node:fs/promises";

/**
 * PDF text extraction, via unpdf (pdf.js without workers or the DOM).
 *
 * This exists because a PDF read as UTF-8 is not an error, it is *garbage in
 * the prompt*: compressed streams decode to pages of mojibake that burn the
 * context budget and prime the model to invent what the document "must" say.
 * The user's resume came back confidently wrong for exactly that reason.
 * Binary content must either become real text here or an honest refusal --
 * never bytes.
 *
 * Pure JS, no network at runtime (the invariant OCR already obeys), and it
 * degrades: a failure returns null and the caller says what it could not do.
 */

export function looksLikePdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString("latin1").startsWith("%PDF");
}

export interface PdfText {
  pages: number;
  /** Joined text of every page. Empty when the PDF has no text layer --
   *  a scan -- which callers should say, because "empty" and "unreadable"
   *  invite different next steps. */
  text: string;
}

export async function extractPdfText(path: string): Promise<PdfText | null> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const buffer = await readFile(path);
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    return { pages: totalPages, text: (text as string).trim() };
  } catch {
    return null;
  }
}
