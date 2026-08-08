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
  let out = escaped.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_m, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<pre class="my-2 overflow-x-auto rounded-md bg-muted p-3 text-[13px] leading-relaxed"><code>${code.replace(/\n$/, "")}</code></pre>`,
    );
    return `${SENTINEL}${idx}${SENTINEL}`;
  });

  out = out.replace(
    /`([^`\n]+)`/g,
    (_m, code) => `<code class="rounded bg-muted px-1 py-0.5 text-[13px]">${code}</code>`,
  );
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, txt) => `<strong>${txt}</strong>`);

  const restore = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g");
  out = out.replace(restore, (_m, i) => codeBlocks[Number(i)]);

  return out;
}
