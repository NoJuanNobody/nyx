import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { createHash } from 'node:crypto';
import { eq, and, ilike } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, teams, teamMembers, apiKeys, teamInvitations } from '../db/schema.js';
import { config } from '../lib/config.js';
import { getClerkClient, verifyClerkOAuthToken } from '../lib/clerk.js';

// ── Production safety check ──────────────────────────────
if (config.NODE_ENV === 'production' && config.DEV_AUTH_BYPASS === 'true') {
  throw new Error('FATAL: DEV_AUTH_BYPASS must not be set in production');
}

// ── Types ────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  clerkId: string | null;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: 'owner' | 'admin' | 'developer' | 'editor' | 'viewer';
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}

// ── Dev bypass user ──────────────────────────────────────

const DEV_USER: AuthUser = {
  id: '00000000-0000-0000-0000-000000000000',
  clerkId: null,
  email: 'dev@nyx.io',
  name: 'Dev User',
  avatarUrl: null,
  role: 'owner',
};

// ── Helpers ──────────────────────────────────────────────

/**
 * Returns true when running in development mode without Clerk credentials.
 * In this mode the middleware injects a hardcoded dev user instead of
 * verifying a real JWT.
 */
function isDevBypass(): boolean {
  return config.NODE_ENV === 'development' && (!config.CLERK_SECRET_KEY || config.DEV_AUTH_BYPASS === 'true');
}

/**
 * Given a verified Clerk user ID, find (or create) the matching row in the
 * local `users` table and return an AuthUser.
 */
async function upsertUser(clerkUserId: string, email: string, name: string, avatarUrl: string | null): Promise<AuthUser> {
  // Try to find existing user by clerkId
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.clerkId, clerkUserId))
    .limit(1);

  if (existing) {
    // Update name / avatar if they changed in Clerk
    if (existing.name !== name || existing.avatarUrl !== avatarUrl || existing.email !== email) {
      await db
        .update(users)
        .set({ name, avatarUrl, email, updatedAt: new Date() })
        .where(eq(users.id, existing.id));
    }

    // Determine the user's highest role across teams (fallback to viewer)
    const role = await resolveRole(existing.id);
    return { id: existing.id, clerkId: clerkUserId, email, name, avatarUrl, role };
  }

  // Check if a user with the same email already exists (e.g. seeded user)
  const [byEmail] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (byEmail) {
    // Link existing email-based user to Clerk
    await db
      .update(users)
      .set({ clerkId: clerkUserId, name, avatarUrl, updatedAt: new Date() })
      .where(eq(users.id, byEmail.id));

    const role = await resolveRole(byEmail.id);
    return { id: byEmail.id, clerkId: clerkUserId, email, name, avatarUrl, role };
  }

  // Create new user
  const [newUser] = await db
    .insert(users)
    .values({ clerkId: clerkUserId, email, name, avatarUrl })
    .returning();

  // Check for pending team invitations and auto-accept them
  await acceptPendingInvitations(newUser.id, email);

  // Guarantee every new user has a team up front. Without this, a fresh signup
  // with no invitation lands with no team, and anything needing a teamId
  // (checkout, creating docs, integrations) silently dead-ends. GET /api/teams
  // also lazily creates one, but doing it eagerly here closes the window where
  // a team-requiring request can fire before that call runs. Mirrors the lazy
  // path (same name/slug); the membership guard keeps the two idempotent.
  const memberships = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(eq(teamMembers.userId, newUser.id));

  if (memberships.length === 0) {
    const slug = `personal-${newUser.id.slice(0, 8)}`;
    const [team] = await db
      .insert(teams)
      .values({ name: 'My Workspace', slug })
      .returning();
    await db
      .insert(teamMembers)
      .values({ teamId: team.id, userId: newUser.id, role: 'owner' });
  }

  const role = await resolveRole(newUser.id);
  return { id: newUser.id, clerkId: clerkUserId, email, name, avatarUrl, role };
}

/**
 * Accept any pending team invitations matching this email address.
 */
async function acceptPendingInvitations(userId: string, email: string): Promise<void> {
  const pendingInvites = await db
    .select()
    .from(teamInvitations)
    .where(and(ilike(teamInvitations.email, email), eq(teamInvitations.status, 'pending')));

  for (const invite of pendingInvites) {
    if (invite.expiresAt < new Date()) {
      await db.update(teamInvitations).set({ status: 'expired' }).where(eq(teamInvitations.id, invite.id));
      continue;
    }

    // Check not already a member
    const [existing] = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, invite.teamId), eq(teamMembers.userId, userId)))
      .limit(1);

    if (!existing) {
      await db.insert(teamMembers).values({
        teamId: invite.teamId,
        userId,
        role: invite.role,
      });
    }

    await db.update(teamInvitations).set({ status: 'accepted' }).where(eq(teamInvitations.id, invite.id));
  }
}

/**
 * Resolve the "best" (most privileged) role a user holds across all teams.
 * Falls back to 'viewer' if the user is not a member of any team.
 */
const ROLE_PRIORITY: Record<string, number> = { owner: 0, admin: 1, developer: 2, editor: 3, viewer: 4 };

async function resolveRole(userId: string): Promise<AuthUser['role']> {
  const memberships = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId));

  if (memberships.length === 0) return 'viewer';

  let best: AuthUser['role'] = 'viewer';
  for (const m of memberships) {
    if (ROLE_PRIORITY[m.role] < ROLE_PRIORITY[best]) {
      best = m.role as AuthUser['role'];
    }
  }
  return best;
}

/**
 * Result of validating an `sd_` API key. Discriminated so callers can map each
 * failure reason to their own error surface (the middleware preserves granular
 * messages; the MCP route collapses them into one 401).
 *
 * The key's owning user row is returned; role resolution is left to the caller
 * (the API middleware needs it for RBAC; the MCP route does not).
 */
export type ApiKeyValidation =
  | { ok: true; keyUser: typeof users.$inferSelect; keyId: string }
  | { ok: false; reason: 'not_api_key' | 'invalid' | 'expired' | 'user_not_found' };

/**
 * Validate an `sd_` API key: hash → lookup (non-revoked) → expiry check →
 * resolve the owning user. Touches `lastUsedAt` fire-and-forget. Shared by the
 * auth middleware and the hosted MCP route so the two never drift.
 */
export async function validateApiKey(token: string): Promise<ApiKeyValidation> {
  if (!token.startsWith('sd_')) return { ok: false, reason: 'not_api_key' };

  const keyHash = createHash('sha256').update(token).digest('hex');
  const [key] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.revoked, false)))
    .limit(1);

  if (!key) return { ok: false, reason: 'invalid' };
  if (key.expiresAt && key.expiresAt < new Date()) return { ok: false, reason: 'expired' };

  // Update last used timestamp (fire-and-forget)
  setImmediate(() => {
    db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id)).catch(() => {});
  });

  // Resolve the user who created the key
  const [keyUser] = await db.select().from(users).where(eq(users.id, key.userId)).limit(1);
  if (!keyUser) return { ok: false, reason: 'user_not_found' };

  return { ok: true, keyUser, keyId: key.id };
}

/**
 * Resolve a verified Clerk user id to a local AuthUser. Local-first (by
 * clerkId) so repeat calls never hit Clerk; falls back to fetching the Clerk
 * user and upserting on first sight. Shared by the auth middleware (session +
 * OAuth) and the hosted MCP route.
 */
export async function resolveClerkUser(clerkUserId: string): Promise<AuthUser | null> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.clerkId, clerkUserId))
    .limit(1);

  if (existing) {
    const role = await resolveRole(existing.id);
    return {
      id: existing.id,
      clerkId: existing.clerkId,
      email: existing.email,
      name: existing.name,
      avatarUrl: existing.avatarUrl,
      role,
    };
  }

  const client = getClerkClient();
  if (!client) return null;

  const clerkUser = await client.users.getUser(clerkUserId);
  const email =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    '';
  const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || email;
  return upsertUser(clerkUserId, email, name, clerkUser.imageUrl ?? null);
}

// ── Plugin ───────────────────────────────────────────────

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('user', null as unknown as AuthUser);

  // Build the Clerk client once (only when credentials are available)
  const clerk = config.CLERK_SECRET_KEY
    ? createClerkClient({ secretKey: config.CLERK_SECRET_KEY, publishableKey: config.CLERK_PUBLISHABLE_KEY ?? undefined })
    : null;

  // Paths that are browser redirects (OAuth flows) and cannot carry Bearer tokens,
  // plus paths that handle their own auth (MCP endpoint, OAuth metadata).
  const AUTH_EXEMPT_PATHS = [
    '/health',
    '/go/',
    '/api/integrations/github/connect',
    '/api/integrations/github/callback',
    '/api/integrations/gitlab/callback',
    '/api/integrations/bitbucket/callback',
    '/api/integrations/atlassian/callback',
    '/api/slack/callback',
    '/api/waitlist',
    '/api/invitations',
    '/api/billing/webhooks/stripe',
    // MCP endpoint and OAuth discovery — the MCP route validates sd_ keys itself
    '/api/mcp',
    '/.well-known/',
  ];

  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // ── Skip auth for OAuth redirect routes ─────────────
    if (AUTH_EXEMPT_PATHS.some((p) => request.url.startsWith(p))) {
      request.user = DEV_USER; // provide a minimal user; OAuth state carries real identity
      return;
    }

    // ── Dev bypass ──────────────────────────────────────
    if (isDevBypass()) {
      request.user = DEV_USER;
      return;
    }

    // ── Production / Clerk mode ─────────────────────────
    if (!clerk) {
      // If we're not in dev-bypass mode but Clerk isn't configured, reject.
      reply.code(500).send({ error: 'Auth not configured: CLERK_SECRET_KEY is required in non-development environments' });
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);

    // ── API key auth path (sd_ prefix) ──────────────────
    if (token.startsWith('sd_')) {
      try {
        const result = await validateApiKey(token);
        if (!result.ok) {
          const error =
            result.reason === 'expired'
              ? 'API key has expired'
              : result.reason === 'user_not_found'
                ? 'API key user not found'
                : 'Invalid or revoked API key';
          reply.code(401).send({ error });
          return;
        }

        const role = await resolveRole(result.keyUser.id);
        request.user = {
          id: result.keyUser.id,
          clerkId: result.keyUser.clerkId,
          email: result.keyUser.email,
          name: result.keyUser.name,
          avatarUrl: result.keyUser.avatarUrl,
          role,
        };
        return;
      } catch (err) {
        request.log.error(err, 'API key authentication failed');
        reply.code(401).send({ error: 'API key authentication failed' });
        return;
      }
    }

    try {
      // Verify the Clerk session JWT
      const { sub: clerkUserId } = await verifyToken(token, { secretKey: config.CLERK_SECRET_KEY! });

      if (!clerkUserId) {
        reply.code(401).send({ error: 'Invalid token: no subject' });
        return;
      }

      // Fetch the full Clerk user to get email/name/avatar
      const clerkUser = await clerk.users.getUser(clerkUserId);

      const email =
        clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
        clerkUser.emailAddresses[0]?.emailAddress ??
        '';
      const name = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || email;
      const avatarUrl = clerkUser.imageUrl ?? null;

      request.user = await upsertUser(clerkUserId, email, name, avatarUrl);
    } catch (err) {
      // Not a valid session JWT — it may be a Clerk OAuth (machine) token, e.g.
      // an MCP client's self-call into the REST API. Try that before rejecting.
      try {
        const oauth = await verifyClerkOAuthToken(authHeader);
        if (oauth) {
          const authUser = await resolveClerkUser(oauth.clerkUserId);
          if (authUser) {
            request.user = authUser;
            return;
          }
        }
      } catch (oauthErr) {
        request.log.error(oauthErr, 'Clerk OAuth token verification failed');
      }
      request.log.error(err, 'Clerk token verification failed');
      reply.code(401).send({ error: 'Unauthorized: invalid or expired token' });
    }
  });
};

// Mark the plugin so Fastify does not encapsulate it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(authPlugin as any)[Symbol.for('skip-override')] = true;

export const authMiddleware = authPlugin;
