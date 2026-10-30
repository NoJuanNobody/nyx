import { describe, it, expect } from 'vitest';
import {
  continueList,
  indentLines,
  insertLink,
  insertSnippet,
  runCommand,
  toggleCodeBlock,
  toggleLinePrefix,
  toggleWrap,
  type EditState,
} from '../../lib/markdownEdits';

const st = (value: string, start = 0, end = start): EditState => ({ value, start, end });
const sel = (r: EditState) => r.value.slice(r.start, r.end);

describe('toggleWrap', () => {
  it('wraps the selection and keeps the text selected', () => {
    const r = toggleWrap(st('say hello now', 4, 9), '**');
    expect(r.value).toBe('say **hello** now');
    expect(sel(r)).toBe('hello');
  });

  it('unwraps when the markers surround the selection', () => {
    const r = toggleWrap(st('say **hello** now', 6, 11), '**');
    expect(r.value).toBe('say hello now');
    expect(sel(r)).toBe('hello');
  });

  it('unwraps when the markers are inside the selection', () => {
    const r = toggleWrap(st('say **hello** now', 4, 13), '**');
    expect(r.value).toBe('say hello now');
  });

  it('wraps the word under a collapsed caret', () => {
    const r = toggleWrap(st('say hello now', 7), '*');
    expect(r.value).toBe('say *hello* now');
  });

  it('inserts an empty pair with the caret between when there is no word', () => {
    const r = toggleWrap(st('a  b', 2), '`');
    expect(r.value).toBe('a `` b');
    expect(r.start).toBe(3);
    expect(r.end).toBe(3);
  });

  it('does not treat the inner star of bold as italic markers', () => {
    const r = toggleWrap(st('**hello**', 2, 7), '*');
    expect(r.value).toBe('***hello***');
  });

  it('supports strikethrough', () => {
    expect(toggleWrap(st('gone', 0, 4), '~~').value).toBe('~~gone~~');
  });
});

describe('toggleLinePrefix', () => {
  it('adds a heading and replaces a different heading level', () => {
    expect(toggleLinePrefix(st('Title', 2), 'h1').value).toBe('# Title');
    expect(toggleLinePrefix(st('## Title', 3), 'h1').value).toBe('# Title');
  });

  it('removes the prefix when every line already has it', () => {
    expect(toggleLinePrefix(st('# Title', 3), 'h1').value).toBe('Title');
  });

  it('applies list markers to every selected line, numbering ordered lists', () => {
    const v = 'one\ntwo\nthree';
    expect(toggleLinePrefix(st(v, 0, v.length), 'ul').value).toBe('- one\n- two\n- three');
    expect(toggleLinePrefix(st(v, 0, v.length), 'ol').value).toBe('1. one\n2. two\n3. three');
    expect(toggleLinePrefix(st(v, 0, v.length), 'task').value).toBe('- [ ] one\n- [ ] two\n- [ ] three');
  });

  it('converts between list kinds instead of stacking prefixes', () => {
    expect(toggleLinePrefix(st('- item', 3), 'ol').value).toBe('1. item');
    expect(toggleLinePrefix(st('- [ ] item', 3), 'ul').value).toBe('- item');
  });

  it('skips blank lines inside a multi-line selection', () => {
    const v = 'a\n\nb';
    expect(toggleLinePrefix(st(v, 0, v.length), 'quote').value).toBe('> a\n\n> b');
  });

  it('does not pull the next line in when the selection ends on a newline', () => {
    const v = 'a\nb';
    expect(toggleLinePrefix(st(v, 0, 2), 'ul').value).toBe('- a\nb');
  });
});

describe('insertLink', () => {
  it('selects the url placeholder around selected text', () => {
    const r = insertLink(st('see docs', 4, 8));
    expect(r.value).toBe('see [docs](url)');
    expect(sel(r)).toBe('url');
  });

  it('uses a pasted URL as the target and selects the link text', () => {
    const r = insertLink(st('https://nyx.dev', 0, 15));
    expect(r.value).toBe('[text](https://nyx.dev)');
    expect(sel(r)).toBe('text');
  });
});

describe('toggleCodeBlock', () => {
  it('fences the selection on its own lines', () => {
    const r = toggleCodeBlock(st('x = 1', 0, 5));
    expect(r.value).toBe('```\nx = 1\n```');
    expect(sel(r)).toBe('x = 1');
  });

  it('inserts an empty block with the caret inside', () => {
    const r = toggleCodeBlock(st('', 0));
    expect(r.value).toBe('```\n\n```');
    expect(r.start).toBe(4);
  });

  it('unwraps an existing fenced block', () => {
    const v = '```\nx = 1\n```';
    expect(toggleCodeBlock(st(v, 5, 5)).value).toBe('x = 1');
  });
});

describe('indentLines', () => {
  it('indents and outdents list items', () => {
    const r = indentLines(st('- item', 3), false)!;
    expect(r.value).toBe('  - item');
    expect(indentLines(st(r.value, 5), true)!.value).toBe('- item');
  });

  it('returns null outside lists so Tab keeps moving focus', () => {
    expect(indentLines(st('plain text', 3), false)).toBeNull();
    expect(indentLines(st('- item', 3), true)).toBeNull();
  });

  it('indents every line of a multi-line selection', () => {
    const v = 'a\nb';
    expect(indentLines(st(v, 0, 3), false)!.value).toBe('  a\n  b');
  });
});

describe('continueList', () => {
  it('continues bullets, numbers (incrementing) and tasks (unchecked)', () => {
    expect(continueList(st('- one', 5))!.value).toBe('- one\n- ');
    expect(continueList(st('2. two', 6))!.value).toBe('2. two\n3. ');
    expect(continueList(st('- [x] done', 10))!.value).toBe('- [x] done\n- [ ] ');
    expect(continueList(st('> quoted', 8))!.value).toBe('> quoted\n> ');
  });

  it('keeps indentation', () => {
    expect(continueList(st('  - nested', 10))!.value).toBe('  - nested\n  - ');
  });

  it('ends the list on an empty item', () => {
    const r = continueList(st('- one\n- ', 8))!;
    expect(r.value).toBe('- one\n');
    expect(r.start).toBe(6);
  });

  it('falls through for non-list lines, mid-line carets and selections', () => {
    expect(continueList(st('plain', 5))).toBeNull();
    expect(continueList(st('- one', 2))).toBeNull();
    expect(continueList(st('- one', 0, 5))).toBeNull();
  });
});

describe('insertSnippet', () => {
  it('replaces the range and places the caret at $0', () => {
    const r = insertSnippet(st('/h1', 3), 0, 3, '# $0');
    expect(r.value).toBe('# ');
    expect(r.start).toBe(2);
  });

  it('puts the caret after the snippet when there is no $0', () => {
    const r = insertSnippet(st('/x', 2), 0, 2, 'abc');
    expect(r.value).toBe('abc');
    expect(r.start).toBe(3);
  });
});

describe('runCommand', () => {
  it('returns null for history commands', () => {
    expect(runCommand('undo', st('a'))).toBeNull();
    expect(runCommand('redo', st('a'))).toBeNull();
  });

  it('inserts a horizontal rule on its own line', () => {
    expect(runCommand('hr', st('abc', 3))!.value).toBe('abc\n---\n');
  });
});
