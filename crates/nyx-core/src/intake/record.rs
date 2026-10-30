//! Intake record lifecycle and persistence.
//!
//! Replaces the hosted `intake_sessions` table (`pending | processed | clarification_needed`)
//! with an explicit state machine:
//!
//! ```text
//! received -> parsed -> structured
//!                    -> clarification_needed -> structured | clarification_needed
//! any of received/parsed/clarification_needed -> failed -> received (retry)
//! ```
//!
//! "Structured" is the LLM step, performed by the caller: build a
//! [`super::StructuringPrompt`], send it, then hand the reply to
//! [`IntakeRepo::mark_structured`], which sets `clarification_needed` for low-confidence specs
//! exactly like `routes/intake.ts`.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::kind::InputKind;
use super::structuring::{Confidence, StructuredSpec};
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, string_enum, Id, Timestamp};
use crate::store::db_err;

string_enum! {
    /// Lifecycle state of an intake record.
    IntakeStatus {
        /// Stored, nothing extracted yet.
        Received => "received",
        /// Text extracted (parsed, OCR'd or transcribed).
        Parsed => "parsed",
        /// A spec draft was produced with usable confidence.
        Structured => "structured",
        /// The draft has low confidence; answers to its open questions are needed.
        ClarificationNeeded => "clarification_needed",
        /// Extraction or structuring failed; see `error`.
        Failed => "failed",
    }
}

impl IntakeStatus {
    /// Is `self -> to` a legal transition?
    #[must_use]
    pub fn can_become(self, to: Self) -> bool {
        use IntakeStatus::{ClarificationNeeded, Failed, Parsed, Received, Structured};
        matches!(
            (self, to),
            (Received, Parsed | Failed)
                | (Parsed, Structured | ClarificationNeeded | Failed)
                | (
                    ClarificationNeeded,
                    Structured | ClarificationNeeded | Failed
                )
                | (Failed, Received)
        )
    }
}

/// A stored intake.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IntakeRecord {
    /// Id.
    pub id: Id,
    /// Owning team.
    pub team_id: Id,
    /// Creator.
    pub created_by_id: Id,
    /// Detected input kind.
    pub kind: InputKind,
    /// Sanitised original file name, if any.
    pub source_name: Option<String>,
    /// MIME type.
    pub mime: String,
    /// Size of the original input.
    pub size_bytes: i64,
    /// Hex SHA-256 of the original input.
    pub sha256: String,
    /// Lifecycle state.
    pub status: IntakeStatus,
    /// Extracted text (the "raw input" handed to structuring).
    pub raw_text: Option<String>,
    /// Parser note shown to the user.
    pub note: Option<String>,
    /// The [`StructuredSpec`] as JSON, once structured.
    pub structured_output: Option<serde_json::Value>,
    /// Failure message, when `failed`.
    pub error: Option<String>,
    /// Document created from this intake.
    pub document_id: Option<Id>,
    /// Creation time.
    pub created_at: Timestamp,
    /// Last change.
    pub updated_at: Timestamp,
}

impl IntakeRecord {
    /// Decode [`IntakeRecord::structured_output`].
    pub fn spec(&self) -> Result<Option<StructuredSpec>> {
        self.structured_output
            .as_ref()
            .map(|v| serde_json::from_value(v.clone()).map_err(Error::from))
            .transpose()
    }
}

/// Input for [`IntakeRepo::create`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewIntakeRecord {
    /// Team.
    pub team_id: Id,
    /// Creator.
    pub created_by_id: Id,
    /// Kind.
    pub kind: InputKind,
    /// Sanitised file name.
    pub source_name: Option<String>,
    /// MIME type.
    pub mime: String,
    /// Original size.
    pub size_bytes: i64,
    /// Hex SHA-256 of the original.
    pub sha256: String,
}

impl NewIntakeRecord {
    /// Build from the original bytes (computes size and SHA-256).
    #[must_use]
    pub fn from_bytes(
        team_id: &str,
        created_by_id: &str,
        kind: InputKind,
        source_name: Option<String>,
        mime: &str,
        bytes: &[u8],
    ) -> Self {
        Self {
            team_id: team_id.into(),
            created_by_id: created_by_id.into(),
            kind,
            source_name,
            mime: mime.into(),
            size_bytes: i64::try_from(bytes.len()).unwrap_or(i64::MAX),
            sha256: hex::encode(Sha256::digest(bytes)),
        }
    }
}

/// Intake persistence.
pub trait IntakeRepo {
    /// Insert a record in state `received`.
    fn create(&self, new: &NewIntakeRecord) -> Result<IntakeRecord>;
    /// Fetch by id.
    fn get(&self, id: &str) -> Result<IntakeRecord>;
    /// Newest-first history of a team (`GET /api/intake/history`).
    fn list_by_team(&self, team_id: &str) -> Result<Vec<IntakeRecord>>;
    /// Earlier intakes of the same bytes in a team, newest first.
    fn find_by_hash(&self, team_id: &str, sha256: &str) -> Result<Vec<IntakeRecord>>;
    /// `received -> parsed`, storing the extracted text and an optional note.
    fn mark_parsed(&self, id: &str, text: &str, note: Option<&str>) -> Result<IntakeRecord>;
    /// `parsed | clarification_needed -> structured | clarification_needed`: low confidence
    /// means clarification is needed (as in `routes/intake.ts`).
    fn mark_structured(&self, id: &str, spec: &StructuredSpec) -> Result<IntakeRecord>;
    /// Move to `failed` with a message.
    fn mark_failed(&self, id: &str, error: &str) -> Result<IntakeRecord>;
    /// `failed -> received`, clearing the error.
    fn retry(&self, id: &str) -> Result<IntakeRecord>;
    /// Remember which document was created from this intake (no status change).
    fn link_document(&self, id: &str, document_id: &str) -> Result<IntakeRecord>;
}

/// SQLite [`IntakeRepo`].
#[derive(Debug, Clone, Copy)]
pub struct SqliteIntake<'c>(&'c Connection);

impl<'c> SqliteIntake<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }

    fn transition(&self, id: &str, to: IntakeStatus) -> Result<IntakeRecord> {
        let cur = self.get(id)?;
        if !cur.status.can_become(to) {
            return Err(Error::Conflict(format!(
                "intake {id}: cannot go from {} to {to}",
                cur.status
            )));
        }
        Ok(cur)
    }
}

fn row(r: &Row<'_>) -> rusqlite::Result<IntakeRecord> {
    let so: Option<String> = r.get("structured_output")?;
    Ok(IntakeRecord {
        id: r.get("id")?,
        team_id: r.get("team_id")?,
        created_by_id: r.get("created_by_id")?,
        kind: r.get("kind")?,
        source_name: r.get("source_name")?,
        mime: r.get("mime")?,
        size_bytes: r.get("size_bytes")?,
        sha256: r.get("sha256")?,
        status: r.get("status")?,
        raw_text: r.get("raw_text")?,
        note: r.get("note")?,
        structured_output: so
            .map(|s| {
                serde_json::from_str(&s).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })
            })
            .transpose()?,
        error: r.get("error")?,
        document_id: r.get("document_id")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

impl IntakeRepo for SqliteIntake<'_> {
    fn create(&self, n: &NewIntakeRecord) -> Result<IntakeRecord> {
        let id = new_id();
        let now = now_ms();
        self.0
            .execute(
                "INSERT INTO intake_records (id, team_id, created_by_id, kind, source_name, mime, size_bytes, sha256, status, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'received',?9,?9)",
                params![id, n.team_id, n.created_by_id, n.kind, n.source_name, n.mime, n.size_bytes, n.sha256, now],
            )
            .map_err(db_err)?;
        self.get(&id)
    }

    fn get(&self, id: &str) -> Result<IntakeRecord> {
        self.0
            .query_row("SELECT * FROM intake_records WHERE id = ?1", [id], row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("intake {id}")))
    }

    fn list_by_team(&self, team_id: &str) -> Result<Vec<IntakeRecord>> {
        let mut s = self.0.prepare(
            "SELECT * FROM intake_records WHERE team_id = ?1 ORDER BY created_at DESC, rowid DESC",
        )?;
        let rows = s
            .query_map([team_id], row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn find_by_hash(&self, team_id: &str, sha256: &str) -> Result<Vec<IntakeRecord>> {
        let mut s = self.0.prepare(
            "SELECT * FROM intake_records WHERE team_id = ?1 AND sha256 = ?2 ORDER BY created_at DESC, rowid DESC",
        )?;
        let rows = s
            .query_map([team_id, sha256], row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn mark_parsed(&self, id: &str, text: &str, note: Option<&str>) -> Result<IntakeRecord> {
        self.transition(id, IntakeStatus::Parsed)?;
        self.0.execute(
            "UPDATE intake_records SET status='parsed', raw_text=?2, note=?3, error=NULL, updated_at=?4 WHERE id=?1",
            params![id, text, note, now_ms()],
        )?;
        self.get(id)
    }

    fn mark_structured(&self, id: &str, spec: &StructuredSpec) -> Result<IntakeRecord> {
        let to = if spec.confidence == Confidence::Low {
            IntakeStatus::ClarificationNeeded
        } else {
            IntakeStatus::Structured
        };
        self.transition(id, to)?;
        self.0.execute(
            "UPDATE intake_records SET status=?2, structured_output=?3, error=NULL, updated_at=?4 WHERE id=?1",
            params![id, to, serde_json::to_string(spec)?, now_ms()],
        )?;
        self.get(id)
    }

    fn mark_failed(&self, id: &str, error: &str) -> Result<IntakeRecord> {
        self.transition(id, IntakeStatus::Failed)?;
        self.0.execute(
            "UPDATE intake_records SET status='failed', error=?2, updated_at=?3 WHERE id=?1",
            params![id, error, now_ms()],
        )?;
        self.get(id)
    }

    fn retry(&self, id: &str) -> Result<IntakeRecord> {
        self.transition(id, IntakeStatus::Received)?;
        self.0.execute(
            "UPDATE intake_records SET status='received', error=NULL, updated_at=?2 WHERE id=?1",
            params![id, now_ms()],
        )?;
        self.get(id)
    }

    fn link_document(&self, id: &str, document_id: &str) -> Result<IntakeRecord> {
        self.get(id)?;
        self.0
            .execute(
                "UPDATE intake_records SET document_id=?2, updated_at=?3 WHERE id=?1",
                params![id, document_id, now_ms()],
            )
            .map_err(db_err)?;
        self.get(id)
    }
}
