import type { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { teamInvitations, teamMembers, users, teams } from '../db/schema.js';

export const invitationRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/invitations/:token — get invitation details (public, no auth required)
  app.get('/:token', async (request, reply) => {
    const { token } = request.params as { token: string };

    const [invitation] = await db
      .select({
        id: teamInvitations.id,
        email: teamInvitations.email,
        role: teamInvitations.role,
        status: teamInvitations.status,
        expiresAt: teamInvitations.expiresAt,
        teamName: teams.name,
      })
      .from(teamInvitations)
      .innerJoin(teams, eq(teamInvitations.teamId, teams.id))
      .where(eq(teamInvitations.token, token))
      .limit(1);

    if (!invitation) {
      reply.code(404);
      return { error: 'Invitation not found' };
    }

    if (invitation.status !== 'pending') {
      return { ...invitation, error: `Invitation has already been ${invitation.status}` };
    }

    if (new Date(invitation.expiresAt) < new Date()) {
      await db.update(teamInvitations).set({ status: 'expired' }).where(eq(teamInvitations.id, invitation.id));
      return { ...invitation, status: 'expired', error: 'Invitation has expired' };
    }

    return invitation;
  });

  // POST /api/invitations/:token/accept — accept invitation (requires auth)
  app.post('/:token/accept', async (request, reply) => {
    const { token } = request.params as { token: string };

    const [invitation] = await db
      .select()
      .from(teamInvitations)
      .where(eq(teamInvitations.token, token))
      .limit(1);

    if (!invitation) {
      reply.code(404);
      return { error: 'Invitation not found' };
    }

    if (invitation.status !== 'pending') {
      reply.code(409);
      return { error: `Invitation has already been ${invitation.status}` };
    }

    if (new Date(invitation.expiresAt) < new Date()) {
      await db.update(teamInvitations).set({ status: 'expired' }).where(eq(teamInvitations.id, invitation.id));
      reply.code(410);
      return { error: 'Invitation has expired' };
    }

    // Check user is authenticated
    if (!request.user?.id) {
      reply.code(401);
      return { error: 'Authentication required to accept invitation' };
    }

    // Check email matches (case-insensitive)
    if (request.user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      reply.code(403);
      return { error: 'This invitation was sent to a different email address' };
    }

    // Check not already a member
    const [existingMember] = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, invitation.teamId), eq(teamMembers.userId, request.user.id)))
      .limit(1);

    if (existingMember) {
      // Mark invitation as accepted anyway
      await db.update(teamInvitations).set({ status: 'accepted' }).where(eq(teamInvitations.id, invitation.id));
      return { teamId: invitation.teamId, alreadyMember: true };
    }

    // Add to team
    await db.insert(teamMembers).values({
      teamId: invitation.teamId,
      userId: request.user.id,
      role: invitation.role,
    });

    // Mark invitation as accepted
    await db.update(teamInvitations).set({ status: 'accepted' }).where(eq(teamInvitations.id, invitation.id));

    return { teamId: invitation.teamId, role: invitation.role };
  });
};
