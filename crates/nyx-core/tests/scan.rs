#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::too_many_lines,
    clippy::assert_is_empty,
    clippy::cast_possible_wrap,
    clippy::cast_possible_truncation,
    clippy::manual_range_contains,
    clippy::unnecessary_literal_bound,
    missing_docs
)]
//! End-to-end scan tests over an in-memory repo fixture with a fake `GitProvider` and a fake
//! embedder: full scan, incremental scan, failure / retry, cancel, metering, offline local folder.

use std::collections::BTreeMap;
use std::sync::Mutex;

use nyx_core::git_provider::{
    BranchRef, FileDiff, GitCommit, GitError, GitFileContent, GitProvider, GitRepo, GitResult,
    GitTreeEntry, GitUser, GitWebhook, Headers, IssueStateFilter, NewPullRequest, NewRepo,
    OAuthToken, ProviderKind, PullRequest, RateLimit, TreeEntryKind, WebhookEvent,
};
use nyx_core::model::NewTeam;
use nyx_core::scan::embed::EmbedError;
use nyx_core::scan::indexer::{index_repo, IndexError, IndexOptions, ScanEvent, ScanHooks};
use nyx_core::scan::jobs::{
    self, enqueue, JobContext, JobError, JobHandler, JobRunner, JobStatus, NewJob, ScanJobHandler,
    REPO_SCAN_JOB,
};
use nyx_core::scan::source::{content_token, GitProviderSource};
use nyx_core::scan::{
    CountingMeter, FakeEmbedder, LocalFolderSource, MemorySource, NoMeter, RepoSource,
};
use nyx_core::store::{ChunkRepo, Db, SqliteChunks, SqliteTeams, TeamRepo};
use secrecy::SecretString;
use serde_json::{json, Value};

// ---------------------------------------------------------------- fixtures

fn db_with_team() -> (Db, String) {
    let db = Db::open_in_memory().unwrap();
    let t = SqliteTeams::new(db.conn())
        .create(&NewTeam {
            name: "Acme".into(),
            slug: "acme".into(),
        })
        .unwrap();
    (db, t.id)
}

const RUST_SRC: &str = "use std::fmt;\n\n/// A point.\npub struct Point {\n    pub x: i32,\n}\n\nimpl Point {\n    pub fn new(x: i32) -> Self {\n        Self { x }\n    }\n}\n\npub fn origin() -> Point {\n    Point::new(0)\n}\n";
const TS_SRC: &str = "import { a } from './a';\n\nexport function login(user: string) {\n  return a(user);\n}\n\nexport class Session {\n  id = 1;\n}\n";
const PY_SRC: &str =
    "import os\n\n\ndef main():\n    print(os.getcwd())\n\n\nclass App:\n    pass\n";

/// A small monorepo: code in three languages, docs, config, plus things that must be ignored.
fn fixture() -> MemorySource {
    let m = MemorySource::new();
    m.put(
        "README.md",
        "# Acme\n\nIntro text.\n\n## Usage\n\nRun it.\n",
    );
    m.put("src/lib.rs", RUST_SRC);
    m.put("web/login.ts", TS_SRC);
    m.put("tools/run.py", PY_SRC);
    m.put("config/app.toml", "name = \"acme\"\n");
    // ignored / rejected
    m.put("node_modules/dep/index.js", "module.exports = 1;");
    m.put("target/debug/out.rs", "fn generated() {}");
    m.put("assets/logo.png", [0x89, b'P', b'N', b'G']);
    m.put("package.json", "{}"); // not in the index allow-list
    m.put("src/blob.rs", vec![b'a', 0, b'b']); // NUL byte: binary content
    m.put("src/huge.rs", "x".repeat(60_000)); // over the 50 KB limit
    m.put("src/empty.rs", "  \n\n");
    m.set_head(Some("commit-1"));
    m
}

fn opts(team: &str) -> IndexOptions {
    IndexOptions::new(team, "acme/app")
}

fn stored(db: &Db, team: &str) -> BTreeMap<String, Vec<String>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for c in SqliteChunks::new(db.conn())
        .code_chunks(team, "acme/app")
        .unwrap()
    {
        out.entry(c.file_path).or_default().push(c.content);
    }
    out
}

// ---------------------------------------------------------------- fake git provider

#[derive(Debug, Default)]
struct FakeGit {
    files: Mutex<BTreeMap<String, String>>,
    head: Mutex<String>,
    tree_calls: Mutex<u32>,
    reads: Mutex<Vec<String>>,
    /// Hosts like Bitbucket report no blob sha in the tree listing.
    hide_shas: Mutex<bool>,
    tree_failures: Mutex<Vec<GitError>>,
}

impl FakeGit {
    fn put(&self, path: &str, content: &str) {
        self.files
            .lock()
            .unwrap()
            .insert(path.into(), content.into());
    }
    fn set_head(&self, h: &str) {
        *self.head.lock().unwrap() = h.into();
    }
    fn tree_calls(&self) -> u32 {
        *self.tree_calls.lock().unwrap()
    }
    fn reads(&self) -> Vec<String> {
        self.reads.lock().unwrap().clone()
    }
    fn hide_shas(&self) {
        *self.hide_shas.lock().unwrap() = true;
    }
}

fn unsupported<T>() -> GitResult<T> {
    Err(GitError::Invalid("not supported by FakeGit".into()))
}

impl GitProvider for FakeGit {
    fn kind(&self) -> ProviderKind {
        ProviderKind::GitHub
    }
    fn list_repos(&self) -> GitResult<Vec<GitRepo>> {
        unsupported()
    }
    fn create_repo(&self, _n: &NewRepo) -> GitResult<GitRepo> {
        unsupported()
    }
    fn get_file_tree(&self, _o: &str, _r: &str, _g: Option<&str>) -> GitResult<Vec<GitTreeEntry>> {
        *self.tree_calls.lock().unwrap() += 1;
        if let Some(e) = {
            let mut f = self.tree_failures.lock().unwrap();
            (!f.is_empty()).then(|| f.remove(0))
        } {
            return Err(e);
        }
        let mut out = vec![GitTreeEntry {
            path: "src".into(),
            kind: TreeEntryKind::Tree,
            size: None,
            sha: None,
        }];
        let hide = *self.hide_shas.lock().unwrap();
        out.extend(
            self.files
                .lock()
                .unwrap()
                .iter()
                .map(|(p, c)| GitTreeEntry {
                    path: p.clone(),
                    kind: TreeEntryKind::Blob,
                    size: Some(c.len() as u64),
                    // stands in for git's sha1 blob id: any stable function of the content
                    sha: (!hide).then(|| format!("blob{}", &content_token(c.as_bytes())[7..23])),
                }),
        );
        Ok(out)
    }
    fn get_file_content(
        &self,
        _o: &str,
        _r: &str,
        path: &str,
        _g: Option<&str>,
    ) -> GitResult<GitFileContent> {
        use base64::Engine as _;
        self.reads.lock().unwrap().push(path.to_string());
        let files = self.files.lock().unwrap();
        let c = files
            .get(path)
            .ok_or_else(|| GitError::NotFound(format!("{path} not found")))?;
        Ok(GitFileContent {
            name: path.rsplit('/').next().unwrap().into(),
            path: path.into(),
            size: c.len() as u64,
            content: base64::engine::general_purpose::STANDARD.encode(c),
            encoding: "base64".into(),
            html_url: String::new(),
        })
    }
    fn list_commits(
        &self,
        _o: &str,
        _r: &str,
        _g: Option<&str>,
        _l: usize,
    ) -> GitResult<Vec<GitCommit>> {
        Ok(vec![GitCommit {
            sha: self.head.lock().unwrap().clone(),
            message: "m".into(),
            author_name: "a".into(),
            author_email: None,
            timestamp: String::new(),
            html_url: None,
        }])
    }
    fn get_commit_diff(&self, _o: &str, _r: &str, _s: &str) -> GitResult<Vec<FileDiff>> {
        unsupported()
    }
    fn create_branch(&self, _o: &str, _r: &str, _n: &str, _f: &str) -> GitResult<BranchRef> {
        unsupported()
    }
    fn create_pull_request(
        &self,
        _o: &str,
        _r: &str,
        _p: &NewPullRequest,
    ) -> GitResult<PullRequest> {
        unsupported()
    }
    fn create_issue(
        &self,
        _o: &str,
        _r: &str,
        _t: &str,
        _b: &str,
        _l: &[String],
    ) -> GitResult<nyx_core::git_provider::GitIssue> {
        unsupported()
    }
    fn list_issues(
        &self,
        _o: &str,
        _r: &str,
        _s: IssueStateFilter,
    ) -> GitResult<Vec<nyx_core::git_provider::GitIssue>> {
        unsupported()
    }
    fn create_webhook(&self, _o: &str, _r: &str, _u: &str, _s: &str) -> GitResult<GitWebhook> {
        unsupported()
    }
    fn delete_webhook(&self, _o: &str, _r: &str, _h: &str) -> GitResult<()> {
        unsupported()
    }
    fn exchange_code_for_token(
        &self,
        _c: &str,
        _s: &SecretString,
        _code: &str,
        _r: Option<&str>,
    ) -> GitResult<OAuthToken> {
        unsupported()
    }
    fn get_authenticated_user(&self) -> GitResult<GitUser> {
        unsupported()
    }
    fn verify_webhook(&self, _h: &Headers, _b: &[u8], _s: &str) -> bool {
        false
    }
    fn parse_webhook(&self, _h: &Headers, _b: &[u8]) -> GitResult<WebhookEvent> {
        unsupported()
    }
    fn last_rate_limit(&self) -> Option<RateLimit> {
        None
    }
}

// ---------------------------------------------------------------- full scan

#[test]
fn full_scan_filters_chunks_embeds_and_stores() {
    let (db, team) = db_with_team();
    let src = fixture();
    let emb = FakeEmbedder::new(8);
    let mut events: Vec<ScanEvent> = Vec::new();
    let mut on_event = |e: &ScanEvent| events.push(e.clone());
    let report = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks {
            on_event: Some(&mut on_event),
            is_cancelled: None,
        },
    )
    .unwrap();

    // 5 indexable files; blob.rs / huge.rs / empty.rs are rejected after reading or by size.
    assert_eq!(report.files_indexed, 5, "{report:?}");
    assert_eq!(report.files_removed, 0);
    assert!(report.failed.is_empty());
    assert!(!report.up_to_date);
    assert_eq!(report.head_token.as_deref(), Some("commit-1"));
    // listing-level skips: node_modules, target, png, package.json, huge.rs (size)
    assert_eq!(report.files_skipped, 5 + 2);
    assert_eq!(report.embed.embedded, report.chunks_created);

    let s = stored(&db, &team);
    assert_eq!(
        s.keys().map(String::as_str).collect::<Vec<_>>(),
        vec![
            "README.md",
            "config/app.toml",
            "src/lib.rs",
            "tools/run.py",
            "web/login.ts"
        ]
    );
    assert!(s["src/lib.rs"][0].starts_with("// File: src/lib.rs\n"));
    for c in SqliteChunks::new(db.conn())
        .code_chunks(&team, "acme/app")
        .unwrap()
    {
        assert_eq!(c.embedding.as_ref().unwrap().len(), 8);
        assert_eq!(c.embedding_model.as_deref(), Some("fake-embed"));
        assert_eq!(c.commit_sha.as_deref(), Some("commit-1"));
    }
    // the stored vector is the embedder's vector for the stored text
    let c0 = &SqliteChunks::new(db.conn())
        .code_chunks(&team, "acme/app")
        .unwrap()[0];
    assert_eq!(c0.embedding.as_ref().unwrap(), &emb.vector_for(&c0.content));

    // events: Planned first, one FileIndexed per file with monotone `done`, Finished last
    assert!(matches!(
        events.first(),
        Some(ScanEvent::Planned { added: 7, .. })
    ));
    assert!(matches!(events.last(), Some(ScanEvent::Finished { .. })));
    let dones: Vec<usize> = events
        .iter()
        .filter_map(|e| match e {
            ScanEvent::FileIndexed { done, total, .. } => {
                assert_eq!(*total, 7);
                Some(*done)
            }
            _ => None,
        })
        .collect();
    assert_eq!(dones.len(), 5);
    assert!(dones.windows(2).all(|w| w[0] < w[1]));
    assert!(events
        .iter()
        .any(|e| matches!(e, ScanEvent::FileSkipped { path, .. } if path == "src/blob.rs")));
}

#[test]
fn forced_reindex_is_served_from_the_embedding_cache() {
    let (db, team) = db_with_team();
    let src = MemorySource::new();
    // A forced re-index of unchanged content must be served entirely from the embedding cache.
    src.put("a/one.rs", RUST_SRC);
    let emb = FakeEmbedder::default();
    index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    let before = emb.texts_sent();
    src.remove("a/one.rs");
    src.put("a/one.rs", RUST_SRC); // same path + content
    let mut o = opts(&team);
    o.force = true;
    let r = index_repo(db.conn(), &src, &emb, &NoMeter, &o, &mut ScanHooks::none()).unwrap();
    assert_eq!(r.files_indexed, 1, "force re-indexes");
    assert_eq!(emb.texts_sent(), before, "but vectors come from the cache");
    assert_eq!(r.embed.cache_hits, r.chunks_created);
}

// ---------------------------------------------------------------- incremental

#[test]
fn incremental_scan_touches_only_changes() {
    let (db, team) = db_with_team();
    let src = fixture();
    let emb = FakeEmbedder::default();
    index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    let first_texts = emb.texts_sent();
    let before = stored(&db, &team);

    // change one file, add one, delete one, add an ignored one
    src.put(
        "tools/run.py",
        format!("{PY_SRC}\ndef extra():\n    pass\n"),
    );
    src.put("tools/new.py", "def fresh():\n    pass\n");
    src.remove("web/login.ts");
    src.put("dist/bundle.js", "var x;");
    src.set_head(Some("commit-2"));
    src.clear_reads();

    let r = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert_eq!((r.files_indexed, r.files_removed), (2, 1), "{r:?}");
    assert!(r.files_unchanged >= 3);

    // only the changed + added files were fetched (token comparison needs no read)
    let mut reads = src.reads();
    reads.sort();
    assert_eq!(reads, vec!["tools/new.py", "tools/run.py"]);
    // only their chunks were embedded
    let delta = emb.texts_sent() - first_texts;
    assert_eq!(delta, r.embed.embedded);
    assert!(delta >= 2 && delta < first_texts);

    let after = stored(&db, &team);
    assert!(
        !after.contains_key("web/login.ts"),
        "removed file's chunks deleted"
    );
    assert!(after.contains_key("tools/new.py"));
    assert_eq!(
        after["src/lib.rs"], before["src/lib.rs"],
        "untouched file kept"
    );
    assert_ne!(after["tools/run.py"], before["tools/run.py"]);
    assert!(after["tools/run.py"]
        .iter()
        .any(|c| c.contains("def extra")));
    // no duplicates: chunk indexes of a replaced file are 0..n
    let chunks = SqliteChunks::new(db.conn())
        .code_chunks(&team, "acme/app")
        .unwrap();
    let run: Vec<i64> = chunks
        .iter()
        .filter(|c| c.file_path == "tools/run.py")
        .map(|c| c.chunk_index)
        .collect();
    assert_eq!(run, (0..run.len() as i64).collect::<Vec<_>>());
}

#[test]
fn unchanged_head_skips_listing_and_a_noop_rescan_embeds_nothing() {
    let (db, team) = db_with_team();
    let src = fixture();
    let emb = FakeEmbedder::default();
    index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    let sent = emb.texts_sent();
    src.clear_reads();

    let r = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert!(r.up_to_date);
    assert!(src.reads().is_empty());

    // head moves but no file changed: listing happens, nothing is read or embedded
    src.set_head(Some("commit-2"));
    let r = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert!(!r.up_to_date);
    assert_eq!(
        (r.files_indexed, r.files_removed, r.chunks_created),
        (0, 0, 0)
    );
    assert!(src.reads().is_empty());
    assert_eq!(emb.texts_sent(), sent);
}

#[test]
fn removing_a_file_that_became_ignored_deletes_its_chunks() {
    let (db, team) = db_with_team();
    let src = fixture();
    let emb = FakeEmbedder::default();
    index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    // a previously indexed file turns binary
    src.put("tools/run.py", vec![0u8, 1, 2]);
    src.set_head(Some("commit-2"));
    let r = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert_eq!(r.files_removed, 1);
    assert!(!stored(&db, &team).contains_key("tools/run.py"));
}

#[test]
fn git_provider_source_scans_and_rescans_by_head() {
    let (db, team) = db_with_team();
    let git = FakeGit::default();
    git.set_head("c1");
    git.put("src/lib.rs", RUST_SRC);
    git.put("web/login.ts", TS_SRC);
    git.put("assets/x.png", "png");
    let src = GitProviderSource::new(&git, "acme", "app", None);
    let emb = FakeEmbedder::default();

    let r = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert_eq!(r.files_indexed, 2);
    assert_eq!(git.tree_calls(), 1);

    // same head: no tree call at all
    let r = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert!(r.up_to_date);
    assert_eq!(git.tree_calls(), 1);

    // new commit changes one file; blob shas in the tree let the scan skip the unchanged file
    // without fetching it
    git.put("src/lib.rs", &format!("{RUST_SRC}\npub fn two() {{}}\n"));
    git.set_head("c2");
    let sent = emb.texts_sent();
    let r = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert_eq!(r.files_indexed, 1);
    assert_eq!(r.files_unchanged, 1);
    let reads = git.reads();
    assert_eq!(
        reads.iter().filter(|p| *p == "web/login.ts").count(),
        1,
        "unchanged file fetched only by the first scan: {reads:?}"
    );
    assert_eq!(reads.iter().filter(|p| *p == "src/lib.rs").count(), 2);
    let delta = emb.texts_sent() - sent;
    assert!(
        delta >= 1 && delta <= 2,
        "only the edited file's chunks, got {delta}"
    );
    assert!(stored(&db, &team)["src/lib.rs"]
        .iter()
        .any(|c| c.contains("pub fn two")));
}

#[test]
fn git_rescan_without_blob_shas_falls_back_to_content_hash() {
    let (db, team) = db_with_team();
    let git = FakeGit::default();
    git.hide_shas();
    git.set_head("c1");
    git.put("src/lib.rs", RUST_SRC);
    git.put("web/login.ts", TS_SRC);
    let src = GitProviderSource::new(&git, "acme", "app", None);
    let emb = FakeEmbedder::default();
    let run = |db: &Db| {
        index_repo(
            db.conn(),
            &src,
            &emb,
            &NoMeter,
            &opts(&team),
            &mut ScanHooks::none(),
        )
        .unwrap()
    };
    assert_eq!(run(&db).files_indexed, 2);
    git.set_head("c2");
    let sent = emb.texts_sent();
    let r = run(&db);
    assert_eq!((r.files_indexed, r.files_unchanged), (0, 2));
    assert_eq!(emb.texts_sent(), sent, "nothing re-embedded");
    assert_eq!(git.reads().len(), 4, "but every file was fetched again");
}

#[test]
fn git_blob_shas_are_what_the_manifest_remembers() {
    let (db, team) = db_with_team();
    let git = FakeGit::default();
    git.set_head("c1");
    git.put("src/lib.rs", RUST_SRC);
    let src = GitProviderSource::new(&git, "acme", "app", None);
    let listed = src.list().unwrap();
    assert!(listed[0]
        .sha
        .as_deref()
        .unwrap()
        .starts_with("git-blob:blob"));
    let emb = FakeEmbedder::default();
    index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    // a file whose content moves back to a known state keeps its sha: no fetch on re-list
    git.set_head("c2");
    let before = git.reads().len();
    index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert_eq!(git.reads().len(), before);
}

// ---------------------------------------------------------------- failure / retry

fn scan_job(db: &Db, team: &str, max_attempts: u32) -> jobs::Job {
    enqueue(
        db.conn(),
        &NewJob::new(REPO_SCAN_JOB, json!({"repo_full_name": "acme/app"}))
            .team(team)
            .max_attempts(max_attempts),
    )
    .unwrap()
}

#[test]
fn transient_embedder_failure_is_retried_and_resumes_without_rework() {
    let (db, team) = db_with_team();
    let src = MemorySource::new();
    // enough files that the first embedding batch finishes before the failing one
    for i in 0..6 {
        src.put(
            &format!("m/f{i}.rs"),
            format!("pub fn f{i}() {{ let x = {i}; }}\n"),
        );
    }
    // The job handler uses the default batch size, so shrink the embedder's own batch limit.
    let emb = FakeEmbedder::default().with_max_batch(2);
    emb.fail_when_containing("f4", EmbedError::Transient("rate limited".into()));
    let handler = ScanJobHandler::new(&src, &emb, &NoMeter);
    let mut runner = JobRunner::new();
    runner.register(handler);
    let job = scan_job(&db, &team, 3);

    let after_first = runner.run_next(db.conn()).unwrap().unwrap();
    assert_eq!(after_first.status, JobStatus::Pending, "requeued for retry");
    assert_eq!(after_first.attempts, 1);
    assert!(after_first
        .error
        .as_deref()
        .unwrap()
        .contains("rate limited"));
    // work finished before the failure was kept
    let kept = stored(&db, &team).len();
    assert!(kept >= 1 && kept < 6, "kept {kept}");
    let sent_after_failure = emb.texts_sent();

    // the provider recovers
    emb.clear_failures();
    let done = runner.run_next(db.conn()).unwrap().unwrap();
    assert_eq!(done.id, job.id);
    assert_eq!(done.status, JobStatus::Completed, "{done:?}");
    assert_eq!(done.attempts, 2);
    assert_eq!(done.progress, 100);
    let report: Value = done.result.unwrap();
    assert_eq!(report["files_indexed"].as_u64().unwrap() as usize, 6 - kept);
    assert_eq!(stored(&db, &team).len(), 6);
    // the retry embedded only what was missing
    assert!(emb.texts_sent() - sent_after_failure <= 6 - kept + 2);
    assert!(runner.run_next(db.conn()).unwrap().is_none());
}

#[test]
fn retries_stop_at_max_attempts_then_manual_retry_works() {
    let (db, team) = db_with_team();
    let src = fixture();
    let emb = FakeEmbedder::default();
    emb.fail_when_containing("File:", EmbedError::Transient("503".into()));
    let mut runner = JobRunner::new();
    runner.register(ScanJobHandler::new(&src, &emb, &NoMeter));
    let job = scan_job(&db, &team, 2);

    let runs = runner.run_all(db.conn(), 10).unwrap();
    assert_eq!(runs.len(), 2, "two attempts then stop");
    let j = jobs::get(db.conn(), &job.id).unwrap();
    assert_eq!(j.status, JobStatus::Failed);
    assert_eq!(j.attempts, 2);
    assert!(j.error.unwrap().contains("gave up after 2 attempts"));
    assert!(stored(&db, &team).is_empty());

    // fix the cause, retry by hand
    emb.clear_failures();
    let j = jobs::retry(db.conn(), &job.id).unwrap();
    assert_eq!(
        (j.status, j.attempts, j.progress),
        (JobStatus::Pending, 0, 0)
    );
    let done = runner.run_next(db.conn()).unwrap().unwrap();
    assert_eq!(done.status, JobStatus::Completed);
    assert_eq!(stored(&db, &team).len(), 5);
    // completed jobs cannot be retried
    assert!(jobs::retry(db.conn(), &job.id).is_err());
}

#[test]
fn permanent_failures_are_not_retried() {
    let (db, team) = db_with_team();
    let src = fixture();
    let emb = FakeEmbedder::default();
    emb.fail_next(EmbedError::Permanent("invalid api key".into()));
    let mut runner = JobRunner::new();
    runner.register(ScanJobHandler::new(&src, &emb, &NoMeter));
    let job = scan_job(&db, &team, 5);
    let j = runner.run_next(db.conn()).unwrap().unwrap();
    assert_eq!(
        (j.id.as_str(), j.status, j.attempts),
        (job.id.as_str(), JobStatus::Failed, 1)
    );
    assert!(j.error.unwrap().contains("invalid api key"));
}

#[test]
fn provider_rate_limit_on_listing_is_retryable() {
    let (db, team) = db_with_team();
    let git = FakeGit::default();
    git.set_head("c1");
    git.put("src/lib.rs", RUST_SRC);
    git.tree_failures
        .lock()
        .unwrap()
        .push(GitError::RateLimited {
            provider: "GitHub",
            retry_after_secs: Some(30),
        });
    let src = GitProviderSource::new(&git, "acme", "app", None);
    let emb = FakeEmbedder::default();
    let mut runner = JobRunner::new();
    runner.register(ScanJobHandler::new(&src, &emb, &NoMeter));
    let job = scan_job(&db, &team, 3);
    let first = runner.run_next(db.conn()).unwrap().unwrap();
    assert_eq!(first.status, JobStatus::Pending);
    let second = runner.run_next(db.conn()).unwrap().unwrap();
    assert_eq!(
        (second.id.as_str(), second.status),
        (job.id.as_str(), JobStatus::Completed)
    );
}

#[test]
fn per_file_read_failure_is_recorded_and_fixed_by_the_next_scan() {
    let (db, team) = db_with_team();
    let src = fixture();
    src.fail_reads("src/lib.rs", 1);
    let emb = FakeEmbedder::default();
    let r = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert_eq!(r.files_indexed, 4);
    assert_eq!(r.failed.len(), 1);
    assert_eq!(r.failed[0].0, "src/lib.rs");

    // the head is not recorded as complete, so the same head is scanned again and picks it up
    let r = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert!(!r.up_to_date);
    assert_eq!(r.files_indexed, 1);
    assert!(r.failed.is_empty());
    assert!(stored(&db, &team).contains_key("src/lib.rs"));
    // now it is complete
    let r = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert!(r.up_to_date);
}

// ---------------------------------------------------------------- metering

#[test]
fn metering_stops_the_scan_and_keeps_paid_work() {
    let (db, team) = db_with_team();
    let src = fixture();
    let emb = FakeEmbedder::default().with_max_batch(2);
    let meter = CountingMeter::with_budget(4);
    let mut o = opts(&team);
    o.batch_size = 2;
    let err = index_repo(db.conn(), &src, &emb, &meter, &o, &mut ScanHooks::none()).unwrap_err();
    assert!(matches!(err, IndexError::Meter(_)), "{err:?}");
    assert!(!err.is_retryable());
    assert_eq!(meter.total(), 4);
    assert_eq!(
        emb.texts_sent(),
        4,
        "the refused batch never reached the embedder"
    );

    // via a job: fatal, no retries
    let meter = CountingMeter::with_budget(0);
    let mut runner = JobRunner::new();
    runner.register(ScanJobHandler::new(&src, &emb, &meter));
    scan_job(&db, &team, 5);
    let j = runner.run_next(db.conn()).unwrap().unwrap();
    assert_eq!((j.status, j.attempts), (JobStatus::Failed, 1));
    assert!(j.error.unwrap().contains("insufficient credits"));
}

// ---------------------------------------------------------------- cancel

#[test]
fn cancel_pending_running_and_finished_jobs() {
    let (db, team) = db_with_team();
    let src = fixture();
    let emb = FakeEmbedder::default();

    // pending: cancelled immediately, never runs
    let j = scan_job(&db, &team, 3);
    let c = jobs::request_cancel(db.conn(), &j.id).unwrap();
    assert_eq!(c.status, JobStatus::Cancelled);
    let mut runner = JobRunner::new();
    runner.register(ScanJobHandler::new(&src, &emb, &NoMeter));
    assert!(runner.run_next(db.conn()).unwrap().is_none());
    assert_eq!(emb.texts_sent(), 0);

    // running: flag is set, the scan stops at its next poll
    let j2 = scan_job(&db, &team, 3);
    let claimed = jobs::claim_next(db.conn(), None).unwrap().unwrap();
    assert_eq!(claimed.id, j2.id);
    let r = jobs::request_cancel(db.conn(), &j2.id).unwrap();
    assert_eq!(r.status, JobStatus::Running);
    assert!(r.cancel_requested);
    let handler = ScanJobHandler::new(&src, &emb, &NoMeter);
    let out = handler.run(&JobContext {
        conn: db.conn(),
        job: &claimed,
    });
    assert_eq!(out, Err(JobError::Cancelled));
    assert!(stored(&db, &team).is_empty());

    // finished jobs refuse
    let j3 = scan_job(&db, &team, 3);
    jobs::claim_next(db.conn(), None).unwrap();
    jobs::complete(db.conn(), &j3.id, &json!({})).unwrap();
    assert!(jobs::request_cancel(db.conn(), &j3.id).is_err());
    // cancelled jobs can be retried
    let again = jobs::retry(db.conn(), &j.id).unwrap();
    assert_eq!(again.status, JobStatus::Pending);
}

#[test]
fn hook_cancellation_stops_between_files_and_keeps_finished_ones() {
    let (db, team) = db_with_team();
    let src = fixture();
    let emb = FakeEmbedder::default();
    let indexed = std::cell::Cell::new(0usize);
    let mut on_event = |e: &ScanEvent| {
        if matches!(e, ScanEvent::FileIndexed { .. }) {
            indexed.set(indexed.get() + 1);
        }
    };
    let stop = || indexed.get() >= 2;
    let mut o = opts(&team);
    o.batch_size = 1; // flush after every file
    let err = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &o,
        &mut ScanHooks {
            on_event: Some(&mut on_event),
            is_cancelled: Some(&stop),
        },
    )
    .unwrap_err();
    assert!(matches!(err, IndexError::Cancelled));
    assert_eq!(stored(&db, &team).len(), 2);
    // a later scan completes the rest
    let r = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert_eq!(r.files_indexed, 3);
}

// ---------------------------------------------------------------- job basics

#[test]
fn job_progress_listing_and_unknown_handler() {
    let (db, team) = db_with_team();
    let src = fixture();
    let emb = FakeEmbedder::default();
    let mut runner = JobRunner::new();
    runner.register(ScanJobHandler::new(&src, &emb, &NoMeter));
    let a = scan_job(&db, &team, 3);
    let b = scan_job(&db, &team, 3);
    // a job nobody handles stays queued (only registered types are claimed)
    let other = enqueue(db.conn(), &NewJob::new("mystery", json!({})).team(&team)).unwrap();
    runner.run_all(db.conn(), 10).unwrap();
    assert_eq!(
        jobs::get(db.conn(), &a.id).unwrap().status,
        JobStatus::Completed
    );
    assert_eq!(
        jobs::get(db.conn(), &b.id).unwrap().status,
        JobStatus::Completed
    );
    assert_eq!(
        jobs::get(db.conn(), &other.id).unwrap().status,
        JobStatus::Pending
    );
    let listed = jobs::list_by_team(db.conn(), &team, 50).unwrap();
    assert_eq!(listed.len(), 3);
    assert_eq!(listed[0].id, other.id, "newest first");
    assert!(jobs::get(db.conn(), "missing").is_err());

    // missing input / team are fatal, not retried
    let bad = enqueue(
        db.conn(),
        &NewJob::new(REPO_SCAN_JOB, json!({})).team(&team),
    )
    .unwrap();
    runner.run_next(db.conn()).unwrap();
    let bad = jobs::get(db.conn(), &bad.id).unwrap();
    assert_eq!(bad.status, JobStatus::Failed);
    assert!(bad.error.unwrap().contains("repo_full_name"));
}

struct Ticker;
impl JobHandler for Ticker {
    fn job_type(&self) -> &str {
        "ticker"
    }
    fn run(&self, ctx: &JobContext<'_>) -> Result<Value, JobError> {
        ctx.progress(40, "halfway");
        let seen = jobs::get(ctx.conn, &ctx.job.id).unwrap();
        assert_eq!(
            (seen.progress, seen.progress_message.as_deref()),
            (40, Some("halfway"))
        );
        assert_eq!(seen.status, JobStatus::Running);
        if ctx.is_cancelled() {
            return Err(JobError::Cancelled);
        }
        Ok(json!({"ok": true}))
    }
}

#[test]
fn custom_handlers_report_progress() {
    let (db, _) = db_with_team();
    let mut runner = JobRunner::new();
    runner.register(Ticker);
    let j = enqueue(db.conn(), &NewJob::new("ticker", json!({}))).unwrap();
    let done = runner.run_next(db.conn()).unwrap().unwrap();
    assert_eq!(done.id, j.id);
    assert_eq!((done.status, done.progress), (JobStatus::Completed, 100));
    assert_eq!(done.result.unwrap(), json!({"ok": true}));
    assert!(done.started_at.is_some() && done.completed_at.is_some());
}

// ---------------------------------------------------------------- offline local folder

#[test]
fn local_folder_scan_works_offline_and_is_incremental() {
    let (db, team) = db_with_team();
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join("src")).unwrap();
    std::fs::create_dir_all(d.path().join("node_modules/x")).unwrap();
    std::fs::write(d.path().join("src/main.rs"), RUST_SRC).unwrap();
    std::fs::write(d.path().join("src/util.py"), PY_SRC).unwrap();
    std::fs::write(d.path().join("node_modules/x/i.js"), "x").unwrap();
    let src = LocalFolderSource::new(d.path()).unwrap();
    let emb = FakeEmbedder::default();

    let r = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert_eq!(r.files_indexed, 2);
    assert_eq!(r.head_token, None);
    let sent = emb.texts_sent();

    // nothing changed: the folder has no head token, so it re-reads but embeds nothing
    let r = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert_eq!((r.files_indexed, r.files_unchanged), (0, 2));
    assert_eq!(emb.texts_sent(), sent);

    std::fs::write(
        d.path().join("src/util.py"),
        format!("{PY_SRC}\ndef more():\n    pass\n"),
    )
    .unwrap();
    std::fs::remove_file(d.path().join("src/main.rs")).unwrap();
    let r = index_repo(
        db.conn(),
        &src,
        &emb,
        &NoMeter,
        &opts(&team),
        &mut ScanHooks::none(),
    )
    .unwrap();
    assert_eq!((r.files_indexed, r.files_removed), (1, 1));
    assert_eq!(
        stored(&db, &team).keys().collect::<Vec<_>>(),
        vec!["src/util.py"]
    );
    assert_eq!(
        content_token(b"x").len(),
        "sha256:".len() + 64,
        "tokens are prefixed sha-256"
    );
    let _ = src.head_token();
}
