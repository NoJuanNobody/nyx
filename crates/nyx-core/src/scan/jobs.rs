//! Background job runner: queue, status, progress, retry and cancel for long scans.
//!
//! Port of `job.service.ts` (a `background_jobs` row with `pending -> running -> completed|failed`
//! and a 0-100 progress) extended with what the desktop needs: `cancelled`, an attempt counter with
//! automatic retry of retryable failures, a cooperative cancel flag, and manual retry.
//!
//! The runner is synchronous and storage-backed so it works with the single SQLite connection the
//! app owns: call [`JobRunner::run_next`] from a worker thread (or a Tauri async task via
//! `spawn_blocking`) that owns a [`Db`](crate::store::Db). Cancelling from another thread uses a
//! second connection to the same file: [`request_cancel`] flips `cancel_requested`, which the
//! running handler polls through [`JobContext::is_cancelled`]. Everything needed to observe a job
//! (status, progress, message, result, error) lives in the row, so the UI/MCP only poll [`get`].

use std::fmt;
use std::str::FromStr;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::embed::Embedder;
use super::indexer::{index_repo, IndexError, IndexOptions, ScanEvent, ScanHooks};
use super::meter::ScanMeter;
use super::source::RepoSource;
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms};
use crate::store::db_err;

/// Job type string of repository scans.
pub const REPO_SCAN_JOB: &str = "repo_scan";
/// Default attempts before a retryable failure becomes final.
pub const DEFAULT_MAX_ATTEMPTS: u32 = 3;

/// Lifecycle of a job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    /// Waiting for a worker (also: waiting for a retry).
    Pending,
    /// A worker is executing it.
    Running,
    /// Finished successfully.
    Completed,
    /// Failed for good.
    Failed,
    /// Cancelled before or during execution.
    Cancelled,
}

impl JobStatus {
    /// Database / wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    /// True once the job can no longer change by itself.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

impl FromStr for JobStatus {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "pending" => Self::Pending,
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            other => return Err(Error::Invalid(format!("unknown job status {other:?}"))),
        })
    }
}

impl fmt::Display for JobStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A background job row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Job {
    /// Id.
    pub id: String,
    /// Owning team.
    pub team_id: Option<String>,
    /// Requesting user.
    pub user_id: Option<String>,
    /// Handler key, e.g. [`REPO_SCAN_JOB`].
    pub job_type: String,
    /// State.
    pub status: JobStatus,
    /// Input payload.
    pub input: Value,
    /// Result payload once completed.
    pub result: Option<Value>,
    /// Last error text.
    pub error: Option<String>,
    /// 0-100.
    pub progress: u8,
    /// Human-readable progress note.
    pub progress_message: Option<String>,
    /// Executions started so far.
    pub attempts: u32,
    /// Attempts allowed.
    pub max_attempts: u32,
    /// Cancel was requested while running.
    pub cancel_requested: bool,
    /// First start (unix ms).
    pub started_at: Option<i64>,
    /// Finish time (unix ms).
    pub completed_at: Option<i64>,
    /// Creation time (unix ms).
    pub created_at: i64,
}

/// Input for [`enqueue`].
#[derive(Debug, Clone)]
pub struct NewJob {
    /// Owning team.
    pub team_id: Option<String>,
    /// Requesting user.
    pub user_id: Option<String>,
    /// Handler key.
    pub job_type: String,
    /// Input payload.
    pub input: Value,
    /// Attempts allowed (default [`DEFAULT_MAX_ATTEMPTS`]).
    pub max_attempts: u32,
}

impl NewJob {
    /// Job of `job_type` with defaults.
    #[must_use]
    pub fn new(job_type: &str, input: Value) -> Self {
        Self {
            team_id: None,
            user_id: None,
            job_type: job_type.to_string(),
            input,
            max_attempts: DEFAULT_MAX_ATTEMPTS,
        }
    }

    /// Scope to a team.
    #[must_use]
    pub fn team(mut self, team_id: &str) -> Self {
        self.team_id = Some(team_id.to_string());
        self
    }

    /// Record the requesting user.
    #[must_use]
    pub fn user(mut self, user_id: &str) -> Self {
        self.user_id = Some(user_id.to_string());
        self
    }

    /// Override the attempt limit (min 1).
    #[must_use]
    pub fn max_attempts(mut self, n: u32) -> Self {
        self.max_attempts = n.max(1);
        self
    }
}

fn row(r: &Row<'_>) -> rusqlite::Result<Job> {
    let json = |s: Option<String>| -> rusqlite::Result<Option<Value>> {
        s.map(|s| {
            serde_json::from_str(&s).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })
        })
        .transpose()
    };
    let status: String = r.get("status")?;
    Ok(Job {
        id: r.get("id")?,
        team_id: r.get("team_id")?,
        user_id: r.get("user_id")?,
        job_type: r.get("type")?,
        status: status.parse().map_err(|e: Error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::other(e.to_string())),
            )
        })?,
        input: json(r.get("input")?)?.unwrap_or(Value::Null),
        result: json(r.get("result")?)?,
        error: r.get("error")?,
        progress: u8::try_from(r.get::<_, i64>("progress")?).unwrap_or(0),
        progress_message: r.get("progress_message")?,
        attempts: u32::try_from(r.get::<_, i64>("attempts")?).unwrap_or(0),
        max_attempts: u32::try_from(r.get::<_, i64>("max_attempts")?).unwrap_or(1),
        cancel_requested: r.get::<_, i64>("cancel_requested")? != 0,
        started_at: r.get("started_at")?,
        completed_at: r.get("completed_at")?,
        created_at: r.get("created_at")?,
    })
}

/// Queue a job.
pub fn enqueue(conn: &Connection, new: &NewJob) -> Result<Job> {
    let id = new_id();
    conn.execute(
        "INSERT INTO background_jobs (id, team_id, user_id, type, status, input, max_attempts, created_at)
         VALUES (?1,?2,?3,?4,'pending',?5,?6,?7)",
        params![
            id,
            new.team_id,
            new.user_id,
            new.job_type,
            new.input.to_string(),
            i64::from(new.max_attempts.max(1)),
            now_ms()
        ],
    )
    .map_err(db_err)?;
    get(conn, &id)
}

/// Fetch a job.
pub fn get(conn: &Connection, id: &str) -> Result<Job> {
    conn.query_row("SELECT * FROM background_jobs WHERE id = ?1", [id], row)
        .optional()?
        .ok_or_else(|| Error::NotFound(format!("job {id}")))
}

/// Newest-first jobs of a team (TS `listByTeam`).
pub fn list_by_team(conn: &Connection, team_id: &str, limit: usize) -> Result<Vec<Job>> {
    let mut s = conn.prepare(
        "SELECT * FROM background_jobs WHERE team_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2",
    )?;
    let rows = s
        .query_map(
            params![team_id, i64::try_from(limit).unwrap_or(i64::MAX)],
            row,
        )?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

/// Claim the oldest pending job (optionally of given types): `pending -> running`, attempt +1.
pub fn claim_next(conn: &Connection, types: Option<&[&str]>) -> Result<Option<Job>> {
    let mut s = conn.prepare(
        "SELECT id, type FROM background_jobs WHERE status = 'pending' ORDER BY created_at, rowid",
    )?;
    let candidates: Vec<(String, String)> = s
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    for (id, ty) in candidates {
        if types.is_some_and(|t| !t.contains(&ty.as_str())) {
            continue;
        }
        let n = conn.execute(
            "UPDATE background_jobs SET status = 'running', attempts = attempts + 1,
                    started_at = COALESCE(started_at, ?2), completed_at = NULL, error = NULL
             WHERE id = ?1 AND status = 'pending'",
            params![id, now_ms()],
        )?;
        if n == 1 {
            return get(conn, &id).map(Some);
        }
    }
    Ok(None)
}

/// Update progress (clamped to 0-100).
pub fn set_progress(
    conn: &Connection,
    id: &str,
    progress: u8,
    message: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE background_jobs SET progress = ?2, progress_message = ?3 WHERE id = ?1",
        params![id, i64::from(progress.min(100)), message],
    )?;
    Ok(())
}

fn finish(
    conn: &Connection,
    id: &str,
    status: JobStatus,
    result: Option<&Value>,
    error: Option<&str>,
) -> Result<Job> {
    conn.execute(
        "UPDATE background_jobs SET status = ?2, result = ?3, error = ?4, completed_at = ?5 WHERE id = ?1",
        params![id, status.as_str(), result.map(Value::to_string), error, now_ms()],
    )?;
    get(conn, id)
}

/// Mark completed with a result (progress becomes 100).
pub fn complete(conn: &Connection, id: &str, result: &Value) -> Result<Job> {
    conn.execute(
        "UPDATE background_jobs SET progress = 100 WHERE id = ?1",
        [id],
    )?;
    finish(conn, id, JobStatus::Completed, Some(result), None)
}

/// Mark failed.
pub fn fail(conn: &Connection, id: &str, error: &str) -> Result<Job> {
    finish(conn, id, JobStatus::Failed, None, Some(error))
}

/// Put a failed attempt back in the queue, keeping the error text for the UI.
pub fn requeue(conn: &Connection, id: &str, error: &str) -> Result<Job> {
    conn.execute(
        "UPDATE background_jobs SET status = 'pending', error = ?2, progress_message = 'waiting to retry'
         WHERE id = ?1",
        params![id, error],
    )?;
    get(conn, id)
}

/// Mark cancelled.
pub fn mark_cancelled(conn: &Connection, id: &str) -> Result<Job> {
    finish(conn, id, JobStatus::Cancelled, None, None)
}

/// Ask a job to stop. A pending job is cancelled at once; a running one gets `cancel_requested`
/// and stops at its next poll. Returns the job (check `status`), or `Conflict` if already finished.
pub fn request_cancel(conn: &Connection, id: &str) -> Result<Job> {
    let job = get(conn, id)?;
    match job.status {
        JobStatus::Pending => {
            let n = conn.execute(
                "UPDATE background_jobs SET status = 'cancelled', completed_at = ?2 WHERE id = ?1 AND status = 'pending'",
                params![id, now_ms()],
            )?;
            if n == 0 {
                // Lost a race with a worker claiming it; fall through to the running path.
                conn.execute(
                    "UPDATE background_jobs SET cancel_requested = 1 WHERE id = ?1",
                    [id],
                )?;
            }
        }
        JobStatus::Running => {
            conn.execute(
                "UPDATE background_jobs SET cancel_requested = 1 WHERE id = ?1",
                [id],
            )?;
        }
        s => return Err(Error::Conflict(format!("job {id} is already {s}"))),
    }
    get(conn, id)
}

/// Is a cancel pending for this job?
pub fn is_cancel_requested(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT cancel_requested FROM background_jobs WHERE id = ?1",
            [id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0)
        != 0)
}

/// Manually retry a failed or cancelled job: back to `pending` with attempts reset.
pub fn retry(conn: &Connection, id: &str) -> Result<Job> {
    let job = get(conn, id)?;
    if !matches!(job.status, JobStatus::Failed | JobStatus::Cancelled) {
        return Err(Error::Conflict(format!(
            "only failed or cancelled jobs can be retried; job {id} is {}",
            job.status
        )));
    }
    conn.execute(
        "UPDATE background_jobs SET status = 'pending', attempts = 0, error = NULL, result = NULL,
                progress = 0, progress_message = NULL, cancel_requested = 0, completed_at = NULL
         WHERE id = ?1",
        [id],
    )?;
    get(conn, id)
}

// ---------------------------------------------------------------- runner

/// How a handler failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum JobError {
    /// Try again (until `max_attempts`).
    #[error("{0}")]
    Retryable(String),
    /// Do not retry.
    #[error("{0}")]
    Fatal(String),
    /// The handler stopped because a cancel was requested.
    #[error("cancelled")]
    Cancelled,
}

impl From<Error> for JobError {
    fn from(e: Error) -> Self {
        Self::Fatal(e.to_string())
    }
}

/// Handed to a running handler.
pub struct JobContext<'a> {
    /// Connection to report progress on and read the cancel flag from.
    pub conn: &'a Connection,
    /// The claimed job.
    pub job: &'a Job,
}

impl JobContext<'_> {
    /// Persist progress (0-100) and a note.
    pub fn progress(&self, pct: u8, message: &str) {
        // Progress is advisory; a failed write must not fail the job.
        let _ = set_progress(self.conn, &self.job.id, pct, Some(message));
    }

    /// Has a cancel been requested?
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        is_cancel_requested(self.conn, &self.job.id).unwrap_or(false)
    }
}

/// Executes jobs of one type.
pub trait JobHandler {
    /// Job type this handler serves.
    fn job_type(&self) -> &str;
    /// Run the job; the returned value becomes the job result.
    ///
    /// # Errors
    /// [`JobError`] decides retry / fail / cancel.
    fn run(&self, ctx: &JobContext<'_>) -> std::result::Result<Value, JobError>;
}

/// Dispatches queued jobs to registered handlers.
#[derive(Default)]
pub struct JobRunner<'a> {
    handlers: Vec<Box<dyn JobHandler + 'a>>,
}

impl<'a> JobRunner<'a> {
    /// Runner with no handlers.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a handler (replaces none; first match wins).
    pub fn register(&mut self, h: impl JobHandler + 'a) -> &mut Self {
        self.handlers.push(Box::new(h));
        self
    }

    /// Claim and execute the next runnable job. Returns the job in its resulting state (`Pending`
    /// again when it was requeued for retry), or `None` when the queue holds nothing runnable.
    pub fn run_next(&self, conn: &Connection) -> Result<Option<Job>> {
        let types: Vec<&str> = self.handlers.iter().map(|h| h.job_type()).collect();
        let Some(job) = claim_next(conn, Some(&types))? else {
            return Ok(None);
        };
        let Some(handler) = self.handlers.iter().find(|h| h.job_type() == job.job_type) else {
            return fail(conn, &job.id, "no handler registered").map(Some);
        };
        if is_cancel_requested(conn, &job.id)? {
            return mark_cancelled(conn, &job.id).map(Some);
        }
        let ctx = JobContext { conn, job: &job };
        let out = match handler.run(&ctx) {
            Ok(v) => complete(conn, &job.id, &v)?,
            Err(JobError::Cancelled) => mark_cancelled(conn, &job.id)?,
            Err(JobError::Fatal(m)) => fail(conn, &job.id, &m)?,
            Err(JobError::Retryable(m)) => {
                if job.attempts < job.max_attempts {
                    requeue(conn, &job.id, &m)?
                } else {
                    fail(
                        conn,
                        &job.id,
                        &format!("{m} (gave up after {} attempts)", job.attempts),
                    )?
                }
            }
        };
        Ok(Some(out))
    }

    /// Run until nothing runnable is left or `max_runs` executions happened (retries count).
    pub fn run_all(&self, conn: &Connection, max_runs: usize) -> Result<Vec<Job>> {
        let mut out = Vec::new();
        for _ in 0..max_runs {
            match self.run_next(conn)? {
                Some(j) => out.push(j),
                None => break,
            }
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------- scan handler

/// [`JobHandler`] that runs [`index_repo`] for a `repo_scan` job.
///
/// Job input: `{"repo_full_name": "owner/repo", "force": false, "max_files": 200}` (all but
/// `repo_full_name` optional). The job's `team_id` scopes the chunks. Progress maps the indexer's
/// events onto 0-100; the result is the serialised [`IndexReport`](super::indexer::IndexReport).
pub struct ScanJobHandler<'a> {
    source: &'a dyn RepoSource,
    embedder: &'a dyn Embedder,
    meter: &'a dyn ScanMeter,
    cache: Option<&'a super::specs::RelevantCodeCache>,
}

impl<'a> ScanJobHandler<'a> {
    /// Build a handler over a source, embedder and meter.
    #[must_use]
    pub fn new(
        source: &'a dyn RepoSource,
        embedder: &'a dyn Embedder,
        meter: &'a dyn ScanMeter,
    ) -> Self {
        Self {
            source,
            embedder,
            meter,
            cache: None,
        }
    }

    /// Invalidate this cache for the team after a scan that changed the index (TS `indexRepo`).
    #[must_use]
    pub fn with_relevant_code_cache(mut self, cache: &'a super::specs::RelevantCodeCache) -> Self {
        self.cache = Some(cache);
        self
    }
}

impl JobHandler for ScanJobHandler<'_> {
    fn job_type(&self) -> &str {
        REPO_SCAN_JOB
    }

    fn run(&self, ctx: &JobContext<'_>) -> std::result::Result<Value, JobError> {
        let team = ctx
            .job
            .team_id
            .as_deref()
            .ok_or_else(|| JobError::Fatal("repo_scan job needs a team".into()))?;
        let repo = ctx
            .job
            .input
            .get("repo_full_name")
            .and_then(Value::as_str)
            .ok_or_else(|| JobError::Fatal("repo_scan job needs input.repo_full_name".into()))?;
        let mut opts = IndexOptions::new(team, repo);
        opts.force = ctx
            .job
            .input
            .get("force")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if let Some(n) = ctx.job.input.get("max_files").and_then(Value::as_u64) {
            opts.max_files = usize::try_from(n).unwrap_or(usize::MAX);
        }

        ctx.progress(1, "starting scan");
        let mut on_event = |ev: &ScanEvent| match ev {
            ScanEvent::Planned {
                added,
                modified,
                removed,
                ..
            } => ctx.progress(
                5,
                &format!("{added} new, {modified} changed, {removed} removed"),
            ),
            ScanEvent::FileIndexed {
                path, done, total, ..
            } => {
                let pct = 5 + (90 * *done / (*total).max(1)).min(90);
                ctx.progress(u8::try_from(pct).unwrap_or(95), &format!("indexed {path}"));
            }
            _ => {}
        };
        let cancelled = || ctx.is_cancelled();
        let mut hooks = ScanHooks {
            on_event: Some(&mut on_event),
            is_cancelled: Some(&cancelled),
        };
        match index_repo(
            ctx.conn,
            self.source,
            self.embedder,
            self.meter,
            &opts,
            &mut hooks,
        ) {
            Ok(report) => {
                if let (Some(c), true) =
                    (self.cache, report.files_indexed + report.files_removed > 0)
                {
                    c.invalidate_team(team);
                }
                serde_json::to_value(report).map_err(|e| JobError::Fatal(e.to_string()))
            }
            Err(IndexError::Cancelled) => Err(JobError::Cancelled),
            Err(e) if e.is_retryable() => Err(JobError::Retryable(e.to_string())),
            Err(e) => Err(JobError::Fatal(e.to_string())),
        }
    }
}
