/**
 * Credit HTTP API (AI-58). Credits are agent-native utility tokens: they are
 * granted by the workspace owner, allocated to named agents and metered with
 * reserve -> commit/release (or one-shot spend). Nothing here sells credits.
 *
 * This is the contract the MCP server and CLI (AI-57) build against.
 * Every mutating call needs an idempotency key (body `idempotencyKey` or the
 * `Idempotency-Key` header); retrying with the same key and payload replays the
 * original result (`replayed: true`). Agent identity: body/query `agentId` or
 * the `X-Nyx-Agent` header, default `default`. Workspace: the caller's own
 * unless `teamId` (body/query) names a team the caller belongs to.
 *
 *   GET  /balance?agentId&teamId   -> WorkspaceBalance + { agent?, balance }
 *   GET  /costs                    -> { costs }
 *   GET  /history?agentId&teamId&limit
 *   POST /reserve   { amount | taskType, ttlMs?, memo?, idempotencyKey }
 *   POST /commit    { reservationId, actualAmount, idempotencyKey }
 *   POST /release   { reservationId, idempotencyKey }
 *   POST /spend     { amount | taskType, memo?, idempotencyKey }
 *   POST /grant     { amount, idempotencyKey }          (owner)
 *   POST /allocate  { agentId, amount, idempotencyKey } (owner)
 *   POST /deallocate{ agentId, amount, idempotencyKey } (owner)
 *
 * Errors: { error, message, ... } with 402 insufficient_credits (+available,
 * required), 400 invalid_*, 404 *_not_found, 409 conflict codes.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  CREDIT_COSTS,
  LedgerError,
  getCreditsService,
  normalizeAgentId,
  teamWorkspace,
  userWorkspace,
  type CreditsService,
  type WorkspaceRef,
} from '../services/credits.service.js';

const STATUS: Record<string, number> = {
  INVALID_AMOUNT: 400,
  INVALID_INPUT: 400,
  INSUFFICIENT_CREDITS: 402,
  RESERVATION_NOT_FOUND: 404,
  ENTRY_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  RESERVATION_CLOSED: 409,
  RESERVATION_EXPIRED: 409,
  OVER_RESERVED: 422,
  NOT_A_COMMIT: 409,
  OVER_REFUND: 409,
  CHAIN_BROKEN: 500,
  INVARIANT_VIOLATION: 500,
};

type Json = Record<string, unknown>;

interface Ctx {
  svc: CreditsService;
  ws: WorkspaceRef;
  agentId: string;
  userId: string;
  body: Json;
  key: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export const creditRoutes: FastifyPluginAsync = async (fastify) => {
  async function context(request: FastifyRequest, reply: FastifyReply, mutating: boolean): Promise<Ctx | null> {
    const userId = request.user?.id;
    if (!userId) {
      reply.code(401).send({ error: 'unauthorized', message: 'Authentication required' });
      return null;
    }
    const body = ((request.body ?? {}) as Json) || {};
    const query = (request.query ?? {}) as Json;
    const teamId = str(body.teamId) ?? str(query.teamId);
    let ws = userWorkspace(userId);
    if (teamId) {
      const { isTeamMember } = await import('../services/credit-ledger.pg-store.js');
      if (!(await isTeamMember(userId, teamId))) {
        reply.code(403).send({ error: 'forbidden', message: 'Not a member of this team' });
        return null;
      }
      ws = teamWorkspace(teamId);
    }
    const agentId = normalizeAgentId(
      str(body.agentId) ?? str(query.agentId) ?? (request.headers['x-nyx-agent'] as string | undefined),
    );
    const key = str(body.idempotencyKey) ?? (request.headers['idempotency-key'] as string | undefined) ?? '';
    if (mutating && !key) {
      reply.code(400).send({ error: 'invalid_input', message: 'idempotencyKey (or Idempotency-Key header) is required' });
      return null;
    }
    return { svc: await getCreditsService(), ws, agentId, userId, body, key };
  }

  /** Resolve the amount: explicit `amount` wins, else the cost table entry for `taskType`. */
  function amountOf(body: Json): number {
    if (body.amount !== undefined) return body.amount as number;
    const t = str(body.taskType);
    const c = t ? CREDIT_COSTS[t] : undefined;
    if (c === undefined) throw new LedgerError('INVALID_INPUT', 'amount or a known taskType is required');
    return c;
  }

  async function available(c: Ctx): Promise<number> {
    const b = await c.svc.getBalance(c.ws, c.agentId);
    return b.agents.find((a) => a.agentId === c.agentId)?.available ?? 0;
  }

  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    mutating: boolean,
    fn: (c: Ctx) => Promise<Json | { status: number; body: Json }>,
  ) {
    const c = await context(request, reply, mutating);
    if (!c) return reply;
    try {
      const out = await fn(c);
      if ('status' in out && 'body' in out) return reply.code(out.status as number).send(out.body);
      return out;
    } catch (err) {
      if (err instanceof LedgerError) {
        const body: Json = { error: err.code.toLowerCase(), message: err.message };
        if (err.code === 'INSUFFICIENT_CREDITS') {
          body.available = await available(c).catch(() => 0);
          body.required = c.body.amount ?? CREDIT_COSTS[String(c.body.taskType)] ?? null;
        }
        return reply.code(STATUS[err.code] ?? 400).send(body);
      }
      throw err;
    }
  }

  // ── Reads ──────────────────────────────────────────

  fastify.get('/balance', (request, reply) =>
    handle(request, reply, false, async (c) => {
      const b = await c.svc.getBalance(c.ws, c.agentId);
      const agent = b.agents.find((a) => a.agentId === c.agentId) ?? null;
      // `balance` = all unspent, unheld credits in the workspace (pool + agent budgets)
      return { ...b, balance: b.total, agent };
    }),
  );

  fastify.get('/costs', async () => ({ costs: CREDIT_COSTS }));

  fastify.get('/history', (request, reply) =>
    handle(request, reply, false, async (c) => {
      const q = request.query as Json;
      const limit = q.limit ? parseInt(String(q.limit), 10) : 50;
      const agentFilter = str(q.agentId) ? c.agentId : undefined;
      const entries = await c.svc.history(c.ws, { agentId: agentFilter, limit });
      return { entries };
    }),
  );

  // ── Agent metering ─────────────────────────────────

  fastify.post('/reserve', (request, reply) =>
    handle(request, reply, true, async (c) => {
      const amount = amountOf(c.body);
      const r = await c.svc.reserve(c.ws, {
        agentId: c.agentId,
        amount,
        idempotencyKey: c.key,
        taskType: str(c.body.taskType),
        ttlMs: c.body.ttlMs as number | undefined,
        memo: str(c.body.memo),
      });
      return {
        status: r.replayed ? 200 : 201,
        body: {
          reservationId: r.entry.id,
          entryId: r.entry.id,
          replayed: r.replayed,
          agentId: c.agentId,
          amount,
          expiresAt: r.entry.expiresAt,
          available: await available(c),
        },
      };
    }),
  );

  async function ownReservation(c: Ctx): Promise<string> {
    const id = str(c.body.reservationId);
    if (!id) throw new LedgerError('INVALID_INPUT', 'reservationId is required');
    const owner = await c.svc.reservationWorkspace(id);
    if (owner !== undefined && owner !== c.ws.id) {
      throw new LedgerError('RESERVATION_NOT_FOUND', `reservation ${id} not found`);
    }
    return id;
  }

  fastify.post('/commit', (request, reply) =>
    handle(request, reply, true, async (c) => {
      const reservationId = await ownReservation(c);
      const actualAmount = c.body.actualAmount as number;
      const r = await c.svc.commit(c.agentId, {
        reservationId,
        actualAmount,
        idempotencyKey: c.key,
        memo: str(c.body.memo),
      });
      return {
        entryId: r.entry.id,
        reservationId,
        committed: actualAmount,
        replayed: r.replayed,
        available: await available(c),
      };
    }),
  );

  fastify.post('/release', (request, reply) =>
    handle(request, reply, true, async (c) => {
      const reservationId = await ownReservation(c);
      const r = await c.svc.release(c.agentId, {
        reservationId,
        idempotencyKey: c.key,
        memo: str(c.body.memo),
      });
      return { entryId: r.entry.id, reservationId, replayed: r.replayed, available: await available(c) };
    }),
  );

  fastify.post('/spend', (request, reply) =>
    handle(request, reply, true, async (c) => {
      const amount = amountOf(c.body);
      const r = await c.svc.spend(c.ws, {
        agentId: c.agentId,
        amount,
        idempotencyKey: c.key,
        taskType: str(c.body.taskType),
        memo: str(c.body.memo),
      });
      return {
        status: r.commit.replayed ? 200 : 201,
        body: {
          reservationId: r.reserve.entry.id,
          reserveEntryId: r.reserve.entry.id,
          commitEntryId: r.commit.entry.id,
          spent: amount,
          replayed: r.commit.replayed,
          agentId: c.agentId,
          available: await available(c),
        },
      };
    }),
  );

  // ── Owner actions ──────────────────────────────────

  fastify.post('/grant', (request, reply) =>
    handle(request, reply, true, async (c) => {
      const r = await c.svc.grant(c.ws, {
        amount: c.body.amount as number,
        idempotencyKey: c.key,
        actorId: c.userId,
        memo: str(c.body.memo),
      });
      return { entryId: r.entry.id, replayed: r.replayed, pool: (await c.svc.getBalance(c.ws)).pool };
    }),
  );

  for (const direction of ['allocate', 'deallocate'] as const) {
    fastify.post(`/${direction}`, (request, reply) =>
      handle(request, reply, true, async (c) => {
        if (!str(c.body.agentId)) throw new LedgerError('INVALID_INPUT', 'agentId is required');
        const r = await c.svc.allocate(
          c.ws,
          {
            agentId: c.agentId,
            amount: c.body.amount as number,
            idempotencyKey: c.key,
            actorId: c.userId,
            memo: str(c.body.memo),
          },
          direction,
        );
        const b = await c.svc.getBalance(c.ws, c.agentId);
        return { entryId: r.entry.id, replayed: r.replayed, pool: b.pool, available: await available(c) };
      }),
    );
  }
};

