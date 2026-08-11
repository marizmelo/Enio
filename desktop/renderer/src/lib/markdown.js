/**
 * Minimal markdown rendering for model output.
 *
 * The critical property, unchanged from the pre-React renderer: everything is
 * escaped FIRST, and only our own literal tag strings are inserted afterwards.
 * Nothing the model emits can introduce a tag, attribute, or entity that was
 * not already neutralised. This is why the output is fed through
 * dangerouslySetInnerHTML without a sanitiser -- the escaping is the sanitiser,
 * and it runs before any tag exists.
 */

export function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Placeholder wrapper for extracted code blocks. U+E000 is in the Unicode
// private use area: it has no meaning, renders as nothing anyone types, and
// cannot appear in model output in practice. The previous implementation used
// a literal NUL for this, which made the file classify as binary -- grep then
// skipped it silently, reporting no matches rather than refusing to search.
const SENTINEL = "";

// A second, distinct sentinel for parked anchors. Sharing one list with the
// code blocks would mean sharing their restore pass, which strips a <br> on
// either side -- correct for a block, wrong for a link inside a sentence.
const LINK = "";

/**
 * Move a trailing "[Source](url)" onto the bold phrase it belongs to.
 *
 * The researcher is told to link the noun -- "the [JBL Flip 7](url) is £120" --
 * and at 4B it reliably half-follows: the link arrives inline, but as a
 * generic [Source](url) tag at the end of the bullet whose subject it cites.
 * Where the link should go is not a judgement call, though. When a block has
 * one bold phrase and ends with one generic-text link, the phrase is the
 * subject and the link is its citation, so the join is done here rather than
 * asked of the model. Same move as the rest of the project: a decision the
 * model gets wrong becomes one it does not have to make.
 *
 * Narrow on purpose. Only generic link text is moved -- a link the model
 * already named meaningfully is where it wanted it -- and only when there is
 * exactly one bold phrase to receive it, because with two the subject is
 * genuinely ambiguous and guessing would put a citation on the wrong claim.
 * Display-only, on the raw markdown at render time: the transcript stays
 * exactly what the model said.
 */
const TRAILING_CITE =
  /^([ \t]*(?:[-*][ \t]+)?)(.*?)[ \t]*\(?\[(?:source|src|link|read more|more info|more|details|reference|here)\]\((https?:\/\/[^\s)]+)\)\)?([.,;:!?]*)[ \t]*$/i;

function liftCitations(raw) {
  return raw
    .split("\n")
    .map((line) => {
      const match = TRAILING_CITE.exec(line);
      if (!match) return line;
      const [, lead, body, href, tail] = match;
      const bolds = body.match(/\*\*[^*\n]+\*\*/g);
      if (!bolds || bolds.length !== 1) return line;
      const linked = body.replace(
        /\*\*([^*\n]+)\*\*/,
        (_m, name) => `**[${name}](${href})**`,
      ).replace(/[ \t]+$/, "");
      // "…testers. [Source](url)." carries the sentence's own full stop AND
      // one after the link; keeping both prints "testers..".
      const punct = /[.,;:!?]$/.test(linked) ? "" : tail;
      return `${lead}${linked}${punct}`;
    })
    .join("\n");
}

export function renderMarkdownish(raw) {
  const escaped = escapeHtml(liftCitations(raw));

  // Pull fenced code blocks out first so the inline-code and bold passes below
  // cannot reach inside them.
  const codeBlocks = [];
  let out = escaped.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const body = code.replace(/\n$/, "");
    // A header carrying the language and a copy button. The button is only
    // markup here -- the click is handled by delegation where this is mounted,
    // because this function returns a string and has no React to hang a
    // handler on.
    const label = lang ? lang.toLowerCase() : "text";
    codeBlocks.push(
      `<div class="my-2 overflow-hidden rounded-md border bg-muted">` +
        `<div class="flex items-center justify-between border-b bg-muted/60 px-3 py-1">` +
          `<span class="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">${label}</span>` +
          `<button type="button" data-copy-code class="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-background hover:text-foreground">Copy</button>` +
        `</div>` +
        // The scroll container is the pre, not the page: a long line of code
        // must not make the whole conversation scroll sideways.
        `<pre class="overflow-x-auto p-3 text-[13px] leading-relaxed"><code>${body}</code></pre>` +
      `</div>`,
    );
    return `${SENTINEL}${idx}${SENTINEL}`;
  });

  // Everything from here on is parked as a sentinel the moment it becomes a
  // tag. These passes are string replacements with no idea what is markup and
  // what is prose, so an unparked tag is one a later pass can reach inside --
  // which is how a URL in backticks ended up swallowing its own closing tick.
  const inline = [];
  const parkHtml = (html) => {
    inline.push(html);
    return `${LINK}${inline.length - 1}${LINK}`;
  };

  // Inline code first. Its contents are literal by definition, so a URL inside
  // backticks must not become a link.
  out = out.replace(/`([^`\n]+)`/g, (_m, code) =>
    parkHtml(`<code class="rounded bg-muted px-1 py-0.5 text-[13px]">${code}</code>`),
  );

  const park = (href, text) => {
    // Only http(s) becomes clickable. Everything here has already been escaped,
    // so a quote cannot close the attribute -- but "javascript:" would still be
    // a working link, and this renders text a web page wrote.
    if (!/^https?:\/\//i.test(href)) return null;
    return parkHtml(
      `<a href="${href}" data-link class="underline decoration-dotted underline-offset-2 hover:decoration-solid">${text}</a>`,
    );
  };

  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, text, href) => {
    return park(href, text) ?? m;
  });

  // Bare URLs too: the model writes them as often as it writes markdown, and a
  // URL you cannot click is a URL you have to retype. Trailing punctuation is
  // sentence structure, not part of the address.
  out = out.replace(/https?:\/\/[^\s<>"']+/g, (m) => {
    const trimmed = m.replace(/[.,;:!?)\]]+$/, "");
    const tail = m.slice(trimmed.length);
    const parked = park(trimmed, shortenUrl(trimmed));
    return parked ? parked + tail : m;
  });

  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, txt) => `<strong>${txt}</strong>`);

  // Line-level structure. This did not exist at first and the cost was not
  // subtle: every newline collapsed to a space in HTML, so a model that
  // answered in tidy headed sections rendered as one unbroken wall — with
  // its "### Step 1" headings sitting mid-sentence as literal hashes.
  out = out
    .split("\n")
    .map((line) => {
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) return `<strong class="mt-2 block">${heading[2]}</strong>`;
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) return `<span class="block pl-3">•&nbsp;${bullet[1]}</span>`;
      return line;
    })
    .join("\n")
    // Paragraph gaps stay gaps; single newlines stay line breaks.
    .replace(/\n{2,}/g, '<span class="block h-2"></span>')
    .replace(/\n/g, "<br>");

  const restore = new RegExp(`(?:<br>)?${SENTINEL}(\\d+)${SENTINEL}(?:<br>)?`, "g");
  out = out.replace(restore, (_m, i) => codeBlocks[Number(i)]);
  // No <br> stripping around these: a link sits inside a sentence.
  out = out.replace(new RegExp(`${LINK}(\\d+)${LINK}`, "g"), (_m, i) => inline[Number(i)]);

  return out;
}

/**
 * A bare URL, shortened to something readable.
 *
 * A full address in the middle of a sentence pushes the line off the screen and
 * says nothing the domain does not. The href keeps the whole thing, so nothing
 * is lost by not printing it.
 */
function shortenUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/$/, "");
    const shown = host + path;
    return shown.length > 48 ? `${shown.slice(0, 47)}…` : shown;
  } catch {
    return url;
  }
}
