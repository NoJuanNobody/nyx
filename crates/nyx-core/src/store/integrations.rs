//! Integrations.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

use super::{db_err, json_col};
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, Integration, NewIntegration};

/// Integration persistence.
pub trait IntegrationRepo {
    /// Create an integration.
    fn create(&self, new: &NewIntegration) -> Result<Integration>;
    /// Fetch by id.
    fn get(&self, id: &str) -> Result<Integration>;
    /// Integrations of a team.
    fn list(&self, team_id: &str) -> Result<Vec<Integration>>;
    /// Replace the configuration JSON.
    fn update_config(&self, id: &str, config: &Value) -> Result<Integration>;
    /// Delete. Fails if snapshots reference it. Returns whether a row was removed.
    fn delete(&self, id: &str) -> Result<bool>;
}

/// SQLite [`IntegrationRepo`].
#[derive(Debug, Clone, Copy)]
pub struct SqliteIntegrations<'c>(&'c Connection);

impl<'c> SqliteIntegrations<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }
}

fn row(r: &Row<'_>) -> rusqlite::Result<Integration> {
    Ok(Integration {
        id: r.get("id")?,
        team_id: r.get("team_id")?,
        r#type: r.get("type")?,
        config: json_col(r, "config")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

impl IntegrationRepo for SqliteIntegrations<'_> {
    fn create(&self, new: &NewIntegration) -> Result<Integration> {
        let (id, now) = (new_id(), now_ms());
        self.0
            .execute(
                "INSERT INTO integrations (id, team_id, type, config, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
                params![id, new.team_id, new.r#type, serde_json::to_string(&new.config)?, now],
            )
            .map_err(db_err)?;
        self.get(&id)
    }

    fn get(&self, id: &str) -> Result<Integration> {
        self.0
            .query_row("SELECT * FROM integrations WHERE id = ?1", [id], row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("integration {id}")))
    }

    fn list(&self, team_id: &str) -> Result<Vec<Integration>> {
        let mut s = self
            .0
            .prepare("SELECT * FROM integrations WHERE team_id = ?1 ORDER BY created_at, id")?;
        let rows = s
            .query_map([team_id], row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn update_config(&self, id: &str, config: &Value) -> Result<Integration> {
        self.get(id)?;
        self.0.execute(
            "UPDATE integrations SET config = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, serde_json::to_string(config)?, now_ms()],
        )?;
        self.get(id)
    }

    fn delete(&self, id: &str) -> Result<bool> {
        Ok(self
            .0
            .execute("DELETE FROM integrations WHERE id = ?1", [id])
            .map_err(db_err)?
            > 0)
    }
}
