# Web theming, fonts and scrolling (AI-78)

## Theme
- `system` (default) / `light` / `dark`, persisted in `localStorage` key `nyx:theme` (all access wrapped in try/catch, see `apps/web/src/lib/theme.ts`).
- `public/theme-init.js` (external, so it satisfies `script-src 'self'`) applies theme and accent before first paint. Keep it in sync with `lib/theme.ts`.
- `<ThemeProvider>` follows OS changes while on `system` and syncs across windows via the `storage` event.
- Settings -> Appearance has the theme and accent pickers.

## Tokens
- Accent is driven by one variable, `--accent-hue` (OKLCH degrees); the `--color-blue-*` scale (which all existing `*-blue-*` utilities use) is built from it. Presets: purple (brand, 287), indigo, blue, teal, green, rose, orange. Persisted as `nyx:accent`.
- Semantic tokens in `index.css`: `--nyx-bg`, `--nyx-surface`, `--nyx-text`, `--nyx-text-muted`, `--nyx-border`, `--nyx-accent`, `--nyx-accent-fg`, `--nyx-accent-text`, `--nyx-scrollbar*`.
- `src/__tests__/lib/contrast.test.ts` parses `index.css` and asserts WCAG AA (4.5:1) for the token pairs, for every accent preset in light and dark.

## Fonts (self-hosted, no CDN)
- Inter Variable via `@fontsource-variable/inter` (SIL Open Font License 1.1; package is MIT-compatible to redistribute with the OFL notice shipped in the package `LICENSE`). Imported in `main.tsx` (`wght.css`); the woff2 files are emitted as same-origin assets and Vite is configured never to inline fonts as `data:` URIs.
- Desktop CSP (`apps/desktop/src-tauri/tauri.conf.json`) allows `font-src 'self'` only; the Google Fonts links and CSP allowances were removed from `index.html`. The desktop config was not edited.
- Fallback stack: `Inter Variable, Inter, system-ui, ...`.

## Scrolling and motion
- `Layout` adds `html.app-shell` (document never scrolls, `h-dvh`); `main` is the scroller. Public pages scroll normally.
- `overscroll-behavior: none` on body and `contain` on scroll containers; thin themed scrollbars (Firefox + WebKit).
- `prefers-reduced-motion: reduce` collapses animations and transitions.

## Notes for the wiring wave
- The index.html CSP meta still lists Clerk/Google Analytics origins from the SaaS build; remove with the rest of the web-auth cleanup.
- Modal/Portal already render to `document.body` (fixed-position fix for #340/#360); not changed.
