import type { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { teams, teamMembers, users } from '../db/schema.js';
import { requireRole } from '../middleware/permissions.js';

export const teamRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/teams — list teams for the current user
  app.get('/', async (request) => {
    const userId = request.user.id;

    const rows = await db
      .select({
        id: teams.id,
        name: teams.name,
        slug: teams.slug,
        role: teamMembers.role,
        createdAt: teams.createdAt,
        updatedAt: teams.updatedAt,
      })
      .from(teamMembers)
      .innerJoin(teams, eq(teamMembers.teamId, teams.id))
      .where(eq(teamMembers.userId, userId));

    return rows;
  });

  // POST /api/teams — create a team (also adds creator as owner)
  app.post('/', async (request, reply) => {
    const { name, slug } = request.body as { name: string; slug: string };
    const userId = request.user.id;

    const [team] = await db.insert(teams).values({ name, slug }).returning();

    await db.insert(teamMembers).values({
      teamId: team.id,
      userId,
      role: 'owner',
    });

    reply.code(201);
    return team;
  });

  // GET /api/teams/:id/members — list members of a team
  // viewers+ can see members
  app.get('/:id/members', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'team' })] }, async (request) => {
    const { id } = request.params as { id: string };

    const rows = await db
      .select({
        id: teamMembers.id,
        userId: teamMembers.userId,
        role: teamMembers.role,
        joinedAt: teamMembers.joinedAt,
        userName: users.name,
        userEmail: users.email,
      })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.userId, users.id))
      .where(eq(teamMembers.teamId, id));

    return { teamId: id, members: rows };
  });

  // POST /api/teams/:id/members — add a member to a team
  // admins+ can add members
  app.post('/:id/members', { preHandler: [requireRole({ minimumRole: 'admin', source: 'team' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { userId, role } = request.body as {
      userId: string;
      role?: 'owner' | 'admin' | 'developer' | 'editor' | 'viewer';
    };

    const [member] = await db
      .insert(teamMembers)
      .values({
        teamId: id,
        userId,
        role: role ?? 'viewer',
      })
      .returning();

    reply.code(201);
    return member;
  });

  // DELETE /api/teams/:id/members/:userId — remove a member from a team
  // admins+ can remove members
  app.delete('/:id/members/:userId', { preHandler: [requireRole({ minimumRole: 'admin', source: 'team' })] }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };

    await db
      .delete(teamMembers)
      .where(
        and(eq(teamMembers.teamId, id), eq(teamMembers.userId, userId))
      );

    reply.code(204);
    return;
  });
};
