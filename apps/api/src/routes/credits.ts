import type { FastifyPluginAsync } from 'fastify';
import {
  getBalance,
  deductCredits,
  getTransactionHistory,
  getTeamBalance,
  CREDIT_COSTS,
} from '../services/credits.service.js';

export const creditRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /balance — returns current credit balance ───
  fastify.get('/balance', async (request) => {
    const userId = request.user?.id;
    if (!userId) {
      throw { statusCode: 401, message: 'Authentication required' };
    }

    const balance = await getBalance(userId);
    return { balance };
  });

  // ── GET /transactions — returns transaction history ─
  fastify.get<{
    Querystring: { limit?: string };
  }>('/transactions', async (request) => {
    const userId = request.user?.id;
    if (!userId) {
      throw { statusCode: 401, message: 'Authentication required' };
    }

    const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;
    const transactions = await getTransactionHistory(userId, limit);
    return { transactions };
  });

  // ── POST /deduct — deduct credits (internal/testing) ─
  fastify.post<{
    Body: {
      amount: number;
      taskType: string;
      description: string;
    };
  }>('/deduct', async (request) => {
    const userId = request.user?.id;
    if (!userId) {
      throw { statusCode: 401, message: 'Authentication required' };
    }

    const { amount, taskType, description } = request.body;

    if (!amount || !taskType || !description) {
      throw { statusCode: 400, message: 'amount, taskType, and description are required' };
    }

    const result = await deductCredits(userId, amount, taskType, description);
    return result;
  });

  // TODO(AI-58): credit purchase paths and plan-based credit grants are removed;
  // credits are agent-native utility tokens and are never sold. AI-58 defines the
  // remaining grant/metering flow.

  // ── GET /costs — returns credit cost configuration ──
  fastify.get('/costs', async () => {
    return { costs: CREDIT_COSTS };
  });

  // ── GET /team-balance — returns team credit pool balance ──
  fastify.get<{
    Querystring: { teamId: string };
  }>('/team-balance', async (request) => {
    if (!request.user) {
      throw { statusCode: 401, message: 'Authentication required' };
    }
    const { teamId } = request.query;
    if (!teamId) {
      throw { statusCode: 400, message: 'teamId is required' };
    }
    const balance = await getTeamBalance(teamId);
    return { teamId, balance };
  });
};
