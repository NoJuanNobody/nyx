import { describe, it, expect } from 'vitest';
import { formatShortcut, matchShortcut } from '../../lib/editorShortcuts';
import {
  BUILTIN_SLASH_COMMANDS,
  filterMentions,
  filterSlashCommands,
  getMentionContext,
  getSlashContext,
  mentionMarkdown,
  parseMentionHref,
  resolveInsert,
} from '../../lib/slashCommands';
import { safeUrl, sanitizeHighlightHtml, splitForRender } from '../../lib/markdownSafety';
import { clearDraft, loadDraft, saveDraft } from '../../lib/draftStore';

const key = (k: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}, code = '') => ({
  key: k,
  code,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe('keyboard shortcuts', () => {
  it('treats Cmd and Ctrl as the same modifier', () => {
    expect(matchShortcut(key('b', { meta: true }))).toBe('bold');
    expect(matchShortcut(key('b', { ctrl: true }))).toBe('bold');
    expect(matchShortcut(key('B', { ctrl: true }))).toBe('bold');
  });

  it('requires a modifier', () => {
    expect(matchShortcut(key('b'))).toBeNull();
  });

  it('maps undo, redo (both styles) and formatting', () => {
    expect(matchShortcut(key('z', { meta: true }))).toBe('undo');
    expect(matchShortcut(key('Z', { meta: true, shift: true }))).toBe('redo');
    expect(matchShortcut(key('y', { ctrl: true }))).toBe('redo');
    expect(matchShortcut(key('k', { meta: true }))).toBe('link');
    expect(matchShortcut(key('`', { meta: true }))).toBe('code');
    expect(matchShortcut(key('X', { meta: true, shift: true }))).toBe('strike');
  });

  it('matches digits and punctuation by physical code', () => {
    expect(matchShortcut(key('¡', { meta: true, alt: true }, 'Digit1'))).toBe('h1');
    expect(matchShortcut(key('&', { ctrl: true, shift: true }, 'Digit7'))).toBe('ol');
    expect(matchShortcut(key('*', { ctrl: true, shift: true }, 'Digit8'))).toBe('ul');
  });

  it('does not fire when extra modifiers are held', () => {
    expect(matchShortcut(key('b', { meta: true, shift: true }))).toBeNull();
    expect(matchShortcut(key('z', { meta: true, alt: true }))).toBeNull();
  });

  it('formats labels per platform', () => {
    expect(formatShortcut('bold', true)).toBe('Cmd+B');
    expect(formatShortcut('bold', false)).toBe('Ctrl+B');
    expect(formatShortcut('strike', false)).toBe('Ctrl+Shift+X');
    expect(formatShortcut('h1', true)).toBe('Cmd+Option+1');
    expect(formatShortcut('hr', true)).toBeNull();
  });
});

describe('slash commands', () => {
  it('ships offline built-ins with unique ids', () => {
    const ids = BUILTIN_SLASH_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['h1', 'h2', 'h3', 'ul', 'ol', 'task', 'quote', 'code', 'table', 'divider', 'link', 'image', 'date']) {
      expect(ids).toContain(id);
    }
  });

  it('ranks label-prefix matches first and searches keywords', () => {
    const r = filterSlashCommands(BUILTIN_SLASH_COMMANDS, 'head').map((c) => c.id);
    expect(r.slice(0, 3)).toEqual(['h1', 'h2', 'h3']);
    expect(filterSlashCommands(BUILTIN_SLASH_COMMANDS, 'todo').map((c) => c.id)).toContain('task');
    expect(filterSlashCommands(BUILTIN_SLASH_COMMANDS, 'zzzz')).toEqual([]);
    expect(filterSlashCommands(BUILTIN_SLASH_COMMANDS, '  ')).toBe(BUILTIN_SLASH_COMMANDS);
  });

  it('resolves dynamic snippets', () => {
    const date = BUILTIN_SLASH_COMMANDS.find((c) => c.id === 'date')!;
    expect(resolveInsert(date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('detects a slash line under the caret', () => {
    expect(getSlashContext('/hea', 4)).toEqual({ lineStart: 0, lineEnd: 4, query: 'hea' });
    expect(getSlashContext('intro\n/co', 9)).toEqual({ lineStart: 6, lineEnd: 9, query: 'co' });
    expect(getSlashContext('/h', 0)).toBeNull();
    expect(getSlashContext('not a command', 5)).toBeNull();
  });

  it('ignores slash lines inside code fences', () => {
    const v = '```\n/usr/bin\n```';
    expect(getSlashContext(v, 12)).toBeNull();
  });
});

describe('mentions', () => {
  it('detects @query before the caret', () => {
    expect(getMentionContext('see @spe', 8)).toEqual({ start: 4, end: 8, query: 'spe' });
    expect(getMentionContext('@a', 2)).toEqual({ start: 0, end: 2, query: 'a' });
  });

  it('ignores emails and code fences', () => {
    expect(getMentionContext('mail me@host', 12)).toBeNull();
    expect(getMentionContext('```\n@x', 6)).toBeNull();
  });

  it('filters, ranks and limits candidates', () => {
    const c = [
      { id: '1', title: 'Billing spec' },
      { id: '2', title: 'Spec: auth' },
      { id: '3', title: 'Roadmap' },
    ];
    expect(filterMentions(c, 'spec').map((x) => x.id)).toEqual(['2', '1']);
    expect(filterMentions(c, '', 2)).toHaveLength(2);
  });

  it('round-trips mention links and escapes brackets', () => {
    const md = mentionMarkdown({ id: 'a/b', title: 'Spec [v2]' });
    expect(md).toBe('[Spec \\[v2\\]](nyx://doc/a%2Fb)');
    expect(parseMentionHref('nyx://doc/a%2Fb')).toBe('a/b');
    expect(parseMentionHref('https://x.com')).toBeNull();
  });
});

describe('markdown safety', () => {
  it('blocks script-capable URL schemes, including obfuscated ones', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('  JavaScript:alert(1)')).toBe('');
    expect(safeUrl('java\tscript:alert(1)')).toBe('');
    expect(safeUrl('vbscript:x')).toBe('');
    expect(safeUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe('');
    expect(safeUrl('file:///etc/passwd')).toBe('');
  });

  it('allows normal links, relative paths, anchors, mentions and image data URIs', () => {
    for (const u of ['https://a.com/x?y=1', 'http://a.com', 'mailto:a@b.co', '/rel/path', 'rel.md', '#sec', 'nyx://doc/1', 'data:image/png;base64,AAAA']) {
      expect(safeUrl(u)).toBe(u);
    }
  });

  it('strips scripts and event handlers from highlighted HTML', () => {
    const out = sanitizeHighlightHtml(
      '<pre class="shiki" style="color:#fff" onclick="x()"><code><span style="color:red">ok</span><script>alert(1)</script><img src=x onerror=alert(1)></code></pre>',
    );
    expect(out).toContain('ok');
    expect(out).not.toMatch(/script|onclick|onerror|<img/i);
  });

  it('keeps small documents whole and splits large ones at headings outside fences', () => {
    expect(splitForRender('# a\nb')).toEqual(['# a\nb']);
    const big = Array.from({ length: 40 }, (_, i) => `# Section ${i}\n${'text '.repeat(40)}`).join('\n');
    const chunks = splitForRender(big, 1000, 500);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.join('\n')).toBe(big);
    const fenced = ['```', ...Array.from({ length: 500 }, () => '# not a heading'), '```', '# real'].join('\n');
    const fc = splitForRender(fenced, 100, 50);
    expect(fc.join('\n')).toBe(fenced);
    expect(fc[0].startsWith('```')).toBe(true);
    expect(fc[0]).toContain('# not a heading');
    expect(fc[0].match(/```/g)!.length).toBe(2);
  });
});

describe('draft store', () => {
  it('saves, loads and clears per document', () => {
    saveDraft('d1', { title: 'T', content: 'C', baseUpdatedAt: 'v1' });
    saveDraft('d2', { title: 'T2', content: 'C2', baseUpdatedAt: 'v1' });
    expect(loadDraft('d1')).toMatchObject({ title: 'T', content: 'C', baseUpdatedAt: 'v1' });
    expect(loadDraft('d2')!.content).toBe('C2');
    clearDraft('d1');
    expect(loadDraft('d1')).toBeNull();
    expect(loadDraft('d2')).not.toBeNull();
  });

  it('rejects malformed entries', () => {
    localStorage.setItem('nyx:draft:bad', '{"title":1}');
    expect(loadDraft('bad')).toBeNull();
    localStorage.setItem('nyx:draft:junk', 'not json');
    expect(loadDraft('junk')).toBeNull();
  });
});
