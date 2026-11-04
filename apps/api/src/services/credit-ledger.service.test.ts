import { describe, it, expect } from 'vitest';
import {
  Ledger,
  LedgerError,
  LOCAL_DEFAULTS,
  ISSUER_ACCOUNT,
  agentAccount,
  poolAccount,
  holdAccount,
  type LedgerEntry,
} from './credit-ledger.service.js';

const user = { kind: 'user', id: 'u1' } as const;
const agent = { kind: 'agent', id: 'claude-code' } as const;
let t = 1_000;
const mk = () => new Ledger(() => (t += 1));
let k = 0;
const key = () => `k${++k}`;

function funded(grant = 100, alloc = 60) {
  const l = mk();
  l.grant({ idempotencyKey: key(), workspaceId: 'w', amount: grant, actor: user });
  l.allocate({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a1', amount: alloc, actor: user });
  return l;
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as LedgerError).code;
  }
  return 'NO_ERROR';
};

describe('grant / allocate / deallocate', () => {
  it('moves credits issuer -> pool -> agent and conserves total', () => {
    const l = funded();
    expect(l.poolBalance('w')).toBe(40);
    expect(l.agentBalance('w', 'a1')).toBe(60);
    expect(l.balance(ISSUER_ACCOUNT)).toBe(-100);
    l.deallocate({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a1', amount: 10, actor: user });
    expect(l.poolBalance('w')).toBe(50);
    expect(l.agentBalance('w', 'a1')).toBe(50);
  });

  it('rejects allocating more than the pool holds', () => {
    const l = funded();
    expect(code(() => l.allocate({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a2', amount: 41, actor: user }))).toBe('INSUFFICIENT_CREDITS');
    expect(l.entries).toHaveLength(2);
  });

  it('rejects non-positive, fractional and unsafe amounts', () => {
    const l = mk();
    for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, NaN]) {
      expect(code(() => l.grant({ idempotencyKey: key(), workspaceId: 'w', amount, actor: user }))).toBe('INVALID_AMOUNT');
    }
  });

  it('rejects ids containing the account separator', () => {
    expect(code(() => mk().grant({ idempotencyKey: key(), workspaceId: 'a:b', amount: 1, actor: user }))).toBe('INVALID_INPUT');
  });

  it('supports local-first defaults', () => {
    const l = mk();
    const { workspaceId, agentId, actor } = LOCAL_DEFAULTS;
    l.grant({ idempotencyKey: 'cfg:1', workspaceId, amount: 50, actor });
    l.allocate({ idempotencyKey: 'cfg:2', workspaceId, agentId, amount: 50, actor });
    expect(l.agentBalance(workspaceId, agentId)).toBe(50);
  });
});

describe('reserve / commit / release', () => {
  it('reserve holds, commit spends actual and returns remainder', () => {
    const l = funded();
    const { entry } = l.reserve({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a1', amount: 20, taskType: 'scan', actor: agent });
    expect(l.agentBalance('w', 'a1')).toBe(40);
    expect(l.agentHeld('w', 'a1')).toBe(20);
    expect(l.balance(holdAccount('w', entry.id))).toBe(20);
    const c = l.commit({ idempotencyKey: key(), reservationId: entry.id, actualAmount: 12, actor: agent });
    expect(l.agentBalance('w', 'a1')).toBe(48);
    expect(l.totalSpent('w')).toBe(12);
    expect(l.agentHeld('w', 'a1')).toBe(0);
    expect(l.getReservation(entry.id)?.status).toBe('committed');
    expect(c.entry.postings.reduce((s, p) => s + p.amount, 0)).toBe(0);
  });

  it('commit of zero returns everything and records no spend', () => {
    const l = funded();
    const r = l.reserve({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a1', amount: 5, actor: agent }).entry;
    l.commit({ idempotencyKey: key(), reservationId: r.id, actualAmount: 0, actor: agent });
    expect(l.agentBalance('w', 'a1')).toBe(60);
    expect(l.totalSpent('w')).toBe(0);
  });

  it('cannot reserve more than the agent budget (no overdraft)', () => {
    const l = funded();
    expect(code(() => l.reserve({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a1', amount: 61, actor: agent }))).toBe('INSUFFICIENT_CREDITS');
    expect(code(() => l.reserve({ idempotencyKey: key(), workspaceId: 'w', agentId: 'ghost', amount: 1, actor: agent }))).toBe('INSUFFICIENT_CREDITS');
  });

  it('concurrent reservations cannot together exceed the budget', () => {
    const l = funded();
    l.reserve({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a1', amount: 40, actor: agent });
    expect(code(() => l.reserve({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a1', amount: 21, actor: agent }))).toBe('INSUFFICIENT_CREDITS');
  });

  it('cannot commit more than reserved', () => {
    const l = funded();
    const r = l.reserve({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a1', amount: 5, actor: agent }).entry;
    expect(code(() => l.commit({ idempotencyKey: key(), reservationId: r.id, actualAmount: 6, actor: agent }))).toBe('OVER_RESERVED');
    expect(l.getReservation(r.id)?.status).toBe('open');
  });

  it('release returns the full hold; a closed reservation cannot be reused', () => {
    const l = funded();
    const r = l.reserve({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a1', amount: 30, actor: agent }).entry;
    l.release({ idempotencyKey: key(), reservationId: r.id, actor: agent });
    expect(l.agentBalance('w', 'a1')).toBe(60);
    expect(code(() => l.commit({ idempotencyKey: key(), reservationId: r.id, actualAmount: 1, actor: agent }))).toBe('RESERVATION_CLOSED');
    expect(code(() => l.release({ idempotencyKey: key(), reservationId: r.id, actor: agent }))).toBe('RESERVATION_CLOSED');
    expect(code(() => l.release({ idempotencyKey: key(), reservationId: 'nope', actor: agent }))).toBe('RESERVATION_NOT_FOUND');
  });

  it('expired reservations cannot commit and are released by expireDue (idempotently)', () => {
    const l = funded();
    const r = l.reserve({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a1', amount: 10, ttlMs: 100, actor: agent, at: 5_000 }).entry;
    expect(code(() => l.commit({ idempotencyKey: key(), reservationId: r.id, actualAmount: 1, actor: agent, at: 5_100 }))).toBe('RESERVATION_EXPIRED');
    expect(l.expireDue(5_050)).toHaveLength(0);
    const out = l.expireDue(5_100);
    expect(out).toHaveLength(1);
    expect(out[0].actor.kind).toBe('system');
    expect(l.agentBalance('w', 'a1')).toBe(60);
    expect(l.expireDue(9_999)).toHaveLength(0);
  });
});

describe('refund', () => {
  it('refunds committed spend up to the committed amount only', () => {
    const l = funded();
    const r = l.reserve({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a1', amount: 10, actor: agent }).entry;
    const c = l.commit({ idempotencyKey: key(), reservationId: r.id, actualAmount: 10, actor: agent }).entry;
    l.refund({ idempotencyKey: key(), commitEntryId: c.id, amount: 4, actor: user });
    expect(l.agentBalance('w', 'a1')).toBe(54);
    expect(l.totalSpent('w')).toBe(6);
    expect(code(() => l.refund({ idempotencyKey: key(), commitEntryId: c.id, amount: 7, actor: user }))).toBe('OVER_REFUND');
    l.refund({ idempotencyKey: key(), commitEntryId: c.id, amount: 6, actor: user });
    expect(l.totalSpent('w')).toBe(0);
  });

  it('rejects unknown and non-commit targets', () => {
    const l = funded();
    expect(code(() => l.refund({ idempotencyKey: key(), commitEntryId: 'le_x', amount: 1, actor: user }))).toBe('ENTRY_NOT_FOUND');
    expect(code(() => l.refund({ idempotencyKey: key(), commitEntryId: l.entries[0].id, amount: 1, actor: user }))).toBe('NOT_A_COMMIT');
  });
});

describe('idempotency', () => {
  it('replays an identical command without a new entry', () => {
    const l = funded();
    const cmd = { idempotencyKey: 'dup', workspaceId: 'w', agentId: 'a1', amount: 5, actor: agent } as const;
    const a = l.reserve(cmd);
    const b = l.reserve({ ...cmd, at: 99_999, memo: 'retry' });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.entry.id).toBe(a.entry.id);
    expect(l.agentBalance('w', 'a1')).toBe(55);
  });

  it('rejects the same key with a different payload', () => {
    const l = funded();
    l.reserve({ idempotencyKey: 'dup2', workspaceId: 'w', agentId: 'a1', amount: 5, actor: agent });
    expect(code(() => l.reserve({ idempotencyKey: 'dup2', workspaceId: 'w', agentId: 'a1', amount: 6, actor: agent }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(code(() => l.grant({ idempotencyKey: 'dup2', workspaceId: 'w', amount: 5, actor: agent }))).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('commit retry does not double-spend', () => {
    const l = funded();
    const r = l.reserve({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a1', amount: 10, actor: agent }).entry;
    const cmd = { idempotencyKey: 'commit-1', reservationId: r.id, actualAmount: 7, actor: agent };
    l.commit(cmd);
    expect(l.commit(cmd).replayed).toBe(true);
    expect(l.totalSpent('w')).toBe(7);
  });

  it('requires a key', () => {
    expect(code(() => mk().grant({ idempotencyKey: '', workspaceId: 'w', amount: 1, actor: user }))).toBe('INVALID_INPUT');
  });
});

describe('invariants and audit trail', () => {
  function scenario() {
    const l = funded(1000, 500);
    l.allocate({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a2', amount: 100, actor: user });
    const r1 = l.reserve({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a1', amount: 50, actor: agent }).entry;
    const r2 = l.reserve({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a2', amount: 30, actor: agent }).entry;
    const c = l.commit({ idempotencyKey: key(), reservationId: r1.id, actualAmount: 41, actor: agent }).entry;
    l.release({ idempotencyKey: key(), reservationId: r2.id, actor: agent });
    l.refund({ idempotencyKey: key(), commitEntryId: c.id, amount: 11, actor: user });
    return l;
  }

  it('every entry sums to zero and the system conserves credits', () => {
    const l = scenario();
    for (const e of l.entries) expect(e.postings.reduce((s, p) => s + p.amount, 0)).toBe(0);
    // issuer debt == pool + agents + holds + spent
    const total =
      l.poolBalance('w') + l.agentBalance('w', 'a1') + l.agentBalance('w', 'a2') + l.agentHeld('w', 'a1') + l.agentHeld('w', 'a2') + l.totalSpent('w');
    expect(total).toBe(1000);
    expect(l.balance(ISSUER_ACCOUNT)).toBe(-1000);
    expect(l.totalSpent('w')).toBe(30);
  });

  it('keeps per-workspace and per-agent budgets isolated', () => {
    const l = scenario();
    l.grant({ idempotencyKey: key(), workspaceId: 'w2', amount: 5, actor: user });
    expect(code(() => l.allocate({ idempotencyKey: key(), workspaceId: 'w2', agentId: 'a1', amount: 6, actor: user }))).toBe('INSUFFICIENT_CREDITS');
    expect(l.balance(poolAccount('w2'))).toBe(5);
    expect(l.balance(agentAccount('w2', 'a1'))).toBe(0);
  });

  it('round-trips through fromEntries and verifies the hash chain', () => {
    const l = scenario();
    const copy = Ledger.fromEntries(JSON.parse(JSON.stringify(l.entries)));
    expect(copy.headHash).toBe(l.headHash);
    expect(copy.agentBalance('w', 'a1')).toBe(l.agentBalance('w', 'a1'));
    expect(() => l.verify()).not.toThrow();
    // replay protection survives reload
    expect(copy.grant({ idempotencyKey: l.entries[0].idempotencyKey, workspaceId: 'w', amount: 1000, actor: user }).replayed).toBe(true);
  });

  it('detects tampering, reordering and gaps', () => {
    const entries: LedgerEntry[] = JSON.parse(JSON.stringify(scenario().entries));
    const tampered = structuredClone(entries);
    tampered[1].postings[0].amount -= 1;
    tampered[1].postings[1].amount += 1;
    expect(code(() => Ledger.fromEntries(tampered))).toBe('CHAIN_BROKEN');
    expect(code(() => Ledger.fromEntries([entries[1], entries[0], ...entries.slice(2)]))).toBe('CHAIN_BROKEN');
    expect(code(() => Ledger.fromEntries(entries.filter((_, i) => i !== 2)))).toBe('CHAIN_BROKEN');
  });

  it('rejects a forged entry that overdrafts even if correctly hashed', () => {
    const l = funded();
    const forged = structuredClone(l.entries[1]) as LedgerEntry;
    forged.postings = [
      { account: poolAccount('w'), amount: -1000 },
      { account: agentAccount('w', 'a1'), amount: 1000 },
    ];
    expect(code(() => Ledger.fromEntries([l.entries[0], forged]))).toBe('CHAIN_BROKEN');
  });

  it('failed commands leave state untouched', () => {
    const l = funded();
    const before = l.headHash;
    expect(code(() => l.reserve({ idempotencyKey: key(), workspaceId: 'w', agentId: 'a1', amount: 999, actor: agent }))).toBe('INSUFFICIENT_CREDITS');
    expect(l.headHash).toBe(before);
    expect(l.entries).toHaveLength(2);
  });
});
