/**
 * Credits service (AI-58): thin adapter over the append-only ledger in
 * credit-ledger.service.ts. Credits are agent-native utility tokens: never
 * sold, no plans, no monthly grants. The only way credits appear is an
 * explicit owner `grant` (initial local allotment, a legacy-balance import, or
 * a grant action). There is no money -> credits path in this module.
 *
 * Persistence is behind `LedgerStore` so the logic is testable without a
 * database; the Postgres store lives in credit-ledger.pg-store.ts.
 */
import {
  Ledger,
  LedgerError,
  type Actor,
  type CommandResult,
  type LedgerEntry,
} from './credit-ledger.service.js';

// ── Cost table (suggested defaults from the spec; config later) ──────
export const CREDIT_COSTS: Record<string, number> = {
  spec_analysis: 1,
  document_generation: 3,
  drift_detection: 2,
  ticket_generation: 2,
  voice_agent_minute: 5,
  agent_meeting_review: 3,
  agent_custom: 3,
};

/** Default reservation TTL when the caller gives none. Credits themselves never expire. */
export const DEFAULT_RESERVATION_TTL_MS = 10 * 60 * 1000;
export const MAX_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;

// ── Store abstraction ───────────────────────────────────────────────
export interface LedgerTx {
  /** Entries (with postings) whose seq is greater than `seq`, ascending. */
  loadAfter(seq: number): Promise<LedgerEntry[]>;
  append(entries: LedgerEntry[]): Promise<void>;
}

export interface LedgerStore {
  /** Run `fn` with writers serialised (advisory lock / BEGIN IMMEDIATE) in one transaction. */
  transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T>;
}

/** Pre-ledger balances, read once to create a "legacy import" grant. */
export interface LegacySource {
  balance(ref: WorkspaceRef): Promise<number>;
}

export interface WorkspaceRef {
  id: string;
  kind: 'user' | 'team';
  ownerId: string;
}

export const DEFAULT_AGENT_ID = 'default';

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
export const userWorkspace = (userId: string): WorkspaceRef => ({
  id: `user_${safe(userId)}`,
  kind: 'user',
  ownerId: userId,
});
export const teamWorkspace = (teamId: string): WorkspaceRef => ({
  id: `team_${safe(teamId)}`,
  kind: 'team',
  ownerId: teamId,
});

/** Normalise a client name (MCP clientInfo.name, CLI --agent) into a ledger agent id. */
export function normalizeAgentId(raw: string | undefined | null): string {
  const v = (raw ?? '').trim().toLowerCase().replace(/[^a-z0-9._/-]/g, '-').replace(/^-+|-+$/g, '');
  return v ? v.slice(0, 64) : DEFAULT_AGENT_ID;
}

export function costFor(taskType: string): number | undefined {
  return CREDIT_COSTS[taskType];
}

export interface CreditsOptions {
  clock?: () => number;
  /** One-time convenience grant per workspace (spec 7). 0 disables. */
  initialGrant?: number;
  /** Amount moved from pool to an agent on first sight (capped by the pool). 0 disables. */
  autoAllocate?: number;
  legacy?: LegacySource;
}

export const CONFIG_ACTOR: Actor = { kind: 'user', id: 'config' };
const LEGACY_ACTOR: Actor = { kind: 'system', id: 'legacy-import' };

export interface AgentUsage {
  agentId: string;
  available: number;
  held: number;
  spent: number;
  commits: number;
  lastActivityAt: number | null;
}

export interface WorkspaceBalance {
  workspaceId: string;
  pool: number;
  /** pool + every agent's available budget (unspent, unheld credits) */
  total: number;
  held: number;
  spent: number;
  agents: AgentUsage[];
}

export class CreditsService {
  private ledger: Ledger | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly ensuredWs = new Set<string>();
  private readonly ensuredAgents = new Set<string>();
  private readonly clock: () => number;
  private readonly initialGrant: number;
  private readonly autoAllocate: number;

  constructor(
    private readonly store: LedgerStore,
    private readonly opts: CreditsOptions = {},
  ) {
    this.clock = opts.clock ?? Date.now;
    this.initialGrant = opts.initialGrant ?? 1000;
    this.autoAllocate = opts.autoAllocate ?? 100;
  }

  /**
   * Run `fn` against an up-to-date ledger inside a locked store transaction,
   * expire due reservations first, then persist every entry `fn` created.
   */
  private run<T>(fn: (l: Ledger) => T): Promise<T> {
    const job = this.tail.then(async () => {
      try {
        return await this.store.transaction(async (tx) => {
          const l = this.ledger ?? Ledger.fromEntries([], this.clock);
          this.ledger = null; // only restored once everything below succeeded
          for (const e of await tx.loadAfter(l.entries.length)) l.ingest(e);
          const persisted = l.entries.length; // everything after this index is new
          l.expireDue();
          const out = fn(l);
          if (l.entries.length > persisted) await tx.append(l.entries.slice(persisted));
          this.ledger = l;
          return out;
        });
      } catch (err) {
        // Memory may be ahead of the store (failed append/commit): rebuild next time.
        this.ledger = null;
        throw err;
      }
    });
    this.tail = job.catch(() => undefined);
    return job;
  }

  // ── Bootstrap: legacy import, initial grant, agent auto-allocation ──

  async ensure(ws: WorkspaceRef, agentId: string): Promise<void> {
    if (!this.ensuredWs.has(ws.id)) {
      const legacy = (await this.opts.legacy?.balance(ws)) ?? 0;
      await this.run((l) => {
        if (legacy > 0) {
          l.grant({
            idempotencyKey: `legacy-import:${ws.id}`,
            workspaceId: ws.id,
            amount: legacy,
            actor: LEGACY_ACTOR,
            memo: 'legacy import',
          });
        }
        if (this.initialGrant > 0) {
          l.grant({
            idempotencyKey: `cfg:init:${ws.id}`,
            workspaceId: ws.id,
            amount: this.initialGrant,
            actor: CONFIG_ACTOR,
            memo: 'initial local allotment',
          });
        }
      });
      this.ensuredWs.add(ws.id);
    }
    const k = `${ws.id}/${agentId}`;
    if (!this.ensuredAgents.has(k)) {
      if (this.autoAllocate > 0) {
        await this.run((l) => {
          const amount = Math.min(this.autoAllocate, l.poolBalance(ws.id));
          if (amount > 0) {
            l.allocate({
              idempotencyKey: `cfg:auto:${ws.id}:${agentId}`,
              workspaceId: ws.id,
              agentId,
              amount,
              actor: CONFIG_ACTOR,
              memo: 'auto allocation on first use',
            });
          }
        });
      }
      this.ensuredAgents.add(k);
    }
  }

  // ── Reads ───────────────────────────────────────────

  async getBalance(ws: WorkspaceRef, agentId?: string): Promise<WorkspaceBalance> {
    await this.ensure(ws, agentId ?? DEFAULT_AGENT_ID);
    return this.run((l) => {
      const stats = new Map<string, AgentUsage>();
      const get = (a: string) => {
        let u = stats.get(a);
        if (!u) {
          u = { agentId: a, available: 0, held: 0, spent: 0, commits: 0, lastActivityAt: null };
          stats.set(a, u);
        }
        return u;
      };
      const commitAgent = new Map<string, string>();
      for (const e of l.entries) {
        if (e.workspaceId !== ws.id || !e.agentId) continue;
        const u = get(e.agentId);
        u.lastActivityAt = e.ts;
        if (e.kind === 'commit') {
          const c = l.getCommit(e.id);
          u.spent += c?.committed ?? 0;
          u.commits += 1;
          commitAgent.set(e.id, e.agentId);
        } else if (e.kind === 'refund' && e.refEntryId) {
          const a = commitAgent.get(e.refEntryId);
          if (a) get(a).spent -= e.postings.find((p) => p.amount > 0)?.amount ?? 0;
        }
      }
      let held = 0;
      let agentsTotal = 0;
      for (const u of stats.values()) {
        u.available = l.agentBalance(ws.id, u.agentId);
        u.held = l.agentHeld(ws.id, u.agentId);
        held += u.held;
        agentsTotal += u.available;
      }
      const pool = l.poolBalance(ws.id);
      return {
        workspaceId: ws.id,
        pool,
        total: pool + agentsTotal,
        held,
        spent: l.totalSpent(ws.id),
        agents: [...stats.values()].sort((a, b) => a.agentId.localeCompare(b.agentId)),
      };
    });
  }

  async history(ws: WorkspaceRef, opts: { agentId?: string; limit?: number } = {}): Promise<LedgerEntry[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    return this.run((l) =>
      l.entries
        .filter((e) => e.workspaceId === ws.id && (!opts.agentId || e.agentId === opts.agentId))
        .slice(-limit)
        .reverse(),
    );
  }

  /** Reservation owner lookup, for authorisation in the HTTP layer. */
  async reservationWorkspace(reservationId: string): Promise<string | undefined> {
    return this.run((l) => l.getReservation(reservationId)?.workspaceId);
  }

  async commitWorkspace(entryId: string): Promise<string | undefined> {
    return this.run((l) => l.getCommit(entryId)?.workspaceId);
  }

  // ── Agent commands ──────────────────────────────────

  async reserve(
    ws: WorkspaceRef,
    c: { agentId: string; amount: number; idempotencyKey: string; taskType?: string; ttlMs?: number; memo?: string },
  ): Promise<CommandResult> {
    await this.ensure(ws, c.agentId);
    const ttlMs = Math.min(c.ttlMs ?? DEFAULT_RESERVATION_TTL_MS, MAX_RESERVATION_TTL_MS);
    return this.run((l) =>
      l.reserve({
        idempotencyKey: c.idempotencyKey,
        workspaceId: ws.id,
        agentId: c.agentId,
        amount: c.amount,
        taskType: c.taskType,
        ttlMs,
        actor: { kind: 'agent', id: c.agentId },
        memo: c.memo,
      }),
    );
  }

  async commit(
    agentId: string,
    c: { reservationId: string; actualAmount: number; idempotencyKey: string; memo?: string },
  ): Promise<CommandResult> {
    return this.run((l) =>
      l.commit({ ...c, actor: { kind: 'agent', id: agentId } }),
    );
  }

  async release(
    agentId: string,
    c: { reservationId: string; idempotencyKey: string; memo?: string },
  ): Promise<CommandResult> {
    return this.run((l) => l.release({ ...c, actor: { kind: 'agent', id: agentId } }));
  }

  /**
   * One-shot metered spend: reserve + commit in a single transaction. Keys are
   * derived (`<key>:reserve`, `<key>:commit`), so a retry replays both.
   */
  async spend(
    ws: WorkspaceRef,
    c: { agentId: string; amount: number; idempotencyKey: string; taskType?: string; memo?: string },
  ): Promise<{ reserve: CommandResult; commit: CommandResult }> {
    await this.ensure(ws, c.agentId);
    return this.run((l) => {
      const actor: Actor = { kind: 'agent', id: c.agentId };
      const reserve = l.reserve({
        idempotencyKey: `${c.idempotencyKey}:reserve`,
        workspaceId: ws.id,
        agentId: c.agentId,
        amount: c.amount,
        taskType: c.taskType,
        ttlMs: DEFAULT_RESERVATION_TTL_MS,
        actor,
        memo: c.memo,
      });
      const commit = l.commit({
        idempotencyKey: `${c.idempotencyKey}:commit`,
        reservationId: reserve.entry.id,
        actualAmount: c.amount,
        actor,
        memo: c.memo,
      });
      return { reserve, commit };
    });
  }

  // ── Owner commands ──────────────────────────────────

  async grant(ws: WorkspaceRef, c: { amount: number; idempotencyKey: string; actorId: string; memo?: string }) {
    await this.ensure(ws, DEFAULT_AGENT_ID);
    return this.run((l) =>
      l.grant({
        idempotencyKey: c.idempotencyKey,
        workspaceId: ws.id,
        amount: c.amount,
        actor: { kind: 'user', id: c.actorId },
        memo: c.memo,
      }),
    );
  }

  async allocate(
    ws: WorkspaceRef,
    c: { agentId: string; amount: number; idempotencyKey: string; actorId: string; memo?: string },
    direction: 'allocate' | 'deallocate' = 'allocate',
  ) {
    await this.ensure(ws, c.agentId);
    return this.run((l) => {
      const cmd = {
        idempotencyKey: c.idempotencyKey,
        workspaceId: ws.id,
        agentId: c.agentId,
        amount: c.amount,
        actor: { kind: 'user', id: c.actorId } as Actor,
        memo: c.memo,
      };
      return direction === 'allocate' ? l.allocate(cmd) : l.deallocate(cmd);
    });
  }
}

export { LedgerError };

// ── Singleton wired to Postgres ─────────────────────────────────────

let instance: Promise<CreditsService> | null = null;

export function getCreditsService(): Promise<CreditsService> {
  instance ??= import('./credit-ledger.pg-store.js').then(
    (m) =>
      new CreditsService(new m.PgLedgerStore(), {
        legacy: new m.PgLegacySource(),
        initialGrant: envInt('NYX_CREDITS_INITIAL_GRANT', 1000),
        autoAllocate: envInt('NYX_CREDITS_AUTO_ALLOCATE', 100),
      }),
  );
  return instance;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isSafeInteger(v) && v >= 0 && process.env[name] !== undefined ? v : fallback;
}
