import type { FastifyPluginAsync } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { intakeSessions } from '../db/schema.js';
import { intakeService } from '../services/intake.service.js';

export const intakeRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/intake/process — transform raw input into structured spec
  app.post('/process', async (request, reply) => {
    const { rawInput, teamId } = request.body as { rawInput: string; teamId: string };

    if (!rawInput || !teamId) {
      reply.code(400);
      return { error: 'rawInput and teamId are required' };
    }

    const userId = (request as unknown as { user?: { id: string } }).user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const result = await intakeService.processRawInput(rawInput, teamId, userId);

    // Save session to DB
    const [session] = await db
      .insert(intakeSessions)
      .values({
        teamId,
        createdById: userId,
        rawInput,
        structuredOutput: result,
        status: result.confidence === 'low' ? 'clarification_needed' : 'processed',
      })
      .returning();

    return { session, spec: result };
  });

  // POST /api/intake/clarify — re-process with clarifications
  app.post('/clarify', async (request, reply) => {
    const { rawInput, questions, answers, teamId } = request.body as {
      rawInput: string;
      questions: string[];
      answers: string[];
      teamId: string;
    };

    if (!rawInput || !questions || !answers || !teamId) {
      reply.code(400);
      return { error: 'rawInput, questions, answers, and teamId are required' };
    }

    const userId = (request as unknown as { user?: { id: string } }).user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const result = await intakeService.processWithClarifications(
      rawInput,
      questions,
      answers,
      teamId,
      userId,
    );

    // Save new session
    const [session] = await db
      .insert(intakeSessions)
      .values({
        teamId,
        createdById: userId,
        rawInput,
        structuredOutput: result,
        status: result.confidence === 'low' ? 'clarification_needed' : 'processed',
      })
      .returning();

    return { session, spec: result };
  });

  // GET /api/intake/history — list past intake sessions for a team
  app.get('/history', async (request, reply) => {
    const { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId query parameter is required' };
    }

    const sessions = await db
      .select()
      .from(intakeSessions)
      .where(eq(intakeSessions.teamId, teamId))
      .orderBy(desc(intakeSessions.createdAt));

    return { sessions };
  });
};
