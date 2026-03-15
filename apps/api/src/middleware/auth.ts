import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, teamMembers, apiKeys, teamInvitations } from '../db/schema.js';
import { config } from '../lib/config.js';

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
    .where(and(eq(teamInvitations.email, email), eq(teamInvitations.status, 'pending')));

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

// ── Plugin ───────────────────────────────────────────────

const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('user', null as unknown as AuthUser);

  // Build the Clerk client once (only when credentials are available)
  const clerk = config.CLERK_SECRET_KEY
    ? createClerkClient({ secretKey: config.CLERK_SECRET_KEY, publishableKey: config.CLERK_PUBLISHABLE_KEY ?? undefined })
    : null;

  // Paths that are browser redirects (OAuth flows) and cannot carry Bearer tokens
  const AUTH_EXEMPT_PATHS = [
    '/health',
    '/api/integrations/github/connect',
    '/api/integrations/github/callback',
    '/api/waitlist',
    '/api/invitations',
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
        const keyHash = createHash('sha256').update(token).digest('hex');
        const [key] = await db
          .select()
          .from(apiKeys)
          .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.revoked, false)))
          .limit(1);

        if (!key) {
          reply.code(401).send({ error: 'Invalid or revoked API key' });
          return;
        }

        if (key.expiresAt && key.expiresAt < new Date()) {
          reply.code(401).send({ error: 'API key has expired' });
          return;
        }

        // Update last used timestamp (fire-and-forget)
        setImmediate(() => {
          db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id)).catch(() => {});
        });

        // Resolve the user who created the key
        const [keyUser] = await db.select().from(users).where(eq(users.id, key.userId)).limit(1);
        if (!keyUser) {
          reply.code(401).send({ error: 'API key user not found' });
          return;
        }

        const role = await resolveRole(keyUser.id);
        request.user = {
          id: keyUser.id,
          clerkId: keyUser.clerkId,
          email: keyUser.email,
          name: keyUser.name,
          avatarUrl: keyUser.avatarUrl,
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
      request.log.error(err, 'Clerk token verification failed');
      reply.code(401).send({ error: 'Unauthorized: invalid or expired token' });
    }
  });
};

// Mark the plugin so Fastify does not encapsulate it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(authPlugin as any)[Symbol.for('skip-override')] = true;

export const authMiddleware = authPlugin;
