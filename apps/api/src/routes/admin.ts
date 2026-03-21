import type { FastifyPluginAsync } from 'fastify';
import { inArray, and, eq, ne, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { teamMembers, teams, users, documents } from '../db/schema.js';
import { config } from '../lib/config.js';

const superAdminEmails = new Set(
  (config.SUPER_ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
);

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/admin/documents
  // Super admins see all documents across all teams.
  // Regular admins see documents only from teams where they have admin/owner role.
  app.get('/documents', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    // Check if caller is a super admin
    const [caller] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));

    const isSuperAdmin = caller && superAdminEmails.has(caller.email.toLowerCase());

    // Find teams the user has admin/owner role on
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

    if (!isSuperAdmin && adminTeams.length === 0) {
      reply.code(403);
      return { error: 'No admin teams found. Requires admin or owner role on at least one team.' };
    }

    // Super admins: get all teams for the filter dropdown
    let allTeams = adminTeams;
    if (isSuperAdmin) {
      allTeams = (await db
        .select({ teamId: teams.id, teamName: teams.name })
        .from(teams)
      ).map((t) => ({ teamId: t.teamId, role: 'super_admin' as const, teamName: t.teamName }));
    }

    const teamIds = allTeams.map((t) => t.teamId);

    // Fetch all non-archived documents from relevant teams
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

    return { documents: docs, teams: allTeams };
  });
};
