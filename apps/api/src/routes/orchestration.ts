import type { FastifyPluginAsync } from 'fastify';
import { orchestrationService } from '../services/orchestration.service.js';

export const orchestrationRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/orchestration/pipelines — create a pipeline
  app.post('/pipelines', async (request, reply) => {
    const { teamId, documentId, name, steps } = request.body as {
      teamId?: string;
      documentId?: string;
      name?: string;
      steps?: Array<{ name: string; workflowId: string; dependsOn?: string[] }>;
    };

    if (!teamId || !documentId || !name || !steps?.length) {
      reply.code(400);
      return { error: 'teamId, documentId, name, and steps are required' };
    }

    const pipeline = orchestrationService.createPipeline({ teamId, documentId, name, steps });
    reply.code(201);
    return pipeline;
  });

  // GET /api/orchestration/pipelines?teamId=X — list pipelines for team
  app.get('/pipelines', async (request, reply) => {
    const { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId query parameter is required' };
    }

    return orchestrationService.listPipelines(teamId);
  });

  // GET /api/orchestration/pipelines/:id — get pipeline details
  app.get('/pipelines/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const pipeline = orchestrationService.getPipeline(id);

    if (!pipeline) {
      reply.code(404);
      return { error: 'Pipeline not found' };
    }

    return pipeline;
  });

  // POST /api/orchestration/pipelines/:id/steps/:stepId/claim — claim a step
  app.post('/pipelines/:id/steps/:stepId/claim', async (request, reply) => {
    const { id, stepId } = request.params as { id: string; stepId: string };
    const { sessionId } = request.body as { sessionId?: string };

    if (!sessionId) {
      reply.code(400);
      return { error: 'sessionId is required' };
    }

    const result = orchestrationService.claimStep(id, stepId, sessionId);
    if (!result.claimed) {
      reply.code(409);
    }
    return result;
  });

  // POST /api/orchestration/pipelines/:id/steps/:stepId/complete — complete a step
  app.post('/pipelines/:id/steps/:stepId/complete', async (request, reply) => {
    const { id, stepId } = request.params as { id: string; stepId: string };
    const { sessionId, output } = request.body as { sessionId?: string; output?: unknown };

    if (!sessionId) {
      reply.code(400);
      return { error: 'sessionId is required' };
    }

    const result = orchestrationService.completeStep(id, stepId, sessionId, output);
    if (!result.completed) {
      reply.code(409);
    }
    return result;
  });

  // POST /api/orchestration/pipelines/:id/steps/:stepId/fail — fail a step
  app.post('/pipelines/:id/steps/:stepId/fail', async (request, reply) => {
    const { id, stepId } = request.params as { id: string; stepId: string };
    const { sessionId, error } = request.body as { sessionId?: string; error?: string };

    if (!sessionId || !error) {
      reply.code(400);
      return { error: 'sessionId and error are required' };
    }

    orchestrationService.failStep(id, stepId, sessionId, error);
    return { failed: true };
  });

  // GET /api/orchestration/pipelines/:id/state — get shared state
  app.get('/pipelines/:id/state', async (request) => {
    const { id } = request.params as { id: string };
    return orchestrationService.getSharedState(id);
  });

  // PUT /api/orchestration/pipelines/:id/state — update shared state
  app.put('/pipelines/:id/state', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { key, value } = request.body as { key?: string; value?: unknown };

    if (!key) {
      reply.code(400);
      return { error: 'key is required' };
    }

    orchestrationService.updateSharedState(id, key, value);
    return { updated: true };
  });

  // GET /api/orchestration/locks/:documentId — check document lock status
  app.get('/locks/:documentId', async (request) => {
    const { documentId } = request.params as { documentId: string };
    const lock = orchestrationService.getLock(documentId);
    return { locked: !!lock, lock };
  });
};
