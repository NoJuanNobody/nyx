/**
 * PROPOSED schema for the append-only credit ledger (AI-56). SQLite, because
 * the desktop app is local-first. Intentionally NOT re-exported from
 * ./schema.ts and NOT wired into drizzle.config.ts: AI-57/AI-58 do that.
 *
 * Append-only is enforced twice: the service layer never updates rows, and the
 * SQL triggers in docs/credits/utility-tokens-spec.md (section 8) abort any
 * UPDATE/DELETE on these tables. Balances are never stored; they are the sum
 * of `credit_postings` per account (optionally cached in a rebuildable view).
 */
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const creditEntries = sqliteTable(
  'credit_entries',
  {
    seq: integer('seq').primaryKey(), // gapless, assigned inside the write transaction
    id: text('id').notNull().unique(), // le_<seq padded>
    ts: integer('ts').notNull(), // unix ms
    kind: text('kind', {
      enum: ['grant', 'allocate', 'deallocate', 'reserve', 'commit', 'release', 'refund'],
    }).notNull(),
    workspaceId: text('workspace_id').notNull(),
    agentId: text('agent_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    reservationId: text('reservation_id'),
    refEntryId: text('ref_entry_id'),
    expiresAt: integer('expires_at'),
    taskType: text('task_type'),
    memo: text('memo').notNull().default(''),
    actorKind: text('actor_kind', { enum: ['user', 'agent', 'system'] }).notNull(),
    actorId: text('actor_id').notNull(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull().unique(),
  },
  (t) => [
    uniqueIndex('credit_entries_idem_idx').on(t.idempotencyKey),
    index('credit_entries_ws_agent_idx').on(t.workspaceId, t.agentId, t.seq),
    index('credit_entries_reservation_idx').on(t.reservationId),
    index('credit_entries_ref_idx').on(t.refEntryId),
  ],
);

export const creditPostings = sqliteTable(
  'credit_postings',
  {
    entrySeq: integer('entry_seq')
      .notNull()
      .references(() => creditEntries.seq),
    idx: integer('idx').notNull(), // position inside the entry (part of the hash)
    account: text('account').notNull(), // issuer | ws:W:pool | ws:W:agent:A | ws:W:hold:R | ws:W:spent
    amount: integer('amount').notNull(), // signed, never 0; entry postings sum to 0
  },
  (t) => [
    uniqueIndex('credit_postings_pk').on(t.entrySeq, t.idx),
    index('credit_postings_account_idx').on(t.account),
  ],
);

export type CreditEntryRow = typeof creditEntries.$inferSelect;
export type CreditPostingRow = typeof creditPostings.$inferSelect;
