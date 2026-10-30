//! SQLite implementation of [`LedgerStore`] (spec section 8).
//!
//! Each `append` runs in `BEGIN IMMEDIATE` (or a savepoint when the caller already holds a
//! transaction), re-checks that the entry extends the stored tail, then inserts the entry and its
//! postings. `BEGIN IMMEDIATE` serialises writers, which makes `seq` gapless and the tail check
//! race-free; the unique index on `idempotency_key` is the backstop for duplicate keys. Triggers
//! (migration 6) make both tables append-only.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{Error, Result};
use crate::ledger::{Actor, ActorKind, EntryKind, LedgerEntry, LedgerStore, Posting};

/// Ledger persistence over a borrowed connection.
#[derive(Debug, Clone, Copy)]
pub struct SqliteLedgerStore<'c>(&'c Connection);

impl<'c> SqliteLedgerStore<'c> {
    /// Wrap a connection (a `&Transaction` also works).
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }

    /// Balance of one account, computed in SQL (`SUM(amount)`); an independent cross-check of the
    /// in-memory fold.
    pub fn balance(&self, account: &str) -> Result<i64> {
        Ok(self.0.query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM credit_postings WHERE account = ?1",
            [account],
            |r| r.get(0),
        )?)
    }

    /// All account balances, computed in SQL.
    pub fn balances(&self) -> Result<HashMap<String, i64>> {
        let mut s = self
            .0
            .prepare("SELECT account, SUM(amount) FROM credit_postings GROUP BY account")?;
        let rows = s
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
            .collect::<std::result::Result<HashMap<_, _>, _>>()?;
        Ok(rows)
    }

    fn tail(&self) -> Result<(i64, String)> {
        Ok(self
            .0
            .query_row(
                "SELECT seq, hash FROM credit_entries ORDER BY seq DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .unwrap_or((0, String::new())))
    }

    fn insert(&self, e: &LedgerEntry) -> Result<()> {
        let (tail_seq, tail_hash) = self.tail()?;
        if i64::try_from(e.seq).ok() != Some(tail_seq + 1) || e.prev_hash != tail_hash {
            return Err(Error::Conflict(format!(
                "ledger tail moved (stored seq {tail_seq})"
            )));
        }
        self.0.execute(
            "INSERT INTO credit_entries (seq, id, ts, kind, workspace_id, agent_id, idempotency_key, fingerprint,
               reservation_id, ref_entry_id, expires_at, task_type, memo, actor_kind, actor_id, prev_hash, hash)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
            params![
                i64::try_from(e.seq).unwrap_or(i64::MAX), e.id, e.ts, e.kind.as_str(), e.workspace_id, e.agent_id, e.idempotency_key, e.fingerprint,
                e.reservation_id, e.ref_entry_id, e.expires_at, e.task_type, e.memo, e.actor.kind.as_str(),
                e.actor.id, e.prev_hash, e.hash
            ],
        )
        .map_err(super::db_err)?;
        for (i, p) in e.postings.iter().enumerate() {
            self.0
                .execute(
                    "INSERT INTO credit_postings (entry_seq, idx, account, amount) VALUES (?1,?2,?3,?4)",
                    params![i64::try_from(e.seq).unwrap_or(i64::MAX), i64::try_from(i).unwrap_or(i64::MAX), p.account, p.amount],
                )
                .map_err(super::db_err)?;
        }
        Ok(())
    }
}

impl LedgerStore for SqliteLedgerStore<'_> {
    fn load_all(&self) -> Result<Vec<LedgerEntry>> {
        let mut postings: HashMap<i64, Vec<Posting>> = HashMap::new();
        {
            let mut s = self.0.prepare(
                "SELECT entry_seq, account, amount FROM credit_postings ORDER BY entry_seq, idx",
            )?;
            let rows = s.query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    Posting {
                        account: r.get(1)?,
                        amount: r.get(2)?,
                    },
                ))
            })?;
            for row in rows {
                let (seq, p) = row?;
                postings.entry(seq).or_default().push(p);
            }
        }
        let mut s = self.0.prepare(
            "SELECT seq, id, ts, kind, workspace_id, agent_id, idempotency_key, fingerprint, reservation_id,
                    ref_entry_id, expires_at, task_type, memo, actor_kind, actor_id, prev_hash, hash
             FROM credit_entries ORDER BY seq",
        )?;
        let rows = s.query_map([], |r| {
            let seq: i64 = r.get(0)?;
            let kind: String = r.get(3)?;
            let actor_kind: String = r.get(13)?;
            let bad = |what: &str| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    what.to_owned().into(),
                )
            };
            Ok(LedgerEntry {
                seq: u64::try_from(seq).map_err(|_| bad("negative seq"))?,
                id: r.get(1)?,
                ts: r.get(2)?,
                kind: EntryKind::parse(&kind).ok_or_else(|| bad("unknown entry kind"))?,
                workspace_id: r.get(4)?,
                agent_id: r.get(5)?,
                idempotency_key: r.get(6)?,
                fingerprint: r.get(7)?,
                reservation_id: r.get(8)?,
                ref_entry_id: r.get(9)?,
                expires_at: r.get(10)?,
                task_type: r.get(11)?,
                memo: r.get(12)?,
                actor: Actor {
                    kind: ActorKind::parse(&actor_kind).ok_or_else(|| bad("unknown actor kind"))?,
                    id: r.get(14)?,
                },
                postings: postings.remove(&seq).unwrap_or_default(),
                prev_hash: r.get(15)?,
                hash: r.get(16)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    fn append(&mut self, entry: &LedgerEntry) -> Result<()> {
        let nested = !self.0.is_autocommit();
        self.0.execute_batch(if nested {
            "SAVEPOINT nyx_ledger_append"
        } else {
            "BEGIN IMMEDIATE"
        })?;
        match self.insert(entry) {
            Ok(()) => {
                self.0.execute_batch(if nested {
                    "RELEASE nyx_ledger_append"
                } else {
                    "COMMIT"
                })?;
                Ok(())
            }
            Err(e) => {
                let _ = self.0.execute_batch(if nested {
                    "ROLLBACK TO nyx_ledger_append; RELEASE nyx_ledger_append"
                } else {
                    "ROLLBACK"
                });
                Err(e)
            }
        }
    }
}
