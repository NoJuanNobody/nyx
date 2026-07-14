import { createClerkClient } from '@clerk/backend';
import { verifyClerkToken } from '@clerk/mcp-tools/server';
import { config } from './config.js';

let _client: ReturnType<typeof createClerkClient> | null | undefined;

/**
 * Lazily-built shared Clerk backend client. Returns null when Clerk isn't
 * configured (local dev without credentials). Evaluated on first use so it
 * respects the resolved config at call time.
 */
export function getClerkClient(): ReturnType<typeof createClerkClient> | null {
  if (_client === undefined) {
    _client = config.CLERK_SECRET_KEY
      ? createClerkClient({
          secretKey: config.CLERK_SECRET_KEY,
          publishableKey: config.CLERK_PUBLISHABLE_KEY ?? undefined,
        })
      : null;
  }
  return _client;
}

/**
 * Verify a Clerk OAuth (machine) token presented as `Authorization: Bearer …`.
 * These are the tokens minted when a user connects the hosted MCP server via
 * the browser OAuth flow. Returns the authorizing Clerk user id and the granted
 * scopes, or null if the header is absent / not a valid Clerk OAuth token.
 */
export async function verifyClerkOAuthToken(
  authorizationHeader: string | undefined,
): Promise<{ clerkUserId: string; scopes: string[] } | null> {
  const client = getClerkClient();
  if (!client || !authorizationHeader?.startsWith('Bearer ')) return null;

  const token = authorizationHeader.slice(7);

  // authenticateRequest reads the Authorization header; the URL is irrelevant
  // for header-based machine tokens but must be a valid absolute URL.
  const req = new Request('https://nyx.local/api/mcp', {
    headers: { authorization: authorizationHeader },
  });

  const requestState = await client.authenticateRequest(req, {
    acceptsToken: 'oauth_token',
  });
  const auth = requestState.toAuth();
  const info = verifyClerkToken(auth, token);
  if (!info) return null;

  const clerkUserId = auth.subject;
  if (!clerkUserId) return null;

  return { clerkUserId, scopes: auth.scopes ?? [] };
}
