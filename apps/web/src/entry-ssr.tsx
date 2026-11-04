/**
 * Server-render entry used only at build time by prerender.mjs to generate
 * static HTML for the public marketing pages (Landing) so that
 * non-JS crawlers and AI answer engines see real content instead of an empty
 * SPA shell. The client app is unchanged and still fully client-rendered — the
 * prerendered markup is simply replaced on mount for real users.
 */
// Namespace imports: react-dom/server and react-router-dom v7 are CJS under
// SSR, so named imports fail — access exports off the namespace object instead.
import * as ReactDOMServer from 'react-dom/server';
import * as RouterDom from 'react-router-dom';
import { Landing } from './pages/Landing';

const { MemoryRouter, Routes, Route } = RouterDom;

/** Render a single public route to an HTML string. */
export function render(url: string): string {
  return ReactDOMServer.renderToString(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/" element={<Landing />} />
      </Routes>
    </MemoryRouter>,
  );
}
