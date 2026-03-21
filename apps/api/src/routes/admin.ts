import type { FastifyPluginAsync } from 'fastify';
import { inArray, and, eq, ne, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { teamMembers, teams, users, documents } from '../db/schema.js';

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/admin/documents
  // Returns all non-archived documents across every team where the caller has admin+ role.
  // Self-enforcing: only returns data for teams the caller legitimately belongs to.
  app.get('/documents', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    // Find all teams where the calling user has admin or owner role
    const adminTeams = await db
      .select({
        teamId: teamMembers.teamId,
        role: teamMembers.role,
        teamName: teams.name,
      })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(
        and(
          eq(teamMembers.userId, userId),
          inArray(teamMembers.role, ['admin', 'owner']),
        ),
      );

    if (adminTeams.length === 0) {
      reply.code(403);
      return { error: 'No admin teams found. Requires admin or owner role on at least one team.' };
    }

    const teamIds = adminTeams.map((t) => t.teamId);

    // Fetch all non-archived documents from those teams with author + team info
    const docs = await db
      .select({
        id: documents.id,
        title: documents.title,
        status: documents.status,
        stage: documents.stage,
        path: documents.path,
        teamId: documents.teamId,
        teamName: teams.name,
        createdById: documents.createdById,
        createdByName: users.name,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .innerJoin(teams, eq(teams.id, documents.teamId))
      .innerJoin(users, eq(users.id, documents.createdById))
      .where(
        and(
          inArray(documents.teamId, teamIds),
          ne(documents.status, 'archived'),
        ),
      )
      .orderBy(desc(documents.updatedAt));

    return { documents: docs, teams: adminTeams };
  });
};
