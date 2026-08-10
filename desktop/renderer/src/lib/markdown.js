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

export function renderMarkdownish(raw) {
  const escaped = escapeHtml(raw);

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

  out = out.replace(
    /`([^`\n]+)`/g,
    (_m, code) => `<code class="rounded bg-muted px-1 py-0.5 text-[13px]">${code}</code>`,
  );
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

  return out;
}
