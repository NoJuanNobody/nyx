import { describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { MarkdownPreview } from '../../components/MarkdownPreview';

// Avoid hitting Shiki in unit tests — we only care about the structural routing
// (block vs inline) here, not the highlighted output.
vi.mock('shiki', () => ({
  codeToHtml: vi.fn().mockResolvedValue(''),
}));

const INLINE_CODE_CLASS_SIGNATURE = 'text-rose-600';

describe('MarkdownPreview', () => {
  it('renders an unlabeled fenced code block as a <pre> block, not stacked inline pills', () => {
    const content = '```\ntree\nline\n```';
    const { container } = render(<MarkdownPreview content={content} />);

    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    // The pre should hold the full block text with whitespace preserved.
    // remark emits a trailing newline after the fence, so trim it for the
    // exact-equality check.
    expect(pre?.textContent?.replace(/\n$/, '')).toBe('tree\nline');

    // Critical regression guard: the unlabeled block must NOT route through
    // InlineCode (the rose-600 pill that fragments per line).
    const inlinePill = container.querySelector(`code.${INLINE_CODE_CLASS_SIGNATURE}`);
    expect(inlinePill).toBeNull();

    // Sanity: rose-600 class should not appear anywhere in the rendered tree
    // for an unlabeled block.
    expect(container.innerHTML).not.toContain(INLINE_CODE_CLASS_SIGNATURE);
  });

  it('renders inline backticks inside a paragraph with the rose-pill InlineCode styling', () => {
    const content = 'Paragraph with `inline` code.';
    const { container } = render(<MarkdownPreview content={content} />);

    // Inline code lives inside a paragraph, not a <pre>.
    const paragraph = container.querySelector('p');
    expect(paragraph).not.toBeNull();
    expect(paragraph?.textContent).toContain('inline');

    const inlinePill = container.querySelector(`code.${INLINE_CODE_CLASS_SIGNATURE}`);
    expect(inlinePill).not.toBeNull();
    expect(inlinePill?.textContent).toBe('inline');

    // Inline code must not be wrapped in a <pre>.
    expect(container.querySelector('pre')).toBeNull();
  });

  it('renders a language-tagged fenced code block through CodeBlock (regression guard)', async () => {
    const content = '```ts\nconst x = 1;\n```';
    const { container } = render(<MarkdownPreview content={content} />);
    // CodeBlock kicks off an async highlight effect for languages; flush it
    // so we don't get an act() warning when the (mocked) promise resolves.
    await act(async () => {});

    // CodeBlock's fallback path always renders a <pre> (the Shiki async path
    // also eventually renders one inside the sanitized HTML, but in the
    // synchronous initial render before highlight resolves, we land on the
    // fallback <pre> with the inner <code class="language-ts">).
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent?.replace(/\n$/, '')).toBe('const x = 1;');

    // The inner <code> should carry the language-ts className from
    // react-markdown — proving block routing is happening, not inline routing.
    const innerCode = pre?.querySelector('code');
    expect(innerCode).not.toBeNull();
    expect(innerCode?.className).toContain('language-ts');

    // Must not be styled as the inline rose pill.
    const inlinePill = container.querySelector(`code.${INLINE_CODE_CLASS_SIGNATURE}`);
    expect(inlinePill).toBeNull();
  });
});
