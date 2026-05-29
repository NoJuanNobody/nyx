import { config } from './config.js';

// Entries wrapped in slashes (e.g. `/^https:\/\/nyx-git-.*\.vercel\.app$/`)
// are treated as regex patterns so Vercel preview URLs can be allowed. This is
// the single source of truth for the CORS allowlist, shared by the @fastify/cors
// registration (app.ts) and by SSE routes that write raw responses.
export const allowedOrigins: Array<string | RegExp> = (config.CORS_ORIGINS
  ? config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : ['http://localhost:5173']
).map((entry) =>
  entry.startsWith('/') && entry.endsWith('/') && entry.length > 2
    ? new RegExp(entry.slice(1, -1))
    : entry,
);

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  return allowedOrigins.some((entry) =>
    entry instanceof RegExp ? entry.test(origin) : entry === origin,
  );
}

/**
 * CORS headers for a manually-written (raw) response such as an SSE stream.
 *
 * The @fastify/cors plugin adds its headers via an onSend hook, which does NOT
 * run for responses written through `reply.raw.writeHead`. SSE endpoints
 * therefore have to set the CORS headers themselves, or the browser blocks the
 * streamed response with "No 'Access-Control-Allow-Origin' header is present"
 * even though the preflight succeeded. Returns an empty object for disallowed
 * (or absent) origins so we never blindly reflect an arbitrary Origin.
 */
export function sseCorsHeaders(origin: string | undefined): Record<string, string> {
  if (!isOriginAllowed(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin!,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}
