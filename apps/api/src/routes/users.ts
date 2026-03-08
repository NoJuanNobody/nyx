import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { createClerkClient } from '@clerk/backend';
import { db } from '../db/index.js';
import { users, teamMembers } from '../db/schema.js';
import { config } from '../lib/config.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  // PATCH /api/users/me — update the current user's name/email
  app.patch('/me', async (request, reply) => {
    const userId = request.user.id;
    const { name, email } = request.body as { name?: string; email?: string };

    const updates: Partial<typeof users.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;

    const [updated] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, userId))
      .returning();

    if (!updated) {
      reply.code(404);
      return { error: 'User not found' };
    }

    return updated;
  });

  // DELETE /api/users/me — delete the current user's account
  app.delete('/me', async (request, reply) => {
    const userId = request.user.id;
    const clerkId = request.user.clerkId;

    // Remove all team memberships
    await db
      .delete(teamMembers)
      .where(eq(teamMembers.userId, userId));

    // Delete the user record
    await db
      .delete(users)
      .where(eq(users.id, userId));

    // If Clerk is active, delete the Clerk user too
    if (clerkId && config.CLERK_SECRET_KEY) {
      try {
        const clerk = createClerkClient({ secretKey: config.CLERK_SECRET_KEY });
        await clerk.users.deleteUser(clerkId);
      } catch (err) {
        // Log but don't fail — the local record is already deleted
        request.log.error(err, 'Failed to delete Clerk user');
      }
    }

    reply.code(204);
    return;
  });
};
