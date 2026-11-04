/**
 * Postgres persistence for the credit ledger (AI-58). One advisory-locked
 * transaction per command serialises writers, which keeps `seq` gapless and
 * overdraft checks race-free across API processes (spec section 8).
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { creditEntries, creditPostings, teamMembers } from '../db/schema.js';
import type { LedgerEntry } from './credit-ledger.service.js';
import type { LedgerStore, LedgerTx, LegacySource, WorkspaceRef } from './credits.service.js';

const LEDGER_LOCK_KEY = 5800058;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class PgLedgerStore implements LedgerStore {
  transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LEDGER_LOCK_KEY})`);
      return fn(new PgTx(tx));
    });
  }
}

class PgTx implements LedgerTx {
  constructor(private readonly tx: Tx) {}

  async loadAfter(seq: number): Promise<LedgerEntry[]> {
    const rows = await this.tx
      .select()
      .from(creditEntries)
      .where(gt(creditEntries.seq, seq))
      .orderBy(asc(creditEntries.seq));
    if (rows.length === 0) return [];
    const postings = await this.tx
      .select()
      .from(creditPostings)
      .where(gt(creditPostings.entrySeq, seq))
      .orderBy(asc(creditPostings.entrySeq), asc(creditPostings.idx));
    const bySeq = new Map<number, { account: string; amount: number }[]>();
    for (const p of postings) {
      const list = bySeq.get(p.entrySeq) ?? [];
      list.push({ account: p.account, amount: Number(p.amount) });
      bySeq.set(p.entrySeq, list);
    }
    return rows.map((r) => ({
      seq: r.seq,
      id: r.id,
      ts: Number(r.ts),
      kind: r.kind as LedgerEntry['kind'],
      workspaceId: r.workspaceId,
      agentId: r.agentId,
      idempotencyKey: r.idempotencyKey,
      fingerprint: r.fingerprint,
      reservationId: r.reservationId,
      refEntryId: r.refEntryId,
      expiresAt: r.expiresAt === null ? null : Number(r.expiresAt),
      taskType: r.taskType,
      memo: r.memo,
      actor: { kind: r.actorKind as LedgerEntry['actor']['kind'], id: r.actorId },
      postings: bySeq.get(r.seq) ?? [],
      prevHash: r.prevHash,
      hash: r.hash,
    }));
  }

  async append(entries: LedgerEntry[]): Promise<void> {
    for (const e of entries) {
      await this.tx.insert(creditEntries).values({
        seq: e.seq,
        id: e.id,
        ts: e.ts,
        kind: e.kind,
        workspaceId: e.workspaceId,
        agentId: e.agentId,
        idempotencyKey: e.idempotencyKey,
        fingerprint: e.fingerprint,
        reservationId: e.reservationId,
        refEntryId: e.refEntryId,
        expiresAt: e.expiresAt,
        taskType: e.taskType,
        memo: e.memo,
        actorKind: e.actor.kind,
        actorId: e.actor.id,
        prevHash: e.prevHash,
        hash: e.hash,
      });
      await this.tx.insert(creditPostings).values(
        e.postings.map((p, idx) => ({ entrySeq: e.seq, idx, account: p.account, amount: p.amount })),
      );
    }
  }
}

/**
 * Reads the pre-ledger balances (tables renamed by migration 0027). Returns 0
 * when the legacy tables do not exist (fresh install) or the owner has none.
 */
export class PgLegacySource implements LegacySource {
  async balance(ref: WorkspaceRef): Promise<number> {
    try {
      const rows =
        ref.kind === 'user'
          ? await db.execute(sql`select balance from legacy_credit_balances where user_id = ${ref.ownerId} limit 1`)
          : await db.execute(sql`select balance from legacy_team_credit_balances where team_id = ${ref.ownerId}::uuid limit 1`);
      const first = (rows as unknown as { balance: number }[])[0];
      return Math.max(0, Number(first?.balance ?? 0));
    } catch {
      return 0;
    }
  }
}

export async function isTeamMember(userId: string, teamId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}

// kept for tooling that wants to verify the persisted chain
export async function loadAllEntries(): Promise<LedgerEntry[]> {
  return db.transaction((tx) => new PgTx(tx).loadAfter(0));
}

