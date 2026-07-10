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

  describe('Pricing route meta', () => {
    const pricingRoute = ROUTES.find((r) => r.url === '/pricing')!;
    const result = injectRouteMeta(LANDING_HTML, pricingRoute.meta);

    it('replaces <title>', () => {
      expect(result).toContain('<title>Pricing — Nyx</title>');
      expect(result).not.toContain('Keep product specs in sync with your code</title>');
    });

    it('replaces meta[name=description]', () => {
      expect(result).toContain('name="description"');
      expect(result).toMatch(/content="Free, Starter/);
      expect(result).not.toContain('Nyx detects when your docs drift');
    });

    it('replaces link[rel=canonical] to /pricing', () => {
      expect(result).toContain('href="https://nyx-creative.com/pricing"');
    });

    it('replaces og:url to /pricing', () => {
      expect(result).toMatch(/property="og:url"\s+content="https:\/\/nyx-creative\.com\/pricing"/);
    });

    it('replaces og:title', () => {
      expect(result).toMatch(/property="og:title"\s+content="Nyx Pricing/);
    });

    it('replaces og:description', () => {
      expect(result).toMatch(/property="og:description"\s+content="Free to \$129/);
    });

    it('replaces twitter:title', () => {
      expect(result).toMatch(/name="twitter:title"\s+content="Nyx Pricing/);
    });

    it('replaces twitter:description', () => {
      expect(result).toMatch(/name="twitter:description"\s+content="Free to \$129/);
    });

    it('does not corrupt the root mount point', () => {
      expect(result).toContain('<div id="root"></div>');
    });
  });

  it('ROUTES has exactly two entries: Landing and Pricing', () => {
    expect(ROUTES).toHaveLength(2);
    expect(ROUTES[0].url).toBe('/');
    expect(ROUTES[0].meta).toBeNull();
    expect(ROUTES[1].url).toBe('/pricing');
    expect(ROUTES[1].meta).not.toBeNull();
  });

  it('Pricing out path targets dist/pricing/index.html', () => {
    const pricing = ROUTES.find((r) => r.url === '/pricing')!;
    expect(pricing.out).toBe('dist/pricing/index.html');
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
