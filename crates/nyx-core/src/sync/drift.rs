//! Drift detection pipeline: a push (or a local file change) names changed paths, the paths
//! select affected specs ([`super::matching`]), the model gives each spec a drift verdict
//! (prompt from [`crate::ai::prompts::drift`]) and verdicts are stored as [`DriftRecord`]s.
//!
//! Ports the fire-and-forget block of `routes/webhooks.ts` (`detectDrift` per document, a
//! `drift_detected` timeline entry, `code_commit` audit events) as an explicit, testable
//! function. Differences from the TS, on purpose:
//!
//! - Only specs selected by path matching are evaluated, not every team document
//!   (`MatchConfig::fallback_all_docs` restores the old behaviour).
//! - **Idempotent**: records are unique per `(run_key, document, document version)`. Replaying
//!   the same push (GitHub redelivery, retry after a crash) makes no model call and writes
//!   nothing twice. A spec edited since the first run is evaluated again.
//! - A reply that cannot be parsed is *not* stored as "no drift" (the TS did that and so hid the
//!   problem). It is reported in [`DriftRunReport::failures`] and retried on the next run.
//! - `code_commit` audit events are written for matched specs only, once per commit.
//! - Only teams whose integration webhook secret verified are processed
//!   ([`process_webhook`]); the TS processed every integration that listed the repo.

use std::collections::HashMap;
use std::fmt;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::impact::SqliteImpact;
use super::matching::{match_specs, normalize_path, MatchConfig, SpecMatch};
use crate::ai::prompts::{self, Tier};
use crate::ai::{LlmProvider, LlmRequest, ModelPair};
use crate::error::{Error, Result};
use crate::net::Headers;
use crate::git_provider::webhook::{self, PushEvent, WebhookEvent};
use crate::git_provider::ProviderKind;
use crate::model::{new_id, now_ms, AuditEventType, Id, NewAuditEvent, Timestamp};
use crate::store::{db_err, AuditRepo, DocumentRepo, SqliteAudit, SqliteDocuments};

// ---------------------------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------------------------

/// The model's judgement for one spec.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftVerdict {
    /// Whether code and spec disagree.
    pub has_drift: bool,
    /// Severity, `0.0..=10.0`.
    pub drift_score: f64,
    /// Explanation.
    pub details: String,
    /// Suggested fixes.
    pub suggestions: Vec<String>,
}

/// Why a reply was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerdictError {
    /// Blank reply.
    Empty,
    /// No JSON object found in the reply.
    NoJson,
    /// A JSON object without usable verdict fields.
    Invalid(String),
}

impl fmt::Display for VerdictError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("empty reply"),
            Self::NoJson => f.write_str("no JSON object in reply"),
            Self::Invalid(m) => write!(f, "invalid verdict: {m}"),
        }
    }
}

impl std::error::Error for VerdictError {}

fn strip_fences(raw: &str) -> String {
    raw.lines()
        .filter(|l| !l.trim_start().starts_with("```"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// First JSON object in `text` that carries a verdict field, tolerant of prose around it.
fn find_verdict_object(text: &str) -> Option<serde_json::Map<String, Value>> {
    let mut fallback = None;
    for (i, _) in text.match_indices('{') {
        let mut it = serde_json::Deserializer::from_str(&text[i..]).into_iter::<Value>();
        if let Some(Ok(Value::Object(m))) = it.next() {
            if m.contains_key("hasDrift") || m.contains_key("driftScore") {
                return Some(m);
            }
            fallback.get_or_insert(m);
        }
    }
    fallback
}

fn as_bool(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" => Some(true),
            "false" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn as_score(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|f| f.is_finite())
}

/// Parse a drift reply. Accepts a bare object, a fenced block or an object embedded in prose;
/// `hasDrift` may be a bool or `"true"`/`"false"`; `driftScore` may be a number or numeric
/// string and is clamped to `0..=10`. When only the score is present, drift means `score >= 1`.
///
/// # Errors
/// [`VerdictError`] when no usable verdict can be extracted.
pub fn parse_verdict(raw: &str) -> std::result::Result<DriftVerdict, VerdictError> {
    if raw.trim().is_empty() {
        return Err(VerdictError::Empty);
    }
    let text = strip_fences(raw);
    let obj = find_verdict_object(&text).ok_or(VerdictError::NoJson)?;
    let has = match obj.get("hasDrift") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            as_bool(v).ok_or_else(|| VerdictError::Invalid("hasDrift is not a boolean".into()))?,
        ),
    };
    let score = match obj.get("driftScore") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            as_score(v)
                .ok_or_else(|| VerdictError::Invalid("driftScore is not a number".into()))?,
        ),
    };
    let (has_drift, drift_score) = match (has, score) {
        (None, None) => {
            return Err(VerdictError::Invalid(
                "neither hasDrift nor driftScore present".into(),
            ))
        }
        (Some(h), s) => (h, s.unwrap_or(if h { 5.0 } else { 0.0 })),
        (None, Some(s)) => (s >= 1.0, s),
    };
    let suggestions = obj
        .get("suggestions")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Ok(DriftVerdict {
        has_drift,
        drift_score: drift_score.clamp(0.0, 10.0),
        details: obj
            .get("details")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        suggestions,
    })
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

/// Lifecycle of a drift finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriftStatus {
    /// Needs attention (only meaningful when `has_drift`).
    Open,
    /// Fixed.
    Resolved,
    /// Accepted as is.
    Dismissed,
}

impl DriftStatus {
    /// Stored string.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Resolved => "resolved",
            Self::Dismissed => "dismissed",
        }
    }

    fn parse(s: &str) -> Result<Self> {
        match s {
            "open" => Ok(Self::Open),
            "resolved" => Ok(Self::Resolved),
            "dismissed" => Ok(Self::Dismissed),
            o => Err(Error::Invalid(format!("unknown drift status `{o}`"))),
        }
    }
}

/// A stored verdict.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DriftRecord {
    /// Id.
    pub id: Id,
    /// Team.
    pub team_id: Id,
    /// Spec.
    pub document_id: Id,
    /// Spec version that was judged.
    pub doc_version: i64,
    /// Idempotency key of the run.
    pub run_key: String,
    /// `push` or `watch`.
    pub source: String,
    /// Repository, when known.
    pub repo_full_name: Option<String>,
    /// Git ref, when known.
    pub git_ref: Option<String>,
    /// Head commit, when known.
    pub commit_sha: Option<String>,
    /// Verdict.
    pub has_drift: bool,
    /// Severity `0..=10`.
    pub drift_score: f64,
    /// Explanation.
    pub details: String,
    /// Suggested fixes.
    pub suggestions: Vec<String>,
    /// Paths that selected this spec.
    pub changed_files: Vec<String>,
    /// Status.
    pub status: DriftStatus,
    /// Created.
    pub created_at: Timestamp,
    /// Resolved/dismissed at.
    pub resolved_at: Option<Timestamp>,
}

fn conv_err(e: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
}

fn record_row(r: &Row<'_>) -> rusqlite::Result<DriftRecord> {
    let sug: String = r.get("suggestions")?;
    let files: String = r.get("changed_files")?;
    let status: String = r.get("status")?;
    Ok(DriftRecord {
        id: r.get("id")?,
        team_id: r.get("team_id")?,
        document_id: r.get("document_id")?,
        doc_version: r.get("doc_version")?,
        run_key: r.get("run_key")?,
        source: r.get("source")?,
        repo_full_name: r.get("repo_full_name")?,
        git_ref: r.get("git_ref")?,
        commit_sha: r.get("commit_sha")?,
        has_drift: r.get::<_, i64>("has_drift")? != 0,
        drift_score: r.get("drift_score")?,
        details: r.get("details")?,
        suggestions: serde_json::from_str(&sug).map_err(conv_err)?,
        changed_files: serde_json::from_str(&files).map_err(conv_err)?,
        status: DriftStatus::parse(&status)
            .map_err(|e| conv_err(std::io::Error::other(e.to_string())))?,
        created_at: r.get("created_at")?,
        resolved_at: r.get("resolved_at")?,
    })
}

/// Repository for `drift_records`.
#[derive(Debug, Clone, Copy)]
pub struct SqliteDrift<'c>(&'c Connection);

impl<'c> SqliteDrift<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }

    /// Has this `(run, document, version)` been judged already?
    pub fn exists(&self, run_key: &str, document_id: &str, doc_version: i64) -> Result<bool> {
        Ok(self
            .0
            .query_row(
                "SELECT 1 FROM drift_records WHERE run_key=?1 AND document_id=?2 AND doc_version=?3",
                params![run_key, document_id, doc_version],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// Insert a verdict. Returns `None` when the unique key already exists (idempotent replay).
    pub fn insert(&self, rec: &NewDriftRecord<'_>) -> Result<Option<DriftRecord>> {
        let id = new_id();
        let n = self
            .0
            .execute(
                "INSERT OR IGNORE INTO drift_records
                 (id, team_id, document_id, doc_version, run_key, source, repo_full_name, git_ref, commit_sha,
                  has_drift, drift_score, details, suggestions, changed_files, status, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'open',?15)",
                params![
                    id,
                    rec.team_id,
                    rec.document_id,
                    rec.doc_version,
                    rec.change.run_key,
                    rec.change.source,
                    rec.change.repo_full_name,
                    rec.change.git_ref,
                    rec.change.commit_sha,
                    i64::from(rec.verdict.has_drift),
                    rec.verdict.drift_score,
                    rec.verdict.details,
                    serde_json::to_string(&rec.verdict.suggestions)?,
                    serde_json::to_string(rec.paths)?,
                    now_ms()
                ],
            )
            .map_err(db_err)?;
        if n == 0 {
            return Ok(None);
        }
        self.get(&id).map(Some)
    }

    /// One record.
    pub fn get(&self, id: &str) -> Result<DriftRecord> {
        self.0
            .query_row("SELECT * FROM drift_records WHERE id=?1", [id], record_row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("drift record {id}")))
    }

    /// Newest-first records of a document.
    pub fn list_for_document(&self, document_id: &str) -> Result<Vec<DriftRecord>> {
        let mut s = self.0.prepare(
            "SELECT * FROM drift_records WHERE document_id=?1 ORDER BY created_at DESC, rowid DESC",
        )?;
        let rows = s
            .query_map([document_id], record_row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    /// Open findings (`has_drift`) of a team, worst first.
    pub fn list_open(&self, team_id: &str) -> Result<Vec<DriftRecord>> {
        let mut s = self.0.prepare(
            "SELECT * FROM drift_records WHERE team_id=?1 AND has_drift=1 AND status='open'
             ORDER BY drift_score DESC, created_at DESC, rowid DESC",
        )?;
        let rows = s
            .query_map([team_id], record_row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    /// Resolve or dismiss a finding.
    pub fn set_status(&self, id: &str, status: DriftStatus) -> Result<DriftRecord> {
        let resolved = (status != DriftStatus::Open).then(now_ms);
        let n = self.0.execute(
            "UPDATE drift_records SET status=?2, resolved_at=?3 WHERE id=?1",
            params![id, status.as_str(), resolved],
        )?;
        if n == 0 {
            return Err(Error::NotFound(format!("drift record {id}")));
        }
        self.get(id)
    }
}

/// Insert payload for [`SqliteDrift::insert`].
#[derive(Debug)]
pub struct NewDriftRecord<'a> {
    /// Team.
    pub team_id: &'a str,
    /// Spec.
    pub document_id: &'a str,
    /// Spec version judged.
    pub doc_version: i64,
    /// Run metadata.
    pub change: &'a ChangeSet,
    /// Paths that selected the spec.
    pub paths: &'a [String],
    /// The verdict.
    pub verdict: &'a DriftVerdict,
}

// ---------------------------------------------------------------------------------------------
// Change sets and code access
// ---------------------------------------------------------------------------------------------

/// One commit of a push.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitInfo {
    /// SHA.
    pub sha: String,
    /// Message.
    pub message: String,
    /// Author name.
    pub author: String,
}

/// What changed, plus the key that makes processing it idempotent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeSet {
    /// Idempotency key (same push => same key).
    pub run_key: String,
    /// `push` or `watch`.
    pub source: String,
    /// Repository, when known.
    pub repo_full_name: Option<String>,
    /// Full git ref.
    pub git_ref: Option<String>,
    /// Head commit.
    pub commit_sha: Option<String>,
    /// Changed paths (normalised, de-duplicated, sorted).
    pub changed_files: Vec<String>,
    /// Commits, oldest first.
    pub commits: Vec<CommitInfo>,
}

fn clean_paths(paths: impl IntoIterator<Item = String>) -> Vec<String> {
    paths
        .into_iter()
        .map(|p| normalize_path(&p))
        .filter(|p| !p.is_empty())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn digest(parts: &[&str]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p.as_bytes());
        h.update([0]);
    }
    hex::encode(h.finalize())
}

impl ChangeSet {
    /// From a parsed push. Key: `push:<repo>:<ref>:<last commit sha>`, or a hash of the paths
    /// when the push carries no commits.
    #[must_use]
    pub fn from_push(p: &PushEvent) -> Self {
        let files = clean_paths(p.changed_files.clone());
        let head = p.commits.last().map(|c| c.id.clone());
        let repo = p.repo_full_name.clone().unwrap_or_default();
        let tail = head.clone().unwrap_or_else(|| {
            digest(&files.iter().map(String::as_str).collect::<Vec<_>>())[..16].to_owned()
        });
        Self {
            run_key: format!("push:{repo}:{}:{tail}", p.git_ref),
            source: "push".into(),
            repo_full_name: p.repo_full_name.clone(),
            git_ref: Some(p.git_ref.clone()),
            commit_sha: head,
            changed_files: files,
            commits: p
                .commits
                .iter()
                .map(|c| CommitInfo {
                    sha: c.id.clone(),
                    message: c.message.clone(),
                    author: c.author_name.clone(),
                })
                .collect(),
        }
    }

    /// From paths and their content hashes (local file watching). Same content => same key.
    #[must_use]
    pub fn from_watch(label: &str, changes: &[(String, String)]) -> Self {
        let mut sorted: Vec<(String, String)> = changes
            .iter()
            .map(|(p, h)| (normalize_path(p), h.clone()))
            .filter(|(p, _)| !p.is_empty())
            .collect();
        sorted.sort();
        sorted.dedup();
        let flat: Vec<&str> = sorted
            .iter()
            .flat_map(|(p, h)| [p.as_str(), h.as_str()])
            .collect();
        Self {
            run_key: format!("watch:{label}:{}", &digest(&flat)[..24]),
            source: "watch".into(),
            repo_full_name: None,
            git_ref: None,
            commit_sha: None,
            changed_files: sorted.into_iter().map(|(p, _)| p).collect(),
            commits: Vec::new(),
        }
    }
}

/// Reads file content at the revision being judged (deleted or unreadable files return `None`).
/// Real implementations: [`super::watch::DirCodeSource`] for a local checkout, or the git
/// provider's contents API (TODO(AI-74 wiring)).
pub trait CodeSource {
    /// Content of `path`, or `None` when absent/unreadable.
    fn read(&self, path: &str) -> Option<String>;
}

/// In-memory source, handy for tests and for callers that already hold the files.
#[derive(Debug, Clone, Default)]
pub struct MemoryCode(pub HashMap<String, String>);

impl CodeSource for MemoryCode {
    fn read(&self, path: &str) -> Option<String> {
        self.0.get(path).cloned()
    }
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

/// Engine knobs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DriftConfig {
    /// Path to spec matching.
    pub matching: MatchConfig,
    /// Characters of changed code sent per spec.
    pub max_code_chars: usize,
    /// Characters of spec sent.
    pub max_spec_chars: usize,
    /// Write `code_commit` audit events for matched specs.
    pub record_commits: bool,
}

impl Default for DriftConfig {
    fn default() -> Self {
        Self {
            matching: MatchConfig::default(),
            max_code_chars: 16_000,
            max_spec_chars: 24_000,
            record_commits: true,
        }
    }
}

/// A spec that could not be judged this run (retried on replay).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriftFailure {
    /// Spec.
    pub document_id: Id,
    /// What went wrong (never contains secrets).
    pub reason: String,
}

/// Outcome of one run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DriftRunReport {
    /// Idempotency key.
    pub run_key: String,
    /// Specs selected by path matching.
    pub matched: Vec<SpecMatch>,
    /// New verdicts stored this run (with or without drift).
    pub evaluated: Vec<DriftRecord>,
    /// Specs already judged for this run and version (no model call made).
    pub skipped_existing: Vec<Id>,
    /// Specs that failed (provider error or unparseable verdict).
    pub failures: Vec<DriftFailure>,
    /// `code_commit` audit events written.
    pub commits_recorded: usize,
}

impl DriftRunReport {
    /// New records that found drift.
    #[must_use]
    pub fn drifted(&self) -> Vec<&DriftRecord> {
        self.evaluated.iter().filter(|r| r.has_drift).collect()
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let mut t: String = s.chars().take(max).collect();
    t.push_str("\n...[truncated]");
    t
}

/// Runs the pipeline against a provider and a code source.
pub struct DriftEngine<'a> {
    llm: &'a dyn LlmProvider,
    models: &'a ModelPair,
    code: &'a dyn CodeSource,
    config: DriftConfig,
}

impl fmt::Debug for DriftEngine<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DriftEngine")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl<'a> DriftEngine<'a> {
    /// New engine.
    #[must_use]
    pub fn new(
        llm: &'a dyn LlmProvider,
        models: &'a ModelPair,
        code: &'a dyn CodeSource,
        config: DriftConfig,
    ) -> Self {
        Self {
            llm,
            models,
            code,
            config,
        }
    }

    /// Code context for a spec: each selected path with its content, budgeted.
    fn code_context(&self, paths: &[String]) -> String {
        let per_file = (self.config.max_code_chars / paths.len().max(1)).max(500);
        let mut out = String::new();
        for p in paths {
            out.push_str("### ");
            out.push_str(p);
            out.push('\n');
            match self.code.read(p) {
                Some(c) => out.push_str(&truncate_chars(&c, per_file)),
                None => out.push_str("(file deleted or unreadable at this revision)"),
            }
            out.push_str("\n\n");
        }
        truncate_chars(
            out.trim_end(),
            self.config.max_code_chars + paths.len() * 200,
        )
    }

    fn judge(&self, spec: &str, code: &str) -> std::result::Result<DriftVerdict, String> {
        let p = prompts::drift(&truncate_chars(spec, self.config.max_spec_chars), code);
        let model = match p.tier {
            Tier::Default => &self.models.default,
            Tier::Fast => &self.models.fast,
        };
        let req = LlmRequest {
            model: model.clone(),
            system: p.system,
            messages: p.messages,
            max_tokens: p.max_tokens,
            temperature: None,
        };
        let resp = self
            .llm
            .complete(&req)
            .map_err(|e| format!("provider error: {e}"))?;
        parse_verdict(&resp.text).map_err(|e| format!("unusable model reply ({e})"))
    }

    /// Process one change set for a team. Safe to call repeatedly with the same set.
    ///
    /// Model calls happen with no transaction open; each record is inserted on its own, so a
    /// crash mid-run loses at most the in-flight spec and the replay picks up the rest.
    ///
    /// # Errors
    /// Database failures. Per-spec model failures are collected in the report instead.
    pub fn run(
        &self,
        conn: &Connection,
        team_id: &str,
        change: &ChangeSet,
    ) -> Result<DriftRunReport> {
        let mut report = DriftRunReport {
            run_key: change.run_key.clone(),
            ..Default::default()
        };
        if change.changed_files.is_empty() {
            return Ok(report);
        }
        let docs_repo = SqliteDocuments::new(conn);
        let docs = docs_repo.list_live(team_id)?;
        let graph = SqliteImpact::new(conn).load(team_id)?;
        report.matched = match_specs(
            conn,
            team_id,
            &change.changed_files,
            &docs,
            &graph,
            &self.config.matching,
        )?;
        let drift = SqliteDrift::new(conn);

        for m in &report.matched.clone() {
            let Some(doc) = docs.iter().find(|d| d.id == m.document_id) else {
                continue;
            };
            let version = docs_repo.latest_version(&doc.id)?.version;
            if drift.exists(&change.run_key, &doc.id, version)? {
                report.skipped_existing.push(doc.id.clone());
                continue;
            }
            let code = self.code_context(&m.paths);
            match self.judge(&doc.content, &code) {
                Ok(verdict) => {
                    let new = NewDriftRecord {
                        team_id,
                        document_id: &doc.id,
                        doc_version: version,
                        change,
                        paths: &m.paths,
                        verdict: &verdict,
                    };
                    match drift.insert(&new)? {
                        Some(rec) => report.evaluated.push(rec),
                        None => report.skipped_existing.push(doc.id.clone()),
                    }
                }
                Err(reason) => report.failures.push(DriftFailure {
                    document_id: doc.id.clone(),
                    reason,
                }),
            }
        }

        if self.config.record_commits && !change.commits.is_empty() {
            let audit = SqliteAudit::new(conn);
            for m in &report.matched {
                let existing = audit.list_by_document(&m.document_id, u32::MAX)?;
                for c in &change.commits {
                    let seen = existing.iter().any(|e| {
                        e.event_type == AuditEventType::CodeCommit
                            && e.commit_sha.as_deref() == Some(c.sha.as_str())
                    });
                    if seen {
                        continue;
                    }
                    audit.append(&NewAuditEvent {
                        team_id: team_id.to_owned(),
                        event_type: AuditEventType::CodeCommit,
                        actor_id: None,
                        document_id: Some(m.document_id.clone()),
                        snapshot_id: None,
                        ticket_id: None,
                        commit_sha: Some(c.sha.clone()),
                        parent_event_id: None,
                        metadata: serde_json::json!({
                            "message": c.message,
                            "ref": change.git_ref,
                            "author": c.author,
                        }),
                    })?;
                    report.commits_recorded += 1;
                }
            }
        }
        Ok(report)
    }
}

// ---------------------------------------------------------------------------------------------
// Webhook entry point
// ---------------------------------------------------------------------------------------------

/// Result of handing a raw webhook delivery to [`process_webhook`].
#[derive(Debug, Clone, PartialEq)]
pub enum WebhookOutcome {
    /// Signature missing/invalid or no secret configured. Respond 401.
    Rejected(String),
    /// Verified but not a push (ping, issues, comments). Nothing done here.
    Ignored(String),
    /// Verified push; one report per team processed.
    Processed(Vec<(Id, DriftRunReport)>),
}

struct RepoIntegration {
    team_id: Id,
    secret: Option<String>,
}

fn integrations_for_repo(
    conn: &Connection,
    kind: ProviderKind,
    repo: &str,
) -> Result<Vec<RepoIntegration>> {
    let mut s = conn.prepare(
        "SELECT team_id, config FROM integrations WHERE type = ?1 ORDER BY created_at, rowid",
    )?;
    let rows: Vec<(String, String)> = s
        .query_map([kind.slug()], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let mut out = Vec::new();
    for (team_id, cfg) in rows {
        let v: Value = serde_json::from_str(&cfg)?;
        let has_repo = v
            .get("selectedRepos")
            .and_then(Value::as_array)
            .is_some_and(|a| {
                a.iter()
                    .any(|r| r.get("fullName").and_then(Value::as_str) == Some(repo))
            });
        if has_repo {
            out.push(RepoIntegration {
                team_id,
                secret: v
                    .get("webhookSecret")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            });
        }
    }
    Ok(out)
}

/// Verify a raw delivery and, for pushes, run the drift pipeline for every team whose
/// integration secret verified it (port of the `/github` webhook route).
///
/// `fallback_secret` is the deployment-wide secret (`GITHUB_WEBHOOK_SECRET` in the TS); when it
/// verifies and no per-integration secret did, every team listing the repo is processed.
///
/// # Errors
/// Database or payload-parsing failures after authentication succeeded.
pub fn process_webhook(
    conn: &Connection,
    engine: &DriftEngine<'_>,
    kind: ProviderKind,
    headers: &Headers,
    body: &[u8],
    fallback_secret: Option<&str>,
) -> Result<WebhookOutcome> {
    let repo = webhook::peek_repo_full_name(kind, body);
    let candidates = match &repo {
        Some(r) => integrations_for_repo(conn, kind, r)?,
        None => Vec::new(),
    };
    let secrets: Vec<String> = candidates.iter().filter_map(|c| c.secret.clone()).collect();
    let verified_teams: Vec<Id> =
        if let Some(s) = webhook::find_verified_secret(kind, headers, body, &secrets) {
            candidates
                .iter()
                .filter(|c| c.secret.as_deref() == Some(s))
                .map(|c| c.team_id.clone())
                .collect()
        } else if let Some(g) = fallback_secret.filter(|g| !g.is_empty()) {
            if !webhook::verify(kind, headers, body, g) {
                return Ok(WebhookOutcome::Rejected("invalid webhook signature".into()));
            }
            candidates.iter().map(|c| c.team_id.clone()).collect()
        } else {
            return Ok(WebhookOutcome::Rejected(
                "webhook secret not configured or signature invalid".into(),
            ));
        };

    let event = webhook::parse(kind, headers, body).map_err(|e| Error::Invalid(e.to_string()))?;
    match event {
        WebhookEvent::Push(push) => {
            let change = ChangeSet::from_push(&push);
            let mut out = Vec::new();
            for team in verified_teams {
                let report = engine.run(conn, &team, &change)?;
                out.push((team, report));
            }
            Ok(WebhookOutcome::Processed(out))
        }
        WebhookEvent::Ping => Ok(WebhookOutcome::Ignored("ping".into())),
        WebhookEvent::Issue(_) => Ok(WebhookOutcome::Ignored("issues".into())),
        WebhookEvent::IssueComment(_) => Ok(WebhookOutcome::Ignored("issue_comment".into())),
        WebhookEvent::Other { event } => Ok(WebhookOutcome::Ignored(event)),
    }
}
