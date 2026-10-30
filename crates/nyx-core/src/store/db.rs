//! Connection handle: opens SQLite, sets pragmas, runs migrations, scopes transactions.

use std::path::Path;

use rusqlite::{Connection, TransactionBehavior};

use super::migrate::{migrate, Migration, CORE_MIGRATIONS};
use crate::error::Result;

/// An open, migrated Nyx database.
#[derive(Debug)]
pub struct Db {
    conn: Connection,
}

impl Db {
    /// Open (creating if needed) a file database and migrate it to the latest schema.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_connection(Connection::open(path)?, &[], true)
    }

    /// Fresh private in-memory database, fully migrated. Ideal for tests.
    pub fn open_in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?, &[], false)
    }

    /// Open a file database with extra migrations (versions above the core ones) applied after the core set.
    pub fn open_with(path: impl AsRef<Path>, extra: &[Migration]) -> Result<Self> {
        Self::from_connection(Connection::open(path)?, extra, true)
    }

    /// In-memory variant of [`Db::open_with`].
    pub fn open_in_memory_with(extra: &[Migration]) -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?, extra, false)
    }

    fn from_connection(mut conn: Connection, extra: &[Migration], file: bool) -> Result<Self> {
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        if file {
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(None, "synchronous", "NORMAL")?;
        }
        let mut all: Vec<Migration> = CORE_MIGRATIONS.to_vec();
        all.extend_from_slice(extra);
        migrate(&mut conn, &all)?;
        Ok(Self { conn })
    }

    /// Borrow the connection for auto-commit statements.
    #[must_use]
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Run `f` in an immediate write transaction: commit on `Ok`, roll back on `Err` (or panic).
    pub fn transaction<T>(&mut self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }
}
