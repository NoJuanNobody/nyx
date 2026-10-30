/**
 * Pure Markdown editing operations.
 *
 * Every function takes an {@link EditState} (text + selection) and returns a
 * new one, or `null` when the operation does not apply. Nothing here touches
 * the DOM, the network or React, so the toolbar, keyboard shortcuts, slash
 * commands and selection toolbar all share one tested implementation and the
 * editing path works fully offline.
 */

export interface EditState {
  value: string;
  /** Selection start (inclusive). */
  start: number;
  /** Selection end (exclusive). Equal to `start` for a collapsed caret. */
  end: number;
}

export type EditorCommandId =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'codeBlock'
  | 'link'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'ul'
  | 'ol'
  | 'task'
  | 'quote'
  | 'hr'
  | 'undo'
  | 'redo';

const WORD_CHAR = /[\p{L}\p{N}_]/u;

export function replaceRange(
  s: EditState,
  from: number,
  to: number,
  text: string,
  selStart?: number,
  selEnd?: number,
): EditState {
  const value = s.value.slice(0, from) + text + s.value.slice(to);
  const caret = from + text.length;
  return { value, start: selStart ?? caret, end: selEnd ?? selStart ?? caret };
}

/** Expand a collapsed caret that touches a word to cover the whole word. */
function expandToWord(s: EditState): { start: number; end: number } {
  if (s.start !== s.end) return { start: s.start, end: s.end };
  let a = s.start;
  let b = s.end;
  while (a > 0 && WORD_CHAR.test(s.value[a - 1])) a--;
  while (b < s.value.length && WORD_CHAR.test(s.value[b])) b++;
  return { start: a, end: b };
}

/**
 * Toggle inline markers (`**`, `*`, `~~`, `` ` ``) around the selection.
 * Wraps when absent, unwraps when the markers are already there (either just
 * outside the selection or inside it). A collapsed caret on a word wraps the
 * word; elsewhere it inserts an empty pair with the caret between.
 */
export function toggleWrap(s: EditState, open: string, close: string = open): EditState {
  const { start, end } = expandToWord(s);
  const { value } = s;
  const selected = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);

  // Single-char emphasis markers must not match half of a doubled marker.
  const single = open.length === 1 && (open === '*' || open === '_');
  const ambiguous = single && (value[start - 2] === open || value[end + 1] === open);

  if (before.endsWith(open) && after.startsWith(close) && !ambiguous && start > 0) {
    const from = start - open.length;
    const to = end + close.length;
    return {
      value: value.slice(0, from) + selected + value.slice(to),
      start: from,
      end: from + selected.length,
    };
  }

  if (
    selected.length >= open.length + close.length &&
    selected.startsWith(open) &&
    selected.endsWith(close) &&
    !single
  ) {
    const inner = selected.slice(open.length, selected.length - close.length);
    return {
      value: before + inner + after,
      start,
      end: start + inner.length,
    };
  }

  if (selected.length === 0) {
    const caret = start + open.length;
    return { value: before + open + close + after, start: caret, end: caret };
  }
  return {
    value: before + open + selected + close + after,
    start: start + open.length,
    end: end + open.length,
  };
}

// ── Line helpers ─────────────────────────────────────────────

interface LineRange {
  from: number;
  to: number;
}

export function lineRange(value: string, start: number, end: number): LineRange {
  const from = value.lastIndexOf('\n', start - 1) + 1;
  // A selection that ends right after a newline should not drag in the next line.
  const probe = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const nl = value.indexOf('\n', probe);
  return { from, to: nl === -1 ? value.length : nl };
}

const STRIP_PREFIX = /^(#{1,6}\s+|>\s?|[-*+]\s\[[ xX]\]\s|[-*+]\s|\d+[.)]\s)/;

type LineKind = 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'task' | 'quote';

function hasKind(line: string, kind: LineKind): boolean {
  const body = line.replace(/^\s*/, '');
  switch (kind) {
    case 'h1':
      return /^#\s/.test(body);
    case 'h2':
      return /^##\s/.test(body);
    case 'h3':
      return /^###\s/.test(body);
    case 'task':
      return /^[-*+]\s\[[ xX]\]\s/.test(body);
    case 'ul':
      return /^[-*+]\s/.test(body) && !/^[-*+]\s\[[ xX]\]\s/.test(body);
    case 'ol':
      return /^\d+[.)]\s/.test(body);
    case 'quote':
      return /^>/.test(body);
  }
}

function prefixFor(kind: LineKind, index: number): string {
  switch (kind) {
    case 'h1':
      return '# ';
    case 'h2':
      return '## ';
    case 'h3':
      return '### ';
    case 'ul':
      return '- ';
    case 'task':
      return '- [ ] ';
    case 'quote':
      return '> ';
    case 'ol':
      return `${index + 1}. `;
  }
}

/**
 * Toggle a block prefix (heading, list, task, quote) on every line touched by
 * the selection. If all non-blank lines already carry it, it is removed;
 * otherwise any other block prefix is replaced.
 */
export function toggleLinePrefix(s: EditState, kind: LineKind): EditState {
  const { from, to } = lineRange(s.value, s.start, s.end);
  const lines = s.value.slice(from, to).split('\n');
  const candidates = lines.filter((l) => l.trim() !== '');
  const considered = candidates.length > 0 ? candidates : lines;
  const remove = considered.every((l) => hasKind(l, kind));

  let counter = 0;
  const out = lines.map((line) => {
    if (line.trim() === '' && lines.length > 1) return line;
    const indent = /^\s*/.exec(line)![0];
    const body = line.slice(indent.length);
    const stripped = body.replace(STRIP_PREFIX, '');
    if (remove) return indent + stripped;
    const next = indent + prefixFor(kind, counter) + stripped;
    counter++;
    return next;
  });

  const text = out.join('\n');
  const value = s.value.slice(0, from) + text + s.value.slice(to);

  if (s.start === s.end) {
    // Keep the caret on the same character, shifted by the prefix change.
    const delta = text.length - (to - from);
    const caret = Math.max(from, s.start + delta);
    return { value, start: caret, end: caret };
  }
  return { value, start: from, end: from + text.length };
}

/** `[text](url)`, selecting the part the user most likely types next. */
export function insertLink(s: EditState): EditState {
  const selected = s.value.slice(s.start, s.end);
  if (/^https?:\/\/\S+$/.test(selected)) {
    const text = 'text';
    const md = `[${text}](${selected})`;
    return replaceRange(s, s.start, s.end, md, s.start + 1, s.start + 1 + text.length);
  }
  const text = selected || 'text';
  const md = `[${text}](url)`;
  const urlStart = s.start + text.length + 3;
  return replaceRange(s, s.start, s.end, md, urlStart, urlStart + 3);
}

/** The fenced block (```...```) containing `pos`, as line-start/line-end offsets. */
function enclosingFence(value: string, pos: number): { from: number; to: number; innerFrom: number; innerTo: number } | null {
  let offset = 0;
  let open: { from: number; innerFrom: number } | null = null;
  for (const line of value.split('\n')) {
    const lineEnd = offset + line.length;
    if (/^```/.test(line)) {
      if (!open) {
        open = { from: offset, innerFrom: lineEnd + 1 };
      } else {
        if (pos >= open.from && pos <= lineEnd) {
          return { from: open.from, to: lineEnd, innerFrom: open.innerFrom, innerTo: Math.max(offset - 1, open.innerFrom) };
        }
        open = null;
      }
    }
    offset = lineEnd + 1;
  }
  return null;
}

/** Fence the selection (or an empty block) with triple backticks; unwraps if already fenced. */
export function toggleCodeBlock(s: EditState): EditState {
  const { value } = s;
  const fence = enclosingFence(value, s.start);
  if (fence) {
    const inner = value.slice(fence.innerFrom, fence.innerTo);
    return replaceRange(s, fence.from, fence.to, inner, fence.from, fence.from + inner.length);
  }

  const selected = value.slice(s.start, s.end);
  const atLineStart = s.start === 0 || value[s.start - 1] === '\n';
  const atLineEnd = s.end === value.length || value[s.end] === '\n';
  const lead = atLineStart ? '' : '\n';
  const trail = atLineEnd ? '' : '\n';
  const open = `${lead}\`\`\`\n`;
  const block = `${open}${selected}\n\`\`\`${trail}`;
  const innerStart = s.start + open.length;
  return replaceRange(s, s.start, s.end, block, innerStart, innerStart + selected.length);
}

export function insertHorizontalRule(s: EditState): EditState {
  const { value } = s;
  const atLineStart = s.start === 0 || value[s.start - 1] === '\n';
  const text = `${atLineStart ? '' : '\n'}---\n`;
  return replaceRange(s, s.start, s.end, text);
}

const LIST_LINE = /^(\s*)([-*+]|\d+[.)]|>)(\s+\[[ xX]\])?(\s?)(.*)$/;

/**
 * Tab / Shift+Tab. Returns `null` when the key should keep its default
 * behaviour (moving focus), so the editor never traps keyboard users: Tab only
 * indents inside list items or across a multi-line selection.
 */
export function indentLines(s: EditState, outdent: boolean): EditState | null {
  const { from, to } = lineRange(s.value, s.start, s.end);
  const lines = s.value.slice(from, to).split('\n');
  const multi = lines.length > 1;
  const inList = LIST_LINE.test(lines[0]) && /^\s*([-*+]|\d+[.)])\s/.test(lines[0]);
  if (!multi && !inList) return null;

  let changed = false;
  const out = lines.map((line) => {
    if (outdent) {
      const m = /^( {1,2}|\t)/.exec(line);
      if (!m) return line;
      changed = true;
      return line.slice(m[0].length);
    }
    if (line === '') return line;
    changed = true;
    return '  ' + line;
  });
  if (!changed) return null;

  const text = out.join('\n');
  const value = s.value.slice(0, from) + text + s.value.slice(to);
  if (s.start === s.end) {
    const delta = text.length - (to - from);
    const caret = Math.max(from, s.start + delta);
    return { value, start: caret, end: caret };
  }
  return { value, start: from, end: from + text.length };
}

/**
 * Enter inside a list/quote line: continue the marker on the next line, or end
 * the list when the item is empty. Returns `null` to fall through to a plain
 * newline (caret not at end of line, no list, selection active).
 */
export function continueList(s: EditState): EditState | null {
  if (s.start !== s.end) return null;
  const { from, to } = lineRange(s.value, s.start, s.end);
  if (s.start !== to) return null;
  const line = s.value.slice(from, to);
  const m = LIST_LINE.exec(line);
  if (!m) return null;
  const [, indent, marker, task, , content] = m;
  if (marker === '>' && !/^\s*>/.test(line)) return null;
  if (content.trim() === '') {
    // Empty item: drop the marker and leave a blank line.
    return replaceRange(s, from, to, '', from, from);
  }
  let nextMarker = marker;
  const ordered = /^(\d+)([.)])$/.exec(marker);
  if (ordered) nextMarker = `${parseInt(ordered[1], 10) + 1}${ordered[2]}`;
  const nextTask = task ? ' [ ]' : '';
  const insert = `\n${indent}${nextMarker}${nextTask} `;
  return replaceRange(s, s.start, s.end, insert);
}

/**
 * Replace `[from, to)` with a snippet. A `$0` token in the snippet marks where
 * the caret should land (and is removed).
 */
export function insertSnippet(s: EditState, from: number, to: number, snippet: string): EditState {
  const i = snippet.indexOf('$0');
  if (i === -1) return replaceRange(s, from, to, snippet);
  const text = snippet.slice(0, i) + snippet.slice(i + 2);
  return replaceRange(s, from, to, text, from + i, from + i);
}

/** Run a formatting command. `undo`/`redo` are history operations and return `null` here. */
export function runCommand(id: EditorCommandId, s: EditState): EditState | null {
  switch (id) {
    case 'bold':
      return toggleWrap(s, '**');
    case 'italic':
      return toggleWrap(s, '*');
    case 'strike':
      return toggleWrap(s, '~~');
    case 'code':
      return toggleWrap(s, '`');
    case 'codeBlock':
      return toggleCodeBlock(s);
    case 'link':
      return insertLink(s);
    case 'h1':
    case 'h2':
    case 'h3':
    case 'ul':
    case 'ol':
    case 'task':
    case 'quote':
      return toggleLinePrefix(s, id);
    case 'hr':
      return insertHorizontalRule(s);
    case 'undo':
    case 'redo':
      return null;
  }
}
