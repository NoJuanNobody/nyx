import type { FastifyPluginAsync } from 'fastify';
import { feedbackService } from '../services/feedback.service.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export const feedbackRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/feedback/format — AI-format raw feedback for preview
  app.post('/format', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const { message } = request.body as { message: string };

    if (!message || !message.trim()) {
      reply.code(400);
      return { error: 'message is required' };
    }

    if (message.length > 5000) {
      reply.code(400);
      return { error: 'message must be under 5000 characters' };
    }

    const formatted = await feedbackService.formatFeedback(message.trim());
    return formatted;
  });

  // POST /api/feedback/submit — submit formatted feedback as GitHub issue
  app.post('/submit', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const { rawMessage, title, body, category } = request.body as {
      rawMessage: string;
      title: string;
      body: string;
      category: string;
    };

    if (!rawMessage || !title || !body || !category) {
      reply.code(400);
      return { error: 'rawMessage, title, body, and category are required' };
    }

    // Rate limit check
    const rateLimit = await feedbackService.checkRateLimit(userId);
    if (!rateLimit.allowed) {
      reply.code(429);
      return { error: 'Rate limit exceeded. Maximum 5 feedback submissions per day.', remaining: 0 };
    }

    // Get user info for the issue metadata
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const userName = user?.name ?? 'Unknown';
    const userEmail = user?.email ?? 'unknown';

    // Submit to GitHub
    let githubIssueUrl: string | undefined;
    let githubIssueNumber: number | undefined;

    try {
      const result = await feedbackService.submitToGitHub(title, body, category, userName, userEmail);
      githubIssueUrl = result.issueUrl;
      githubIssueNumber = result.issueNumber;
    } catch (err) {
      // Log error but still save feedback locally
      app.log.error(err, 'Failed to submit feedback to GitHub');
    }

    // Save to database
    const record = await feedbackService.saveFeedback(
      userId,
      rawMessage,
      title,
      body,
      category,
      githubIssueUrl,
      githubIssueNumber,
    );

    return {
      id: record.id,
      githubIssueUrl: githubIssueUrl ?? null,
      remaining: rateLimit.remaining - 1,
    };
  });
};
