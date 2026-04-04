import type { FastifyPluginAsync } from 'fastify';
import { jobService } from '../services/job.service.js';

export const jobRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/teams/:teamId/jobs — list background jobs for a team
  app.get('/teams/:teamId/jobs', async (request) => {
    const { teamId } = request.params as { teamId: string };
    const { limit } = (request.query as { limit?: string }) ?? {};
    const jobs = await jobService.listByTeam(teamId, limit ? parseInt(limit, 10) : undefined);
    return { teamId, jobs };
  });

  // GET /api/jobs/:jobId — get background job status
  app.get('/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = await jobService.getById(jobId);

    if (!job) {
      reply.code(404);
      return { error: 'Job not found' };
    }

    return job;
  });
};
