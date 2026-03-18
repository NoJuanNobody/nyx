import type { FastifyPluginAsync } from 'fastify';
import {
  getBalance,
  addCredits,
  deductCredits,
  getTransactionHistory,
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

  // ── POST /purchase — add credits to user account ────
  fastify.post('/purchase', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const { amount } = request.body as { amount?: number };
    if (!amount || amount <= 0 || !Number.isInteger(amount)) {
      reply.code(400);
      return { error: 'amount must be a positive integer' };
    }

    // In production, this would verify a Stripe payment first
    const { balance } = await addCredits(userId, amount, `Purchased ${amount} credits`);
    return { balance, added: amount };
  });

  // ── GET /costs — returns credit cost configuration ──
  fastify.get('/costs', async () => {
    return { costs: CREDIT_COSTS };
  });
};
