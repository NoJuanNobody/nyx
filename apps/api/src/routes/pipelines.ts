import type { FastifyPluginAsync } from 'fastify';
import {
  hasPipelineAccess,
  activatePipeline,
  listOwnedPipelines,
} from '../services/pipeline-access.service.js';

export const pipelineRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /owned — list pipelines the user has already activated ──
  fastify.get('/owned', async (request) => {
    const userId = request.user?.id;
    if (!userId) {
      throw { statusCode: 401, message: 'Authentication required' };
    }

    const pipelines = await listOwnedPipelines(userId);
    return { pipelines };
  });

  // ── POST /activate — activate a pipeline (first-time charges credits) ──
  fastify.post<{
    Body: {
      pipelineId: string;
      pipelineLabel: string;
      creditCost: number;
      teamId?: string;
    };
  }>('/activate', async (request) => {
    const userId = request.user?.id;
    if (!userId) {
      throw { statusCode: 401, message: 'Authentication required' };
    }

    const { pipelineId, pipelineLabel, creditCost, teamId } = request.body;

    if (!pipelineId || !pipelineLabel || creditCost == null) {
      throw { statusCode: 400, message: 'pipelineId, pipelineLabel, and creditCost are required' };
    }

    const result = await activatePipeline(userId, pipelineId, pipelineLabel, creditCost, teamId);
    return result;
  });

  // ── GET /check/:pipelineId — check if user owns a specific pipeline ──
  fastify.get<{
    Params: { pipelineId: string };
  }>('/check/:pipelineId', async (request) => {
    const userId = request.user?.id;
    if (!userId) {
      throw { statusCode: 401, message: 'Authentication required' };
    }

    const { pipelineId } = request.params;
    const owned = await hasPipelineAccess(userId, pipelineId);
    return { owned };
  });
};
