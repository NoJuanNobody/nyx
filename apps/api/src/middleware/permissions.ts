import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { teamMembers, documents, integrations } from '../db/schema.js';

/**
 * Role hierarchy — higher index = more permissions.
 * Used to check "at least role X" by comparing indices.
 */
const ROLE_HIERARCHY = ['viewer', 'editor', 'developer', 'admin', 'owner'] as const;
export type Role = (typeof ROLE_HIERARCHY)[number];

function roleIndex(role: Role): number {
  return ROLE_HIERARCHY.indexOf(role);
}

/**
 * Look up the calling user's role within a specific team.
 * Returns the role string or null if the user is not a member.
 */
async function getUserTeamRole(
  userId: string,
  teamId: string,
): Promise<Role | null> {
  const [membership] = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(
      and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
    );
  return (membership?.role as Role) ?? null;
}

// ── teamId extraction helpers ────────────────────────────

/**
 * Try to resolve a teamId from the request in this order:
 * 1. Route param  `:teamId`  or  `:id` when the route is team-scoped
 * 2. Query string `?teamId=`
 * 3. Request body `{ teamId }`
 */
function getTeamIdFromRequest(request: FastifyRequest): string | undefined {
  const params = request.params as Record<string, string>;
  const query = request.query as Record<string, string>;
  const body = (request.body ?? {}) as Record<string, unknown>;

  return params.teamId ?? query.teamId ?? (body.teamId as string | undefined);
}

/**
 * Resolve the teamId by looking up a document.
 * Used when the route only has `:id` pointing to a document.
 */
async function getTeamIdFromDocument(
  documentId: string,
): Promise<string | null> {
  const [doc] = await db
    .select({ teamId: documents.teamId })
    .from(documents)
    .where(eq(documents.id, documentId));
  return doc?.teamId ?? null;
}

/**
 * Resolve the teamId by looking up an integration.
 */
async function getTeamIdFromIntegration(
  integrationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ teamId: integrations.teamId })
    .from(integrations)
    .where(eq(integrations.id, integrationId));
  return row?.teamId ?? null;
}

// ── Public API ───────────────────────────────────────────

export interface RequireRoleOptions {
  /** Minimum role required (uses hierarchy: viewer < editor < developer < admin < owner) */
  minimumRole: Role;
  /**
   * How to locate the teamId on the request.
   *
   * - `'team'`        — teamId comes from params.id (team routes like /api/teams/:id/...)
   * - `'request'`     — teamId comes from params.teamId, query.teamId, or body.teamId
   * - `'document'`    — look up the document by params.id or params.documentId to find teamId
   * - `'integration'` — look up the integration by params.id to find teamId
   */
  source?: 'request' | 'team' | 'document' | 'integration';
}

/**
 * Returns a Fastify preHandler hook that enforces role-based access.
 *
 * Usage inside a route plugin:
 * ```ts
 * app.get('/', { preHandler: [requireRole({ minimumRole: 'editor' })] }, handler);
 * ```
 */
export function requireRole(options: RequireRoleOptions) {
  const { minimumRole, source = 'request' } = options;

  return async function checkRole(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const userId = request.user?.id;
    if (!userId) {
      return reply.code(401).send({ error: 'Authentication required' });
    }

    // ── resolve teamId ──────────────────────────────────
    let teamId: string | null | undefined;

    switch (source) {
      case 'team': {
        const params = request.params as Record<string, string>;
        teamId = params.id;
        break;
      }
      case 'document': {
        const params = request.params as Record<string, string>;
        const docId = params.id ?? params.documentId;
        if (!docId) {
          return reply
            .code(400)
            .send({ error: 'Missing document identifier in request' });
        }
        teamId = await getTeamIdFromDocument(docId);
        if (!teamId) {
          return reply.code(404).send({ error: 'Document not found' });
        }
        break;
      }
      case 'integration': {
        const params = request.params as Record<string, string>;
        const intId = params.id;
        if (!intId) {
          return reply
            .code(400)
            .send({ error: 'Missing integration identifier in request' });
        }
        teamId = await getTeamIdFromIntegration(intId);
        if (!teamId) {
          return reply.code(404).send({ error: 'Integration not found' });
        }
        break;
      }
      default: {
        // 'request' — try params, query, body
        teamId = getTeamIdFromRequest(request);
        break;
      }
    }

    if (!teamId) {
      return reply.code(400).send({ error: 'Unable to determine team context' });
    }

    // ── check membership & role ─────────────────────────
    const userRole = await getUserTeamRole(userId, teamId);

    if (!userRole) {
      return reply
        .code(403)
        .send({ error: 'You are not a member of this team' });
    }

    if (roleIndex(userRole) < roleIndex(minimumRole)) {
      return reply.code(403).send({
        error: `Requires at least '${minimumRole}' role. Your role: '${userRole}'`,
      });
    }

    // Attach resolved values for downstream handlers (optional convenience)
    (request as unknown as Record<string, unknown>).teamRole = userRole;
    (request as unknown as Record<string, unknown>).resolvedTeamId = teamId;
  };
}
