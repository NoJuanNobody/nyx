//! The repository indexer: scan -> filter -> plan -> read -> chunk -> embed -> store.
//!
//! Port of `codeEmbeddingService.indexRepo` with the improvements the parity issues ask for:
//!
//! - **Incremental** (#348): unchanged files (same revision token) are neither read, chunked nor
//!   embedded; removed / newly-ignored files have their chunks deleted; an unchanged repo head
//!   skips even the listing.
//! - **Per-file atomicity**: each file's old chunks are replaced in one savepoint, so a crash or a
//!   failed batch never leaves a half-indexed file, and work finished before a failure is kept
//!   (a retry resumes instead of starting over; the delete-everything-first step of the TS is gone).
//! - **Batching + dedupe** (#348): chunks of many files are embedded together
//!   ([`super::embed::embed_texts`]); repeats cost nothing.
//! - **Progress events and cancellation** via [`ScanHooks`]; **credit metering** via
//!   [`ScanMeter`].
//!
//! File-level problems (unreadable, binary, too large) are recorded and the scan continues, like
//! the TS `skippedFiles`. Embedder / metering / database failures abort with an [`IndexError`];
//! [`IndexError::is_retryable`] tells the job runner whether another attempt can help.

use serde::{Deserialize, Serialize};

use super::chunker::{chunk_code_file, CodeChunkOptions};
use super::embed::{embed_texts, EmbedError, EmbedStats, Embedder};
use super::filter::{FileFilter, Language, SkipReason};
use super::meter::{MeterError, ScanMeter};
use super::plan::{plan_scan, ScanPlan, DEFAULT_MAX_FILES};
use super::source::{content_token, RepoSource};
use super::store::{self, ManifestEntry};
use crate::error::Error;
use crate::model::NewCodeChunk;
use crate::store::{ChunkRepo, SqliteChunks};

/// Indexer settings.
#[derive(Debug, Clone)]
pub struct IndexOptions {
    /// Team owning the chunks.
    pub team_id: String,
    /// `owner/repo` (or any stable label for a local folder).
    pub repo_full_name: String,
    /// File filter (default: [`FileFilter::for_index`]).
    pub filter: FileFilter,
    /// Chunker settings.
    pub chunk: CodeChunkOptions,
    /// Cap on indexed files (default 200).
    pub max_files: usize,
    /// Chunks per embedding batch (default 50).
    pub batch_size: usize,
    /// Re-index every file even if its token is unchanged.
    pub force: bool,
}

impl IndexOptions {
    /// Defaults matching the TS service.
    #[must_use]
    pub fn new(team_id: &str, repo_full_name: &str) -> Self {
        Self {
            team_id: team_id.to_string(),
            repo_full_name: repo_full_name.to_string(),
            filter: FileFilter::for_index(),
            chunk: CodeChunkOptions::default(),
            max_files: DEFAULT_MAX_FILES,
            batch_size: super::embed::DEFAULT_BATCH_SIZE,
            force: false,
        }
    }
}

/// Progress event emitted during a scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ScanEvent {
    /// The plan is ready.
    Planned {
        /// New files.
        added: usize,
        /// Changed or to-be-verified files.
        modified: usize,
        /// Proven unchanged.
        unchanged: usize,
        /// To delete.
        removed: usize,
        /// Rejected by the filter.
        skipped: usize,
    },
    /// A file was (re)indexed.
    FileIndexed {
        /// Path.
        path: String,
        /// Chunks stored.
        chunks: usize,
        /// Files finished so far (indexed + unchanged + skipped + failed).
        done: usize,
        /// Files to process in total.
        total: usize,
    },
    /// A file was left out after reading it.
    FileSkipped {
        /// Path.
        path: String,
        /// Reason.
        reason: SkipReason,
    },
    /// A file could not be read.
    FileFailed {
        /// Path.
        path: String,
        /// Error text.
        error: String,
    },
    /// A file's chunks were deleted.
    FileRemoved {
        /// Path.
        path: String,
    },
    /// The scan finished.
    Finished {
        /// Final report.
        report: IndexReport,
    },
}

/// Optional callbacks for a running scan.
#[derive(Default)]
pub struct ScanHooks<'a> {
    /// Receives every [`ScanEvent`].
    pub on_event: Option<&'a mut dyn FnMut(&ScanEvent)>,
    /// Polled between files and before each embedding batch; `true` stops the scan.
    pub is_cancelled: Option<&'a dyn Fn() -> bool>,
}

impl ScanHooks<'_> {
    /// No callbacks.
    #[must_use]
    pub fn none() -> Self {
        Self::default()
    }

    fn emit(&mut self, ev: &ScanEvent) {
        if let Some(f) = self.on_event.as_mut() {
            f(ev);
        }
    }

    fn cancelled(&self) -> bool {
        self.is_cancelled.is_some_and(|f| f())
    }
}

/// Outcome of a scan.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndexReport {
    /// Snapshot token (commit sha) seen by this scan.
    pub head_token: Option<String>,
    /// True when the repo head matched the last complete scan and nothing was listed.
    pub up_to_date: bool,
    /// Files (re)indexed.
    pub files_indexed: usize,
    /// Files whose token matched the manifest.
    pub files_unchanged: usize,
    /// Files whose chunks were deleted.
    pub files_removed: usize,
    /// Files rejected by the filter or by content checks.
    pub files_skipped: usize,
    /// Eligible files beyond the `max_files` cap.
    pub files_over_limit: usize,
    /// Files that could not be read: `(path, error)`.
    pub failed: Vec<(String, String)>,
    /// Chunks written.
    pub chunks_created: usize,
    /// Embedding work done.
    pub embed: EmbedStatsDto,
}

/// Serializable copy of [`EmbedStats`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmbedStatsDto {
    /// Chunks requested.
    pub requested: usize,
    /// Repeats within one embed call.
    pub deduped: usize,
    /// Served from the embedding cache.
    pub cache_hits: usize,
    /// Sent to the embedder.
    pub embedded: usize,
    /// Embedder calls.
    pub batches: usize,
}

impl From<EmbedStats> for EmbedStatsDto {
    fn from(s: EmbedStats) -> Self {
        Self {
            requested: s.requested,
            deduped: s.deduped,
            cache_hits: s.cache_hits,
            embedded: s.embedded,
            batches: s.batches,
        }
    }
}

/// Why a scan stopped early.
#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    /// Cancelled through [`ScanHooks::is_cancelled`].
    #[error("scan cancelled")]
    Cancelled,
    /// The embedder failed.
    #[error(transparent)]
    Embed(#[from] EmbedError),
    /// Out of credits (or the ledger failed).
    #[error(transparent)]
    Meter(#[from] MeterError),
    /// Source, database or other core failure.
    #[error(transparent)]
    Core(#[from] Error),
}

impl IndexError {
    /// True when trying again later may succeed (transient embedder failure, I/O).
    #[must_use]
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Embed(e) => e.is_transient(),
            Self::Core(Error::Io(_)) => true,
            Self::Core(Error::Invalid(m)) => m.contains("rate limit") || m.contains("transport"),
            _ => false,
        }
    }
}

struct Prepared {
    path: String,
    language: Language,
    fingerprint: String,
    size: u64,
    pieces: Vec<String>,
}

struct Run<'a, 'h> {
    conn: &'a rusqlite::Connection,
    embedder: &'a dyn Embedder,
    meter: &'a dyn ScanMeter,
    opts: &'a IndexOptions,
    head: Option<String>,
    hooks: &'a mut ScanHooks<'h>,
    report: IndexReport,
    embed: EmbedStats,
    pending: Vec<Prepared>,
    pending_chunks: usize,
    done: usize,
    total: usize,
}

impl Run<'_, '_> {
    fn flush(&mut self) -> Result<(), IndexError> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let batch = std::mem::take(&mut self.pending);
        self.pending_chunks = 0;
        let texts: Vec<String> = batch
            .iter()
            .flat_map(|p| p.pieces.iter().cloned())
            .collect();

        let mut meter_err: Option<MeterError> = None;
        let mut cancelled = false;
        let meter = self.meter;
        let hooks = &*self.hooks;
        let res = embed_texts(
            self.conn,
            self.embedder,
            &texts,
            self.opts
                .batch_size
                .max(1)
                .min(self.embedder.max_batch().max(1)),
            &mut |n| {
                if hooks.cancelled() {
                    cancelled = true;
                    return Err(EmbedError::Permanent("cancelled".into()));
                }
                meter.charge(n).map_err(|e| {
                    meter_err = Some(e);
                    EmbedError::Permanent("metering refused".into())
                })
            },
        );
        let (vectors, stats) = match res {
            Ok(v) => v,
            Err(e) => {
                if cancelled {
                    return Err(IndexError::Cancelled);
                }
                if let Some(m) = meter_err {
                    return Err(IndexError::Meter(m));
                }
                return Err(IndexError::Embed(e));
            }
        };
        self.embed.add(stats);

        let model = self.embedder.model().to_string();
        let mut vi = vectors.into_iter();
        for file in batch {
            let vecs: Vec<Vec<f32>> = vi.by_ref().take(file.pieces.len()).collect();
            let n = file.pieces.len();
            let conn = self.conn;
            let o = self.opts;
            let head = self.head.clone();
            store::atomic(conn, || {
                store::delete_file_chunks(conn, &o.team_id, &o.repo_full_name, &file.path)?;
                let repo = SqliteChunks::new(conn);
                for (i, (content, v)) in file.pieces.iter().zip(vecs).enumerate() {
                    repo.insert_code_chunk(&NewCodeChunk {
                        team_id: o.team_id.clone(),
                        file_path: file.path.clone(),
                        content: content.clone(),
                        embedding: Some(v),
                        embedding_model: Some(model.clone()),
                        repo_full_name: o.repo_full_name.clone(),
                        commit_sha: head.clone(),
                        chunk_index: i64::try_from(i).unwrap_or(i64::MAX),
                    })?;
                }
                store::upsert_manifest(
                    conn,
                    &o.team_id,
                    &o.repo_full_name,
                    &ManifestEntry {
                        path: file.path.clone(),
                        fingerprint: file.fingerprint.clone(),
                        size: file.size,
                        language: file.language.as_str().to_string(),
                        chunk_count: u32::try_from(n).unwrap_or(u32::MAX),
                    },
                )
            })?;
            self.report.files_indexed += 1;
            self.report.chunks_created += n;
            self.done += 1;
            let ev = ScanEvent::FileIndexed {
                path: file.path,
                chunks: n,
                done: self.done,
                total: self.total,
            };
            self.hooks.emit(&ev);
        }
        Ok(())
    }
}

/// Index (or incrementally re-index) one repository snapshot.
///
/// # Errors
/// [`IndexError`]; see the module docs for which failures are per-file (recorded in the report) and
/// which abort.
pub fn index_repo(
    conn: &rusqlite::Connection,
    source: &dyn RepoSource,
    embedder: &dyn Embedder,
    meter: &dyn ScanMeter,
    opts: &IndexOptions,
    hooks: &mut ScanHooks<'_>,
) -> Result<IndexReport, IndexError> {
    let (team, repo) = (opts.team_id.as_str(), opts.repo_full_name.as_str());
    let head = source.head_token()?;
    let mut report = IndexReport {
        head_token: head.clone(),
        ..IndexReport::default()
    };

    if !opts.force {
        if let (Some(h), Some(st)) = (&head, store::get_repo_state(conn, team, repo)?) {
            if st.head_token.as_deref() == Some(h.as_str()) {
                report.up_to_date = true;
                report.files_unchanged = st.file_count as usize;
                hooks.emit(&ScanEvent::Finished {
                    report: report.clone(),
                });
                return Ok(report);
            }
        }
    }

    let entries = source.list()?;
    let mut manifest = store::load_manifest(conn, team, repo)?;
    if opts.force {
        for m in manifest.values_mut() {
            m.fingerprint.clear();
        }
    }
    let plan: ScanPlan = plan_scan(&entries, &manifest, &opts.filter, opts.max_files);
    hooks.emit(&ScanEvent::Planned {
        added: plan.added.len(),
        modified: plan.modified.len(),
        unchanged: plan.unchanged.len(),
        removed: plan.removed.len(),
        skipped: plan.skipped.len(),
    });
    report.files_unchanged = plan.unchanged.len();
    report.files_skipped = plan.skipped.len();
    report.files_over_limit = plan.over_limit.len();

    if !plan.is_noop() {
        // From here on the stored head no longer describes a complete scan.
        store::clear_head_token(conn, team, repo)?;
    }
    for path in &plan.removed {
        if hooks.cancelled() {
            return Err(IndexError::Cancelled);
        }
        store::atomic(conn, || {
            store::remove_file(conn, team, repo, path).map(|_| ())
        })?;
        report.files_removed += 1;
        hooks.emit(&ScanEvent::FileRemoved { path: path.clone() });
    }

    let total = plan.added.len() + plan.modified.len();
    // Flush (and commit finished files) every `batch` chunks; never above what the model accepts.
    let batch = opts.batch_size.max(1).min(embedder.max_batch().max(1));
    let mut run = Run {
        conn,
        embedder,
        meter,
        opts,
        head: head.clone(),
        hooks,
        report,
        embed: EmbedStats::default(),
        pending: Vec::new(),
        pending_chunks: 0,
        done: 0,
        total,
    };

    for pf in plan.to_index() {
        if run.hooks.cancelled() {
            return Err(IndexError::Cancelled);
        }
        let bytes = match source.read(&pf.path) {
            Ok(b) => b,
            Err(e) => {
                let error = e.to_string();
                run.report.failed.push((pf.path.clone(), error.clone()));
                run.done += 1;
                run.hooks.emit(&ScanEvent::FileFailed {
                    path: pf.path.clone(),
                    error,
                });
                continue;
            }
        };
        let fingerprint = pf.sha.clone().unwrap_or_else(|| content_token(&bytes));
        let size = bytes.len() as u64;
        if manifest
            .get(&pf.path)
            .is_some_and(|m| m.fingerprint == fingerprint)
        {
            run.report.files_unchanged += 1;
            run.done += 1;
            continue;
        }
        // Rejected after reading (binary, empty, over the limit): remember the fingerprint with
        // zero chunks so an unchanged file is not fetched again, and drop any stale chunks.
        let skip = |run: &mut Run<'_, '_>, reason: SkipReason| -> Result<(), IndexError> {
            let had_chunks = manifest.get(&pf.path).is_some_and(|m| m.chunk_count > 0);
            store::atomic(conn, || {
                store::delete_file_chunks(conn, team, repo, &pf.path)?;
                store::upsert_manifest(
                    conn,
                    team,
                    repo,
                    &ManifestEntry {
                        path: pf.path.clone(),
                        fingerprint: fingerprint.clone(),
                        size,
                        language: pf.language.as_str().to_string(),
                        chunk_count: 0,
                    },
                )
            })?;
            if had_chunks {
                run.report.files_removed += 1;
            }
            run.report.files_skipped += 1;
            run.done += 1;
            run.hooks.emit(&ScanEvent::FileSkipped {
                path: pf.path.clone(),
                reason,
            });
            Ok(())
        };
        let text = match opts.filter.check_content(bytes) {
            Ok(t) => t,
            Err(reason) => {
                skip(&mut run, reason)?;
                continue;
            }
        };
        let pieces: Vec<String> = chunk_code_file(&pf.path, &text, pf.language, &opts.chunk)
            .into_iter()
            .map(|c| c.content)
            .collect();
        if pieces.is_empty() {
            skip(&mut run, SkipReason::Empty)?;
            continue;
        }
        run.pending_chunks += pieces.len();
        run.pending.push(Prepared {
            path: pf.path.clone(),
            language: pf.language,
            fingerprint,
            size,
            pieces,
        });
        if run.pending_chunks >= batch {
            run.flush()?;
        }
    }
    run.flush()?;

    let Run {
        mut report, embed, ..
    } = run;
    report.embed = embed.into();
    let final_manifest = store::load_manifest(conn, team, repo)?;
    let chunk_count: u32 = final_manifest.values().map(|m| m.chunk_count).sum();
    let file_count = u32::try_from(
        final_manifest
            .values()
            .filter(|m| m.chunk_count > 0)
            .count(),
    )
    .unwrap_or(u32::MAX);
    // Only a scan with no unread files counts as complete for the head-token shortcut.
    let complete_head = if report.failed.is_empty() {
        head.as_deref()
    } else {
        None
    };
    store::put_repo_state(conn, team, repo, complete_head, file_count, chunk_count)?;
    hooks.emit(&ScanEvent::Finished {
        report: report.clone(),
    });
    Ok(report)
}
