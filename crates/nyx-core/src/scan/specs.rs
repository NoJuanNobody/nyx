//! Spec-vs-code scan and semantic code search.
//!
//! Ports the rest of `codebase-scanner.service.ts` and `code-embedding.service.ts`:
//!
//! - [`scan_specs`] / [`scan_document`]: for each team document, ask the fast model which repo
//!   files relate to it, read up to 10 of them (50 KB total), ask the default model what sections
//!   the spec is missing and draft the content, then hand the finding to a [`SpecProposalSink`].
//!   Every model failure degrades to "nothing found" for that document, as in the TS.
//! - [`search_code`]: embed a query and rank stored code chunks (cosine, `top_k` 8, threshold 0.25).
//! - [`fetch_relevant_code_for_document`] + [`RelevantCodeCache`]: grounding context for document
//!   edits, never fails (empty result instead), cached 5 minutes with the TS size caps.
//!
//! Gaps: the TS wrote a `change_proposals` row directly; proposals in the Rust core are branch
//! backed (`vcs::proposal::propose`), so the sink is a trait and the wiring wave decides which
//! branch receives the proposed content. The TS 6 s soft timeout on retrieval is dropped (the
//! search is local and synchronous). Documents are scanned in `list_live` order rather than
//! most-recently-updated first.

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::embed::Embedder;
use super::filter::FileFilter;
use super::source::RepoSource;
use crate::ai::parse::{find_keyed_object, strip_fences, MissingSection};
use crate::ai::{LlmProvider, LlmRequest, ModelPair};
use crate::error::{Error, Result};
use crate::model::{now_ms, Document};
use crate::store::{ChunkRepo, DocumentRepo, SqliteChunks, SqliteDocuments};

/// Files read per document.
pub const MAX_FILES_PER_DOC: usize = 10;
/// Characters of code sent per document (TS: 50 KB).
pub const MAX_TOTAL_CONTENT_CHARS: usize = 50 * 1024;
/// Paths offered to the matcher.
pub const MAX_PATHS_TO_MATCHER: usize = 500;
/// Default hits for [`search_code`].
pub const DEFAULT_TOP_K: usize = 8;
/// Default minimum cosine similarity for [`search_code`].
pub const DEFAULT_THRESHOLD: f32 = 0.25;

// ---------------------------------------------------------------- spec scan

/// Receives a finding worth proposing (TS: inserted a pending `change_proposals` row).
pub trait SpecProposalSink {
    /// Create a proposal and return its id.
    ///
    /// # Errors
    /// Failure is swallowed by the scanner (proposal creation is best-effort).
    fn create(
        &self,
        doc: &Document,
        title: &str,
        description: &str,
        proposed_content: &str,
    ) -> Result<String>;
}

/// Records proposals in memory (tests, previews).
#[derive(Debug, Default)]
pub struct RecordingSink {
    /// `(document_id, title, description, proposed_content)` in creation order.
    pub created: Mutex<Vec<(String, String, String, String)>>,
}

impl SpecProposalSink for RecordingSink {
    fn create(
        &self,
        doc: &Document,
        title: &str,
        description: &str,
        content: &str,
    ) -> Result<String> {
        let mut c = self
            .created
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        c.push((
            doc.id.clone(),
            title.into(),
            description.into(),
            content.into(),
        ));
        Ok(format!("proposal-{}", c.len()))
    }
}

/// Finding for one document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentScanResult {
    /// Document id.
    pub document_id: String,
    /// Title.
    pub document_title: String,
    /// Files the matcher picked.
    pub relevant_files: Vec<String>,
    /// Sections the spec lacks.
    pub missing_sections: Vec<MissingSection>,
    /// Drafted full document, if anything was missing.
    pub proposed_content: Option<String>,
    /// Id from the [`SpecProposalSink`].
    pub proposal_id: Option<String>,
}

/// Result of a team-wide scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpecScanResult {
    /// Team.
    pub team_id: String,
    /// Unix ms.
    pub scanned_at: i64,
    /// Documents processed.
    pub documents_scanned: usize,
    /// Proposals created.
    pub proposals_created: usize,
    /// Per-document findings.
    pub results: Vec<DocumentScanResult>,
    /// Set when the scan could not run.
    pub error: Option<String>,
}

/// Everything a spec scan needs besides the database.
pub struct SpecScanner<'a> {
    /// Repo files.
    pub source: &'a dyn RepoSource,
    /// Model backend.
    pub llm: &'a dyn LlmProvider,
    /// Model names.
    pub models: &'a ModelPair,
    /// Where findings go.
    pub sink: &'a dyn SpecProposalSink,
    /// Which files are candidates.
    pub filter: FileFilter,
}

impl<'a> SpecScanner<'a> {
    /// Scanner with the TS file filter ([`FileFilter::for_specs`]).
    #[must_use]
    pub fn new(
        source: &'a dyn RepoSource,
        llm: &'a dyn LlmProvider,
        models: &'a ModelPair,
        sink: &'a dyn SpecProposalSink,
    ) -> Self {
        Self {
            source,
            llm,
            models,
            sink,
            filter: FileFilter::for_specs(),
        }
    }

    fn file_paths(&self) -> Result<Vec<String>> {
        Ok(self
            .source
            .list()?
            .into_iter()
            .filter(|e| {
                matches!(
                    self.filter.check_path(&e.path, e.size),
                    super::filter::Decision::Include(_)
                )
            })
            .map(|e| e.path)
            .collect())
    }

    /// Scan every live document of `team_id`.
    pub fn scan_all(&self, conn: &Connection, team_id: &str) -> SpecScanResult {
        let mut out = SpecScanResult {
            team_id: team_id.to_string(),
            scanned_at: now_ms(),
            documents_scanned: 0,
            proposals_created: 0,
            results: Vec::new(),
            error: None,
        };
        let paths = match self.file_paths() {
            Ok(p) => p,
            Err(e) => {
                out.error = Some(format!("Failed to fetch file tree: {e}"));
                return out;
            }
        };
        let docs = match SqliteDocuments::new(conn).list_live(team_id) {
            Ok(d) => d,
            Err(e) => {
                out.error = Some(e.to_string());
                return out;
            }
        };
        if docs.is_empty() {
            out.error = Some("No documents found for this team".into());
            return out;
        }
        for doc in &docs {
            let r = self.scan_loaded(doc, &paths);
            out.documents_scanned += 1;
            if r.proposal_id.is_some() {
                out.proposals_created += 1;
            }
            out.results.push(r);
        }
        out
    }

    /// Scan one document of `team_id`.
    ///
    /// # Errors
    /// [`Error::NotFound`] when the document is not in the team; source failures.
    pub fn scan_document(
        &self,
        conn: &Connection,
        team_id: &str,
        document_id: &str,
    ) -> Result<DocumentScanResult> {
        let doc = SqliteDocuments::new(conn).get(document_id)?;
        if doc.team_id != team_id {
            return Err(Error::NotFound("Document not found".into()));
        }
        let paths = self.file_paths()?;
        Ok(self.scan_loaded(&doc, &paths))
    }

    fn scan_loaded(&self, doc: &Document, all_paths: &[String]) -> DocumentScanResult {
        let mut result = DocumentScanResult {
            document_id: doc.id.clone(),
            document_title: doc.title.clone(),
            relevant_files: Vec::new(),
            missing_sections: Vec::new(),
            proposed_content: None,
            proposal_id: None,
        };
        let matched = self.match_code_files(&doc.title, &doc.content, all_paths);
        if matched.is_empty() {
            return result;
        }
        result.relevant_files.clone_from(&matched);

        let mut code: Vec<(String, String)> = Vec::new();
        let mut total = 0usize;
        for path in matched.iter().take(MAX_FILES_PER_DOC) {
            if total >= MAX_TOTAL_CONTENT_CHARS {
                break;
            }
            let Ok(bytes) = self.source.read(path) else {
                continue;
            };
            let text = String::from_utf8_lossy(&bytes);
            let truncated: String = text.chars().take(MAX_TOTAL_CONTENT_CHARS - total).collect();
            total += truncated.chars().count();
            code.push((path.clone(), truncated));
        }
        if code.is_empty() {
            return result;
        }

        let (missing, proposed) =
            self.analyze_and_generate(&doc.title, &doc.content, doc.stage.as_deref(), &code);
        if let (Some(content), false) = (&proposed, missing.is_empty()) {
            let title = format!("[Auto-scan] Fill missing sections for \"{}\"", doc.title);
            let list = missing
                .iter()
                .map(|s| format!("- **{}** ({}): {}", s.name, s.priority, s.description))
                .collect::<Vec<_>>()
                .join("\n");
            let description = format!(
                "Codebase scan found {} missing or incomplete section(s) based on the actual implementation code.\n\nMissing sections:\n{list}",
                missing.len()
            );
            result.proposal_id = self.sink.create(doc, &title, &description, content).ok();
        }
        result.missing_sections = missing;
        result.proposed_content = proposed;
        result
    }

    /// Ask the fast model which files relate to a document; only paths that exist are kept.
    fn match_code_files(&self, title: &str, content: &str, all: &[String]) -> Vec<String> {
        let list = all
            .iter()
            .take(MAX_PATHS_TO_MATCHER)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        let snippet: String = content.chars().take(2000).collect();
        let system = "You are a code-to-documentation matcher. Given a spec document and a list of file paths from a repository, identify which code files are most relevant to the spec.\n\nReturn ONLY a JSON array of file paths, ordered by relevance (most relevant first). Return at most 10 paths. Example: [\"src/services/auth.ts\", \"src/routes/login.ts\"]\n\nIf no files seem relevant, return an empty array: []";
        let user = format!("## Document: \"{title}\"\n\n{snippet}\n\n## Repository Files\n{list}");
        let req = LlmRequest::simple(self.models.fast.clone(), system, user, 1024);
        let Ok(resp) = self.llm.complete(&req) else {
            return Vec::new();
        };
        let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&strip_fences(&resp.text))
        else {
            return Vec::new();
        };
        let valid: std::collections::HashSet<&str> = all.iter().map(String::as_str).collect();
        items
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .filter(|p| valid.contains(p.as_str()))
            .take(MAX_FILES_PER_DOC)
            .collect()
    }

    /// Ask the default model for missing sections and drafted content.
    fn analyze_and_generate(
        &self,
        title: &str,
        content: &str,
        stage: Option<&str>,
        code: &[(String, String)],
    ) -> (Vec<MissingSection>, Option<String>) {
        let code_block = code
            .iter()
            .map(|(p, c)| format!("### {p}\n```\n{c}\n```"))
            .collect::<Vec<_>>()
            .join("\n\n");
        let stage_ctx = stage.map_or_else(String::new, |s| {
            format!(" This is a \"{s}\" stage document.")
        });
        let system = format!("You are a spec completeness analyzer. Given a specification document and the actual implementation code, identify what sections are missing or incomplete in the spec, then generate the missing content based on what the code actually implements.{stage_ctx}\n\nRespond ONLY with valid JSON in this exact format:\n{{\n  \"missingSections\": [\n    {{\"name\": \"section name\", \"description\": \"what is missing\", \"priority\": \"high|medium|low\"}}\n  ],\n  \"proposedContent\": \"The full updated document content with missing sections filled in based on the code. Use markdown format. Preserve existing content and add new sections where appropriate.\"\n}}\n\nIf the spec is already complete relative to the code, return:\n{{\"missingSections\": [], \"proposedContent\": null}}");
        let user = format!(
            "## Specification: \"{title}\"\n\n{content}\n\n## Implementation Code\n\n{code_block}"
        );
        let req = LlmRequest::simple(self.models.default.clone(), system, user, 4096);
        let Ok(resp) = self.llm.complete(&req) else {
            return (Vec::new(), None);
        };
        let text = strip_fences(&resp.text);
        let candidate = find_keyed_object(&text, &["missingSections"]).unwrap_or(&text);
        let Ok(v) = serde_json::from_str::<Value>(candidate) else {
            return (Vec::new(), None);
        };
        let missing = v
            .get("missingSections")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|s| {
                        let name = s.get("name")?.as_str().filter(|x| !x.is_empty())?;
                        let description =
                            s.get("description")?.as_str().filter(|x| !x.is_empty())?;
                        let priority = s.get("priority")?.as_str()?;
                        ["high", "medium", "low"]
                            .contains(&priority)
                            .then(|| MissingSection {
                                name: name.into(),
                                description: description.into(),
                                priority: priority.into(),
                            })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let proposed = v
            .get("proposedContent")
            .and_then(Value::as_str)
            .map(str::to_string);
        (missing, proposed)
    }
}

/// Convenience wrapper for [`SpecScanner::scan_all`].
pub fn scan_specs(scanner: &SpecScanner<'_>, conn: &Connection, team_id: &str) -> SpecScanResult {
    scanner.scan_all(conn, team_id)
}

/// Convenience wrapper for [`SpecScanner::scan_document`].
///
/// # Errors
/// See [`SpecScanner::scan_document`].
pub fn scan_document(
    scanner: &SpecScanner<'_>,
    conn: &Connection,
    team_id: &str,
    document_id: &str,
) -> Result<DocumentScanResult> {
    scanner.scan_document(conn, team_id, document_id)
}

// ---------------------------------------------------------------- search

/// A ranked code chunk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodeHit {
    /// File.
    pub file_path: String,
    /// Chunk text (with its `// File:` prefix).
    pub content: String,
    /// Cosine similarity.
    pub score: f32,
    /// Chunk position in the file.
    pub chunk_index: i64,
}

/// Semantic search over a team's indexed code. Chunks embedded with a different dimension (a
/// different model) are skipped by the store.
///
/// # Errors
/// Embedding or database failure.
pub fn search_code(
    conn: &Connection,
    embedder: &dyn Embedder,
    team_id: &str,
    query: &str,
    top_k: usize,
    threshold: f32,
) -> Result<Vec<CodeHit>> {
    let mut v = embedder.embed(&[query.to_string()])?;
    let q = v
        .pop()
        .ok_or_else(|| Error::Invalid("embedder returned no vector".into()))?;
    Ok(SqliteChunks::new(conn)
        .search_code_chunks(team_id, &q, top_k)?
        .into_iter()
        .filter(|(_, s)| *s >= threshold)
        .map(|(c, score)| CodeHit {
            file_path: c.file_path,
            content: c.content,
            score,
            chunk_index: c.chunk_index,
        })
        .collect())
}

/// Code context for grounding a document edit.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelevantCode {
    /// `(path, content)` per chunk, best first.
    pub chunks: Vec<(String, String)>,
    /// Distinct paths in rank order.
    pub sources: Vec<String>,
}

const CACHE_TTL_MS: i64 = 5 * 60 * 1000;
const MAX_PER_TEAM: usize = 200;
const MAX_GLOBAL: usize = 1000;

struct CacheEntry {
    key: String,
    team_id: String,
    expires_at: i64,
    value: RelevantCode,
}

/// Cache hit / miss counters (TS `cacheMetrics`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheMetrics {
    /// Served from cache.
    pub hits: u64,
    /// Not in cache.
    pub misses: u64,
    /// Dropped for size, age or invalidation.
    pub evictions: u64,
}

/// LRU cache of [`RelevantCode`], TTL 5 min, 200 entries per team, 1000 overall.
#[derive(Default)]
pub struct RelevantCodeCache {
    inner: Mutex<(Vec<CacheEntry>, CacheMetrics)>,
}

impl RelevantCodeCache {
    /// Empty cache.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, (Vec<CacheEntry>, CacheMetrics)> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Counters.
    #[must_use]
    pub fn metrics(&self) -> CacheMetrics {
        self.lock().1
    }

    /// Entries currently held.
    #[must_use]
    pub fn len(&self) -> usize {
        self.lock().0.len()
    }

    /// True when empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn get(&self, key: &str, now: i64) -> Option<RelevantCode> {
        let mut g = self.lock();
        let before = g.0.len();
        g.0.retain(|e| e.expires_at >= now);
        g.1.evictions += (before - g.0.len()) as u64;
        if let Some(i) = g.0.iter().position(|e| e.key == key) {
            let e = g.0.remove(i);
            let v = e.value.clone();
            g.0.push(e); // most recently used goes last
            g.1.hits += 1;
            Some(v)
        } else {
            g.1.misses += 1;
            None
        }
    }

    fn put(&self, key: String, team_id: &str, value: RelevantCode, now: i64) {
        let mut g = self.lock();
        g.0.retain(|e| e.key != key);
        loop {
            let team_count = g.0.iter().filter(|e| e.team_id == team_id).count();
            if team_count < MAX_PER_TEAM && g.0.len() < MAX_GLOBAL {
                break;
            }
            // Evict the least recently used entry (the TS evicted the oldest globally).
            g.0.remove(0);
            g.1.evictions += 1;
        }
        g.0.push(CacheEntry {
            key,
            team_id: team_id.to_string(),
            expires_at: now + CACHE_TTL_MS,
            value,
        });
    }

    /// Drop everything cached for a team (call after a successful index run).
    pub fn invalidate_team(&self, team_id: &str) {
        let mut g = self.lock();
        let before = g.0.len();
        g.0.retain(|e| e.team_id != team_id);
        g.1.evictions += (before - g.0.len()) as u64;
    }
}

fn query_hash(text: &str) -> String {
    hex::encode(&Sha256::digest(text.as_bytes())[..8])
}

/// Most relevant indexed code for a document (title + first 2000 chars as the query).
///
/// Never fails: a missing document, empty query, embedding error or empty index all yield an empty
/// [`RelevantCode`] so callers can fall back to an ungrounded prompt.
pub fn fetch_relevant_code_for_document(
    conn: &Connection,
    embedder: &dyn Embedder,
    cache: &RelevantCodeCache,
    document_id: &str,
    team_id: &str,
    now: i64,
) -> RelevantCode {
    let Ok(doc) = SqliteDocuments::new(conn).get(document_id) else {
        return RelevantCode::default();
    };
    if doc.team_id != team_id {
        return RelevantCode::default();
    }
    let snippet: String = doc.content.chars().take(2000).collect();
    let query = format!("{}\n\n{snippet}", doc.title).trim().to_string();
    if query.is_empty() {
        return RelevantCode::default();
    }
    let key = format!("{team_id}:{document_id}:{}", query_hash(&query));
    if let Some(hit) = cache.get(&key, now) {
        return hit;
    }
    let Ok(hits) = search_code(
        conn,
        embedder,
        team_id,
        &query,
        DEFAULT_TOP_K,
        DEFAULT_THRESHOLD,
    ) else {
        return RelevantCode::default();
    };
    if hits.is_empty() {
        return RelevantCode::default();
    }
    let mut out = RelevantCode::default();
    for h in hits {
        if !out.sources.contains(&h.file_path) {
            out.sources.push(h.file_path.clone());
        }
        out.chunks.push((h.file_path, h.content));
    }
    cache.put(key, team_id, out.clone(), now);
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::ai::FakeLlm;
    use crate::model::{NewDocument, NewUser};
    use crate::scan::embed::FakeEmbedder;
    use crate::scan::indexer::{index_repo, IndexOptions, ScanHooks};
    use crate::scan::meter::NoMeter;
    use crate::scan::source::MemorySource;
    use crate::scan::store::testutil::db_with_team;
    use crate::store::{SqliteTeams, SqliteUsers, TeamRepo, UserRepo};

    fn models() -> ModelPair {
        ModelPair {
            default: "m".into(),
            fast: "f".into(),
        }
    }

    fn setup() -> (crate::store::Db, String, String, String) {
        let (db, team) = db_with_team();
        let user = SqliteUsers::new(db.conn())
            .create(&NewUser {
                email: "a@b.c".into(),
                name: "A".into(),
                avatar_url: None,
            })
            .unwrap();
        let doc = SqliteDocuments::new(db.conn())
            .create(&NewDocument {
                title: "Auth spec".into(),
                content: "Login flow".into(),
                path: "/".into(),
                team_id: team.clone(),
                created_by_id: user.id.clone(),
                stage: Some("implementation".into()),
                lifecycle_id: None,
            })
            .unwrap();
        (db, team, user.id, doc.id)
    }

    fn repo() -> MemorySource {
        let m = MemorySource::new();
        m.put("src/auth.ts", "export function login() {}");
        m.put("src/other.ts", "export const x = 1;");
        m.put("logo.png", "binary");
        m
    }

    #[test]
    fn scan_finds_missing_sections_and_creates_a_proposal() {
        let (db, team, _, _) = setup();
        let src = repo();
        let llm = FakeLlm::with_texts(&[
            r#"```json
["src/auth.ts", "does/not/exist.ts", "logo.png"]
```"#,
            r##"{"missingSections":[{"name":"Errors","description":"no error handling","priority":"high"},{"name":"","description":"x","priority":"low"},{"name":"Bad","description":"x","priority":"urgent"}],"proposedContent":"# Auth spec\n\n## Errors"}"##,
        ]);
        let sink = RecordingSink::default();
        let m = models();
        let sc = SpecScanner::new(&src, &llm, &m, &sink);
        let r = sc.scan_all(db.conn(), &team);
        assert_eq!(r.error, None);
        assert_eq!(r.documents_scanned, 1);
        assert_eq!(r.proposals_created, 1);
        let d = &r.results[0];
        assert_eq!(d.relevant_files, vec!["src/auth.ts"]);
        assert_eq!(d.missing_sections.len(), 1);
        assert_eq!(d.missing_sections[0].name, "Errors");
        assert_eq!(d.proposal_id.as_deref(), Some("proposal-1"));
        let created = sink.created.lock().unwrap();
        assert!(created[0]
            .1
            .starts_with("[Auto-scan] Fill missing sections for \"Auth spec\""));
        assert!(created[0]
            .2
            .contains("- **Errors** (high): no error handling"));
        // matcher saw only eligible paths; analyzer saw the file content
        let reqs = llm.requests();
        assert!(reqs[0].messages[0].content.contains("src/auth.ts"));
        assert!(!reqs[0].messages[0].content.contains("logo.png"));
        assert!(reqs[1].messages[0]
            .content
            .contains("export function login"));
        assert!(reqs[1].system.contains("\"implementation\" stage"));
        assert_eq!(reqs[0].model, "f");
        assert_eq!(reqs[1].model, "m");
    }

    #[test]
    fn complete_spec_and_model_failures_yield_no_proposal() {
        let (db, team, _, doc_id) = setup();
        let src = repo();
        let m = models();
        let sink = RecordingSink::default();

        let llm = FakeLlm::with_texts(&[
            r#"["src/auth.ts"]"#,
            r#"{"missingSections": [], "proposedContent": null}"#,
        ]);
        let r = SpecScanner::new(&src, &llm, &m, &sink)
            .scan_document(db.conn(), &team, &doc_id)
            .unwrap();
        assert_eq!(r.relevant_files.len(), 1);
        assert!(r.proposal_id.is_none() && r.proposed_content.is_none());

        let llm = FakeLlm::with_texts(&["not json at all"]);
        let r = SpecScanner::new(&src, &llm, &m, &sink)
            .scan_document(db.conn(), &team, &doc_id)
            .unwrap();
        assert!(r.relevant_files.is_empty());

        let llm = FakeLlm::new();
        llm.push(Err(crate::ai::LlmError::Transport("down".into())));
        let r = SpecScanner::new(&src, &llm, &m, &sink)
            .scan_document(db.conn(), &team, &doc_id)
            .unwrap();
        assert!(r.relevant_files.is_empty());
        assert!(sink.created.lock().unwrap().is_empty());
    }

    #[test]
    fn errors_for_wrong_team_and_empty_team() {
        let (db, team, _, doc_id) = setup();
        let src = repo();
        let m = models();
        let llm = FakeLlm::new();
        let sink = RecordingSink::default();
        let sc = SpecScanner::new(&src, &llm, &m, &sink);
        assert!(matches!(
            sc.scan_document(db.conn(), "other-team", &doc_id),
            Err(Error::NotFound(_))
        ));
        let t2 = SqliteTeams::new(db.conn())
            .create(&crate::model::NewTeam {
                name: "Empty".into(),
                slug: "empty".into(),
            })
            .unwrap();
        let r = sc.scan_all(db.conn(), &t2.id);
        assert_eq!(r.error.as_deref(), Some("No documents found for this team"));
        let _ = team;
    }

    fn indexed(db: &crate::store::Db, team: &str, emb: &FakeEmbedder) {
        let m = MemorySource::new();
        m.put(
            "src/auth.ts",
            "// File: stub\nexport function login() { /* Auth spec Login flow */ }",
        );
        index_repo(
            db.conn(),
            &m,
            emb,
            &NoMeter,
            &IndexOptions::new(team, "o/r"),
            &mut ScanHooks::none(),
        )
        .unwrap();
    }

    #[test]
    fn search_ranks_and_applies_threshold() {
        let (db, team, _, _) = setup();
        let emb = FakeEmbedder::new(16);
        indexed(&db, &team, &emb);
        let chunk = SqliteChunks::new(db.conn())
            .code_chunks(&team, "o/r")
            .unwrap()[0]
            .content
            .clone();
        // querying the exact chunk text gives similarity ~1
        let hits = search_code(db.conn(), &emb, &team, &chunk, 8, 0.25).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].score > 0.99);
        assert_eq!(hits[0].file_path, "src/auth.ts");
        // an impossible threshold filters everything
        assert!(search_code(db.conn(), &emb, &team, &chunk, 8, 1.5)
            .unwrap()
            .is_empty());
        // other team sees nothing
        assert!(search_code(db.conn(), &emb, "nope", &chunk, 8, 0.0)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn relevant_code_is_cached_and_never_fails() {
        let (db, team, _, doc_id) = setup();
        let emb = FakeEmbedder::new(16);
        let cache = RelevantCodeCache::new();
        // nothing indexed: empty, not cached
        let r = fetch_relevant_code_for_document(db.conn(), &emb, &cache, &doc_id, &team, 0);
        assert!(r.chunks.is_empty());
        assert!(cache.is_empty());

        // index a chunk whose text equals the document query so similarity is 1
        let query = "Auth spec\n\nLogin flow";
        SqliteChunks::new(db.conn())
            .insert_code_chunk(&crate::model::NewCodeChunk {
                team_id: team.clone(),
                file_path: "src/auth.ts".into(),
                content: query.into(),
                embedding: Some(emb.vector_for(query)),
                embedding_model: Some("fake-embed".into()),
                repo_full_name: "o/r".into(),
                commit_sha: None,
                chunk_index: 0,
            })
            .unwrap();
        let r = fetch_relevant_code_for_document(db.conn(), &emb, &cache, &doc_id, &team, 1000);
        assert_eq!(r.sources, vec!["src/auth.ts"]);
        let sent = emb.texts_sent();
        let r2 = fetch_relevant_code_for_document(db.conn(), &emb, &cache, &doc_id, &team, 2000);
        assert_eq!(r, r2);
        assert_eq!(emb.texts_sent(), sent, "second call served from cache");
        assert_eq!(cache.metrics().hits, 1);
        // expiry
        let _ = fetch_relevant_code_for_document(
            db.conn(),
            &emb,
            &cache,
            &doc_id,
            &team,
            1000 + CACHE_TTL_MS + 1,
        );
        assert_eq!(emb.texts_sent(), sent + 1);
        cache.invalidate_team(&team);
        assert!(cache.is_empty());
        // unknown document and wrong team
        assert!(
            fetch_relevant_code_for_document(db.conn(), &emb, &cache, "nope", &team, 0)
                .chunks
                .is_empty()
        );
        assert!(
            fetch_relevant_code_for_document(db.conn(), &emb, &cache, &doc_id, "other", 0)
                .chunks
                .is_empty()
        );
    }

    #[test]
    fn cache_enforces_per_team_cap() {
        let c = RelevantCodeCache::new();
        for i in 0..(MAX_PER_TEAM + 5) {
            c.put(format!("k{i}"), "t1", RelevantCode::default(), 0);
        }
        assert_eq!(c.len(), MAX_PER_TEAM);
        assert_eq!(c.metrics().evictions, 5);
        c.put("other".into(), "t2", RelevantCode::default(), 0);
        assert_eq!(c.len(), MAX_PER_TEAM + 1);
        // k0..k4 were evicted (LRU), k5 survives and a get refreshes it
        assert!(c.get("k0", 1).is_none());
        assert!(c.get("k5", 1).is_some());
    }
}
