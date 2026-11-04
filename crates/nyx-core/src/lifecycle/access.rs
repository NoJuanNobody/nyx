//! Pipeline activation records (TS: `pipeline-access.service.ts`).
//!
//! Pipelines are free: activation only records that a user switched a pipeline on, idempotently,
//! and never touches the credit ledger. `credits_paid` is kept in [`Activation`] for API parity
//! and is always `0`.

use rusqlite::{params, Connection};
use serde::Serialize;

use super::pipeline::Registry;
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, Id, Timestamp};
use crate::store::db_err;
use crate::store::lifecycles::{LifecycleRepo, SqliteLifecycles};

/// Result of [`PipelineAccess::activate`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Activation {
    /// True when the user had already activated this pipeline.
    pub already_owned: bool,
    /// Always 0: activation is free.
    pub credits_paid: u64,
}

/// One activated pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OwnedPipeline {
    /// Row id.
    pub id: Id,
    /// Pipeline (lifecycle) slug.
    pub pipeline_slug: String,
    /// Team the activation was made for, if any.
    pub team_id: Option<Id>,
    /// Activation time.
    pub activated_at: Timestamp,
    /// Always 0.
    pub credits_paid: u64,
}

/// Activation store borrowing a connection.
#[derive(Debug, Clone, Copy)]
pub struct PipelineAccess<'c>(&'c Connection);

impl<'c> PipelineAccess<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }

    /// Has `user_id` activated `pipeline_slug`?
    pub fn has_access(&self, user_id: &str, pipeline_slug: &str) -> Result<bool> {
        Ok(self.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM pipeline_activations WHERE user_id = ?1 AND pipeline_slug = ?2)",
            params![user_id, pipeline_slug],
            |r| r.get::<_, i64>(0),
        )? != 0)
    }

    /// Activate a pipeline for a user, free and idempotent. The slug must be a built-in pipeline
    /// or an existing lifecycle (the TS service did not check; unknown ids are rejected here).
    pub fn activate(
        &self,
        user_id: &str,
        pipeline_slug: &str,
        team_id: Option<&str>,
    ) -> Result<Activation> {
        if user_id.trim().is_empty() {
            return Err(Error::Invalid("user_id is required".into()));
        }
        let known = Registry::builtin().get(pipeline_slug).is_some()
            || SqliteLifecycles::new(self.0)
                .find_by_slug(pipeline_slug)?
                .is_some();
        if !known {
            return Err(Error::NotFound(format!("pipeline {pipeline_slug}")));
        }
        if self.has_access(user_id, pipeline_slug)? {
            return Ok(Activation {
                already_owned: true,
                credits_paid: 0,
            });
        }
        self.0
            .execute(
                "INSERT OR IGNORE INTO pipeline_activations (id, user_id, pipeline_slug, team_id, activated_at)
                 VALUES (?1,?2,?3,?4,?5)",
                params![new_id(), user_id, pipeline_slug, team_id, now_ms()],
            )
            .map_err(db_err)?;
        Ok(Activation {
            already_owned: false,
            credits_paid: 0,
        })
    }

    /// All pipelines a user has activated, oldest first.
    pub fn list_owned(&self, user_id: &str) -> Result<Vec<OwnedPipeline>> {
        let mut s = self.0.prepare(
            "SELECT id, pipeline_slug, team_id, activated_at FROM pipeline_activations
             WHERE user_id = ?1 ORDER BY activated_at, pipeline_slug",
        )?;
        let rows = s
            .query_map([user_id], |r| {
                Ok(OwnedPipeline {
                    id: r.get(0)?,
                    pipeline_slug: r.get(1)?,
                    team_id: r.get(2)?,
                    activated_at: r.get(3)?,
                    credits_paid: 0,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Db;

    #[test]
    fn activation_is_free_and_idempotent() {
        let db = Db::open_in_memory().unwrap();
        let acc = PipelineAccess::new(db.conn());
        assert!(!acc.has_access("u1", "hardware_design").unwrap());
        let first = acc.activate("u1", "hardware_design", Some("t1")).unwrap();
        assert_eq!(
            first,
            Activation {
                already_owned: false,
                credits_paid: 0
            }
        );
        assert!(acc.has_access("u1", "hardware_design").unwrap());
        let second = acc.activate("u1", "hardware_design", None).unwrap();
        assert_eq!(
            second,
            Activation {
                already_owned: true,
                credits_paid: 0
            }
        );
        acc.activate("u1", "contract_law", None).unwrap();
        acc.activate("u2", "contract_law", None).unwrap();
        let owned = acc.list_owned("u1").unwrap();
        assert_eq!(owned.len(), 2);
        let hw = owned
            .iter()
            .find(|o| o.pipeline_slug == "hardware_design")
            .unwrap();
        assert_eq!(hw.team_id.as_deref(), Some("t1"));
        assert!(owned.iter().all(|o| o.credits_paid == 0));
        assert_eq!(acc.list_owned("u2").unwrap().len(), 1);
        assert_eq!(acc.list_owned("nobody").unwrap().len(), 0);
    }

    #[test]
    fn unknown_pipelines_and_blank_users_are_rejected() {
        let db = Db::open_in_memory().unwrap();
        let acc = PipelineAccess::new(db.conn());
        assert!(matches!(
            acc.activate("u1", "no_such", None),
            Err(Error::NotFound(_))
        ));
        assert!(matches!(
            acc.activate(" ", "contract_law", None),
            Err(Error::Invalid(_))
        ));
    }

    #[test]
    fn seeded_custom_lifecycles_can_be_activated() {
        let db = Db::open_in_memory().unwrap();
        SqliteLifecycles::new(db.conn())
            .create(&crate::model::NewLifecycle::new("custom_flow", "Custom"))
            .unwrap();
        let acc = PipelineAccess::new(db.conn());
        assert!(
            !acc.activate("u1", "custom_flow", None)
                .unwrap()
                .already_owned
        );
    }

    #[test]
    fn never_touches_the_ledger_tables() {
        let db = Db::open_in_memory().unwrap();
        PipelineAccess::new(db.conn())
            .activate("u1", "contract_law", None)
            .unwrap();
        let n: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM credit_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}
