/**
 * Credit metering tools (AI-57).
 *
 * Credits are agent-native utility tokens: metered and spent by external
 * agents, never sold. There is intentionally no purchase/checkout/plan tool.
 * Contract: docs/credits/utility-tokens-spec.md (sections 3 and 5).
 *
 * HTTP contract assumed from the API (AI-58, apps/api/src/routes/credits.ts):
 *   GET  /api/credits/balance?agentId=   -> balance object
 *   POST /api/credits/reserve            { idempotencyKey, agentId, amount, taskType?, ttlMs?, memo? }
 *   POST /api/credits/commit             { idempotencyKey, reservationId, actualAmount, memo? }
 *   POST /api/credits/release            { idempotencyKey, reservationId, memo? }
 *   POST /api/credits/spend              { idempotencyKey, agentId, amount, taskType?, memo? }
 * Every POST also carries an `Idempotency-Key` header. Errors are JSON bodies
 * such as { error: 'insufficient_credits', available, required }.
 */
import { z } from 'zod';
import type { ToolDefinition } from '@nyx/harness-core';
import { apiRequest, getConfig } from './auth.js';

const idempotencyKey = z
  .string()
  .min(8)
  .max(200)
  .describe('Caller-chosen key; reuse the same key to safely retry. Use your tool-call id.');
const agentId = z
  .string()
  .regex(/^[^\s:]+$/, 'agent_id must not contain whitespace or ":"')
  .optional()
  .describe('Agent identity; defaults to NYX_AGENT_ID or "default".');
const amount = z.number().int().positive().describe('Whole credits (> 0).');

export const creditSchemas = {
  nyx_credits_balance: z.object({ agent_id: agentId }).strict(),
  nyx_credits_reserve: z
    .object({
      idempotency_key: idempotencyKey,
      agent_id: agentId,
      amount,
      task_type: z.string().min(1).max(100).optional(),
      ttl_ms: z.number().int().positive().optional(),
      memo: z.string().max(500).optional(),
    })
    .strict(),
  nyx_credits_commit: z
    .object({
      idempotency_key: idempotencyKey,
      reservation_id: z.string().min(1),
      actual_amount: z.number().int().nonnegative().describe('Actual cost; must be <= reserved.'),
      memo: z.string().max(500).optional(),
    })
    .strict(),
  nyx_credits_release: z
    .object({
      idempotency_key: idempotencyKey,
      reservation_id: z.string().min(1),
      memo: z.string().max(500).optional(),
    })
    .strict(),
  nyx_credits_spend: z
    .object({
      idempotency_key: idempotencyKey,
      agent_id: agentId,
      amount,
      task_type: z.string().min(1).max(100).optional(),
      memo: z.string().max(500).optional(),
    })
    .strict(),
} as const;

export type CreditToolName = keyof typeof creditSchemas;

export const CREDIT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'nyx_credits_balance',
    description:
      'Show the spendable credit balance of an agent (and held/pool amounts when reported). Credits are utility tokens, never sold.',
    inputSchema: {
      type: 'object',
      properties: { agent_id: { type: 'string', description: 'Agent identity (default: "default")' } },
    },
  },
  {
    name: 'nyx_credits_reserve',
    description:
      'Hold credits for an in-flight operation. Returns a reservation id to commit or release. Fails with insufficient_credits (available, required) when the budget is too low.',
    inputSchema: {
      type: 'object',
      properties: {
        idempotency_key: { type: 'string', description: 'Retry-safe key (min 8 chars)' },
        agent_id: { type: 'string' },
        amount: { type: 'integer', minimum: 1, description: 'Max credits to hold' },
        task_type: { type: 'string' },
        ttl_ms: { type: 'integer', minimum: 1, description: 'Hold expiry in ms' },
        memo: { type: 'string' },
      },
      required: ['idempotency_key', 'amount'],
    },
  },
  {
    name: 'nyx_credits_commit',
    description:
      'Settle a reservation with the actual cost (<= reserved); the remainder returns to the agent budget.',
    inputSchema: {
      type: 'object',
      properties: {
        idempotency_key: { type: 'string' },
        reservation_id: { type: 'string' },
        actual_amount: { type: 'integer', minimum: 0 },
        memo: { type: 'string' },
      },
      required: ['idempotency_key', 'reservation_id', 'actual_amount'],
    },
  },
  {
    name: 'nyx_credits_release',
    description: 'Cancel a reservation (operation failed or was cancelled); all held credits return to the agent budget.',
    inputSchema: {
      type: 'object',
      properties: {
        idempotency_key: { type: 'string' },
        reservation_id: { type: 'string' },
        memo: { type: 'string' },
      },
      required: ['idempotency_key', 'reservation_id'],
    },
  },
  {
    name: 'nyx_credits_spend',
    description: 'One-shot spend of a known cost (reserve + commit in a single call).',
    inputSchema: {
      type: 'object',
      properties: {
        idempotency_key: { type: 'string' },
        agent_id: { type: 'string' },
        amount: { type: 'integer', minimum: 1 },
        task_type: { type: 'string' },
        memo: { type: 'string' },
      },
      required: ['idempotency_key', 'amount'],
    },
  },
];

export function isCreditTool(name: string): name is CreditToolName {
  return Object.prototype.hasOwnProperty.call(creditSchemas, name);
}

function resolveAgent(explicit?: string): string {
  return explicit ?? process.env.NYX_AGENT_ID ?? 'default';
}

async function post<T>(path: string, key: string, body: Record<string, unknown>): Promise<T> {
  return apiRequest<T>(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({ idempotencyKey: key, ...body }),
  });
}

/** Validate args with zod and call the credits API. Throws on invalid input or API error. */
export async function executeCreditTool(name: CreditToolName, rawArgs: unknown): Promise<unknown> {
  const parsed = creditSchemas[name].safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ');
    throw new Error(`Invalid arguments for ${name}: ${msg}`);
  }
  const a = parsed.data as Record<string, unknown>;
  getConfig(); // fail early with a clear message when not configured

  switch (name) {
    case 'nyx_credits_balance':
      return apiRequest(`/api/credits/balance?agentId=${encodeURIComponent(resolveAgent(a.agent_id as string | undefined))}`);
    case 'nyx_credits_reserve':
      return post('/api/credits/reserve', a.idempotency_key as string, {
        agentId: resolveAgent(a.agent_id as string | undefined),
        amount: a.amount,
        taskType: a.task_type,
        ttlMs: a.ttl_ms,
        memo: a.memo,
      });
    case 'nyx_credits_commit':
      return post('/api/credits/commit', a.idempotency_key as string, {
        reservationId: a.reservation_id,
        actualAmount: a.actual_amount,
        memo: a.memo,
      });
    case 'nyx_credits_release':
      return post('/api/credits/release', a.idempotency_key as string, {
        reservationId: a.reservation_id,
        memo: a.memo,
      });
    case 'nyx_credits_spend':
      return post('/api/credits/spend', a.idempotency_key as string, {
        agentId: resolveAgent(a.agent_id as string | undefined),
        amount: a.amount,
        taskType: a.task_type,
        memo: a.memo,
      });
  }
}
