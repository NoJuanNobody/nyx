//! Domain model, ported from `apps/api/src/db/schema.ts` (agent, Stripe, subscription and chat
//! tables are intentionally not ported). One file per aggregate. See `docs/rust-core-data-model.md`.
//!
//! Conventions: ids are UUID v4 strings, timestamps are unix milliseconds (UTC), JSON columns are
//! [`serde_json::Value`].

mod audit;
mod document;
mod embedding;
mod identity;
mod integration;
mod lifecycle;
mod ticket;

pub use audit::{AuditEvent, AuditEventType, NewAuditEvent};
pub use document::{
    BranchStatus, Document, DocumentBranch, DocumentVersion, NewBranch, NewDocument, NewSnapshot,
    Snapshot,
};
pub use embedding::{
    cosine_similarity, decode_embedding, encode_embedding, CodeChunk, DocChunk, NewCodeChunk,
    NewDocChunk,
};
pub use identity::{NewTeam, NewUser, Team, TeamMember, User, UserRole};
pub use integration::{Integration, IntegrationType, NewIntegration};
pub use lifecycle::{Lifecycle, LifecycleStage, NewLifecycle, NewLifecycleStage};
pub use ticket::{NewTicket, Ticket, TicketProvider, TicketStatus};

/// Primary key type: a UUID v4 string.
pub type Id = String;
/// Unix milliseconds, UTC.
pub type Timestamp = i64;

/// Generate a fresh id.
#[must_use]
pub fn new_id() -> Id {
    uuid::Uuid::new_v4().to_string()
}

/// Current time in unix milliseconds.
#[must_use]
pub fn now_ms() -> Timestamp {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Declares a string-backed enum with serde, `FromStr`, `Display` and rusqlite conversions.
macro_rules! string_enum {
    ($(#[$m:meta])* $name:ident { $($(#[$vm:meta])* $var:ident => $s:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
        pub enum $name {
            $( $(#[$vm])* #[serde(rename = $s)] $var ),+
        }

        impl $name {
            /// Every variant.
            pub const ALL: &'static [Self] = &[$(Self::$var),+];

            /// Database / wire representation.
            #[must_use]
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$var => $s),+ }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl std::str::FromStr for $name {
            type Err = $crate::error::Error;
            fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
                match s {
                    $($s => Ok(Self::$var),)+
                    other => Err($crate::error::Error::Invalid(
                        format!("unknown {} '{}'", stringify!($name), other),
                    )),
                }
            }
        }

        impl rusqlite::ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
                Ok(rusqlite::types::ToSqlOutput::from(self.as_str()))
            }
        }

        impl rusqlite::types::FromSql for $name {
            fn column_result(v: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
                v.as_str()?
                    .parse()
                    .map_err(|e: $crate::error::Error| rusqlite::types::FromSqlError::Other(Box::new(e)))
            }
        }
    };
}
pub(crate) use string_enum;
