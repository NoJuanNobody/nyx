import { describe, it, expect } from 'vitest';
import {
  CreditsService,
  CREDIT_COSTS,
  normalizeAgentId,
  userWorkspace,
  teamWorkspace,
  type LedgerStore,
  type LedgerTx,
} from '../credits.service.js';
import type { LedgerEntry } from '../credit-ledger.service.js';
import { LedgerError } from '../credit-ledger.service.js';

/** In-memory stand-in for the Postgres store; counts transactions. */
class MemStore implements LedgerStore {
  rows: LedgerEntry[] = [];
  failNextAppend = false;
  async transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    const snapshot = [...this.rows];
    const tx: LedgerTx = {
      loadAfter: async (seq) => this.rows.filter((e) => e.seq > seq),
      append: async (entries) => {
        if (this.failNextAppend) {
          this.failNextAppend = false;
          throw new Error('db down');
        }
        this.rows.push(...entries);
      },
    };
    try {
      return await fn(tx);
    } catch (e) {
      this.rows = snapshot; // rollback
      throw e;
    }
  }
}

const ws = userWorkspace('u1');
let n = 0;
const key = () => `k${++n}`;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as LedgerError).code;
  }
  return 'NO_ERROR';
};

function make(opts: ConstructorParameters<typeof CreditsService>[1] = {}, store = new MemStore()) {
  let t = 1_000_000;
  return { store, svc: new CreditsService(store, { clock: () => (t += 1), ...opts }) };
}

describe('workspace and agent ids', () => {
  it('derives colon-free workspace ids and normalises client names', () => {
    expect(userWorkspace('abc:12 3').id).toBe('user_abc_12_3');
    expect(teamWorkspace('t-1').id).toBe('team_t-1');
    expect(normalizeAgentId('Claude Code')).toBe('claude-code');
    expect(normalizeAgentId('')).toBe('default');
    expect(normalizeAgentId(undefined)).toBe('default');
  });
});

describe('bootstrap (initial grant, auto allocation, legacy import)', () => {
  it('grants the local allotment once and auto-allocates to a new agent', async () => {
    const { svc, store } = make({ initialGrant: 1000, autoAllocate: 100 });
    const b = await svc.getBalance(ws, 'claude-code');
    expect(b.pool).toBe(900);
    expect(b.agents.find((a) => a.agentId === 'claude-code')?.available).toBe(100);
    expect(b.total).toBe(1000);
    const len = store.rows.length;
    await svc.getBalance(ws, 'claude-code');
    expect(store.rows.length).toBe(len); // idempotent, nothing re-minted
  });

  it('starts agents at zero when auto allocation is disabled', async () => {
    const { svc } = make({ initialGrant: 50, autoAllocate: 0 });
    const b = await svc.getBalance(ws, 'cursor');
    expect(b.pool).toBe(50);
    expect(b.agents.find((a) => a.agentId === 'cursor')?.available ?? 0).toBe(0);
  });

  it('imports a legacy balance as an owner grant labelled "legacy import"', async () => {
    const { svc, store } = make({
      initialGrant: 0,
      autoAllocate: 0,
      legacy: { balance: async () => 42 },
    });
    const b = await svc.getBalance(ws);
    expect(b.pool).toBe(42);
    const e = store.rows.find((r) => r.idempotencyKey === `legacy-import:${ws.id}`)!;
    expect(e.kind).toBe('grant');
    expect(e.memo).toBe('legacy import');
    // a second service over the same store (restart) does not import twice
    const again = new CreditsService(store, { initialGrant: 0, autoAllocate: 0, legacy: { balance: async () => 42 } });
    expect((await again.getBalance(ws)).pool).toBe(42);
    expect(store.rows.filter((r) => r.kind === 'grant')).toHaveLength(1);
  });
});

describe('reserve / commit / release / spend', () => {
  const setup = () => make({ initialGrant: 100, autoAllocate: 20 });

  it('reserve holds, commit settles the actual cost and returns the remainder', async () => {
    const { svc } = setup();
    const r = await svc.reserve(ws, { agentId: 'a', amount: 10, idempotencyKey: key() });
    let b = await svc.getBalance(ws, 'a');
    expect(b.agents.find((x) => x.agentId === 'a')).toMatchObject({ available: 10, held: 10 });
    await svc.commit('a', { reservationId: r.entry.id, actualAmount: 4, idempotencyKey: key() });
    b = await svc.getBalance(ws, 'a');
    expect(b.agents.find((x) => x.agentId === 'a')).toMatchObject({ available: 16, held: 0, spent: 4, commits: 1 });
    expect(b.spent).toBe(4);
  });

  it('release returns the full hold; credits are not spent', async () => {
    const { svc } = setup();
    const r = await svc.reserve(ws, { agentId: 'a', amount: 7, idempotencyKey: key() });
    await svc.release('a', { reservationId: r.entry.id, idempotencyKey: key() });
    const b = await svc.getBalance(ws, 'a');
    expect(b.agents.find((x) => x.agentId === 'a')).toMatchObject({ available: 20, held: 0, spent: 0 });
  });

  it('rejects an overdraft with INSUFFICIENT_CREDITS and appends nothing', async () => {
    const { svc, store } = setup();
    await svc.getBalance(ws, 'a');
    const len = store.rows.length;
    expect(await code(svc.reserve(ws, { agentId: 'a', amount: 21, idempotencyKey: key() }))).toBe('INSUFFICIENT_CREDITS');
    expect(store.rows.length).toBe(len);
    // service still works afterwards
    await svc.reserve(ws, { agentId: 'a', amount: 20, idempotencyKey: key() });
  });

  it('replays an identical retry and rejects the same key with a different payload', async () => {
    const { svc } = setup();
    const k = key();
    const first = await svc.reserve(ws, { agentId: 'a', amount: 5, idempotencyKey: k });
    const again = await svc.reserve(ws, { agentId: 'a', amount: 5, idempotencyKey: k });
    expect(again.replayed).toBe(true);
    expect(again.entry.id).toBe(first.entry.id);
    expect(await code(svc.reserve(ws, { agentId: 'a', amount: 6, idempotencyKey: k }))).toBe('IDEMPOTENCY_CONFLICT');
    expect((await svc.getBalance(ws, 'a')).agents.find((x) => x.agentId === 'a')?.held).toBe(5);
  });

  it('a commit exceeding the reservation fails; a closed reservation cannot be reused', async () => {
    const { svc } = setup();
    const r = await svc.reserve(ws, { agentId: 'a', amount: 5, idempotencyKey: key() });
    expect(await code(svc.commit('a', { reservationId: r.entry.id, actualAmount: 6, idempotencyKey: key() }))).toBe('OVER_RESERVED');
    await svc.commit('a', { reservationId: r.entry.id, actualAmount: 5, idempotencyKey: key() });
    expect(await code(svc.release('a', { reservationId: r.entry.id, idempotencyKey: key() }))).toBe('RESERVATION_CLOSED');
  });

  it('expires due reservations on the next call and rejects late commits', async () => {
    let now = 1_000_000;
    const store = new MemStore();
    const svc = new CreditsService(store, { clock: () => now, initialGrant: 100, autoAllocate: 20 });
    const r = await svc.reserve(ws, { agentId: 'a', amount: 8, idempotencyKey: key(), ttlMs: 1000 });
    now += 5000;
    const b = await svc.getBalance(ws, 'a');
    expect(b.agents.find((x) => x.agentId === 'a')).toMatchObject({ available: 20, held: 0 });
    expect(await code(svc.commit('a', { reservationId: r.entry.id, actualAmount: 8, idempotencyKey: key() }))).toBe('RESERVATION_CLOSED');
  });

  it('spend is an atomic reserve+commit and is idempotent per key', async () => {
    const { svc, store } = setup();
    const k = key();
    const a = await svc.spend(ws, { agentId: 'a', amount: CREDIT_COSTS.document_generation, idempotencyKey: k, taskType: 'document_generation' });
    const b = await svc.spend(ws, { agentId: 'a', amount: CREDIT_COSTS.document_generation, idempotencyKey: k, taskType: 'document_generation' });
    expect(b.commit.replayed).toBe(true);
    expect(b.commit.entry.id).toBe(a.commit.entry.id);
    expect((await svc.getBalance(ws, 'a')).agents.find((x) => x.agentId === 'a')).toMatchObject({ available: 17, spent: 3 });
    expect(store.rows.filter((r) => r.kind === 'commit')).toHaveLength(1);
  });

  it('spend failing at the commit step leaves no half-written reservation', async () => {
    const { svc, store } = setup();
    await svc.getBalance(ws, 'a');
    const len = store.rows.length;
    expect(await code(svc.spend(ws, { agentId: 'a', amount: 999, idempotencyKey: key() }))).toBe('INSUFFICIENT_CREDITS');
    expect(store.rows.length).toBe(len);
  });

  it('recovers from a failed append: memory is rebuilt from the store', async () => {
    const { svc, store } = setup();
    await svc.getBalance(ws, 'a');
    store.failNextAppend = true;
    await expect(svc.reserve(ws, { agentId: 'a', amount: 5, idempotencyKey: key() })).rejects.toThrow('db down');
    const b = await svc.getBalance(ws, 'a');
    expect(b.agents.find((x) => x.agentId === 'a')).toMatchObject({ available: 20, held: 0 });
  });

  it('two service instances on one store stay consistent (catch-up from the store)', async () => {
    const store = new MemStore();
    const s1 = new CreditsService(store, { initialGrant: 100, autoAllocate: 20 });
    const s2 = new CreditsService(store, { initialGrant: 100, autoAllocate: 20 });
    await s1.reserve(ws, { agentId: 'a', amount: 15, idempotencyKey: key() });
    expect(await code(s2.reserve(ws, { agentId: 'a', amount: 15, idempotencyKey: key() }))).toBe('INSUFFICIENT_CREDITS');
  });
});

describe('owner commands and isolation', () => {
  it('grant/allocate/deallocate move credits inside one workspace only', async () => {
    const { svc } = make({ initialGrant: 0, autoAllocate: 0 });
    await svc.grant(ws, { amount: 100, idempotencyKey: key(), actorId: 'u1' });
    await svc.allocate(ws, { agentId: 'a', amount: 30, idempotencyKey: key(), actorId: 'u1' });
    await svc.allocate(ws, { agentId: 'a', amount: 10, idempotencyKey: key(), actorId: 'u1' }, 'deallocate');
    const b = await svc.getBalance(ws, 'a');
    expect(b.pool).toBe(80);
    expect(b.agents.find((x) => x.agentId === 'a')?.available).toBe(20);
    const other = await svc.getBalance(userWorkspace('someone-else'), 'a');
    expect(other.total).toBe(0);
  });

  it('cannot allocate more than the pool', async () => {
    const { svc } = make({ initialGrant: 0, autoAllocate: 0 });
    await svc.grant(ws, { amount: 5, idempotencyKey: key(), actorId: 'u1' });
    expect(await code(svc.allocate(ws, { agentId: 'a', amount: 6, idempotencyKey: key(), actorId: 'u1' }))).toBe('INSUFFICIENT_CREDITS');
  });

  it('history is scoped to the workspace and verifies as a valid chain', async () => {
    const { svc, store } = make({ initialGrant: 10, autoAllocate: 5 });
    await svc.getBalance(ws, 'a');
    await svc.getBalance(userWorkspace('other'), 'a');
    const h = await svc.history(ws);
    expect(h.every((e) => e.workspaceId === ws.id)).toBe(true);
    const { Ledger } = await import('../credit-ledger.service.js');
    expect(() => Ledger.fromEntries(store.rows)).not.toThrow();
  });
});
