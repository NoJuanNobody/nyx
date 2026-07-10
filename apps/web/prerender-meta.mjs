/**
 * Pure head-injection helper for the SSG prerender pipeline.
 * Exports ROUTES (route config with per-route meta) and injectRouteMeta (string replacer).
 * Split out from prerender.mjs so it can be unit-tested without triggering the build.
 */

/**
 * Per-route configuration.
 *
 * `meta: null` means use the index.html <head> as-is (the Landing defaults).
 * A non-null `meta` object patches every crawlable head tag for that route.
 */
export const ROUTES = [
  {
    url: '/',
    out: 'dist/index.html',
    meta: null,
  },
  {
    url: '/pricing',
    out: 'dist/pricing/index.html',
    meta: {
      title: 'Pricing — Nyx',
      description:
        'Free, Starter ($24/mo), Pro ($59/mo), Team ($129/mo). Compare plans and start free. 14-day free trial on all paid plans. AI-assisted docs that stay in sync with your code.',
      canonical: 'https://nyx-creative.com/pricing',
      ogUrl: 'https://nyx-creative.com/pricing',
      ogTitle: 'Nyx Pricing — Simple, transparent plans',
      ogDescription:
        'Free to $129/mo. AI-assisted product specs that stay in sync with your codebase. Start free, upgrade as your team grows.',
      twitterTitle: 'Nyx Pricing — Simple, transparent plans',
      twitterDescription:
        'Free to $129/mo. AI-powered product docs that stay in sync with your code. Start free, upgrade as your team grows.',
    },
  },
];

/**
 * Replace Landing-specific <head> meta with route-specific values.
 * `meta: null` → returns `html` unchanged.
 *
 * Uses exact string replacements (no DOM parser) so the file remains a
 * lightweight Node script with zero dependencies.
 */
export function injectRouteMeta(html, meta) {
  if (!meta) return html;

  // Use function-form replacements so $ in content values (e.g. "$129/mo")
  // is never misinterpreted as a regex back-reference.
  return html
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escAttr(meta.title)}</title>`)
    .replace(
      /(<meta\s+name="description"\s+content=")[^"]*(")/,
      (_, p1, p2) => `${p1}${escAttr(meta.description)}${p2}`,
    )
    .replace(
      /(<link\s+rel="canonical"\s+href=")[^"]*(")/,
      (_, p1, p2) => `${p1}${escAttr(meta.canonical)}${p2}`,
    )
    .replace(
      /(<meta\s+property="og:url"\s+content=")[^"]*(")/,
      (_, p1, p2) => `${p1}${escAttr(meta.ogUrl)}${p2}`,
    )
    .replace(
      /(<meta\s+property="og:title"\s+content=")[^"]*(")/,
      (_, p1, p2) => `${p1}${escAttr(meta.ogTitle)}${p2}`,
    )
    .replace(
      /(<meta\s+property="og:description"\s+content=")[^"]*(")/,
      (_, p1, p2) => `${p1}${escAttr(meta.ogDescription)}${p2}`,
    )
    .replace(
      /(<meta\s+name="twitter:title"\s+content=")[^"]*(")/,
      (_, p1, p2) => `${p1}${escAttr(meta.twitterTitle)}${p2}`,
    )
    .replace(
      /(<meta\s+name="twitter:description"\s+content=")[^"]*(")/,
      (_, p1, p2) => `${p1}${escAttr(meta.twitterDescription)}${p2}`,
    );
}

/** Escape characters that are special inside an HTML attribute value. */
function escAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
