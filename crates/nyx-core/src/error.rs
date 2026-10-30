//! Error type shared across the core.

/// Core error type.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A requested entity does not exist.
    #[error("not found: {0}")]
    NotFound(String),
    /// Caller supplied invalid input.
    #[error("invalid input: {0}")]
    Invalid(String),
    /// Insufficient credit balance for an operation.
    #[error("insufficient credits: need {needed}, have {available}")]
    InsufficientCredits {
        /// Credits required.
        needed: u64,
        /// Credits available.
        available: u64,
    },
    /// Underlying I/O failure.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Core result alias.
pub type Result<T> = std::result::Result<T, Error>;
