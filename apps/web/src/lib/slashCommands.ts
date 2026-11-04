/**
 * Slash commands and document mentions for the Markdown editor.
 *
 * All built-in commands are local text snippets: they work offline and never
 * touch the network. Server-side templates are merged in by the palette as an
 * optional extra and are not required for any command here.
 */

export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  group: 'Blocks' | 'Insert' | 'Spec' | 'Template';
  /** Extra search terms. */
  keywords?: string[];
  /** Snippet inserted in place of the `/query` line. `$0` marks the caret. */
  insert: string | (() => string);
  /** Small badge shown at the right (stage name for templates). */
  badge?: string;
}

const today = () => new Date().toISOString().slice(0, 10);

export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  { id: 'h1', label: 'Heading 1', description: 'Large section heading', group: 'Blocks', keywords: ['title', 'h1'], insert: '# $0' },
  { id: 'h2', label: 'Heading 2', description: 'Medium section heading', group: 'Blocks', keywords: ['h2', 'subtitle'], insert: '## $0' },
  { id: 'h3', label: 'Heading 3', description: 'Small section heading', group: 'Blocks', keywords: ['h3'], insert: '### $0' },
  { id: 'ul', label: 'Bullet list', description: 'Unordered list', group: 'Blocks', keywords: ['ul', 'unordered', 'bullets'], insert: '- $0' },
  { id: 'ol', label: 'Numbered list', description: 'Ordered list', group: 'Blocks', keywords: ['ol', 'ordered', 'numbers'], insert: '1. $0' },
  { id: 'task', label: 'Task list', description: 'Checklist with checkboxes', group: 'Blocks', keywords: ['todo', 'checkbox', 'checklist'], insert: '- [ ] $0' },
  { id: 'quote', label: 'Quote', description: 'Block quotation', group: 'Blocks', keywords: ['blockquote', 'cite'], insert: '> $0' },
  { id: 'code', label: 'Code block', description: 'Fenced code with language', group: 'Blocks', keywords: ['fence', 'snippet', 'pre'], insert: '```$0\n\n```' },
  { id: 'table', label: 'Table', description: '3 x 2 table', group: 'Blocks', keywords: ['grid', 'columns'], insert: '| Column | Column | Column |\n| ------ | ------ | ------ |\n| $0 |  |  |\n|  |  |  |' },
  { id: 'divider', label: 'Divider', description: 'Horizontal rule', group: 'Blocks', keywords: ['hr', 'rule', 'line', 'separator'], insert: '---\n$0' },
  { id: 'link', label: 'Link', description: 'Inline link', group: 'Insert', keywords: ['url', 'href'], insert: '[$0text](url)' },
  { id: 'image', label: 'Image', description: 'Image by URL or path', group: 'Insert', keywords: ['picture', 'img'], insert: '![$0alt text](path/to/image.png)' },
  { id: 'date', label: 'Today', description: 'Insert the current date', group: 'Insert', keywords: ['date', 'now'], insert: () => today() },
  { id: 'callout', label: 'Callout', description: 'Highlighted note', group: 'Insert', keywords: ['note', 'warning', 'info', 'admonition'], insert: '> **Note**\n> $0' },
  { id: 'story', label: 'User story', description: 'As a ... I want ... so that ...', group: 'Spec', keywords: ['requirement', 'persona'], insert: '**As a** $0user,\n**I want** goal,\n**so that** benefit.' },
  { id: 'acceptance', label: 'Acceptance criteria', description: 'Checklist of testable criteria', group: 'Spec', keywords: ['criteria', 'ac', 'done', 'definition'], insert: '### Acceptance criteria\n\n- [ ] $0\n- [ ] \n- [ ] ' },
  { id: 'openq', label: 'Open questions', description: 'Questions that need an answer', group: 'Spec', keywords: ['questions', 'tbd', 'unknown'], insert: '### Open questions\n\n- $0' },
  { id: 'risks', label: 'Risks', description: 'Risk and mitigation table', group: 'Spec', keywords: ['risk', 'mitigation'], insert: '### Risks\n\n| Risk | Likelihood | Mitigation |\n| ---- | ---------- | ---------- |\n| $0 |  |  |' },
];

export function resolveInsert(cmd: SlashCommand): string {
  return typeof cmd.insert === 'function' ? cmd.insert() : cmd.insert;
}

/** Case-insensitive match on label, description, group and keywords; label prefix hits rank first. */
export function filterSlashCommands<T extends SlashCommand>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const scored: Array<{ item: T; score: number; order: number }> = [];
  items.forEach((item, order) => {
    const label = item.label.toLowerCase();
    let score = -1;
    if (label.startsWith(q)) score = 0;
    else if (item.keywords?.some((k) => k.startsWith(q))) score = 1;
    else if (label.includes(q)) score = 2;
    else if (
      item.description.toLowerCase().includes(q) ||
      item.group.toLowerCase().includes(q) ||
      item.badge?.toLowerCase().includes(q) ||
      item.keywords?.some((k) => k.includes(q))
    ) {
      score = 3;
    }
    if (score >= 0) scored.push({ item, score, order });
  });
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  return scored.map((s) => s.item);
}

/** True when `index` sits inside an open ``` fence (odd number of fence lines before it). */
export function insideFence(value: string, index: number): boolean {
  let fences = 0;
  let pos = 0;
  while (pos < index) {
    if (value.startsWith('```', pos)) fences++;
    const nl = value.indexOf('\n', pos);
    if (nl === -1) break;
    pos = nl + 1;
  }
  return fences % 2 === 1;
}

export interface SlashContext {
  lineStart: number;
  lineEnd: number;
  query: string;
}

/** The `/query` line under the caret, or `null` when the palette should not show. */
export function getSlashContext(value: string, caret: number): SlashContext | null {
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
  let lineEnd = value.indexOf('\n', caret);
  if (lineEnd === -1) lineEnd = value.length;
  if (value[lineStart] !== '/' || caret <= lineStart) return null;
  if (insideFence(value, lineStart)) return null;
  return { lineStart, lineEnd, query: value.slice(lineStart + 1, lineEnd) };
}

// ── Mentions ────────────────────────────────────────────────

export interface MentionCandidate {
  id: string;
  title: string;
}

export interface MentionContext {
  /** Index of the `@`. */
  start: number;
  end: number;
  query: string;
}

const MENTION_MAX = 48;

/** `@query` immediately before the caret (preceded by start/whitespace/open bracket). */
export function getMentionContext(value: string, caret: number): MentionContext | null {
  for (let i = caret - 1; i >= 0 && caret - i <= MENTION_MAX; i--) {
    const ch = value[i];
    if (ch === '@') {
      const prev = i === 0 ? '' : value[i - 1];
      if (prev !== '' && !/[\s(\[]/.test(prev)) return null;
      if (insideFence(value, i)) return null;
      return { start: i, end: caret, query: value.slice(i + 1, caret) };
    }
    if (/[\n\[\]()]/.test(ch)) return null;
  }
  return null;
}

export function filterMentions(candidates: MentionCandidate[], query: string, limit = 8): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  const matches = q ? candidates.filter((c) => c.title.toLowerCase().includes(q)) : candidates;
  return [...matches]
    .sort((a, b) => {
      const ap = a.title.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.title.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp || a.title.localeCompare(b.title);
    })
    .slice(0, limit);
}

export const MENTION_SCHEME = 'nyx://doc/';

function escapeLinkText(t: string): string {
  return t.replace(/([\\[\]])/g, '\\$1');
}

/** Markdown for a document mention: a link with the `nyx://doc/<id>` scheme. */
export function mentionMarkdown(c: MentionCandidate): string {
  return `[${escapeLinkText(c.title || 'Untitled')}](${MENTION_SCHEME}${encodeURIComponent(c.id)})`;
}

export function parseMentionHref(href: string | undefined): string | null {
  if (!href || !href.startsWith(MENTION_SCHEME)) return null;
  try {
    return decodeURIComponent(href.slice(MENTION_SCHEME.length)) || null;
  } catch {
    return null;
  }
}
