/**
 * Post-build prerender for the public marketing pages.
 *
 * Runs after `vite build`. Bundles the SSR entry with Rollup (which correctly
 * handles react-router-dom's CommonJS named exports), renders the Landing and
 * Pricing pages to static HTML, and injects each into a copy of the built
 * index.html shell, writing:
 *   dist/index.html          (Landing)
 *   dist/pricing/index.html  (Pricing)
 *
 * The client SPA is untouched — real users still boot the app (createRoot),
 * which replaces the prerendered markup. Crawlers/AI engines that don't run JS
 * get the real content. See #477.
 */
import { build } from 'vite';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROUTES, injectRouteMeta } from './prerender-meta.mjs';

// 1) Bundle the SSR entry. noExternal pulls react-router into the bundle so
//    Rollup's commonjs interop resolves its named exports (the dev SSR runner
//    can't). react/react-dom stay external and load via Node.
await build({
  root: process.cwd(),
  logLevel: 'warn',
  ssr: { noExternal: ['react-router-dom', 'react-router'] },
  build: {
    ssr: 'src/entry-ssr.tsx',
    outDir: 'dist-ssr',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'entry-ssr.mjs' } },
  },
});

// 2) Render each route and inject into the built shell.
const { render } = await import(pathToFileURL(resolve('dist-ssr/entry-ssr.mjs')).href);
const template = readFileSync(resolve('dist/index.html'), 'utf-8');

if (!template.includes('<div id="root"></div>')) {
  throw new Error('prerender: could not find the root mount point in dist/index.html');
}

for (const { url, out, meta } of ROUTES) {
  const appHtml = render(url);
  let html = template.replace('<div id="root"></div>', `<div id="root">${appHtml}</div>`);
  html = injectRouteMeta(html, meta);
  const outPath = resolve(out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.log(`prerendered ${url} -> ${out} (${appHtml.length} chars)`);
}

// 3) Clean up the intermediate SSR bundle.
rmSync(resolve('dist-ssr'), { recursive: true, force: true });
