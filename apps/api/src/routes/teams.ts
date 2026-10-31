import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq, and, ilike, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import { teams, teamMembers, users, teamInvitations } from '../db/schema.js';
import { requireRole } from '../middleware/permissions.js';
import { sendEmail, buildInviteEmail } from '../services/email.js';
import { notificationService } from '../services/notification.service.js';
import { NotificationEvents } from '../services/notification-events.js';

export const teamRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/teams — list teams for the current user
  // Auto-provisions a default team if the user has none.
  app.get('/', async (request) => {
    const userId = request.user.id;

    let rows = await db
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

    // Auto-create a personal team for users with no memberships
    if (rows.length === 0) {
      const slug = `personal-${userId.slice(0, 8)}`;
      const [team] = await db.insert(teams).values({ name: 'My Workspace', slug }).returning();
      await db.insert(teamMembers).values({ teamId: team.id, userId, role: 'owner' });

      rows = await db
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
    }

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

  // POST /api/teams/:id/members — invite by email (add directly or create pending invitation)
  // admins+ can add members
  app.post('/:id/members', { preHandler: [requireRole({ minimumRole: 'admin', source: 'team' })] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { email, role } = request.body as {
      email: string;
      role?: 'owner' | 'admin' | 'developer' | 'editor' | 'viewer';
    };

    const memberRole = role ?? 'viewer';
    const normalizedEmail = email.trim().toLowerCase();

    // Look up user by email (case-insensitive)
    const [existingUser] = await db
      .select()
      .from(users)
      .where(ilike(users.email, normalizedEmail))
      .limit(1);

    if (existingUser) {
      // Check if already a member
      const [alreadyMember] = await db
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, existingUser.id)))
        .limit(1);

      if (alreadyMember) {
        reply.code(409);
        return { error: 'User is already a member of this team' };
      }

      // Add directly
      const [member] = await db
        .insert(teamMembers)
        .values({ teamId: id, userId: existingUser.id, role: memberRole })
        .returning();

      // Notify the added user
      const [teamForNotif] = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
      if (teamForNotif) {
        notificationService.create({
          userId: existingUser.id,
          teamId: id,
          eventType: NotificationEvents.TEAM_INVITE,
          title: `You've been added to ${teamForNotif.name}`,
          metadata: { memberId: member.id, email: normalizedEmail },
          entityId: member.id,
        }).catch(() => {});
      }

      reply.code(201);
      return { ...member, type: 'added' };
    }

    // User not found — create pending invitation
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 day expiry

    const token = randomUUID();

    const [invitation] = await db
      .insert(teamInvitations)
      .values({
        teamId: id,
        email: normalizedEmail,
        role: memberRole,
        invitedById: request.user.id,
        token,
        expiresAt,
      })
      .returning();

    // Deduplicate any older pending invitations for the same (teamId, email)
    if (invitation?.id) {
      try {
        await db
          .delete(teamInvitations)
          .where(
            and(
              eq(teamInvitations.teamId, id),
              ilike(teamInvitations.email, normalizedEmail),
              eq(teamInvitations.status, 'pending'),
              ne(teamInvitations.id, invitation.id),
            ),
          );
      } catch {
        // Ignore cleanup errors
      }
    }

    // Send invite email (Resend with automatic Clerk Invitations fallback)
    const [team] = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
    const { subject, html, acceptUrl } = buildInviteEmail(
      team?.name || 'My Workspace',
      request.user.name || request.user.email,
      token,
    );
    let emailSent = false;
    if (team) {
      emailSent = await sendEmail({
        to: normalizedEmail,
        subject,
        html,
        inviteRedirectUrl: acceptUrl,
      }).catch(() => false);
    }

    reply.code(201);
    return { ...invitation, type: 'invited', inviteUrl: acceptUrl, emailSent };
  });

  // GET /api/teams/:id/invitations — list pending invitations
  app.get('/:id/invitations', { preHandler: [requireRole({ minimumRole: 'viewer', source: 'team' })] }, async (request) => {
    const { id } = request.params as { id: string };

    const rows = await db
      .select()
      .from(teamInvitations)
      .where(and(eq(teamInvitations.teamId, id), eq(teamInvitations.status, 'pending')));

    return { teamId: id, invitations: rows };
  });

  // DELETE /api/teams/:id/invitations/:invId — cancel a pending invitation
  app.delete('/:id/invitations/:invId', { preHandler: [requireRole({ minimumRole: 'admin', source: 'team' })] }, async (request, reply) => {
    const { id, invId } = request.params as { id: string; invId: string };

    const [deleted] = await db
      .delete(teamInvitations)
      .where(and(eq(teamInvitations.id, invId), eq(teamInvitations.teamId, id)))
      .returning();

    if (!deleted) {
      reply.code(404);
      return { error: 'Invitation not found' };
    }

    reply.code(204);
    return;
  });

  // PATCH /api/teams/:id/members/:userId — update a member's role
  // admins+ can update roles
  app.patch('/:id/members/:userId', { preHandler: [requireRole({ minimumRole: 'admin', source: 'team' })] }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    const { role } = request.body as {
      role: 'owner' | 'admin' | 'developer' | 'editor' | 'viewer';
    };

    const [updated] = await db
      .update(teamMembers)
      .set({ role })
      .where(
        and(eq(teamMembers.teamId, id), eq(teamMembers.userId, userId))
      )
      .returning();

    if (!updated) {
      reply.code(404);
      return { error: 'Team member not found' };
    }

    return updated;
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
