//! Lifecycles and stages.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{db_err, json_col};
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, Lifecycle, LifecycleStage, NewLifecycle, NewLifecycleStage};

/// Lifecycle persistence.
pub trait LifecycleRepo {
    /// Create a lifecycle. Marking it default clears the previous default atomically (use inside a transaction).
    fn create(&self, new: &NewLifecycle) -> Result<Lifecycle>;
    /// Fetch by id.
    fn get(&self, id: &str) -> Result<Lifecycle>;
    /// Fetch by slug.
    fn find_by_slug(&self, slug: &str) -> Result<Option<Lifecycle>>;
    /// The default lifecycle, if any.
    fn default_lifecycle(&self) -> Result<Option<Lifecycle>>;
    /// All lifecycles ordered by `sort_order`.
    fn list(&self) -> Result<Vec<Lifecycle>>;
    /// Add a stage (id on the input is ignored). Duplicate slug yields [`Error::Conflict`].
    fn add_stage(&self, stage: &NewLifecycleStage) -> Result<LifecycleStage>;
    /// Stages of a lifecycle ordered by `sort_order`.
    fn stages(&self, lifecycle_id: &str) -> Result<Vec<LifecycleStage>>;
    /// Delete a lifecycle and (cascade) its stages. Fails if documents still reference it.
    fn delete(&self, id: &str) -> Result<bool>;
}

/// SQLite [`LifecycleRepo`].
#[derive(Debug, Clone, Copy)]
pub struct SqliteLifecycles<'c>(&'c Connection);

impl<'c> SqliteLifecycles<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }
}

fn lifecycle_row(r: &Row<'_>) -> rusqlite::Result<Lifecycle> {
    Ok(Lifecycle {
        id: r.get("id")?,
        slug: r.get("slug")?,
        label: r.get("label")?,
        description: r.get("description")?,
        icon: r.get("icon")?,
        is_default: r.get::<_, i64>("is_default")? != 0,
        sort_order: r.get("sort_order")?,
        created_at: r.get("created_at")?,
    })
}

fn stage_row(r: &Row<'_>) -> rusqlite::Result<LifecycleStage> {
    let docs = json_col(r, "docs")?;
    Ok(LifecycleStage {
        id: r.get("id")?,
        lifecycle_id: r.get("lifecycle_id")?,
        slug: r.get("slug")?,
        sort_order: r.get("sort_order")?,
        label: r.get("label")?,
        abbreviation: r.get("abbreviation")?,
        subtitle: r.get("subtitle")?,
        color: r.get("color")?,
        text_color: r.get("text_color")?,
        dot_color: r.get("dot_color")?,
        border_color: r.get("border_color")?,
        hex: r.get("hex")?,
        who: r.get("who")?,
        description: r.get("description")?,
        icon: r.get("icon")?,
        ai: r.get("ai")?,
        output: r.get("output")?,
        docs: serde_json::from_value(docs).unwrap_or_default(),
    })
}

impl LifecycleRepo for SqliteLifecycles<'_> {
    fn create(&self, new: &NewLifecycle) -> Result<Lifecycle> {
        if new.slug.trim().is_empty() || new.label.trim().is_empty() {
            return Err(Error::Invalid("slug and label are required".into()));
        }
        if new.is_default {
            self.0.execute(
                "UPDATE lifecycles SET is_default = 0 WHERE is_default = 1",
                [],
            )?;
        }
        let id = new_id();
        self.0
            .execute(
                "INSERT INTO lifecycles (id, slug, label, description, icon, is_default, sort_order, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![id, new.slug, new.label, new.description, new.icon, i64::from(new.is_default), new.sort_order, now_ms()],
            )
            .map_err(db_err)?;
        self.get(&id)
    }

    fn get(&self, id: &str) -> Result<Lifecycle> {
        self.0
            .query_row(
                "SELECT * FROM lifecycles WHERE id = ?1",
                [id],
                lifecycle_row,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("lifecycle {id}")))
    }

    fn find_by_slug(&self, slug: &str) -> Result<Option<Lifecycle>> {
        Ok(self
            .0
            .query_row(
                "SELECT * FROM lifecycles WHERE slug = ?1",
                [slug],
                lifecycle_row,
            )
            .optional()?)
    }

    fn default_lifecycle(&self) -> Result<Option<Lifecycle>> {
        Ok(self
            .0
            .query_row(
                "SELECT * FROM lifecycles WHERE is_default = 1",
                [],
                lifecycle_row,
            )
            .optional()?)
    }

    fn list(&self) -> Result<Vec<Lifecycle>> {
        let mut s = self
            .0
            .prepare("SELECT * FROM lifecycles ORDER BY sort_order, slug")?;
        let rows = s
            .query_map([], lifecycle_row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn add_stage(&self, st: &NewLifecycleStage) -> Result<LifecycleStage> {
        let id = new_id();
        let docs = serde_json::to_string(&st.docs)?;
        self.0
            .execute(
                "INSERT INTO lifecycle_stages (id, lifecycle_id, slug, sort_order, label, abbreviation, subtitle,
                   color, text_color, dot_color, border_color, hex, who, description, icon, ai, output, docs)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
                params![
                    id, st.lifecycle_id, st.slug, st.sort_order, st.label, st.abbreviation, st.subtitle, st.color,
                    st.text_color, st.dot_color, st.border_color, st.hex, st.who, st.description, st.icon, st.ai,
                    st.output, docs
                ],
            )
            .map_err(db_err)?;
        Ok(self.0.query_row(
            "SELECT * FROM lifecycle_stages WHERE id = ?1",
            [&id],
            stage_row,
        )?)
    }

    fn stages(&self, lifecycle_id: &str) -> Result<Vec<LifecycleStage>> {
        let mut s = self.0.prepare(
            "SELECT * FROM lifecycle_stages WHERE lifecycle_id = ?1 ORDER BY sort_order, slug",
        )?;
        let rows = s
            .query_map([lifecycle_id], stage_row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn delete(&self, id: &str) -> Result<bool> {
        Ok(self
            .0
            .execute("DELETE FROM lifecycles WHERE id = ?1", [id])
            .map_err(db_err)?
            > 0)
    }
}
