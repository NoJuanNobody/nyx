-- Append-only double-entry credit ledger (docs/credits/utility-tokens-spec.md sections 8-9).
-- Balances are never stored: they are SUM(amount) per account over credit_postings.
CREATE TABLE credit_entries (
    seq              INTEGER PRIMARY KEY,
    id               TEXT NOT NULL UNIQUE,
    ts               INTEGER NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN
        ('grant','allocate','deallocate','reserve','commit','release','refund')),
    workspace_id     TEXT NOT NULL,
    agent_id         TEXT,
    idempotency_key  TEXT NOT NULL,
    fingerprint      TEXT NOT NULL,
    reservation_id   TEXT,
    ref_entry_id     TEXT,
    expires_at       INTEGER,
    task_type        TEXT,
    memo             TEXT NOT NULL DEFAULT '',
    actor_kind       TEXT NOT NULL CHECK (actor_kind IN ('user','agent','system')),
    actor_id         TEXT NOT NULL,
    prev_hash        TEXT NOT NULL,
    hash             TEXT NOT NULL UNIQUE
);
CREATE UNIQUE INDEX credit_entries_idem_idx ON credit_entries(idempotency_key);
CREATE INDEX credit_entries_ws_agent_idx ON credit_entries(workspace_id, agent_id, seq);
CREATE INDEX credit_entries_reservation_idx ON credit_entries(reservation_id);
CREATE INDEX credit_entries_ref_idx ON credit_entries(ref_entry_id);

CREATE TABLE credit_postings (
    entry_seq  INTEGER NOT NULL REFERENCES credit_entries(seq),
    idx        INTEGER NOT NULL,
    account    TEXT NOT NULL,
    amount     INTEGER NOT NULL CHECK (amount <> 0),
    PRIMARY KEY (entry_seq, idx)
);
CREATE INDEX credit_postings_account_idx ON credit_postings(account);

CREATE TRIGGER credit_entries_no_update BEFORE UPDATE ON credit_entries
BEGIN SELECT RAISE(ABORT, 'credit_entries is append-only'); END;
CREATE TRIGGER credit_entries_no_delete BEFORE DELETE ON credit_entries
BEGIN SELECT RAISE(ABORT, 'credit_entries is append-only'); END;
CREATE TRIGGER credit_postings_no_update BEFORE UPDATE ON credit_postings
BEGIN SELECT RAISE(ABORT, 'credit_postings is append-only'); END;
CREATE TRIGGER credit_postings_no_delete BEFORE DELETE ON credit_postings
BEGIN SELECT RAISE(ABORT, 'credit_postings is append-only'); END;
