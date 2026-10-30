//! Onboarding: progress steps and the "scan a repo into starter docs" flow.
//!
//! Port of `onboarding.service.ts` and `routes/onboarding.ts`:
//!
//! - [`completed_steps`] / [`mark_step_complete`]: the `onboarding_progress` table (migration 0167,
//!   from TS migration 0024), idempotent, with the route's step whitelist ([`VALID_STEPS`]).
//! - [`group_into_modules`], [`score_file`], [`sample_module`]: module detection and smart sampling
//!   (parity issue #268) over a repo listing, ported pattern for pattern.
//! - [`scan_repository`]: pick up to 80 representative files, document each module with the fast
//!   model (bounded concurrency), merge into an overview with the default model. Small repos
//!   (< 5 source files) use the single-prompt path. All model calls go through
//!   [`Advisor`](crate::ai::Advisor), i.e. any [`LlmProvider`].
//! - [`ScanCache`]: 10 minute in-memory cache keyed by `owner/repo@head`.
//! - [`save_scan_documents`]: the route's auto-save of module docs plus an overview as documents
//!   (`implementation` stage, path `/repos/{owner}/{repo}`).
//!
//! Differences from the TS: only the sampled files are fetched (the TS downloaded the whole
//! tarball to read at most 80 of them), and per-module concurrency uses scoped threads.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::filter::{Decision, FileFilter};
use super::source::{RepoSource, SourceEntry};
use crate::ai::prompts::CodeFile;
use crate::ai::{Advisor, LlmProvider, ModelPair};
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, NewDocument};
use crate::store::{db_err, DocumentRepo, SqliteDocuments};

/// Onboarding checklist steps accepted by `POST /progress/:step`.
pub const VALID_STEPS: &[&str] = &[
    "repo-connected",
    "first-doc-created",
    "board-visited",
    "first-ticket-generated",
    "observability-visited",
];

/// Stage given to documents created by a repo scan (TS `SCAN_DEFAULT_STAGE`).
pub const SCAN_DEFAULT_STAGE: &str = "implementation";
/// Files sampled per module.
pub const MAX_PER_MODULE: usize = 8;
/// Files sampled overall.
pub const MAX_TOTAL_FILES: usize = 80;
/// Repos with fewer valid source files use the single-prompt path.
pub const SMALL_REPO_THRESHOLD: usize = 5;
/// Concurrent module-doc model calls (TS `AI_CONCURRENCY`; do not raise without checking limits).
pub const AI_CONCURRENCY: usize = 6;
/// Scan cache lifetime in ms (10 minutes).
pub const SCAN_CACHE_TTL_MS: i64 = 10 * 60 * 1000;

// ---------------------------------------------------------------- progress

/// Steps the user has completed, oldest first.
pub fn completed_steps(conn: &Connection, user_id: &str) -> Result<Vec<String>> {
    let mut s = conn.prepare(
        "SELECT step_key FROM onboarding_progress WHERE user_id = ?1 ORDER BY completed_at, rowid",
    )?;
    let rows = s
        .query_map([user_id], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

/// Mark a step complete. Idempotent (a second call keeps the original timestamp).
///
/// # Errors
/// [`Error::Invalid`] for a step outside [`VALID_STEPS`].
pub fn mark_step_complete(conn: &Connection, user_id: &str, step: &str) -> Result<()> {
    if !VALID_STEPS.contains(&step) {
        return Err(Error::Invalid("Invalid step key".into()));
    }
    if user_id.is_empty() {
        return Err(Error::Invalid("user id is required".into()));
    }
    conn.execute(
        "INSERT OR IGNORE INTO onboarding_progress (id, user_id, step_key, completed_at)
         VALUES (?1,?2,?3,?4)",
        params![new_id(), user_id, step, now_ms()],
    )
    .map_err(db_err)?;
    Ok(())
}

/// Fraction of [`VALID_STEPS`] completed, for a progress bar.
pub fn completion_percent(conn: &Connection, user_id: &str) -> Result<u8> {
    let done = completed_steps(conn, user_id)?
        .iter()
        .filter(|s| VALID_STEPS.contains(&s.as_str()))
        .count();
    Ok(u8::try_from(done * 100 / VALID_STEPS.len()).unwrap_or(100))
}

// ---------------------------------------------------------------- modules

fn module_patterns() -> &'static Vec<(&'static str, Vec<Regex>)> {
    static P: OnceLock<Vec<(&'static str, Vec<Regex>)>> = OnceLock::new();
    P.get_or_init(|| {
        let mk = |pats: &[&str]| -> Vec<Regex> {
            pats.iter().filter_map(|p| Regex::new(p).ok()).collect()
        };
        vec![
            (
                "API Routes",
                mk(&[r"(?i)\broutes?\b", r"(?i)\bendpoints?\b"]),
            ),
            ("Services", mk(&[r"(?i)\bservices?\b"])),
            (
                "Components",
                mk(&[r"(?i)\bcomponents?\b", r"(?i)\bpages?\b", r"(?i)\bviews?\b"]),
            ),
            (
                "Data Layer",
                mk(&[
                    r"(?i)\bdb\b",
                    r"(?i)\bschema\b",
                    r"(?i)\bmodels?\b",
                    r"(?i)\bmigrations?\b",
                ]),
            ),
            (
                "Middleware",
                mk(&[r"(?i)\bmiddleware\b", r"(?i)\bhooks?\b"]),
            ),
            (
                "Utilities",
                mk(&[r"(?i)\butils?\b", r"(?i)\blib\b", r"(?i)\bhelpers?\b"]),
            ),
            (
                "Configuration",
                mk(&[r"^[^/]+\.(json|ya?ml|toml)$", r"(?i)\bconfig\b"]),
            ),
        ]
    })
}

/// Group eligible files into modules by path patterns. Modules keep the TS order (API Routes,
/// Services, Components, Data Layer, Middleware, Utilities, Configuration, Other); empty ones are
/// dropped; a file lands in the first module whose pattern matches.
#[must_use]
pub fn group_into_modules(
    entries: &[SourceEntry],
    filter: &FileFilter,
) -> Vec<(String, Vec<SourceEntry>)> {
    let patterns = module_patterns();
    let mut buckets: Vec<(String, Vec<SourceEntry>)> = patterns
        .iter()
        .map(|(n, _)| ((*n).to_string(), Vec::new()))
        .collect();
    let mut other = Vec::new();
    for e in entries {
        if !matches!(filter.check_path(&e.path, e.size), Decision::Include(_)) {
            continue;
        }
        match patterns
            .iter()
            .position(|(_, rx)| rx.iter().any(|r| r.is_match(&e.path)))
        {
            Some(i) => buckets[i].1.push(e.clone()),
            None => other.push(e.clone()),
        }
    }
    if !other.is_empty() {
        buckets.push(("Other".into(), other));
    }
    buckets.retain(|(_, f)| !f.is_empty());
    buckets
}

fn name_parts(path: &str) -> (&str, String) {
    let filename = path.rsplit('/').next().unwrap_or(path);
    let no_ext = match filename.rfind('.') {
        Some(i)
            if i > 0
                && filename[i + 1..]
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '_') =>
        {
            &filename[..i]
        }
        _ => filename,
    };
    (filename, no_ext.to_lowercase())
}

/// Importance score of a file within its module (port of `scoreFile`).
#[must_use]
pub fn score_file(item: &SourceEntry, all: &[SourceEntry]) -> i32 {
    static TESTS: OnceLock<Regex> = OnceLock::new();
    static TEST_EXT: OnceLock<Regex> = OnceLock::new();
    let (filename, stem) = name_parts(&item.path);
    let mut score = 0;
    if stem == "index" {
        score += 10;
    }
    if stem == "types" || stem == "interfaces" || filename.ends_with(".d.ts") {
        score += 8;
    }
    if ["main", "app", "server", "schema"].contains(&stem.as_str()) {
        score += 7;
    }
    if filename.to_lowercase().starts_with("readme") {
        score += 5;
    }
    let mut sizes: Vec<u64> = all.iter().map(|f| f.size.unwrap_or(0)).collect();
    sizes.sort_unstable();
    let q75 = sizes.get(sizes.len() * 3 / 4).copied().unwrap_or(0);
    if item.size.unwrap_or(0) >= q75 && q75 > 0 {
        score += 3;
    }
    let is_test = TESTS
        .get_or_init(|| Regex::new(r"(?i)\b(__tests__|test|spec)\b").unwrap_or_else(|_| bad()))
        .is_match(&item.path)
        || TEST_EXT
            .get_or_init(|| Regex::new(r"\.(test|spec)\.\w+$").unwrap_or_else(|_| bad()))
            .is_match(&item.path);
    if is_test {
        score -= 5;
    }
    if std::path::Path::new(&item.path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("lock"))
        || item.path.ends_with("lock.json")
    {
        score -= 3;
    }
    score
}

#[allow(clippy::panic)]
fn bad() -> Regex {
    panic!("invalid built-in regex")
}

/// Pick the `max` most representative files of a module (stable for equal scores, like the JS sort).
#[must_use]
pub fn sample_module(files: &[SourceEntry], max: usize) -> Vec<SourceEntry> {
    if files.len() <= max {
        return files.to_vec();
    }
    let mut scored: Vec<(i32, &SourceEntry)> =
        files.iter().map(|f| (score_file(f, files), f)).collect();
    scored.sort_by_key(|a| std::cmp::Reverse(a.0));
    scored
        .into_iter()
        .take(max)
        .map(|(_, f)| f.clone())
        .collect()
}

// ---------------------------------------------------------------- scan

/// Result of [`scan_repository`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OnboardingScan {
    /// Sampled files that were read.
    pub files: Vec<(String, String)>,
    /// Merged overview document (Markdown).
    pub suggested_docs: String,
    /// `(module, docs)` per module.
    pub module_docs: Vec<(String, String)>,
    /// Number of modules documented.
    pub module_count: usize,
    /// Number of files read.
    pub file_count: usize,
}

/// Scan settings.
#[derive(Debug, Clone)]
pub struct ScanRepoOptions {
    /// Filter (default: [`FileFilter::for_onboarding`]).
    pub filter: FileFilter,
    /// Files per module.
    pub max_per_module: usize,
    /// Files overall.
    pub max_total: usize,
    /// Parallel model calls.
    pub concurrency: usize,
}

impl Default for ScanRepoOptions {
    fn default() -> Self {
        Self {
            filter: FileFilter::for_onboarding(),
            max_per_module: MAX_PER_MODULE,
            max_total: MAX_TOTAL_FILES,
            concurrency: AI_CONCURRENCY,
        }
    }
}

/// Read a sampled file; unreadable / binary / oversized files are dropped like the TS.
fn read_text(source: &dyn RepoSource, filter: &FileFilter, path: &str) -> Option<String> {
    let bytes = source.read(path).ok()?;
    filter.check_content(bytes).ok()
}

/// Generate starter documentation for a repository: sample files per module, document each
/// module, merge into an overview.
///
/// # Errors
/// Source listing failure or a model failure (any failed call aborts the scan, as in the TS).
pub fn scan_repository(
    source: &dyn RepoSource,
    llm: &dyn LlmProvider,
    models: &ModelPair,
    repo_label: &str,
    opts: &ScanRepoOptions,
) -> Result<OnboardingScan> {
    let entries = source.list()?;
    let modules = group_into_modules(&entries, &opts.filter);
    let valid_count: usize = modules.iter().map(|(_, f)| f.len()).sum();

    // Phase 4: sample per module within the overall budget.
    let mut sampled: Vec<(String, Vec<String>)> = Vec::new();
    let mut total = 0usize;
    for (name, files) in &modules {
        let remaining = opts.max_total.saturating_sub(total);
        if remaining == 0 {
            break;
        }
        let picked = sample_module(files, opts.max_per_module.min(remaining));
        total += picked.len();
        sampled.push((name.clone(), picked.into_iter().map(|f| f.path).collect()));
    }

    // Phase 5: read.
    let mut module_files: Vec<(String, Vec<CodeFile>)> = Vec::new();
    let mut all_files: Vec<(String, String)> = Vec::new();
    if valid_count < SMALL_REPO_THRESHOLD {
        // Small repo: every valid file, one prompt.
        let mut files = Vec::new();
        for (_, paths) in &sampled {
            for p in paths {
                if let Some(content) = read_text(source, &opts.filter, p) {
                    all_files.push((p.clone(), content.clone()));
                    files.push(CodeFile {
                        path: p.clone(),
                        content,
                    });
                }
            }
        }
        let docs = Advisor::new(llm, models).bootstrap_docs_from_code(&files)?;
        return Ok(OnboardingScan {
            file_count: all_files.len(),
            files: all_files,
            suggested_docs: docs.clone(),
            module_docs: vec![("Overview".into(), docs)],
            module_count: 1,
        });
    }
    for (name, paths) in &sampled {
        let mut files = Vec::new();
        for p in paths {
            if let Some(content) = read_text(source, &opts.filter, p) {
                all_files.push((p.clone(), content.clone()));
                files.push(CodeFile {
                    path: p.clone(),
                    content,
                });
            }
        }
        module_files.push((name.clone(), files));
    }
    module_files.retain(|(_, f)| !f.is_empty());

    // Phase 6: per-module docs, bounded concurrency. Scoped threads in batches of `concurrency`.
    let width = opts.concurrency.max(1);
    let mut module_docs: Vec<(String, String)> = Vec::new();
    for batch in module_files.chunks(width) {
        let results: Vec<Result<(String, String)>> = if width == 1 {
            batch
                .iter()
                .map(|(m, f)| {
                    Advisor::new(llm, models)
                        .bootstrap_module_docs(m, f)
                        .map(|d| (m.clone(), d))
                        .map_err(Error::from)
                })
                .collect()
        } else {
            std::thread::scope(|s| {
                let handles: Vec<_> = batch
                    .iter()
                    .map(|(m, f)| {
                        s.spawn(move || {
                            Advisor::new(llm, models)
                                .bootstrap_module_docs(m, f)
                                .map(|d| (m.clone(), d))
                                .map_err(Error::from)
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .map(|h| {
                        h.join().unwrap_or_else(|_| {
                            Err(Error::Invalid("module doc worker panicked".into()))
                        })
                    })
                    .collect()
            })
        };
        for r in results {
            module_docs.push(r?);
        }
    }

    // Phase 7: merge.
    let suggested = Advisor::new(llm, models).merge_module_docs(&module_docs, repo_label)?;
    Ok(OnboardingScan {
        file_count: all_files.len(),
        files: all_files,
        suggested_docs: suggested,
        module_count: module_docs.len(),
        module_docs,
    })
}

// ---------------------------------------------------------------- cache

/// In-memory scan-result cache keyed by `owner/repo@head_sha`, TTL [`SCAN_CACHE_TTL_MS`].
/// A re-scan of the same commit inside the window costs no source or model calls.
#[derive(Debug, Default)]
pub struct ScanCache {
    entries: Mutex<HashMap<String, (OnboardingScan, i64)>>,
}

impl ScanCache {
    /// Empty cache.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, (OnboardingScan, i64)>> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn key(owner: &str, repo: &str, head: &str) -> String {
        format!("{owner}/{repo}@{head}")
    }

    /// Cached scan if still fresh at `now` (expired entries are dropped).
    pub fn get(&self, owner: &str, repo: &str, head: &str, now: i64) -> Option<OnboardingScan> {
        if head.is_empty() {
            return None;
        }
        let key = Self::key(owner, repo, head);
        let mut m = self.lock();
        match m.get(&key) {
            Some((v, exp)) if *exp > now => Some(v.clone()),
            Some(_) => {
                m.remove(&key);
                None
            }
            None => None,
        }
    }

    /// Store a result (ignored for an empty head).
    pub fn put(&self, owner: &str, repo: &str, head: &str, scan: OnboardingScan, now: i64) {
        if head.is_empty() {
            return;
        }
        self.lock().insert(
            Self::key(owner, repo, head),
            (scan, now + SCAN_CACHE_TTL_MS),
        );
    }

    /// Drop every cached head of `owner/repo`.
    pub fn invalidate(&self, owner: &str, repo: &str) {
        let prefix = format!("{owner}/{repo}@");
        self.lock().retain(|k, _| !k.starts_with(&prefix));
    }
}

/// Like [`scan_repository`] but served from `cache` when the source head is known and fresh.
///
/// # Errors
/// Same as [`scan_repository`].
pub fn scan_repository_cached(
    cache: &ScanCache,
    source: &dyn RepoSource,
    llm: &dyn LlmProvider,
    models: &ModelPair,
    owner: &str,
    repo: &str,
    opts: &ScanRepoOptions,
) -> Result<OnboardingScan> {
    let head = source.head_token()?.unwrap_or_default();
    if let Some(hit) = cache.get(owner, repo, &head, now_ms()) {
        return Ok(hit);
    }
    let scan = scan_repository(source, llm, models, &format!("{owner}/{repo}"), opts)?;
    cache.put(owner, repo, &head, scan.clone(), now_ms());
    Ok(scan)
}

// ---------------------------------------------------------------- save

/// A document created from a scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedDoc {
    /// Document id.
    pub id: String,
    /// Title.
    pub title: String,
    /// Path.
    pub path: String,
}

/// Persist a scan as documents: one per module (in order) then `{owner}/{repo} Overview`, all in
/// `/repos/{owner}/{repo}` at stage [`SCAN_DEFAULT_STAGE`]. Atomic.
///
/// # Errors
/// [`Error::Invalid`] for empty owner / repo / team / user.
pub fn save_scan_documents(
    conn: &Connection,
    team_id: &str,
    user_id: &str,
    owner: &str,
    repo: &str,
    scan: &OnboardingScan,
) -> Result<Vec<SavedDoc>> {
    if owner.is_empty() || repo.is_empty() {
        return Err(Error::Invalid("owner and repo are required".into()));
    }
    if team_id.is_empty() {
        return Err(Error::Invalid("teamId is required".into()));
    }
    if user_id.is_empty() {
        return Err(Error::Invalid("Authentication required".into()));
    }
    let path = format!("/repos/{owner}/{repo}");
    let mut docs: Vec<(String, String)> = scan.module_docs.clone();
    docs.push((
        format!("{owner}/{repo} Overview"),
        scan.suggested_docs.clone(),
    ));
    super::store::atomic(conn, || {
        let repo_docs = SqliteDocuments::new(conn);
        docs.iter()
            .map(|(title, content)| {
                let d = repo_docs.create(&NewDocument {
                    title: title.clone(),
                    content: content.clone(),
                    path: path.clone(),
                    team_id: team_id.to_string(),
                    created_by_id: user_id.to_string(),
                    stage: Some(SCAN_DEFAULT_STAGE.into()),
                    lifecycle_id: None,
                })?;
                Ok(SavedDoc {
                    id: d.id,
                    title: d.title,
                    path: d.path,
                })
            })
            .collect()
    })
}

/// Helper for UIs: module -> file count of a listing.
#[must_use]
pub fn module_summary(entries: &[SourceEntry], filter: &FileFilter) -> BTreeMap<String, usize> {
    group_into_modules(entries, filter)
        .into_iter()
        .map(|(n, f)| (n, f.len()))
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::ai::FakeLlm;
    use crate::scan::source::MemorySource;
    use crate::scan::store::testutil::{count, db_with_team};

    fn e(path: &str, size: u64) -> SourceEntry {
        SourceEntry {
            path: path.into(),
            size: Some(size),
            sha: None,
        }
    }

    fn models() -> ModelPair {
        ModelPair {
            default: "m".into(),
            fast: "f".into(),
        }
    }

    #[test]
    fn progress_is_idempotent_and_validated() {
        let (db, _) = db_with_team();
        let c = db.conn();
        assert!(completed_steps(c, "u1").unwrap().is_empty());
        mark_step_complete(c, "u1", "repo-connected").unwrap();
        mark_step_complete(c, "u1", "repo-connected").unwrap();
        mark_step_complete(c, "u1", "board-visited").unwrap();
        mark_step_complete(c, "u2", "repo-connected").unwrap();
        assert_eq!(
            completed_steps(c, "u1").unwrap(),
            vec!["repo-connected", "board-visited"]
        );
        assert_eq!(completion_percent(c, "u1").unwrap(), 40);
        assert!(matches!(
            mark_step_complete(c, "u1", "nope"),
            Err(Error::Invalid(_))
        ));
        assert_eq!(count(c, "onboarding_progress"), 3);
    }

    #[test]
    fn groups_files_into_modules_in_ts_order() {
        let entries = vec![
            e("src/routes/users.ts", 10),
            e("src/services/auth.ts", 10),
            e("src/components/Button.tsx", 10),
            e("src/db/schema.ts", 10),
            e("src/middleware/cors.ts", 10),
            e("src/lib/util.ts", 10),
            e("package.json", 10),
            e("src/main.ts", 10),
            e("node_modules/x/index.js", 10),
            e("dist/a.js", 10),
            e("static/app.min.js", 10),
            e("big.ts", 200_000),
        ];
        let m = group_into_modules(&entries, &FileFilter::for_onboarding());
        let names: Vec<&str> = m.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "API Routes",
                "Services",
                "Components",
                "Data Layer",
                "Middleware",
                "Utilities",
                "Configuration",
                "Other"
            ]
        );
        assert_eq!(m.last().unwrap().1[0].path, "src/main.ts");
    }

    #[test]
    fn scoring_prefers_entry_points_and_penalises_tests() {
        let files = vec![
            e("a/index.ts", 100),
            e("a/types.ts", 100),
            e("a/server.ts", 100),
            e("a/README.md", 100),
            e("a/helper.ts", 100),
            e("a/helper.test.ts", 100),
            e("a/big.ts", 10_000),
            e("a/yarn.lock", 100),
        ];
        let s = |p: &str| score_file(files.iter().find(|f| f.path == p).unwrap(), &files);
        assert!(s("a/index.ts") > s("a/types.ts"));
        assert!(s("a/types.ts") > s("a/server.ts"));
        assert!(s("a/server.ts") > s("a/README.md"));
        assert!(s("a/helper.ts") > s("a/helper.test.ts"));
        assert_eq!(s("a/big.ts"), 3);
        assert!(s("a/yarn.lock") < s("a/helper.ts"));
        let picked = sample_module(&files, 3);
        assert_eq!(picked.len(), 3);
        assert_eq!(picked[0].path, "a/index.ts");
        assert_eq!(sample_module(&files[..2], 5).len(), 2);
    }

    fn repo_with(n: usize) -> MemorySource {
        let m = MemorySource::new();
        for i in 0..n {
            m.put(
                &format!("src/services/s{i}.ts"),
                format!("export const s{i} = {i};"),
            );
        }
        m.put("src/routes/r.ts", "export const r = 1;");
        m.set_head(Some("abc"));
        m
    }

    #[test]
    fn small_repo_uses_single_prompt() {
        let m = MemorySource::new();
        m.put("a.ts", "export const a = 1;");
        m.put("b.ts", "export const b = 1;");
        let llm = FakeLlm::with_texts(&["# Docs"]);
        let s = scan_repository(&m, &llm, &models(), "o/r", &ScanRepoOptions::default()).unwrap();
        assert_eq!(llm.call_count(), 1);
        assert_eq!(s.module_count, 1);
        assert_eq!(
            s.module_docs,
            vec![("Overview".to_string(), "# Docs".to_string())]
        );
        assert_eq!(s.suggested_docs, "# Docs");
        assert_eq!(s.file_count, 2);
    }

    #[test]
    fn module_scan_documents_each_module_then_merges() {
        let m = repo_with(6);
        let llm = FakeLlm::with_texts(&["services docs", "routes docs", "MERGED"]);
        let opts = ScanRepoOptions {
            concurrency: 1,
            ..ScanRepoOptions::default()
        };
        let s = scan_repository(&m, &llm, &models(), "o/r", &opts).unwrap();
        assert_eq!(s.module_count, 2);
        // API Routes comes before Services in module order.
        assert_eq!(
            s.module_docs[0],
            ("API Routes".to_string(), "services docs".to_string())
        );
        assert_eq!(s.module_docs[1].0, "Services");
        assert_eq!(s.suggested_docs, "MERGED");
        assert_eq!(llm.call_count(), 3);
        let reqs = llm.requests();
        assert_eq!(reqs[0].model, "f", "module docs use the fast model");
        assert_eq!(reqs[2].model, "m", "merge uses the default model");
        assert!(reqs[2].messages[0].content.contains("## Module: Services"));
        assert_eq!(s.file_count, 7);
    }

    #[test]
    fn module_scan_respects_total_and_per_module_caps() {
        let m = repo_with(20);
        let llm = FakeLlm::new();
        for _ in 0..3 {
            llm.push_text("x");
        }
        let opts = ScanRepoOptions {
            concurrency: 1,
            max_per_module: 3,
            max_total: 4,
            ..ScanRepoOptions::default()
        };
        let s = scan_repository(&m, &llm, &models(), "o/r", &opts).unwrap();
        assert_eq!(s.file_count, 4);
    }

    #[test]
    fn bounded_concurrency_path_works() {
        let m = repo_with(6);
        let llm = FakeLlm::new();
        for _ in 0..3 {
            llm.push_text("same");
        }
        let s = scan_repository(&m, &llm, &models(), "o/r", &ScanRepoOptions::default()).unwrap();
        assert_eq!(s.module_count, 2);
        assert!(s.module_docs.iter().all(|(_, d)| d == "same"));
    }

    #[test]
    fn model_failure_aborts() {
        let m = repo_with(6);
        let llm = FakeLlm::new();
        llm.push(Err(crate::ai::LlmError::Transport("down".into())));
        let opts = ScanRepoOptions {
            concurrency: 1,
            ..ScanRepoOptions::default()
        };
        assert!(scan_repository(&m, &llm, &models(), "o/r", &opts).is_err());
    }

    #[test]
    fn cache_serves_same_head_and_expires() {
        let c = ScanCache::new();
        let scan = OnboardingScan {
            files: vec![],
            suggested_docs: "d".into(),
            module_docs: vec![],
            module_count: 0,
            file_count: 0,
        };
        c.put("o", "r", "h1", scan.clone(), 1000);
        assert_eq!(c.get("o", "r", "h1", 1001), Some(scan.clone()));
        assert_eq!(c.get("o", "r", "h2", 1001), None);
        assert_eq!(c.get("o", "r", "h1", 1000 + SCAN_CACHE_TTL_MS), None);
        c.put("o", "r", "h1", scan.clone(), 1000);
        c.put("o", "r2", "h1", scan.clone(), 1000);
        c.invalidate("o", "r");
        assert_eq!(c.get("o", "r", "h1", 1001), None);
        assert!(c.get("o", "r2", "h1", 1001).is_some());
        c.put("o", "r", "", scan, 1000);
        assert_eq!(c.get("o", "r", "", 1001), None);
    }

    #[test]
    fn cached_scan_skips_llm_on_second_call() {
        let m = repo_with(6);
        let llm = FakeLlm::new();
        for _ in 0..3 {
            llm.push_text("x");
        }
        let cache = ScanCache::new();
        let opts = ScanRepoOptions {
            concurrency: 1,
            ..ScanRepoOptions::default()
        };
        let a = scan_repository_cached(&cache, &m, &llm, &models(), "o", "r", &opts).unwrap();
        let b = scan_repository_cached(&cache, &m, &llm, &models(), "o", "r", &opts).unwrap();
        assert_eq!(a, b);
        assert_eq!(llm.call_count(), 3);
    }

    #[test]
    fn saves_module_docs_then_overview() {
        use crate::model::NewUser;
        use crate::store::{SqliteUsers, UserRepo};
        let (db, team) = db_with_team();
        let c = db.conn();
        let user = SqliteUsers::new(c)
            .create(&NewUser {
                email: "a@b.c".into(),
                name: "A".into(),
                avatar_url: None,
            })
            .unwrap();
        let scan = OnboardingScan {
            files: vec![],
            suggested_docs: "overview".into(),
            module_docs: vec![
                ("Services".into(), "svc".into()),
                ("Other".into(), "oth".into()),
            ],
            module_count: 2,
            file_count: 3,
        };
        let saved = save_scan_documents(c, &team, &user.id, "acme", "app", &scan).unwrap();
        let titles: Vec<&str> = saved.iter().map(|d| d.title.as_str()).collect();
        assert_eq!(titles, vec!["Services", "Other", "acme/app Overview"]);
        assert!(saved.iter().all(|d| d.path == "/repos/acme/app"));
        let d = SqliteDocuments::new(c).get(&saved[2].id).unwrap();
        assert_eq!(d.stage.as_deref(), Some("implementation"));
        assert_eq!(d.content, "overview");
        assert!(save_scan_documents(c, &team, &user.id, "", "app", &scan).is_err());
        assert_eq!(SqliteDocuments::new(c).list_live(&team).unwrap().len(), 3);
    }
}
