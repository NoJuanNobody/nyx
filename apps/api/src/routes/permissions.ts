import type { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { teamMembers } from '../db/schema.js';

/**
 * Role hierarchy — higher index = more permissions.
 */
const ROLE_HIERARCHY = ['viewer', 'editor', 'developer', 'admin', 'owner'] as const;
type Role = (typeof ROLE_HIERARCHY)[number];

function roleIndex(role: Role): number {
  return ROLE_HIERARCHY.indexOf(role);
}

/**
 * Maps actions to the minimum role required to perform them.
 */
const ACTION_ROLE_MAP: Record<string, Role> = {
  read: 'viewer',
  edit: 'editor',
  create: 'editor',
  deploy: 'developer',
  merge: 'developer',
  delete: 'admin',
  manage: 'admin',
  transfer: 'owner',
};

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

export const permissionRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Check permission ──────────────────────────────────
  fastify.get<{
    Querystring: {
      teamId: string;
      action: string;
      resourceType?: string;
      resourceId?: string;
    };
  }>('/check', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      return reply.code(401).send({ error: 'Authentication required' });
    }

    const { teamId, action, resourceType, resourceId } = request.query;

    if (!teamId || !action) {
      return reply
        .code(400)
        .send({ error: 'Missing required query parameters: teamId, action' });
    }

    const requiredRole = ACTION_ROLE_MAP[action];
    if (!requiredRole) {
      return reply.code(400).send({
        error: `Unknown action: ${action}. Valid actions: ${Object.keys(ACTION_ROLE_MAP).join(', ')}`,
      });
    }

    const userRole = await getUserTeamRole(userId, teamId);

    if (!userRole) {
      return {
        allowed: false,
        role: null,
        requiredRole,
        reason: 'User is not a member of this team',
      };
    }

    const allowed = roleIndex(userRole) >= roleIndex(requiredRole);

    return {
      allowed,
      role: userRole,
      requiredRole,
      ...(allowed
        ? {}
        : {
            reason: `Action '${action}' requires at least '${requiredRole}' role. Your role: '${userRole}'`,
          }),
    };
  });

  // ── Get user role and hierarchy ───────────────────────
  fastify.get<{
    Querystring: { teamId: string };
  }>('/roles', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      return reply.code(401).send({ error: 'Authentication required' });
    }

    const { teamId } = request.query;

    if (!teamId) {
      return reply
        .code(400)
        .send({ error: 'Missing required query parameter: teamId' });
    }

    const userRole = await getUserTeamRole(userId, teamId);

    if (!userRole) {
      return reply
        .code(403)
        .send({ error: 'You are not a member of this team' });
    }

    // Build allowed actions for the user's role
    const allowedActions = Object.entries(ACTION_ROLE_MAP)
      .filter(([, role]) => roleIndex(userRole) >= roleIndex(role))
      .map(([action]) => action);

    return {
      role: userRole,
      hierarchy: [...ROLE_HIERARCHY],
      allowedActions,
      actionRoleMap: ACTION_ROLE_MAP,
    };
  });
};
