//! Error type shared across the core.

use crate::ledger::LedgerError;

/// Core error type.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A requested entity does not exist.
    #[error("not found: {0}")]
    NotFound(String),
    /// Caller supplied invalid input.
    #[error("invalid input: {0}")]
    Invalid(String),
    /// The operation conflicts with current state (stale base, duplicate, lost race).
    #[error("conflict: {0}")]
    Conflict(String),
    /// Insufficient credit balance for an operation.
    #[error("insufficient credits: need {needed}, have {available}")]
    InsufficientCredits {
        /// Credits required.
        needed: u64,
        /// Credits available.
        available: u64,
    },
    /// A credit ledger rule was violated.
    #[error(transparent)]
    Ledger(#[from] LedgerError),
    /// SQLite failure.
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    /// JSON (de)serialisation failure.
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    /// Migration runner failure (checksum drift, unknown future version, bad SQL).
    #[error("migration error: {0}")]
    Migration(String),
    /// Underlying I/O failure.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Core result alias.
pub type Result<T> = std::result::Result<T, Error>;
