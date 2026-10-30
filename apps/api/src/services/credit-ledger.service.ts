/**
 * Append-only, double-entry credit ledger for agent-native utility tokens (AI-56).
 *
 * PURE CORE: no I/O, no database, no network, no Stripe. Persistence is a
 * separate concern (see credit-ledger.schema.ts); callers load persisted
 * entries with `Ledger.fromEntries()` and persist each new entry returned by a
 * command. The rules here are specified in docs/credits/utility-tokens-spec.md
 * (section "Rust-portable ledger spec") and are meant to be ported to Rust.
 *
 * Credits are non-transferable utility tokens: never sold, no fiat value.
 * There is deliberately no purchase, plan grant, expiry or cross-workspace
 * transfer operation.
 */
import { createHash } from 'node:crypto';

// ── Types ─────────────────────────────────────────────

export type EntryKind =
  | 'grant'
  | 'allocate'
  | 'deallocate'
  | 'reserve'
  | 'commit'
  | 'release'
  | 'refund';

export type ActorKind = 'user' | 'agent' | 'system';

export interface Actor {
  kind: ActorKind;
  id: string;
}

/** Signed balance delta for one account. Postings of an entry sum to zero. */
export interface Posting {
  account: string;
  amount: number;
}

export interface LedgerEntry {
  seq: number; // 1-based, gapless
  id: string; // `le_<seq padded to 12>`
  ts: number; // unix ms
  kind: EntryKind;
  workspaceId: string;
  agentId: string | null;
  idempotencyKey: string;
  fingerprint: string; // sha256 of canonical command payload
  reservationId: string | null; // reserve: own id; commit/release: the reservation
  refEntryId: string | null; // refund: the commit entry being refunded
  expiresAt: number | null; // reserve only
  taskType: string | null;
  memo: string;
  actor: Actor;
  postings: Posting[];
  prevHash: string; // '' (genesis) or previous entry hash
  hash: string;
}

export type LedgerErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_INPUT'
  | 'INSUFFICIENT_CREDITS'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RESERVATION_NOT_FOUND'
  | 'RESERVATION_CLOSED'
  | 'RESERVATION_EXPIRED'
  | 'OVER_RESERVED'
  | 'ENTRY_NOT_FOUND'
  | 'NOT_A_COMMIT'
  | 'OVER_REFUND'
  | 'CHAIN_BROKEN'
  | 'INVARIANT_VIOLATION';

export class LedgerError extends Error {
  constructor(
    public readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface Reservation {
  id: string;
  workspaceId: string;
  agentId: string;
  reserved: number;
  expiresAt: number | null;
  status: 'open' | 'committed' | 'released';
  committed: number;
}

export interface CommitRecord {
  entryId: string;
  workspaceId: string;
  agentId: string;
  committed: number;
  refunded: number;
}

interface Base {
  idempotencyKey: string;
  actor: Actor;
  memo?: string;
  /** unix ms; defaults to the ledger clock */
  at?: number;
}

export type GrantCmd = Base & { workspaceId: string; amount: number };
export type AllocateCmd = Base & { workspaceId: string; agentId: string; amount: number };
export type ReserveCmd = Base & {
  workspaceId: string;
  agentId: string;
  amount: number;
  taskType?: string;
  ttlMs?: number;
};
export type CommitCmd = Base & { reservationId: string; actualAmount: number };
export type ReleaseCmd = Base & { reservationId: string };
export type RefundCmd = Base & { commitEntryId: string; amount: number };

export interface CommandResult {
  entry: LedgerEntry;
  /** true when the idempotency key matched an earlier identical command */
  replayed: boolean;
}

// ── Account naming ────────────────────────────────────

/** Global mint. The only account allowed to go negative (-total ever granted). */
export const ISSUER_ACCOUNT = 'issuer';
export const poolAccount = (ws: string) => `ws:${ws}:pool`;
export const agentAccount = (ws: string, agent: string) => `ws:${ws}:agent:${agent}`;
export const holdAccount = (ws: string, reservationId: string) => `ws:${ws}:hold:${reservationId}`;
export const spentAccount = (ws: string) => `ws:${ws}:spent`;

/** Local-first defaults for the single-user desktop app. */
export const LOCAL_DEFAULTS = {
  workspaceId: 'local',
  agentId: 'default',
  actor: { kind: 'user', id: 'local-user' } as Actor,
} as const;

// ── Helpers ───────────────────────────────────────────

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function entryHash(e: Omit<LedgerEntry, 'hash'>): string {
  return sha256(canonical(e));
}

function assertAmount(n: number, what = 'amount'): void {
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new LedgerError('INVALID_AMOUNT', `${what} must be a positive integer`);
  }
}

function assertId(v: string, what: string): void {
  if (!v || /[:\s]/.test(v)) {
    throw new LedgerError('INVALID_INPUT', `${what} must be non-empty without ':' or whitespace`);
  }
}

// ── Ledger ────────────────────────────────────────────

export class Ledger {
  private readonly _entries: LedgerEntry[] = [];
  private readonly balances = new Map<string, number>();
  private readonly keys = new Map<string, LedgerEntry>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly commits = new Map<string, CommitRecord>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** Rebuild state from persisted entries, re-validating every invariant. */
  static fromEntries(entries: readonly LedgerEntry[], clock?: () => number): Ledger {
    const l = new Ledger(clock);
    for (const e of entries) l.apply(e);
    return l;
  }

  get entries(): readonly LedgerEntry[] {
    return this._entries;
  }

  get headHash(): string {
    return this._entries.at(-1)?.hash ?? '';
  }

  balance(account: string): number {
    return this.balances.get(account) ?? 0;
  }

  /** Spendable credits for an agent (excludes amounts held by open reservations). */
  agentBalance(ws: string, agent: string): number {
    return this.balance(agentAccount(ws, agent));
  }

  poolBalance(ws: string): number {
    return this.balance(poolAccount(ws));
  }

  /** Credits currently held by open reservations of an agent. */
  agentHeld(ws: string, agent: string): number {
    let sum = 0;
    for (const r of this.reservations.values()) {
      if (r.status === 'open' && r.workspaceId === ws && r.agentId === agent) sum += r.reserved;
    }
    return sum;
  }

  totalSpent(ws: string): number {
    return this.balance(spentAccount(ws));
  }

  getReservation(id: string): Reservation | undefined {
    return this.reservations.get(id);
  }

  getCommit(entryId: string): CommitRecord | undefined {
    return this.commits.get(entryId);
  }

  // ── Commands ────────────────────────────────────────

  grant(c: GrantCmd): CommandResult {
    assertId(c.workspaceId, 'workspaceId');
    assertAmount(c.amount);
    return this.run('grant', c, { ws: c.workspaceId, agent: null }, () => ({
      postings: [
        { account: ISSUER_ACCOUNT, amount: -c.amount },
        { account: poolAccount(c.workspaceId), amount: c.amount },
      ],
    }));
  }

  /** Move credits from the workspace pool into an agent's budget. */
  allocate(c: AllocateCmd): CommandResult {
    assertId(c.workspaceId, 'workspaceId');
    assertId(c.agentId, 'agentId');
    assertAmount(c.amount);
    return this.run('allocate', c, { ws: c.workspaceId, agent: c.agentId }, () => ({
      postings: [
        { account: poolAccount(c.workspaceId), amount: -c.amount },
        { account: agentAccount(c.workspaceId, c.agentId), amount: c.amount },
      ],
    }));
  }

  /** Return unspent agent budget to the workspace pool. */
  deallocate(c: AllocateCmd): CommandResult {
    assertId(c.workspaceId, 'workspaceId');
    assertId(c.agentId, 'agentId');
    assertAmount(c.amount);
    return this.run('deallocate', c, { ws: c.workspaceId, agent: c.agentId }, () => ({
      postings: [
        { account: agentAccount(c.workspaceId, c.agentId), amount: -c.amount },
        { account: poolAccount(c.workspaceId), amount: c.amount },
      ],
    }));
  }

  /** Hold credits for an in-flight operation. The returned entry id is the reservation id. */
  reserve(c: ReserveCmd): CommandResult {
    assertId(c.workspaceId, 'workspaceId');
    assertId(c.agentId, 'agentId');
    assertAmount(c.amount);
    if (c.ttlMs !== undefined) assertAmount(c.ttlMs, 'ttlMs');
    return this.run(
      'reserve',
      c,
      { ws: c.workspaceId, agent: c.agentId, taskType: c.taskType ?? null },
      (id, now) => ({
        reservationId: id,
        expiresAt: c.ttlMs ? now + c.ttlMs : null,
        postings: [
          { account: agentAccount(c.workspaceId, c.agentId), amount: -c.amount },
          { account: holdAccount(c.workspaceId, id), amount: c.amount },
        ],
      }),
    );
  }

  /** Settle a reservation for the metered `actualAmount` (<= reserved); remainder returns to the agent. */
  commit(c: CommitCmd): CommandResult {
    if (!Number.isSafeInteger(c.actualAmount) || c.actualAmount < 0) {
      throw new LedgerError('INVALID_AMOUNT', 'actualAmount must be a non-negative integer');
    }
    return this.run('commit', c, () => {
      const r = this.openReservation(c.reservationId, c.at ?? this.clock());
      if (c.actualAmount > r.reserved) {
        throw new LedgerError(
          'OVER_RESERVED',
          `actual ${c.actualAmount} exceeds reserved ${r.reserved}; reserve more up front`,
        );
      }
      return { ws: r.workspaceId, agent: r.agentId };
    }, (_id, _now) => {
      const r = this.reservations.get(c.reservationId)!;
      const postings: Posting[] = [
        { account: holdAccount(r.workspaceId, r.id), amount: -r.reserved },
      ];
      if (c.actualAmount > 0) {
        postings.push({ account: spentAccount(r.workspaceId), amount: c.actualAmount });
      }
      if (r.reserved > c.actualAmount) {
        postings.push({
          account: agentAccount(r.workspaceId, r.agentId),
          amount: r.reserved - c.actualAmount,
        });
      }
      return { reservationId: r.id, postings };
    });
  }

  /** Cancel a reservation; the full hold returns to the agent. */
  release(c: ReleaseCmd): CommandResult {
    return this.run('release', c, () => {
      const r = this.getOpen(c.reservationId);
      return { ws: r.workspaceId, agent: r.agentId };
    }, () => {
      const r = this.reservations.get(c.reservationId)!;
      return {
        reservationId: r.id,
        postings: [
          { account: holdAccount(r.workspaceId, r.id), amount: -r.reserved },
          { account: agentAccount(r.workspaceId, r.agentId), amount: r.reserved },
        ],
      };
    });
  }

  /** Give back already-committed spend (e.g. a failed op discovered later). Never exceeds what was committed. */
  refund(c: RefundCmd): CommandResult {
    assertAmount(c.amount);
    return this.run('refund', c, () => {
      const rec = this.commits.get(c.commitEntryId);
      if (!rec) {
        const known = this._entries.some((e) => e.id === c.commitEntryId);
        throw new LedgerError(
          known ? 'NOT_A_COMMIT' : 'ENTRY_NOT_FOUND',
          `entry ${c.commitEntryId} is not a refundable commit`,
        );
      }
      if (rec.refunded + c.amount > rec.committed) {
        throw new LedgerError(
          'OVER_REFUND',
          `refund ${c.amount} exceeds remaining ${rec.committed - rec.refunded}`,
        );
      }
      return { ws: rec.workspaceId, agent: rec.agentId };
    }, () => {
      const rec = this.commits.get(c.commitEntryId)!;
      return {
        refEntryId: rec.entryId,
        postings: [
          { account: spentAccount(rec.workspaceId), amount: -c.amount },
          { account: agentAccount(rec.workspaceId, rec.agentId), amount: c.amount },
        ],
      };
    });
  }

  /**
   * Release every open reservation whose TTL has passed. Idempotent: keys are
   * `expire:<reservationId>`. Call from a timer or before balance reads.
   */
  expireDue(now: number = this.clock()): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    for (const r of [...this.reservations.values()]) {
      if (r.status === 'open' && r.expiresAt !== null && r.expiresAt <= now) {
        const res = this.release({
          idempotencyKey: `expire:${r.id}`,
          reservationId: r.id,
          actor: { kind: 'system', id: 'expiry' },
          memo: 'reservation expired',
          at: now,
        });
        out.push(res.entry);
      }
    }
    return out;
  }

  /** Verify hash chain, gapless seq, zero-sum postings and non-negative balances. */
  verify(): void {
    Ledger.fromEntries(this._entries);
  }

  // ── Internals ───────────────────────────────────────

  private getOpen(id: string): Reservation {
    const r = this.reservations.get(id);
    if (!r) throw new LedgerError('RESERVATION_NOT_FOUND', `reservation ${id} not found`);
    if (r.status !== 'open') {
      throw new LedgerError('RESERVATION_CLOSED', `reservation ${id} is already ${r.status}`);
    }
    return r;
  }

  private openReservation(id: string, now: number): Reservation {
    const r = this.getOpen(id);
    if (r.expiresAt !== null && r.expiresAt <= now) {
      throw new LedgerError('RESERVATION_EXPIRED', `reservation ${id} expired`);
    }
    return r;
  }

  /** Scope is given directly, or computed (and validated) by a callback. */
  private run(
    kind: EntryKind,
    c: Base,
    scopeOrValidate:
      | { ws: string; agent: string | null; taskType?: string | null }
      | (() => { ws: string; agent: string | null }),
    build: (id: string, now: number) => Partial<LedgerEntry> & { postings: Posting[] },
  ): CommandResult;
  private run(
    kind: EntryKind,
    c: Base,
    scopeOrValidate:
      | { ws: string; agent: string | null; taskType?: string | null }
      | (() => { ws: string; agent: string | null }),
    build: (id: string, now: number) => Partial<LedgerEntry> & { postings: Posting[] },
  ): CommandResult {
    if (!c.idempotencyKey || typeof c.idempotencyKey !== 'string') {
      throw new LedgerError('INVALID_INPUT', 'idempotencyKey is required');
    }
    const { idempotencyKey, actor: _actor, memo, at, ...payload } = c;
    const fingerprint = sha256(canonical({ kind, ...payload }));

    // Idempotency: same key + same payload => replay; same key + different payload => conflict.
    const prior = this.keys.get(idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new LedgerError(
          'IDEMPOTENCY_CONFLICT',
          `idempotency key ${idempotencyKey} was used with a different request`,
        );
      }
      return { entry: prior, replayed: true };
    }

    const now = at ?? this.clock();
    const scope = typeof scopeOrValidate === 'function' ? scopeOrValidate() : scopeOrValidate;
    const seq = this._entries.length + 1;
    const id = `le_${String(seq).padStart(12, '0')}`;
    const built = build(id, now);

    const draft: Omit<LedgerEntry, 'hash'> = {
      seq,
      id,
      ts: now,
      kind,
      workspaceId: scope.ws,
      agentId: scope.agent,
      idempotencyKey,
      fingerprint,
      reservationId: built.reservationId ?? null,
      refEntryId: built.refEntryId ?? null,
      expiresAt: built.expiresAt ?? null,
      taskType: (scope as { taskType?: string | null }).taskType ?? null,
      memo: memo ?? '',
      actor: c.actor,
      postings: built.postings,
      prevHash: this.headHash,
    };
    const entry: LedgerEntry = { ...draft, hash: entryHash(draft) };
    this.apply(entry); // validates; throws before any state change
    return { entry, replayed: false };
  }

  /** Validate then fold one entry into state. Used for new entries and for loading. */
  private apply(e: LedgerEntry): void {
    if (e.seq !== this._entries.length + 1) {
      throw new LedgerError('CHAIN_BROKEN', `expected seq ${this._entries.length + 1}, got ${e.seq}`);
    }
    if (e.prevHash !== this.headHash) {
      throw new LedgerError('CHAIN_BROKEN', `prevHash mismatch at seq ${e.seq}`);
    }
    const { hash, ...rest } = e;
    if (entryHash(rest) !== hash) {
      throw new LedgerError('CHAIN_BROKEN', `hash mismatch at seq ${e.seq}`);
    }
    if (this.keys.has(e.idempotencyKey)) {
      throw new LedgerError('INVARIANT_VIOLATION', `duplicate idempotency key at seq ${e.seq}`);
    }
    if (e.postings.length < 2 || e.postings.some((p) => !Number.isSafeInteger(p.amount) || p.amount === 0)) {
      throw new LedgerError('INVARIANT_VIOLATION', `malformed postings at seq ${e.seq}`);
    }
    if (e.postings.reduce((s, p) => s + p.amount, 0) !== 0) {
      throw new LedgerError('INVARIANT_VIOLATION', `postings do not sum to zero at seq ${e.seq}`);
    }

    // Net per account within the entry, then check non-negativity.
    const delta = new Map<string, number>();
    for (const p of e.postings) delta.set(p.account, (delta.get(p.account) ?? 0) + p.amount);
    for (const [acct, d] of delta) {
      if (acct !== ISSUER_ACCOUNT && this.balance(acct) + d < 0) {
        throw new LedgerError(
          'INSUFFICIENT_CREDITS',
          `${acct} has ${this.balance(acct)}, needs ${-d} (seq ${e.seq})`,
        );
      }
    }

    // Kind-specific state (validated again on load so a tampered store fails).
    this.foldKind(e);

    for (const [acct, d] of delta) this.balances.set(acct, this.balance(acct) + d);
    this._entries.push(e);
    this.keys.set(e.idempotencyKey, e);
  }

  private foldKind(e: LedgerEntry): void {
    switch (e.kind) {
      case 'reserve': {
        const hold = e.postings.find((p) => p.amount > 0)!;
        this.reservations.set(e.id, {
          id: e.id,
          workspaceId: e.workspaceId,
          agentId: e.agentId!,
          reserved: hold.amount,
          expiresAt: e.expiresAt,
          status: 'open',
          committed: 0,
        });
        break;
      }
      case 'commit': {
        const r = this.getOpen(e.reservationId ?? '');
        const spent = e.postings.find((p) => p.account === spentAccount(r.workspaceId))?.amount ?? 0;
        if (spent > r.reserved) throw new LedgerError('OVER_RESERVED', `commit exceeds reservation at seq ${e.seq}`);
        r.status = 'committed';
        r.committed = spent;
        this.commits.set(e.id, {
          entryId: e.id,
          workspaceId: r.workspaceId,
          agentId: r.agentId,
          committed: spent,
          refunded: 0,
        });
        break;
      }
      case 'release': {
        this.getOpen(e.reservationId ?? '').status = 'released';
        break;
      }
      case 'refund': {
        const rec = this.commits.get(e.refEntryId ?? '');
        if (!rec) throw new LedgerError('ENTRY_NOT_FOUND', `refund target missing at seq ${e.seq}`);
        const amt = e.postings.find((p) => p.amount > 0)!.amount;
        if (rec.refunded + amt > rec.committed) throw new LedgerError('OVER_REFUND', `over-refund at seq ${e.seq}`);
        rec.refunded += amt;
        break;
      }
      default:
        break;
    }
  }
}
