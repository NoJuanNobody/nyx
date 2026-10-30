//! Forward-only, versioned migration runner with embedded SQL.
//!
//! Rules: versions are unique and strictly increasing; applied migrations are recorded with a
//! sha256 checksum and must never change; a database with a version this build does not know is
//! refused (downgrades are not supported); each migration runs in its own transaction.

use std::collections::HashMap;

use rusqlite::{params, Connection, TransactionBehavior};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::model::now_ms;

/// One embedded migration.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    /// Strictly increasing version.
    pub version: u32,
    /// Short name.
    pub name: &'static str,
    /// SQL text.
    pub sql: &'static str,
}

/// Migrations that ship with `nyx-core`. Append only; never edit or reorder.
pub const CORE_MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "identity_lifecycle",
        sql: include_str!("../../migrations/0001_identity_lifecycle.sql"),
    },
    Migration {
        version: 2,
        name: "integrations",
        sql: include_str!("../../migrations/0002_integrations.sql"),
    },
    Migration {
        version: 3,
        name: "documents",
        sql: include_str!("../../migrations/0003_documents.sql"),
    },
    Migration {
        version: 4,
        name: "tickets_audit",
        sql: include_str!("../../migrations/0004_tickets_audit.sql"),
    },
    Migration {
        version: 5,
        name: "chunks",
        sql: include_str!("../../migrations/0005_chunks.sql"),
    },
    Migration {
        version: 6,
        name: "credit_ledger",
        sql: include_str!("../../migrations/0006_credit_ledger.sql"),
    },
    Migration {
        version: 164,
        name: "pipeline_activations",
        sql: include_str!("../../migrations/0164_pipeline_activations.sql"),
    },
    Migration {
        version: 169,
        name: "ticket_drafts",
        sql: include_str!("../../migrations/0169_ticket_drafts.sql"),
    },
    Migration {
        version: 170,
        name: "vcs",
        sql: include_str!("../../migrations/0170_vcs.sql"),
    },
    Migration {
        version: 172,
        name: "deliverables",
        sql: include_str!("../../migrations/0172_deliverables.sql"),
    },
    Migration {
        version: 173,
        name: "intake_records",
        sql: include_str!("../../migrations/0173_intake_records.sql"),
    },
    Migration {
        version: 175,
        name: "ai",
        sql: include_str!("../../migrations/0175_ai.sql"),
    },
    Migration {
        version: 176,
        name: "notifications_governance",
        sql: include_str!("../../migrations/0176_notifications_governance.sql"),
    },
];

fn checksum(sql: &str) -> String {
    hex::encode(Sha256::digest(sql.as_bytes()))
}

/// Highest applied version (0 for a fresh database).
pub fn current_version(conn: &Connection) -> Result<u32> {
    ensure_table(conn)?;
    let v: Option<i64> = conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
        r.get(0)
    })?;
    Ok(u32::try_from(v.unwrap_or(0)).unwrap_or(0))
}

fn ensure_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            checksum   TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        )",
    )?;
    Ok(())
}

/// Apply all pending migrations. Returns the versions applied by this call.
pub fn migrate(conn: &mut Connection, migrations: &[Migration]) -> Result<Vec<u32>> {
    for w in migrations.windows(2) {
        if w[0].version >= w[1].version {
            return Err(Error::Migration(format!(
                "migration versions must be strictly increasing ({} then {})",
                w[0].version, w[1].version
            )));
        }
    }
    ensure_table(conn)?;

    let mut stmt =
        conn.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")?;
    let applied: HashMap<u32, String> = stmt
        .query_map([], |r| {
            Ok((
                u32::try_from(r.get::<_, i64>(0)?).unwrap_or(0),
                r.get::<_, String>(1)?,
            ))
        })?
        .collect::<std::result::Result<_, _>>()?;
    drop(stmt);

    let known: HashMap<u32, &Migration> = migrations.iter().map(|m| (m.version, m)).collect();
    for (v, sum) in &applied {
        match known.get(v) {
            None => {
                return Err(Error::Migration(format!(
                    "database has migration {v} unknown to this build (downgrade is not supported)"
                )))
            }
            Some(m) if checksum(m.sql) != *sum => {
                return Err(Error::Migration(format!(
                "migration {v} ({}) was edited after being applied; add a new migration instead",
                m.name
            )))
            }
            Some(_) => {}
        }
    }
    let max_applied = applied.keys().copied().max().unwrap_or(0);

    let mut done = Vec::new();
    for m in migrations {
        if applied.contains_key(&m.version) {
            continue;
        }
        if m.version < max_applied {
            return Err(Error::Migration(format!(
                "migration {} is older than already-applied {max_applied}; versions must be applied in order",
                m.version
            )));
        }
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(m.sql).map_err(|e| {
            Error::Migration(format!("migration {} ({}) failed: {e}", m.version, m.name))
        })?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
            params![m.version, m.name, checksum(m.sql), now_ms()],
        )?;
        tx.commit()?;
        done.push(m.version);
    }
    Ok(done)
}
