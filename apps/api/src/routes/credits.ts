import type { FastifyPluginAsync } from 'fastify';
import {
  getBalance,
  deductCredits,
  getTransactionHistory,
  CREDIT_COSTS,
} from '../services/credits.service.js';
import { createCreditPackCheckoutSession, CREDIT_PACK_PRICES } from '../services/stripe.service.js';

export const CREDIT_PACKS = [
  { id: 'starter', name: 'Starter', credits: 50, priceUsd: 5, popular: false },
  { id: 'growth', name: 'Growth', credits: 200, priceUsd: 15, popular: true },
  { id: 'pro', name: 'Pro', credits: 500, priceUsd: 30, popular: false },
  { id: 'enterprise', name: 'Enterprise', credits: 2000, priceUsd: 100, popular: false },
];

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

  // ── POST /purchase — initiate Stripe Checkout for a credit pack ──
  fastify.post('/purchase', async (request, reply) => {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401);
      return { error: 'Authentication required' };
    }

    const { packId } = request.body as { packId?: string };
    if (!packId) {
      reply.code(400);
      return { error: 'packId is required' };
    }

    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) {
      reply.code(400);
      return { error: 'Invalid credit pack' };
    }

    const priceId = CREDIT_PACK_PRICES[pack.id];
    const origin = (request.headers['origin'] as string) || 'http://localhost:5173';
    const checkoutUrl = await createCreditPackCheckoutSession(
      userId,
      pack.id,
      pack.credits,
      priceId,
      `${origin}/billing?checkout=success`,
      `${origin}/billing?checkout=cancel`,
    );
    return { checkoutUrl, pack };
  });

  // ── GET /costs — returns credit cost configuration ──
  fastify.get('/costs', async () => {
    return { costs: CREDIT_COSTS };
  });

  // ── GET /packs — returns available credit packs ──
  fastify.get('/packs', async () => {
    return { packs: CREDIT_PACKS };
  });
};
