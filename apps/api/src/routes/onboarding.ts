import type { FastifyPluginAsync } from 'fastify';
import { onboardingService } from '../services/onboarding.service.js';
import { githubService } from '../services/github.service.js';
import { config } from '../lib/config.js';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';

/**
 * Default lifecycle stage for documents created by the repo scan flow.
 *
 * Scanned docs are AI-generated from source code that already exists, so
 * `implementation` is the natural default — these are reverse-engineered
 * descriptions of code that has already been built.
 *
 * Centralized here so future changes only touch one site.
 */
const SCAN_DEFAULT_STAGE = 'implementation';

export const onboardingRoutes: FastifyPluginAsync = async (app) => {
  app.post('/scan', async (request, reply) => {
    const { owner, repo, teamId } = request.body as { owner: string; repo: string; teamId: string };

    if (!owner || !repo) {
      reply.code(400);
      return { error: 'owner and repo are required' };
    }

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId is required' };
    }

    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    // Try stored GitHub integration token first
    let accessToken: string | null = null;
    accessToken = await githubService.getGitHubTokenForTeam(teamId);

    // Fall back to header token in development only
    if (!accessToken) {
      if (config.NODE_ENV === 'production') {
        reply.code(400);
        return { error: 'No GitHub integration configured for this team. Connect GitHub in Settings.' };
      }
      accessToken = (request.headers['x-github-token'] as string) ?? '';
    }

    if (!accessToken) {
      reply.code(400);
      return { error: 'x-github-token header is required (dev mode)' };
    }

    const result = await onboardingService.scanRepository(accessToken, owner, repo);

    // Auto-save documents to DB.
    //
    // Bulk-insert every module doc and the merged overview in a single
    // round-trip. Ordering matters: the response `documents` array must
    // list per-module docs (in the same order as `result.moduleDocs`)
    // followed by the overview. Every row preserves the
    // `stage: SCAN_DEFAULT_STAGE` default from #342.
    const basePath = `/repos/${owner}/${repo}`;

    const moduleRows = result.moduleDocs.map(({ module: moduleName, docs }) => ({
      title: moduleName,
      content: docs,
      path: basePath,
      teamId,
      createdById: userId,
      stage: SCAN_DEFAULT_STAGE,
    }));

    const overviewRow = {
      title: `${owner}/${repo} Overview`,
      content: result.suggestedDocs,
      path: basePath,
      teamId,
      createdById: userId,
      stage: SCAN_DEFAULT_STAGE,
    };

    const insertedDocs = await db
      .insert(documents)
      .values([...moduleRows, overviewRow])
      .returning();

    const savedDocs: Array<{ id: string; title: string; path: string }> = insertedDocs.map(
      (doc) => ({ id: doc.id, title: doc.title, path: doc.path }),
    );

    return {
      documents: savedDocs,
      moduleCount: result.moduleCount,
      fileCount: result.fileCount,
    };
  });

  app.get('/progress', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }
    const completedSteps = await onboardingService.getProgress(userId);
    return { completedSteps };
  });

  app.post('/progress/:step', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }
    const { step } = request.params as { step: string };
    const validSteps = ['repo-connected', 'first-doc-created', 'board-visited', 'first-ticket-generated', 'observability-visited'];
    if (!validSteps.includes(step)) {
      reply.code(400);
      return { error: 'Invalid step key' };
    }
    await onboardingService.markStepComplete(userId, step);
    reply.code(204);
    return;
  });
};
