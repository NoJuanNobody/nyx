//! SQLite persistence for the AI feature set (migration `0175_ai`): non-secret provider
//! settings, the token usage log (`GET /ai-usage`) and ticket suggestions
//! (`suggestion.service.ts`). API keys are never stored here; see [`super::config::ByokKeys`].

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::advisor::UsageSink;
use super::config::{ProviderConfig, ProviderKind};
use super::parse::TicketDraft;
use super::provider::Usage;
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, Id, Timestamp};
use crate::store::db_err;

/// Persisted provider settings.
#[derive(Debug, Clone, Copy)]
pub struct SqliteProviderConfigs<'c>(&'c Connection);

impl<'c> SqliteProviderConfigs<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }

    fn row(r: &Row<'_>) -> rusqlite::Result<(ProviderConfig, bool)> {
        let kind: String = r.get("kind")?;
        let kind = ProviderKind::from_slug(&kind).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::other(e.to_string())),
            )
        })?;
        Ok((
            ProviderConfig {
                kind,
                model: r.get("model")?,
                fast_model: r.get("fast_model")?,
                base_url: r.get("base_url")?,
            },
            r.get::<_, i64>("is_active")? != 0,
        ))
    }

    /// Insert or update a provider's settings (activation state is preserved).
    ///
    /// # Errors
    /// [`Error::Invalid`] if the config fails validation; database failure.
    pub fn upsert(&self, cfg: &ProviderConfig) -> Result<()> {
        cfg.validate()?;
        let now = now_ms();
        self.0
            .execute(
                "INSERT INTO ai_provider_configs (kind, model, fast_model, base_url, is_active, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)
                 ON CONFLICT(kind) DO UPDATE SET model = ?2, fast_model = ?3, base_url = ?4, updated_at = ?5",
                params![cfg.kind.slug(), cfg.model, cfg.fast_model, cfg.base_url, now],
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// All configured providers.
    ///
    /// # Errors
    /// Database failure.
    pub fn list(&self) -> Result<Vec<ProviderConfig>> {
        let mut st = self
            .0
            .prepare("SELECT * FROM ai_provider_configs ORDER BY created_at, kind")?;
        let rows = st
            .query_map([], Self::row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(|(c, _)| c).collect())
    }

    /// One provider's settings.
    ///
    /// # Errors
    /// Database failure.
    pub fn get(&self, kind: ProviderKind) -> Result<Option<ProviderConfig>> {
        Ok(self
            .0
            .query_row(
                "SELECT * FROM ai_provider_configs WHERE kind = ?1",
                [kind.slug()],
                Self::row,
            )
            .optional()?
            .map(|(c, _)| c))
    }

    /// Remove a provider's settings (does not touch its key in the secret store).
    ///
    /// # Errors
    /// [`Error::NotFound`] if it was not configured.
    pub fn delete(&self, kind: ProviderKind) -> Result<()> {
        let n = self.0.execute(
            "DELETE FROM ai_provider_configs WHERE kind = ?1",
            [kind.slug()],
        )?;
        if n == 0 {
            return Err(Error::NotFound(format!("provider {}", kind.slug())));
        }
        Ok(())
    }

    /// Make `kind` the single active provider.
    ///
    /// # Errors
    /// [`Error::NotFound`] if it is not configured.
    pub fn set_active(&self, kind: ProviderKind) -> Result<()> {
        if self.get(kind)?.is_none() {
            return Err(Error::NotFound(format!("provider {}", kind.slug())));
        }
        self.0.execute(
            "UPDATE ai_provider_configs SET is_active = (kind = ?1)",
            [kind.slug()],
        )?;
        Ok(())
    }

    /// The active provider, if one was chosen. `None` means "auto-select".
    ///
    /// # Errors
    /// Database failure.
    pub fn active(&self) -> Result<Option<ProviderKind>> {
        let slug: Option<String> = self
            .0
            .query_row(
                "SELECT kind FROM ai_provider_configs WHERE is_active = 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        slug.map(|s| ProviderKind::from_slug(&s)).transpose()
    }
}

/// Usage totals for one operation.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationUsage {
    /// Operation name (`analyze`, `generate-document`, ...).
    pub operation: String,
    /// Prompt tokens.
    pub input_tokens: u64,
    /// Completion tokens.
    pub output_tokens: u64,
}

/// Aggregated usage (port of `GET /ai-usage`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    /// Total prompt tokens.
    pub total_input_tokens: u64,
    /// Total completion tokens.
    pub total_output_tokens: u64,
    /// Per operation, ordered by name.
    pub by_operation: Vec<OperationUsage>,
}

/// Usage log; also a [`UsageSink`] so an `Advisor` can record straight into SQLite.
#[derive(Debug, Clone, Copy)]
pub struct SqliteUsage<'c>(&'c Connection);

impl<'c> SqliteUsage<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }

    /// Append a usage row with an explicit timestamp.
    ///
    /// # Errors
    /// Database failure.
    pub fn record_at(
        &self,
        at: Timestamp,
        operation: &str,
        provider: &str,
        model: &str,
        usage: Usage,
    ) -> Result<()> {
        self.0.execute(
            "INSERT INTO ai_usage_log (id, operation, provider, model, input_tokens, output_tokens, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                new_id(),
                operation,
                provider,
                model,
                i64::try_from(usage.input_tokens).unwrap_or(i64::MAX),
                i64::try_from(usage.output_tokens).unwrap_or(i64::MAX),
                at
            ],
        )?;
        Ok(())
    }

    /// Totals since `since_ms` (unix ms).
    ///
    /// # Errors
    /// Database failure.
    pub fn summary(&self, since_ms: Timestamp) -> Result<UsageSummary> {
        let mut st = self.0.prepare(
            "SELECT operation, SUM(input_tokens), SUM(output_tokens) FROM ai_usage_log
             WHERE created_at >= ?1 GROUP BY operation ORDER BY operation",
        )?;
        let by_operation = st
            .query_map([since_ms], |r| {
                Ok(OperationUsage {
                    operation: r.get(0)?,
                    input_tokens: u64::try_from(r.get::<_, i64>(1)?).unwrap_or(0),
                    output_tokens: u64::try_from(r.get::<_, i64>(2)?).unwrap_or(0),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(UsageSummary {
            total_input_tokens: by_operation.iter().map(|o| o.input_tokens).sum(),
            total_output_tokens: by_operation.iter().map(|o| o.output_tokens).sum(),
            by_operation,
        })
    }
}

impl UsageSink for SqliteUsage<'_> {
    fn record(&self, operation: &str, provider: &str, model: &str, usage: Usage) {
        // Usage accounting must never fail the user's request.
        let _ = self.record_at(now_ms(), operation, provider, model, usage);
    }
}

/// Review state of a suggestion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SuggestionStatus {
    /// Awaiting review.
    Pending,
    /// Turned into a ticket.
    Approved,
    /// Rejected.
    Dismissed,
}

impl SuggestionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Dismissed => "dismissed",
        }
    }

    fn parse(s: &str) -> Result<Self> {
        match s {
            "pending" => Ok(Self::Pending),
            "approved" => Ok(Self::Approved),
            "dismissed" => Ok(Self::Dismissed),
            other => Err(Error::Invalid(format!("bad suggestion status {other:?}"))),
        }
    }
}

/// An AI-proposed ticket awaiting review.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketSuggestion {
    /// Id.
    pub id: Id,
    /// Document it was generated from.
    pub document_id: Id,
    /// Title.
    pub title: String,
    /// Description (markdown).
    pub description: String,
    /// Labels.
    pub labels: Vec<String>,
    /// Review state.
    pub status: SuggestionStatus,
    /// Reviewer.
    pub reviewed_by_id: Option<Id>,
    /// Created (unix ms).
    pub created_at: Timestamp,
    /// Updated (unix ms).
    pub updated_at: Timestamp,
}

/// Ticket suggestions (`suggestion.service.ts`). Creating the actual ticket on approval is the
/// caller's job (through `TicketRepo` / the git provider); `approve` only flips the state.
#[derive(Debug, Clone, Copy)]
pub struct SqliteSuggestions<'c>(&'c Connection);

impl<'c> SqliteSuggestions<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }

    fn row(r: &Row<'_>) -> rusqlite::Result<TicketSuggestion> {
        let labels: String = r.get("labels")?;
        let status: String = r.get("status")?;
        let bad = |e: String| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::other(e)),
            )
        };
        Ok(TicketSuggestion {
            id: r.get("id")?,
            document_id: r.get("document_id")?,
            title: r.get("title")?,
            description: r.get("description")?,
            labels: serde_json::from_str(&labels).map_err(|e| bad(e.to_string()))?,
            status: SuggestionStatus::parse(&status).map_err(|e| bad(e.to_string()))?,
            reviewed_by_id: r.get("reviewed_by_id")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
        })
    }

    /// Store drafts as pending suggestions for a document.
    ///
    /// # Errors
    /// [`Error::Invalid`] if the document does not exist.
    pub fn create_many(
        &self,
        document_id: &str,
        drafts: &[TicketDraft],
    ) -> Result<Vec<TicketSuggestion>> {
        let now = now_ms();
        drafts
            .iter()
            .map(|d| {
                let id = new_id();
                self.0
                    .execute(
                        "INSERT INTO ticket_suggestions (id, document_id, title, description, labels, status, created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)",
                        params![id, document_id, d.title, d.description, serde_json::to_string(&d.labels)?, now],
                    )
                    .map_err(db_err)?;
                self.get(&id)
            })
            .collect()
    }

    /// Fetch one.
    ///
    /// # Errors
    /// [`Error::NotFound`].
    pub fn get(&self, id: &str) -> Result<TicketSuggestion> {
        self.0
            .query_row(
                "SELECT * FROM ticket_suggestions WHERE id = ?1",
                [id],
                Self::row,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("Suggestion not found: {id}")))
    }

    /// Suggestions of a document, newest first.
    ///
    /// # Errors
    /// Database failure.
    pub fn list_by_document(&self, document_id: &str) -> Result<Vec<TicketSuggestion>> {
        let mut st = self.0.prepare("SELECT * FROM ticket_suggestions WHERE document_id = ?1 ORDER BY created_at DESC, rowid DESC")?;
        let rows = st
            .query_map([document_id], Self::row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    fn require_pending(&self, id: &str) -> Result<TicketSuggestion> {
        let s = self.get(id)?;
        if s.status == SuggestionStatus::Pending {
            Ok(s)
        } else {
            Err(Error::Conflict("Suggestion already reviewed".into()))
        }
    }

    /// Edit a pending suggestion (`None` leaves a field untouched).
    ///
    /// # Errors
    /// [`Error::NotFound`]; [`Error::Conflict`] if already reviewed.
    pub fn update(
        &self,
        id: &str,
        title: Option<&str>,
        description: Option<&str>,
        labels: Option<&[String]>,
    ) -> Result<TicketSuggestion> {
        self.require_pending(id)?;
        let labels = labels.map(serde_json::to_string).transpose()?;
        self.0.execute(
            "UPDATE ticket_suggestions SET title = COALESCE(?2, title), description = COALESCE(?3, description),
             labels = COALESCE(?4, labels), updated_at = ?5 WHERE id = ?1",
            params![id, title, description, labels, now_ms()],
        )?;
        self.get(id)
    }

    /// Replace the description with an expanded one (allowed in any state, like the TS service).
    ///
    /// # Errors
    /// [`Error::NotFound`].
    pub fn set_description(&self, id: &str, description: &str) -> Result<TicketSuggestion> {
        self.get(id)?;
        self.0.execute(
            "UPDATE ticket_suggestions SET description = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, description, now_ms()],
        )?;
        self.get(id)
    }

    fn review(
        &self,
        id: &str,
        status: SuggestionStatus,
        reviewer: Option<&str>,
    ) -> Result<TicketSuggestion> {
        self.require_pending(id)?;
        self.0.execute(
            "UPDATE ticket_suggestions SET status = ?2, reviewed_by_id = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, status.as_str(), reviewer, now_ms()],
        )?;
        self.get(id)
    }

    /// Mark approved (call after the ticket was created).
    ///
    /// # Errors
    /// [`Error::NotFound`]; [`Error::Conflict`] if already reviewed.
    pub fn approve(&self, id: &str, reviewer: Option<&str>) -> Result<TicketSuggestion> {
        self.review(id, SuggestionStatus::Approved, reviewer)
    }

    /// Mark dismissed.
    ///
    /// # Errors
    /// [`Error::NotFound`]; [`Error::Conflict`] if already reviewed.
    pub fn dismiss(&self, id: &str, reviewer: Option<&str>) -> Result<TicketSuggestion> {
        self.review(id, SuggestionStatus::Dismissed, reviewer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{NewDocument, NewTeam, NewUser};
    use crate::store::{
        Db, DocumentRepo, SqliteDocuments, SqliteTeams, SqliteUsers, TeamRepo, UserRepo,
    };

    fn db_with_doc() -> (Db, String) {
        let db = Db::open_in_memory().unwrap();
        let user = SqliteUsers::new(db.conn())
            .create(&NewUser {
                email: "a@b.c".into(),
                name: "A".into(),
                avatar_url: None,
            })
            .unwrap();
        let team = SqliteTeams::new(db.conn())
            .create(&NewTeam {
                name: "T".into(),
                slug: "t".into(),
            })
            .unwrap();
        let doc = SqliteDocuments::new(db.conn())
            .create(&NewDocument {
                title: "D".into(),
                content: "c".into(),
                path: "/".into(),
                team_id: team.id,
                created_by_id: user.id,
                stage: None,
                lifecycle_id: None,
            })
            .unwrap();
        (db, doc.id)
    }

    fn draft(t: &str) -> TicketDraft {
        TicketDraft {
            title: t.into(),
            description: format!("{t} desc"),
            labels: vec!["x".into()],
        }
    }

    #[test]
    fn migration_applies_and_provider_configs_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let repo = SqliteProviderConfigs::new(db.conn());
        assert!(repo.list().unwrap().is_empty());
        assert_eq!(repo.active().unwrap(), None);
        repo.upsert(&ProviderConfig::new(ProviderKind::Anthropic))
            .unwrap();
        let mut or = ProviderConfig::new(ProviderKind::OpenRouter);
        or.fast_model = Some("anthropic/claude-haiku-4-5".into());
        repo.upsert(&or).unwrap();
        assert_eq!(repo.list().unwrap().len(), 2);
        assert_eq!(repo.get(ProviderKind::OpenRouter).unwrap().unwrap(), or);
        assert_eq!(repo.get(ProviderKind::OpenAi).unwrap(), None);

        repo.set_active(ProviderKind::OpenRouter).unwrap();
        assert_eq!(repo.active().unwrap(), Some(ProviderKind::OpenRouter));
        repo.set_active(ProviderKind::Anthropic).unwrap();
        assert_eq!(repo.active().unwrap(), Some(ProviderKind::Anthropic));

        // Update keeps activation.
        let mut a = ProviderConfig::new(ProviderKind::Anthropic);
        a.model = "claude-opus".into();
        repo.upsert(&a).unwrap();
        assert_eq!(repo.active().unwrap(), Some(ProviderKind::Anthropic));
        assert_eq!(
            repo.get(ProviderKind::Anthropic).unwrap().unwrap().model,
            "claude-opus"
        );

        assert!(matches!(
            repo.set_active(ProviderKind::OpenAi),
            Err(Error::NotFound(_))
        ));
        repo.delete(ProviderKind::Anthropic).unwrap();
        assert_eq!(repo.active().unwrap(), None);
        assert!(matches!(
            repo.delete(ProviderKind::Anthropic),
            Err(Error::NotFound(_))
        ));
        // Invalid config is refused.
        assert!(repo
            .upsert(&ProviderConfig::new(ProviderKind::OpenAiCompatible))
            .is_err());
    }

    #[test]
    fn usage_log_aggregates_by_operation_since() {
        let db = Db::open_in_memory().unwrap();
        let u = SqliteUsage::new(db.conn());
        let us = |i, o| Usage {
            input_tokens: i,
            output_tokens: o,
        };
        u.record_at(1_000, "analyze", "anthropic", "m", us(10, 1))
            .unwrap();
        u.record_at(2_000, "analyze", "anthropic", "m", us(20, 2))
            .unwrap();
        u.record_at(3_000, "generate-document", "anthropic", "m", us(5, 50))
            .unwrap();
        u.record_at(10, "old", "anthropic", "m", us(999, 999))
            .unwrap();
        let s = u.summary(500).unwrap();
        assert_eq!(s.total_input_tokens, 35);
        assert_eq!(s.total_output_tokens, 53);
        assert_eq!(s.by_operation.len(), 2);
        assert_eq!(
            s.by_operation[0],
            OperationUsage {
                operation: "analyze".into(),
                input_tokens: 30,
                output_tokens: 3
            }
        );
        let empty = u.summary(i64::MAX).unwrap();
        assert!(empty.by_operation.is_empty() && empty.total_input_tokens == 0);
        // Sink path.
        UsageSink::record(&u, "sink-op", "p", "m", us(1, 1));
        assert_eq!(
            u.summary(0)
                .unwrap()
                .by_operation
                .iter()
                .filter(|o| o.operation == "sink-op")
                .count(),
            1
        );
    }

    #[test]
    fn suggestion_lifecycle() {
        let (db, doc) = db_with_doc();
        let repo = SqliteSuggestions::new(db.conn());
        let made = repo.create_many(&doc, &[draft("A"), draft("B")]).unwrap();
        assert_eq!(made.len(), 2);
        assert!(made
            .iter()
            .all(|s| s.status == SuggestionStatus::Pending && s.labels == vec!["x"]));
        assert_eq!(repo.list_by_document(&doc).unwrap().len(), 2);

        let upd = repo
            .update(
                &made[0].id,
                Some("A2"),
                None,
                Some(&["y".to_owned(), "z".to_owned()]),
            )
            .unwrap();
        assert_eq!(upd.title, "A2");
        assert_eq!(upd.description, "A desc");
        assert_eq!(upd.labels, vec!["y", "z"]);

        let expanded = repo
            .set_description(&made[0].id, "## Context\nfull")
            .unwrap();
        assert_eq!(expanded.description, "## Context\nfull");

        let ok = repo.approve(&made[0].id, Some("user-1")).unwrap();
        assert_eq!(ok.status, SuggestionStatus::Approved);
        assert_eq!(ok.reviewed_by_id.as_deref(), Some("user-1"));
        assert!(matches!(
            repo.approve(&made[0].id, None),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            repo.update(&made[0].id, Some("x"), None, None),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            repo.dismiss(&made[0].id, None),
            Err(Error::Conflict(_))
        ));
        // Expansion is still allowed after review.
        assert!(repo.set_description(&made[0].id, "late").is_ok());

        let d = repo.dismiss(&made[1].id, None).unwrap();
        assert_eq!(d.status, SuggestionStatus::Dismissed);
        assert!(matches!(repo.get("nope"), Err(Error::NotFound(_))));
    }

    #[test]
    fn suggestions_require_existing_document() {
        let (db, doc) = db_with_doc();
        let repo = SqliteSuggestions::new(db.conn());
        assert!(matches!(
            repo.create_many("missing-doc", &[draft("A")]),
            Err(Error::Invalid(_))
        ));
        repo.create_many(&doc, &[draft("A")]).unwrap();
    }
}
