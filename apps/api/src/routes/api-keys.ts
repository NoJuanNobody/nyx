import type { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { randomBytes, createHash } from 'node:crypto';
import { db } from '../db/index.js';
import { apiKeys } from '../db/schema.js';

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function generateApiKey(): { fullKey: string; prefix: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  const fullKey = `sd_${raw}`;
  const prefix = fullKey.slice(0, 10);
  const hash = hashKey(fullKey);
  return { fullKey, prefix, hash };
}

export const apiKeyRoutes: FastifyPluginAsync = async (fastify) => {
  // ── List API keys for team ──────────────────────────────
  fastify.get<{ Querystring: { teamId: string } }>('/', async (request) => {
    const { teamId } = request.query;

    // Only admin/owner can manage API keys
    if (request.user.role !== 'owner' && request.user.role !== 'admin') {
      throw { statusCode: 403, message: 'Only admins and owners can manage API keys' };
    }

    const keys = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        scopes: apiKeys.scopes,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        revoked: apiKeys.revoked,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.teamId, teamId));

    return keys;
  });

  // ── Create API key ─────────────────────────────────────
  fastify.post<{
    Body: {
      teamId: string;
      name: string;
      scopes?: string[];
      expiresInDays?: number;
    };
  }>('/', async (request) => {
    const { teamId, name, scopes, expiresInDays } = request.body;
    const user = request.user;

    if (user.role !== 'owner' && user.role !== 'admin') {
      throw { statusCode: 403, message: 'Only admins and owners can create API keys' };
    }

    const { fullKey, prefix, hash } = generateApiKey();

    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const [key] = await db.insert(apiKeys).values({
      teamId,
      userId: user.id,
      name,
      keyHash: hash,
      keyPrefix: prefix,
      scopes: scopes ?? ['read', 'write'],
      expiresAt,
    }).returning();

    // Return full key only on creation — it's never shown again
    return {
      id: key.id,
      name: key.name,
      key: fullKey,
      keyPrefix: prefix,
      scopes: key.scopes,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
    };
  });

  // ── Revoke API key ─────────────────────────────────────
  fastify.delete<{ Params: { keyId: string } }>('/:keyId', async (request) => {
    const { keyId } = request.params;

    if (request.user.role !== 'owner' && request.user.role !== 'admin') {
      throw { statusCode: 403, message: 'Only admins and owners can revoke API keys' };
    }

    const [updated] = await db
      .update(apiKeys)
      .set({ revoked: true })
      .where(eq(apiKeys.id, keyId))
      .returning();

    if (!updated) {
      throw { statusCode: 404, message: 'API key not found' };
    }

    return { revoked: true };
  });
};
