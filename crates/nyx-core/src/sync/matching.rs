//! Changed paths to affected specs. The TS webhook ran drift detection against *every* team
//! document; this narrows the candidates first (cheaper, fewer false verdicts) using three
//! signals, strongest wins per spec:
//!
//! | Signal | Score |
//! |---|---|
//! | explicit `impact_edges` link between the file and the spec | 1.0 |
//! | the spec mentions the full repo path | 1.0 |
//! | the spec mentions the file name (`login.rs`) as a whole word | 0.8 |
//! | the spec mentions the file stem (`login`, >= 4 chars, not generic) as a whole word | 0.4 |
//! | cosine between the file's stored code-chunk vectors and the spec's chunk vectors | the cosine, when `>= semantic_threshold` |
//!
//! Set [`MatchConfig::fallback_all_docs`] to restore the TS behaviour (every live spec) when
//! nothing matched.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::impact::ImpactGraph;
use crate::error::Result;
use crate::model::{decode_embedding, Document};
use crate::store::{ChunkRepo, SqliteChunks};

/// Why a spec was selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchReason {
    /// Explicit impact edge.
    Linked,
    /// Full path appears in the spec.
    PathMention,
    /// File name appears in the spec.
    NameMention,
    /// File stem appears in the spec.
    StemMention,
    /// Embedding similarity.
    Semantic,
    /// Nothing matched and the fallback selected every spec.
    Fallback,
}

/// A spec selected for a change set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpecMatch {
    /// Document id.
    pub document_id: String,
    /// Best score over all paths, in `(0, 1]`.
    pub score: f32,
    /// Changed paths that selected this spec (score >= `min_score`), sorted.
    pub paths: Vec<String>,
    /// Distinct reasons, sorted.
    pub reasons: Vec<MatchReason>,
}

/// Matching knobs.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MatchConfig {
    /// Minimum per-path score to select a spec.
    pub min_score: f32,
    /// Use stored code/doc chunk vectors when present.
    pub use_semantic: bool,
    /// Minimum cosine for a semantic match.
    pub semantic_threshold: f32,
    /// Cap on selected specs (best first).
    pub max_specs: usize,
    /// When nothing matched, select every spec with all changed paths (TS behaviour).
    pub fallback_all_docs: bool,
}

impl Default for MatchConfig {
    fn default() -> Self {
        Self {
            min_score: 0.4,
            use_semantic: true,
            semantic_threshold: 0.6,
            max_specs: 25,
            fallback_all_docs: false,
        }
    }
}

const GENERIC_STEMS: &[&str] = &[
    "index", "main", "mod", "lib", "test", "tests", "spec", "readme", "config", "utils", "util",
    "types", "init", "app", "package", "cargo", "license", "setup",
];

/// Normalise a repo path: forward slashes, no leading `./` or `/`.
#[must_use]
pub fn normalize_path(p: &str) -> String {
    let s = p.trim().replace('\\', "/");
    s.trim_start_matches("./")
        .trim_start_matches('/')
        .to_owned()
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Whole-word (ASCII-case-insensitive) containment. `needle` must be non-empty.
fn contains_word(hay_lower: &str, needle_lower: &str) -> bool {
    let mut from = 0;
    while let Some(i) = hay_lower[from..].find(needle_lower) {
        let start = from + i;
        let end = start + needle_lower.len();
        let before_ok = hay_lower[..start]
            .chars()
            .next_back()
            .map_or(true, |c| !is_word_char(c));
        let after_ok = hay_lower[end..]
            .chars()
            .next()
            .map_or(true, |c| !is_word_char(c));
        if before_ok && after_ok {
            return true;
        }
        from = start + needle_lower.chars().next().map_or(1, char::len_utf8);
        if from >= hay_lower.len() {
            break;
        }
    }
    false
}

/// Mention score of `path` inside a spec body (`0.0` when absent).
#[must_use]
pub fn mention_score(content_lower: &str, path: &str) -> (f32, Option<MatchReason>) {
    let path_lower = normalize_path(path).to_lowercase();
    if path_lower.is_empty() {
        return (0.0, None);
    }
    if content_lower.contains(&path_lower) {
        return (1.0, Some(MatchReason::PathMention));
    }
    let name = path_lower.rsplit('/').next().unwrap_or(&path_lower);
    if name.contains('.') && name.len() >= 3 && contains_word(content_lower, name) {
        return (0.8, Some(MatchReason::NameMention));
    }
    let stem = name.split('.').next().unwrap_or(name);
    if stem.chars().count() >= 4
        && !GENERIC_STEMS.contains(&stem)
        && contains_word(content_lower, stem)
    {
        return (0.4, Some(MatchReason::StemMention));
    }
    (0.0, None)
}

/// Semantic candidates: for each changed file with stored code vectors, the best-matching
/// documents of the team. Returns `doc_id -> (path -> best cosine)`.
fn semantic_candidates(
    conn: &Connection,
    team_id: &str,
    paths: &[String],
    threshold: f32,
) -> Result<BTreeMap<String, BTreeMap<String, f32>>> {
    let mut out: BTreeMap<String, BTreeMap<String, f32>> = BTreeMap::new();
    let chunks = SqliteChunks::new(conn);
    let mut stmt = conn.prepare_cached(
        "SELECT embedding FROM code_chunks WHERE team_id = ?1 AND file_path = ?2 AND embedding IS NOT NULL",
    )?;
    for p in paths {
        let blobs: Vec<Vec<u8>> = stmt
            .query_map(params![team_id, p], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        for b in blobs {
            let Ok(v) = decode_embedding(&b) else {
                continue;
            };
            for (c, sim) in chunks.search_doc_chunks(team_id, &v, 3)? {
                if sim >= threshold {
                    let slot = out
                        .entry(c.doc_id)
                        .or_default()
                        .entry(p.clone())
                        .or_insert(0.0);
                    if sim > *slot {
                        *slot = sim;
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Select the specs affected by `changed` (normalised, de-duplicated by the caller or here).
///
/// # Errors
/// Database failure while reading chunk vectors.
pub fn match_specs(
    conn: &Connection,
    team_id: &str,
    changed: &[String],
    docs: &[Document],
    graph: &ImpactGraph,
    cfg: &MatchConfig,
) -> Result<Vec<SpecMatch>> {
    let paths: Vec<String> = changed
        .iter()
        .map(|p| normalize_path(p))
        .filter(|p| !p.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if paths.is_empty() || docs.is_empty() {
        return Ok(Vec::new());
    }
    let linked = graph.specs_for_files(&paths);
    let semantic = if cfg.use_semantic {
        semantic_candidates(conn, team_id, &paths, cfg.semantic_threshold)?
    } else {
        BTreeMap::new()
    };

    let mut out = Vec::new();
    for d in docs {
        let lower = d.content.to_lowercase() + "\n" + &d.title.to_lowercase();
        let mut best = 0.0_f32;
        let mut hit_paths: BTreeSet<String> = BTreeSet::new();
        let mut reasons: BTreeSet<MatchReason> = BTreeSet::new();
        for p in &paths {
            let mut s = 0.0_f32;
            let mut r: Vec<MatchReason> = Vec::new();
            if linked.get(&d.id).is_some_and(|ps| ps.contains(p)) {
                s = 1.0;
                r.push(MatchReason::Linked);
            }
            let (m, why) = mention_score(&lower, p);
            if m > 0.0 {
                s = s.max(m);
                r.extend(why);
            }
            if let Some(&c) = semantic.get(&d.id).and_then(|m| m.get(p)) {
                s = s.max(c);
                r.push(MatchReason::Semantic);
            }
            if s >= cfg.min_score {
                best = best.max(s);
                hit_paths.insert(p.clone());
                reasons.extend(r);
            }
        }
        if !hit_paths.is_empty() {
            out.push(SpecMatch {
                document_id: d.id.clone(),
                score: best,
                paths: hit_paths.into_iter().collect(),
                reasons: reasons.into_iter().collect(),
            });
        }
    }
    if out.is_empty() && cfg.fallback_all_docs {
        out = docs
            .iter()
            .map(|d| SpecMatch {
                document_id: d.id.clone(),
                score: cfg.min_score,
                paths: paths.clone(),
                reasons: vec![MatchReason::Fallback],
            })
            .collect();
    }
    out.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.document_id.cmp(&b.document_id))
    });
    out.truncate(cfg.max_specs);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Db;
    use crate::sync::impact::{Edge, NodeRef};

    fn doc(id: &str, content: &str) -> Document {
        Document {
            id: id.into(),
            title: id.into(),
            content: content.into(),
            path: "/".into(),
            team_id: "t".into(),
            created_by_id: "u".into(),
            stage: None,
            lifecycle_id: None,
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
        }
    }

    #[test]
    fn normalize() {
        assert_eq!(normalize_path("./src\\a.rs"), "src/a.rs");
        assert_eq!(normalize_path("/x/y"), "x/y");
        assert_eq!(normalize_path("  "), "");
    }

    #[test]
    fn word_boundaries() {
        assert!(contains_word("see `login.rs` here", "login.rs"));
        assert!(!contains_word("relogin.rs", "login.rs"));
        assert!(!contains_word("loginx", "login"));
        assert!(contains_word("login", "login"));
        assert!(contains_word("xlogin login", "login"));
    }

    #[test]
    fn mention_levels() {
        let c = "the flow lives in `src/auth/login.rs`; see also session.rs and the billing module";
        assert_eq!(
            mention_score(c, "src/auth/login.rs"),
            (1.0, Some(MatchReason::PathMention))
        );
        assert_eq!(
            mention_score(c, "other/session.rs"),
            (0.8, Some(MatchReason::NameMention))
        );
        assert_eq!(mention_score(c, "crates/billing/mod.rs").0, 0.0); // generic stem "mod"
        assert_eq!(
            mention_score(c, "src/billing.ts"),
            (0.4, Some(MatchReason::StemMention))
        );
        assert_eq!(mention_score(c, "src/app.rs").0, 0.0);
        assert_eq!(mention_score(c, "").0, 0.0);
    }

    #[test]
    fn selects_by_link_mention_and_ignores_unrelated() {
        let db = Db::open_in_memory().unwrap();
        let docs = [
            doc("linked", "No file names here at all."),
            doc("mentions", "Implemented by src/auth/login.rs"),
            doc("stem", "Covers the login experience"),
            doc("unrelated", "Billing and invoices"),
        ];
        let g = ImpactGraph::from_edges([Edge {
            src: NodeRef::spec("linked"),
            dst: NodeRef::file("src/auth/login.rs"),
            relation: "implements".into(),
            weight: 1.0,
        }]);
        let cfg = MatchConfig {
            use_semantic: false,
            ..Default::default()
        };
        let m = match_specs(
            db.conn(),
            "t",
            &["./src/auth/login.rs".into(), "src/auth/login.rs".into()],
            &docs,
            &g,
            &cfg,
        )
        .unwrap();
        let ids: Vec<_> = m.iter().map(|x| x.document_id.as_str()).collect();
        assert_eq!(ids, ["linked", "mentions", "stem"]);
        assert_eq!(m[0].reasons, [MatchReason::Linked]);
        assert_eq!(m[0].paths, ["src/auth/login.rs"]);
        assert!(m[2].score < 0.5);

        let strict = MatchConfig {
            min_score: 0.9,
            ..cfg
        };
        assert_eq!(
            match_specs(
                db.conn(),
                "t",
                &["src/auth/login.rs".into()],
                &docs,
                &g,
                &strict
            )
            .unwrap()
            .len(),
            2
        );
        let capped = MatchConfig {
            max_specs: 1,
            ..cfg
        };
        assert_eq!(
            match_specs(
                db.conn(),
                "t",
                &["src/auth/login.rs".into()],
                &docs,
                &g,
                &capped
            )
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn fallback_selects_everything_only_when_enabled() {
        let db = Db::open_in_memory().unwrap();
        let docs = [doc("a", "x"), doc("b", "y")];
        let g = ImpactGraph::new();
        let off = MatchConfig {
            use_semantic: false,
            ..Default::default()
        };
        assert!(
            match_specs(db.conn(), "t", &["zzz.rs".into()], &docs, &g, &off)
                .unwrap()
                .is_empty()
        );
        let on = MatchConfig {
            fallback_all_docs: true,
            ..off
        };
        let m = match_specs(db.conn(), "t", &["zzz.rs".into()], &docs, &g, &on).unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].reasons, [MatchReason::Fallback]);
        assert!(match_specs(db.conn(), "t", &[], &docs, &g, &on)
            .unwrap()
            .is_empty());
    }
}
