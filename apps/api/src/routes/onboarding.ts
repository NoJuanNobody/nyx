import type { FastifyPluginAsync } from 'fastify';
import { onboardingService } from '../services/onboarding.service.js';
import { githubService } from '../services/github.service.js';
import { config } from '../lib/config.js';

export const onboardingRoutes: FastifyPluginAsync = async (app) => {
  app.post('/scan', async (request, reply) => {
    const { owner, repo, teamId } = request.body as { owner: string; repo: string; teamId?: string };

    if (!owner || !repo) {
      reply.code(400);
      return { error: 'owner and repo are required' };
    }

    // Try stored GitHub integration token first
    let accessToken: string | null = null;
    if (teamId) {
      accessToken = await githubService.getGitHubTokenForTeam(teamId);
    }

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
    return result;
  });
};
