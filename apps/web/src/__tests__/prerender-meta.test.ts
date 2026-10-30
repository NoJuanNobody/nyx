import { describe, it, expect } from 'vitest';
import { injectRouteMeta, ROUTES } from '../../prerender-meta.mjs';

const LANDING_HTML = `<!doctype html>
<html lang="en">
  <head>
    <title>Nyx — Keep product specs in sync with your code</title>
    <meta name="description" content="Nyx detects when your docs drift from your code." />
    <link rel="canonical" href="https://nyx-creative.com/" />
    <meta property="og:url" content="https://nyx-creative.com/" />
    <meta property="og:title" content="Nyx — Keep product specs in sync with your code" />
    <meta property="og:description" content="Detects doc-code drift." />
    <meta name="twitter:title" content="Nyx — Keep product specs in sync with your code" />
    <meta name="twitter:description" content="Detects doc-code drift." />
  </head>
  <body><div id="root"></div></body>
</html>`;

describe('injectRouteMeta', () => {
  it('returns html unchanged when meta is null', () => {
    expect(injectRouteMeta(LANDING_HTML, null)).toBe(LANDING_HTML);
  });

  it('ROUTES has exactly one entry: Landing', () => {
    expect(ROUTES).toHaveLength(1);
    expect(ROUTES[0].url).toBe('/');
    expect(ROUTES[0].meta).toBeNull();
  });

  it('escapes & in description without double-escaping', () => {
    const meta = {
      title: 'T',
      description: 'A & B',
      canonical: 'https://example.com/',
      ogUrl: 'https://example.com/',
      ogTitle: 'T',
      ogDescription: 'A & B',
      twitterTitle: 'T',
      twitterDescription: 'T',
    };
    const out = injectRouteMeta(LANDING_HTML, meta);
    expect(out).toContain('A &amp; B');
    expect(out).not.toContain('&amp;amp;');
  });
});
