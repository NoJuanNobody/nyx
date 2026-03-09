import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/index.js';
import { waitlistSignups } from '../db/schema.js';

export const waitlistRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/waitlist — submit email for waitlist (no auth required)
  app.post('/', async (request, reply) => {
    const { email } = request.body as { email?: string };

    if (!email || !email.includes('@')) {
      reply.code(400);
      return { error: 'Valid email is required' };
    }

    try {
      await db
        .insert(waitlistSignups)
        .values({ email: email.toLowerCase().trim() })
        .onConflictDoNothing();
    } catch {
      // Ignore duplicate
    }

    reply.code(201);
    return { ok: true };
  });
};
