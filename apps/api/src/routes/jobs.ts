import type { FastifyPluginAsync } from 'fastify';
import { jobService } from '../services/job.service.js';

export const jobRoutes: FastifyPluginAsync = async (app) => {
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
