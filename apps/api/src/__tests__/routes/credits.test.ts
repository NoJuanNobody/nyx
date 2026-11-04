import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { LedgerEntry } from '../../services/credit-ledger.service.js';
import type { LedgerStore, LedgerTx } from '../../services/credits.service.js';

// ── In-memory store behind the real CreditsService ───

const rows: LedgerEntry[] = [];
const store: LedgerStore = {
  async transaction<T>(fn: (tx: LedgerTx) => Promise<T>) {
    const snap = [...rows];
    try {
      return await fn({
        loadAfter: async (seq) => rows.filter((e) => e.seq > seq),
        append: async (es) => void rows.push(...es),
      });
    } catch (e) {
      rows.length = 0;
      rows.push(...snap);
      throw e;
    }
  },
};

const memberOf = new Set<string>();
vi.mock('../../services/credit-ledger.pg-store.js', () => ({
  isTeamMember: async (u: string, t: string) => memberOf.has(`${u}/${t}`),
  PgLedgerStore: class {},
  PgLegacySource: class {},
}));

let svc: import('../../services/credits.service.js').CreditsService;
vi.mock('../../services/credits.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/credits.service.js')>(
    '../../services/credits.service.js',
  );
  return { ...actual, getCreditsService: async () => svc };
});

async function buildApp(userId?: string) {
  const { creditRoutes } = await import('../../routes/credits.js');
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as never);
  app.addHook('preHandler', async (request) => {
    request.user = userId
      ? ({ id: userId, clerkId: 'c', email: 't@t.com', name: 'T', avatarUrl: null, role: 'admin' } as never)
      : (null as never);
  });
  app.register(creditRoutes, { prefix: '/credits' });
  await app.ready();
  return app;
}

let n = 0;
const k = () => ({ idempotencyKey: `k${++n}` });

describe('Credits routes', () => {
  beforeEach(async () => {
    rows.length = 0;
    memberOf.clear();
    const { CreditsService } = await import('../../services/credits.service.js');
    svc = new CreditsService(store, { initialGrant: 100, autoAllocate: 20 });
  });

  it('exposes no purchase, pack or deduct paths', async () => {
    const app = await buildApp('user-1');
    for (const url of ['/credits/purchase', '/credits/packs', '/credits/deduct']) {
      const res = await app.inject({ method: 'POST', url, payload: {} });
      expect(res.statusCode).toBe(404);
    }
  });

  it('requires authentication', async () => {
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/credits/balance' })).statusCode).toBe(401);
  });

  it('GET /balance returns pool, per-agent usage and total', async () => {
    const app = await buildApp('user-1');
    const res = await app.inject({ method: 'GET', url: '/credits/balance?agentId=claude-code' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.pool).toBe(80);
    expect(b.balance).toBe(100);
    expect(b.agent).toMatchObject({ agentId: 'claude-code', available: 20 });
  });

  it('reserve -> commit with idempotent replays', async () => {
    const app = await buildApp('user-1');
    const rk = k();
    const r1 = await app.inject({ method: 'POST', url: '/credits/reserve', payload: { agentId: 'a', taskType: 'document_generation', ...rk } });
    expect(r1.statusCode).toBe(201);
    const { reservationId, amount, available } = r1.json();
    expect(amount).toBe(3);
    expect(available).toBe(17);
    const r2 = await app.inject({ method: 'POST', url: '/credits/reserve', payload: { agentId: 'a', taskType: 'document_generation', ...rk } });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({ replayed: true, reservationId });

    const ck = k();
    const c = await app.inject({ method: 'POST', url: '/credits/commit', payload: { agentId: 'a', reservationId, actualAmount: 2, ...ck } });
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({ committed: 2, available: 18 });
    const again = await app.inject({ method: 'POST', url: '/credits/commit', payload: { agentId: 'a', reservationId, actualAmount: 2, ...ck } });
    expect(again.json().replayed).toBe(true);
  });

  it('accepts the Idempotency-Key header and X-Nyx-Agent header', async () => {
    const app = await buildApp('user-1');
    const res = await app.inject({
      method: 'POST',
      url: '/credits/spend',
      headers: { 'idempotency-key': 'hdr-1', 'x-nyx-agent': 'Cursor' },
      payload: { amount: 4 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ agentId: 'cursor', spent: 4, available: 16 });
  });

  it('requires an idempotency key on mutations', async () => {
    const app = await buildApp('user-1');
    const res = await app.inject({ method: 'POST', url: '/credits/reserve', payload: { amount: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_input');
  });

  it('returns 402 insufficient_credits with available and required', async () => {
    const app = await buildApp('user-1');
    const res = await app.inject({ method: 'POST', url: '/credits/spend', payload: { agentId: 'a', amount: 50, ...k() } });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'insufficient_credits', available: 20, required: 50 });
  });

  it('release returns the hold; reusing a key with another payload is a 409', async () => {
    const app = await buildApp('user-1');
    const rk = k();
    const r = await app.inject({ method: 'POST', url: '/credits/reserve', payload: { agentId: 'a', amount: 5, ...rk } });
    const clash = await app.inject({ method: 'POST', url: '/credits/reserve', payload: { agentId: 'a', amount: 6, ...rk } });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toBe('idempotency_conflict');
    const rel = await app.inject({ method: 'POST', url: '/credits/release', payload: { agentId: 'a', reservationId: r.json().reservationId, ...k() } });
    expect(rel.statusCode).toBe(200);
    expect(rel.json().available).toBe(20);
  });

  it('one user cannot settle another user\'s reservation', async () => {
    const owner = await buildApp('user-1');
    const r = await owner.inject({ method: 'POST', url: '/credits/reserve', payload: { agentId: 'a', amount: 5, ...k() } });
    const intruder = await buildApp('user-2');
    const res = await intruder.inject({
      method: 'POST',
      url: '/credits/commit',
      payload: { reservationId: r.json().reservationId, actualAmount: 5, ...k() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('owner can allocate and deallocate between pool and agent', async () => {
    const app = await buildApp('user-1');
    const a = await app.inject({ method: 'POST', url: '/credits/allocate', payload: { agentId: 'zed', amount: 30, ...k() } });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ available: 50, pool: 50 });
    const d = await app.inject({ method: 'POST', url: '/credits/deallocate', payload: { agentId: 'zed', amount: 10, ...k() } });
    expect(d.json()).toMatchObject({ available: 40, pool: 60 });
    const bad = await app.inject({ method: 'POST', url: '/credits/allocate', payload: { amount: 1, ...k() } });
    expect(bad.statusCode).toBe(400);
  });

  it('grant adds to the pool (owner action, never a payment)', async () => {
    const app = await buildApp('user-1');
    const g = await app.inject({ method: 'POST', url: '/credits/grant', payload: { amount: 25, ...k() } });
    expect(g.statusCode).toBe(200);
    expect(g.json().pool).toBe(105);
  });

  it('team workspaces require membership', async () => {
    const app = await buildApp('user-1');
    const denied = await app.inject({ method: 'GET', url: '/credits/balance?teamId=t1' });
    expect(denied.statusCode).toBe(403);
    memberOf.add('user-1/t1');
    const ok = await app.inject({ method: 'GET', url: '/credits/balance?teamId=t1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().workspaceId).toBe('team_t1');
  });

  it('GET /history lists entries for the workspace; GET /costs lists the cost table', async () => {
    const app = await buildApp('user-1');
    await app.inject({ method: 'POST', url: '/credits/spend', payload: { agentId: 'a', amount: 1, ...k() } });
    const h = await app.inject({ method: 'GET', url: '/credits/history?limit=10' });
    expect(h.json().entries[0].kind).toBe('commit');
    const c = await app.inject({ method: 'GET', url: '/credits/costs' });
    expect(c.json().costs.document_generation).toBe(3);
  });
});
