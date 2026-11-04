import DOMPurify from 'dompurify';

/**
 * Markdown preview safety helpers. The preview never renders raw HTML from the
 * document (react-markdown escapes it), so the remaining vectors are URLs and
 * pre-rendered syntax-highlight HTML; both are filtered here.
 */

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'nyx:']);

/**
 * Allow relative URLs, in-page anchors, image data URIs and a short list of
 * protocols. Anything else (`javascript:`, `vbscript:`, `file:`, `data:text/html`...)
 * becomes an empty string.
 */
export function safeUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return '';
  // Browsers strip control chars/whitespace inside the scheme; do the same before checking.
  const compact = url.replace(/[\u0000- \u007f-\u009f]/g, '');
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(compact)) return url;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  if (!m) return url; // relative, #anchor, //host handled below
  if (compact.startsWith('//')) return url;
  return SAFE_PROTOCOLS.has(`${m[1].toLowerCase()}:`) ? url : '';
}

/** Sanitize Shiki's `<pre><code><span style>` output. */
export function sanitizeHighlightHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['pre', 'code', 'span', 'div', 'br'],
    ALLOWED_ATTR: ['class', 'style'],
  });
}

/**
 * Split a document into chunks at ATX headings outside code fences so large
 * documents can be rendered (and re-rendered) a chunk at a time. Chunks are
 * only produced once the document is larger than `minChars`.
 */
export function splitForRender(content: string, minChars = 20_000, targetChars = 6_000): string[] {
  if (content.length <= minChars) return [content];
  const lines = content.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  let fenced = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^#{1,6}\s/.test(line) && size >= targetChars) {
      chunks.push(current.join('\n'));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}
