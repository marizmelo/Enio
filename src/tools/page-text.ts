/**
 * A page's markup as the text a person would read off it.
 *
 * `textContent` is the concatenation of a subtree's text nodes and nothing
 * else: what separates two table cells, two list items or two lines on a
 * rendered page is layout, and layout is not in the text. So a minified
 * `<li>Adaptive ANC</li><li>30-hour battery</li>` read back as
 * "Adaptive ANC30-hour battery", and a Wikipedia infobox as
 * "LeagueCampeonato Brasileiro Série ACampeonato Carioca". The model had
 * that as its only evidence, and the grounding check then could not find
 * "LDAC" or "EV" as words and called real names missing.
 *
 * The separators are the ones the HTML standard's innerText gives a rendered
 * page -- a line per block, a tab between cells, a line for <br>, a blank
 * line around a paragraph -- which is also what `browse` already returns,
 * because there Chromium computes it. Here there is no layout to ask, so
 * the element's name stands in for its display.
 *
 * No config and no network: this module is importable on its own, which is
 * what lets its tests run without redirecting an environment.
 */

/** Elements that start and end a line wherever they appear. */
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "caption", "dd", "details", "dialog",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main",
  "menu", "nav", "ol", "optgroup", "option", "pre", "section", "summary", "table",
  "tbody", "tfoot", "thead", "tr", "ul",
]);
const CELL = new Set(["td", "th"]);
/** Never text a reader sees. */
const UNREAD = new Set(["script", "style", "noscript", "template", "head", "svg", "iframe"]);
/** Page furniture, dropped only when asked: Readability has already taken
 *  it out of an article, and a page it declined still has it. */
const CHROME = new Set(["nav", "header", "footer", "aside"]);
/** Where adjacent elements are one token cut up for colour or layout, not
 *  two labels: highlighted code and typeset formulas. */
const VERBATIM = new Set(["pre", "code", "kbd", "samp", "math"]);

/** Separators in order of strength; between two pieces of text the
 *  strongest one asked for wins and the rest are dropped. */
const NONE = 0, SPACE = 1, CELL_GAP = 2, LINE = 3, PARAGRAPH = 4;
const GAP = ["", " ", "\t", "\n", "\n\n"];

const WORD_CHAR = /[\p{L}\p{N}]/u;

interface DomNode {
  nodeType: number;
  localName?: string;
  tagName?: string;
  data?: string;
  textContent?: string | null;
  childNodes?: ArrayLike<DomNode>;
  previousSibling?: DomNode | null;
}

export interface PageTextOptions {
  /** Leave out nav, header, footer and aside. */
  dropChrome?: boolean;
}

/**
 * The readable text of a DOM subtree.
 *
 * Inline markup yields nothing, so "<b>Sam</b>sung" stays one word. The one
 * place an inline boundary yields a space is between two elements with no
 * text at all between them, where each holds more than a character and the
 * seam would otherwise join two words:
 * `<span class="name">Lucid Air</span><span class="trim">Grand Touring</span>`
 * is two labels a stylesheet put on two lines, and it is where "Lucid
 * AirGrand Touring" came from. Markup that splits a word puts text beside
 * the element, not another element.
 */
export function nodeText(root: unknown, options: PageTextOptions = {}): string {
  let out = "";
  let pending = NONE;
  let seam = false;
  // True from a cell's opening until its first text. A block that is the
  // first or last thing in a cell is how the cell was styled, not a line of
  // its own: `<td><div>512 mi</div></td>` must not take its row apart.
  let cellEdge = false;

  const ask = (gap: number) => {
    if (cellEdge && gap >= LINE) return;
    if (gap > pending) pending = gap;
  };
  const write = (text: string) => {
    if (!text) return;
    if (out) {
      if (pending !== NONE) out += GAP[pending];
      else if (seam && WORD_CHAR.test(out[out.length - 1]!) && WORD_CHAR.test(text[0]!)) out += " ";
    }
    out += text;
    pending = NONE;
    seam = false;
    cellEdge = false;
  };

  const walk = (node: DomNode, verbatim: boolean, pre: boolean) => {
    if (node.nodeType === 3) {
      const data = node.data ?? "";
      if (pre) {
        // Indentation and line breaks are the content here.
        write(data);
        return;
      }
      const flat = data.replace(/\s+/g, " ");
      if (flat === " " || flat === "") {
        if (flat) ask(SPACE);
        return;
      }
      if (flat.startsWith(" ")) ask(SPACE);
      write(flat.trim());
      if (flat.endsWith(" ")) ask(SPACE);
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;

    const tag = (node.localName ?? node.tagName ?? "").toLowerCase();
    if (UNREAD.has(tag)) return;
    if (options.dropChrome && CHROME.has(tag)) {
      ask(LINE);
      return;
    }
    if (tag === "br") {
      ask(LINE);
      return;
    }

    const gap = tag === "p" ? PARAGRAPH : BLOCK.has(tag) ? LINE : NONE;
    // Superscripts and subscripts belong to what they follow ("mc²"), and a
    // one-character element is a letter of a word, not a label: a heading
    // animated letter by letter must not come back spelled out.
    const opensSeam =
      !gap && !verbatim && tag !== "sup" && tag !== "sub" && isLabel(node.previousSibling) && isLabel(node);
    if (gap) ask(gap);
    else if (opensSeam) seam = true;

    const cell = CELL.has(tag);
    const before = out.length;
    if (cell) cellEdge = true;

    const inside = verbatim || VERBATIM.has(tag);
    const kids = node.childNodes;
    if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]!, inside, pre || tag === "pre");

    if (cell) {
      cellEdge = false;
      // Whatever is pending after the cell's last text was asked by a block
      // closing inside it.
      if (out.length > before && pending >= LINE) pending = CELL_GAP;
      ask(CELL_GAP);
    }
    if (gap) ask(gap);
    // A seam nothing inside used must not reach the text after the element.
    if (opensSeam) seam = false;
  };

  walk(root as DomNode, false, false);
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** An element holding more than one character of text. */
function isLabel(node: DomNode | null | undefined): boolean {
  if (!node || node.nodeType !== 1) return false;
  return (node.textContent ?? "").trim().length > 1;
}

/* ---------- without a DOM ----------------------------------------------- */

const BLOCK_TAG = new RegExp(`<\\/?(?:br|${[...BLOCK].join("|")})\\b[^>]*>`, "gi");
const PARAGRAPH_TAG = /<\/?p\b[^>]*>/gi;
const CELL_TAG = /<\/(?:td|th)\s*>/gi;

/**
 * The same reading by pattern, for when there is no parser: the last resort
 * under `extractReadable`, and search snippets, which are one line of
 * somebody else's markup.
 *
 * It keeps the same contract with less to go on. A block is a line, a cell
 * a tab, and a tag that stands between two pieces of text is nothing, so a
 * search engine's "<b>Sam</b>sung" stays a word. Two tags back to back are a
 * space: it cannot tell a label from a letter the way the walk above does,
 * and here gluing two words costs more than opening one.
 */
export function markupText(html: string, options: PageTextOptions = {}): string {
  let text = html;
  text = text.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  if (options.dropChrome) text = text.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, "\n");
  // The source's own line breaks and indentation are not the page's: every
  // tab and newline below this line is one a tag asked for.
  text = text.replace(/\s+/g, " ");
  // A form feed marks a paragraph until the end, so that a run of block
  // boundaries is one line break and only a paragraph is a blank line.
  text = text.replace(PARAGRAPH_TAG, "\f");
  text = text.replace(BLOCK_TAG, "\n");
  text = text.replace(CELL_TAG, "\t");
  text = text.replace(/(?:<[^>]+>){2,}/g, " ");
  text = text.replace(/<[^>]+>/g, "");
  return text
    .replace(/ {2,}/g, " ")
    .replace(/ ?([\t\n\f]) ?/g, "$1")
    .replace(/[\t\n]*\n[\t\n]*/g, "\n")
    .replace(/[\t\n]*\f[\t\n\f]*/g, "\n\n")
    .replace(/\t{2,}/g, "\t")
    .trim();
}
