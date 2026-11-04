//! SQLite persistence. One file per aggregate; each exposes a repository trait plus a SQLite
//! implementation that borrows a [`rusqlite::Connection`] (a `&Transaction` derefs to one, so repos
//! compose inside [`Db::transaction`]).
//!
//! Adding an aggregate: create `store/<name>.rs`, register it below, and add the next numbered
//! SQL file under `crates/nyx-core/migrations/` plus its entry in [`migrate::CORE_MIGRATIONS`].

pub mod audit;
pub mod branches;
pub mod chunks;
pub mod credits;
pub mod db;
pub mod documents;
pub mod identity;
pub mod import;
pub mod integrations;
pub mod lifecycles;
pub mod migrate;
pub mod snapshots;
pub mod tickets;

pub use audit::{AuditRepo, SqliteAudit};
pub use branches::{BranchRepo, MergeStrategy, SqliteBranches};
pub use chunks::{ChunkRepo, SqliteChunks};
pub use credits::SqliteLedgerStore;
pub use db::Db;
pub use documents::{DocumentRepo, SqliteDocuments};
pub use identity::{SqliteTeams, SqliteUsers, TeamRepo, UserRepo};
pub use integrations::{IntegrationRepo, SqliteIntegrations};
pub use lifecycles::{LifecycleRepo, SqliteLifecycles};
pub use migrate::{migrate, Migration, CORE_MIGRATIONS};
pub use snapshots::{SnapshotRepo, SqliteSnapshots};
pub use tickets::{SqliteTickets, TicketRepo};

use rusqlite::{ffi, Row};
use serde_json::Value;

use crate::error::Error;

/// Map constraint failures to domain errors; everything else stays a database error.
pub(crate) fn db_err(e: rusqlite::Error) -> Error {
    if let rusqlite::Error::SqliteFailure(f, msg) = &e {
        let text = msg.clone().unwrap_or_default();
        if f.code == rusqlite::ErrorCode::ConstraintViolation {
            return match f.extended_code {
                ffi::SQLITE_CONSTRAINT_UNIQUE | ffi::SQLITE_CONSTRAINT_PRIMARYKEY => {
                    Error::Conflict(text)
                }
                ffi::SQLITE_CONSTRAINT_FOREIGNKEY => {
                    Error::Invalid(format!("referenced row does not exist ({text})"))
                }
                _ => Error::Invalid(text),
            };
        }
    }
    Error::Db(e)
}

/// Read a JSON text column.
pub(crate) fn json_col(row: &Row<'_>, name: &str) -> rusqlite::Result<Value> {
    let s: String = row.get(name)?;
    serde_json::from_str(&s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

/// Read a nullable JSON text column.
pub(crate) fn json_col_opt(row: &Row<'_>, name: &str) -> rusqlite::Result<Option<Value>> {
    let s: Option<String> = row.get(name)?;
    s.map(|s| {
        serde_json::from_str(&s).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })
    })
    .transpose()
}
