import type { FastifyPluginAsync } from 'fastify';
import { eq, and, sql, gte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { teamAiKeys, aiUsageLog, subscriptions, teams } from '../db/schema.js';
import { requireRole } from '../middleware/permissions.js';
import { encrypt, decrypt } from '../services/encryption.service.js';
import { config } from '../lib/config.js';
import { invalidateTeamClient } from '../services/ai.service.js';

const BYOK_ELIGIBLE_PLANS = ['team', 'enterprise'];

async function getTeamPlan(teamId: string): Promise<string> {
  const [sub] = await db
    .select({ plan: subscriptions.plan })
    .from(subscriptions)
    .where(eq(subscriptions.teamId, teamId))
    .limit(1);
  return sub?.plan ?? 'free';
}

function getEncryptionSecret(): string {
  const secret = config.BYOK_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error('BYOK_ENCRYPTION_SECRET is not configured');
  }
  return secret;
}

export const aiKeyRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/teams/:id/ai-key — validate and store an encrypted API key
  app.post('/:id/ai-key', {
    preHandler: [requireRole({ minimumRole: 'admin', source: 'team' })],
  }, async (request, reply) => {
    const { id: teamId } = request.params as { id: string };
    const { provider, apiKey } = request.body as { provider: string; apiKey: string };

    if (!provider || !apiKey) {
      return reply.code(400).send({ error: 'provider and apiKey are required' });
    }

    // Tier gate
    const plan = await getTeamPlan(teamId);
    if (!BYOK_ELIGIBLE_PLANS.includes(plan)) {
      return reply.code(403).send({
        error: 'BYOK is available on Team and Enterprise plans.',
      });
    }

    // Check for existing key
    const [existing] = await db
      .select({ id: teamAiKeys.id })
      .from(teamAiKeys)
      .where(and(eq(teamAiKeys.teamId, teamId), eq(teamAiKeys.provider, provider)))
      .limit(1);

    if (existing) {
      return reply.code(409).send({
        error: 'A key for this provider already exists. Use PUT to rotate.',
      });
    }

    // Encrypt and store
    const secret = getEncryptionSecret();
    const { ciphertext, iv } = encrypt(apiKey, secret);
    const keySuffix = apiKey.slice(-4);

    const [row] = await db
      .insert(teamAiKeys)
      .values({
        teamId,
        provider,
        encryptedKey: ciphertext,
        keyIv: iv,
        keySuffix,
        createdBy: request.user.id,
      })
      .returning();

    reply.code(201);
    return {
      provider: row.provider,
      keySuffix: row.keySuffix,
      isActive: row.isActive,
      createdAt: row.createdAt,
    };
  });

  // GET /api/teams/:id/ai-key — get key status (never the key itself)
  app.get('/:id/ai-key', {
    preHandler: [requireRole({ minimumRole: 'viewer', source: 'team' })],
  }, async (request) => {
    const { id: teamId } = request.params as { id: string };

    const [key] = await db
      .select({
        provider: teamAiKeys.provider,
        keySuffix: teamAiKeys.keySuffix,
        isActive: teamAiKeys.isActive,
        createdAt: teamAiKeys.createdAt,
        rotatedAt: teamAiKeys.rotatedAt,
      })
      .from(teamAiKeys)
      .where(and(eq(teamAiKeys.teamId, teamId), eq(teamAiKeys.isActive, true)))
      .limit(1);

    // Per-team model preferences live on the teams table.
    const [team] = await db
      .select({ defaultModel: teams.defaultModel, fastModel: teams.fastModel })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);

    const defaultModel = team?.defaultModel ?? null;
    const fastModel = team?.fastModel ?? null;

    if (!key) {
      return { configured: false, defaultModel, fastModel };
    }

    return {
      configured: true,
      provider: key.provider,
      keySuffix: key.keySuffix,
      isActive: key.isActive,
      createdAt: key.createdAt,
      rotatedAt: key.rotatedAt,
      defaultModel,
      fastModel,
    };
  });

  // PUT /api/teams/:id/model — update per-team LLM model preferences
  app.put('/:id/model', {
    preHandler: [requireRole({ minimumRole: 'admin', source: 'team' })],
  }, async (request) => {
    const { id: teamId } = request.params as { id: string };
    const body = request.body as { defaultModel?: string | null; fastModel?: string | null };

    // Partial update: only set the fields the caller actually provided.
    const updates: { defaultModel?: string | null; fastModel?: string | null } = {};
    if ('defaultModel' in body) updates.defaultModel = body.defaultModel ?? null;
    if ('fastModel' in body) updates.fastModel = body.fastModel ?? null;

    const [updated] = await db
      .update(teams)
      .set(updates)
      .where(eq(teams.id, teamId))
      .returning({ defaultModel: teams.defaultModel, fastModel: teams.fastModel });

    return {
      defaultModel: updated?.defaultModel ?? null,
      fastModel: updated?.fastModel ?? null,
    };
  });

  // PUT /api/teams/:id/ai-key — rotate (replace) the key
  app.put('/:id/ai-key', {
    preHandler: [requireRole({ minimumRole: 'admin', source: 'team' })],
  }, async (request, reply) => {
    const { id: teamId } = request.params as { id: string };
    const { apiKey } = request.body as { apiKey: string };

    if (!apiKey) {
      return reply.code(400).send({ error: 'apiKey is required' });
    }

    // Find existing active key
    const [existing] = await db
      .select({ id: teamAiKeys.id, provider: teamAiKeys.provider })
      .from(teamAiKeys)
      .where(and(eq(teamAiKeys.teamId, teamId), eq(teamAiKeys.isActive, true)))
      .limit(1);

    if (!existing) {
      return reply.code(404).send({ error: 'No active key found to rotate' });
    }

    const secret = getEncryptionSecret();
    const { ciphertext, iv } = encrypt(apiKey, secret);
    const keySuffix = apiKey.slice(-4);

    const [updated] = await db
      .update(teamAiKeys)
      .set({
        encryptedKey: ciphertext,
        keyIv: iv,
        keySuffix,
        rotatedAt: new Date(),
      })
      .where(eq(teamAiKeys.id, existing.id))
      .returning();

    // Invalidate cached AI client for this team
    invalidateTeamClient(teamId);

    return {
      provider: updated.provider,
      keySuffix: updated.keySuffix,
      isActive: updated.isActive,
      rotatedAt: updated.rotatedAt,
    };
  });

  // DELETE /api/teams/:id/ai-key — remove the key, revert to SyncDocs-managed
  app.delete('/:id/ai-key', {
    preHandler: [requireRole({ minimumRole: 'admin', source: 'team' })],
  }, async (request, reply) => {
    const { id: teamId } = request.params as { id: string };

    const [deleted] = await db
      .delete(teamAiKeys)
      .where(and(eq(teamAiKeys.teamId, teamId), eq(teamAiKeys.isActive, true)))
      .returning();

    if (!deleted) {
      return reply.code(404).send({ error: 'No active key found' });
    }

    // Invalidate cached AI client for this team
    invalidateTeamClient(teamId);

    reply.code(204);
    return;
  });

  // GET /api/teams/:id/ai-usage — usage stats
  app.get('/:id/ai-usage', {
    preHandler: [requireRole({ minimumRole: 'admin', source: 'team' })],
  }, async (request) => {
    const { id: teamId } = request.params as { id: string };
    const query = request.query as { period?: string };
    const days = parseInt(query.period?.replace('d', '') ?? '30', 10) || 30;
    const since = new Date();
    since.setDate(since.getDate() - days);

    // Aggregate by operation
    const rows = await db
      .select({
        operation: aiUsageLog.operation,
        inputTokens: sql<number>`sum(${aiUsageLog.inputTokens})::int`,
        outputTokens: sql<number>`sum(${aiUsageLog.outputTokens})::int`,
        keySource: aiUsageLog.keySource,
      })
      .from(aiUsageLog)
      .where(and(eq(aiUsageLog.teamId, teamId), gte(aiUsageLog.createdAt, since)))
      .groupBy(aiUsageLog.operation, aiUsageLog.keySource);

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const byOperation: Array<{ operation: string; inputTokens: number; outputTokens: number }> = [];
    let keySource: string | null = null;

    for (const row of rows) {
      totalInputTokens += row.inputTokens;
      totalOutputTokens += row.outputTokens;
      if (row.keySource) keySource = row.keySource;

      const existing = byOperation.find((o) => o.operation === row.operation);
      if (existing) {
        existing.inputTokens += row.inputTokens;
        existing.outputTokens += row.outputTokens;
      } else {
        byOperation.push({
          operation: row.operation,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
        });
      }
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      keySource,
      byOperation,
    };
  });
};
