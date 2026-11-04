import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

const shiki = vi.hoisted(() => ({ codeToHtml: vi.fn() }));
vi.mock('shiki', () => ({ codeToHtml: shiki.codeToHtml }));

import { MarkdownPreview } from '../../components/MarkdownPreview';

async function renderPreview(content: string, props: { onMentionClick?: (id: string) => void } = {}) {
  const utils = render(<MarkdownPreview content={content} {...props} />);
  await act(async () => {});
  return utils;
}

describe('MarkdownPreview sanitization', () => {
  it('never creates script or event-handler elements from raw HTML in the document', async () => {
    const { container } = await renderPreview(
      'Hello <script>window.__pwned = 1</script> <img src=x onerror="window.__pwned = 2"> <b onclick="x()">bold</b>\n\n<iframe src="https://evil.test"></iframe>',
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('strips javascript: and data:text/html link targets', async () => {
    const { container } = await renderPreview(
      '[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](data:text/html;base64,PHNjcmlwdD4=) [d](vbscript:x) [ok](https://example.com)',
    );
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    for (const h of hrefs.slice(0, 4)) {
      expect(h === null || h === '').toBe(true);
    }
    expect(hrefs[4]).toBe('https://example.com');
  });

  it('opens external links safely and leaves relative links alone', async () => {
    const { container } = await renderPreview('[ext](https://example.com) [rel](./other.md)');
    const [ext, rel] = Array.from(container.querySelectorAll('a'));
    expect(ext.getAttribute('target')).toBe('_blank');
    expect(ext.getAttribute('rel')).toContain('noopener');
    expect(ext.getAttribute('rel')).toContain('noreferrer');
    expect(rel.getAttribute('target')).toBeNull();
  });

  it('blocks script-scheme image sources and shows alt text instead', async () => {
    const { container, getByText } = await renderPreview('![logo](javascript:alert(1))');
    expect(container.querySelector('img')).toBeNull();
    expect(getByText(/Image: logo/)).toBeInTheDocument();
  });

  it('renders https images lazily and falls back to alt text when they fail (offline)', async () => {
    const { container, getByText } = await renderPreview('![diagram](https://example.com/a.png)');
    const img = container.querySelector('img')!;
    expect(img.getAttribute('loading')).toBe('lazy');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(getByText(/Image: diagram/)).toBeInTheDocument();
  });

  it('sanitizes syntax-highlighter HTML before injecting it', async () => {
    shiki.codeToHtml.mockResolvedValueOnce(
      '<pre class="shiki"><code><span style="color:#fff">const x</span><script>window.__pwned=3</script><img src=x onerror="window.__pwned=4"></code></pre>',
    );
    const { container } = await renderPreview('```ts\nconst x = 1;\n```');
    await act(async () => {});
    expect(container.textContent).toContain('const x');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
  });

  it('falls back to plain code when highlighting throws', async () => {
    shiki.codeToHtml.mockRejectedValueOnce(new Error('unknown language'));
    const { container } = await renderPreview('```zzz\nplain\n```');
    expect(container.querySelector('pre')?.textContent).toContain('plain');
  });
});

describe('MarkdownPreview mentions', () => {
  it('renders nyx://doc links as mention chips that call back with the document id', async () => {
    const onMentionClick = vi.fn();
    const { container } = await renderPreview('See [Billing spec](nyx://doc/d1).', { onMentionClick });
    const chip = container.querySelector('a[data-mention]') as HTMLAnchorElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe('Billing spec');
    fireEvent.click(chip);
    expect(onMentionClick).toHaveBeenCalledWith('d1');
  });
});

describe('MarkdownPreview rendering', () => {
  it('shows an empty state', async () => {
    const { getByText } = await renderPreview('');
    expect(getByText(/Nothing to preview/)).toBeInTheDocument();
  });

  it('renders GFM tables and task lists', async () => {
    const { container } = await renderPreview('| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo');
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it('renders large documents in chunks without losing content', async () => {
    const sections = Array.from({ length: 80 }, (_, i) => `## Section ${i}\n\n${'Some paragraph text. '.repeat(30)}`);
    const { container } = await renderPreview(sections.join('\n\n'));
    expect(container.querySelectorAll('h2')).toHaveLength(80);
    expect(container.textContent).toContain('Section 79');
  });

  it('keeps fenced code containing headings in one piece when chunking', async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `## S${i}\n\n${'x '.repeat(200)}`).join('\n\n');
    const content = `${filler}\n\n\`\`\`md\n# not a heading\n## also not\n\`\`\``;
    const { container } = await renderPreview(content);
    expect(container.querySelectorAll('h1')).toHaveLength(0);
    expect(container.querySelector('pre')?.textContent).toContain('# not a heading');
  });
});
