//! Ticket drafting: turn specs / spec changes into reviewable drafts, clean up what the model
//! returns, and de-duplicate against tickets that already exist.
//!
//! The model calls themselves live in [`crate::ai::Advisor`] (`generate_bulk_ticket_suggestions`,
//! `generate_ticket_from_diff`, `analyze_changes_for_tickets`); this module is the deterministic
//! layer on both sides of them: [`TicketGenerator`] (sanitising wrapper), [`find_duplicates`] /
//! [`dedupe_key`] (title-based dedupe) and the traceability footer ([`with_traceability`]).

use std::collections::HashSet;
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ai::parse::{SuggestedTicket, TicketDraft};
use crate::ai::provider::LlmError;
use crate::ai::Advisor;

/// Longest title we pass on (GitHub allows 256, Jira summary 255).
pub const MAX_TITLE_CHARS: usize = 250;
/// Most labels kept per draft.
pub const MAX_LABELS: usize = 10;
/// Longest label kept.
pub const MAX_LABEL_CHARS: usize = 50;
/// Title used when a single-ticket reply carried no usable title (same wording as the parse
/// fallback in [`crate::ai::parse::ticket`]).
pub const FALLBACK_TITLE: &str = "Implement code changes to match spec updates";
/// Title similarity (Jaccard over word sets) at or above which two titles are treated as the
/// same ticket.
pub const DUPLICATE_THRESHOLD: f64 = 0.8;

// ------------------------------------------------------------ cleaning

/// Clean one model-produced draft. Returns `None` when there is no usable title (a malformed
/// array element becomes an empty-title draft in the parser; those are dropped here).
#[must_use]
pub fn sanitize_draft(d: TicketDraft) -> Option<TicketDraft> {
    let title: String = d
        .title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect();
    if title.is_empty() {
        return None;
    }
    let mut seen = HashSet::new();
    let labels = d
        .labels
        .into_iter()
        .map(|l| l.trim().chars().take(MAX_LABEL_CHARS).collect::<String>())
        .filter(|l| !l.is_empty() && seen.insert(l.to_lowercase()))
        .take(MAX_LABELS)
        .collect();
    Some(TicketDraft {
        title,
        description: d.description.trim().to_owned(),
        labels,
    })
}

/// Sanitise a batch: drop unusable drafts and collapse exact title repeats inside the batch
/// (first wins).
#[must_use]
pub fn sanitize_batch(drafts: Vec<TicketDraft>) -> Vec<TicketDraft> {
    let mut seen = HashSet::new();
    drafts
        .into_iter()
        .filter_map(sanitize_draft)
        .filter(|d| seen.insert(dedupe_key(&d.title)))
        .collect()
}

/// Sanitising wrapper around [`Advisor`] for the three generation entry points.
#[derive(Debug, Clone, Copy)]
pub struct TicketGenerator<'a> {
    advisor: Advisor<'a>,
}

impl<'a> TicketGenerator<'a> {
    /// Wrap an advisor.
    #[must_use]
    pub fn new(advisor: Advisor<'a>) -> Self {
        Self { advisor }
    }

    /// Plan and expand tickets for a whole document (at most
    /// [`crate::ai::prompts::MAX_BULK_TICKETS`], no over-generation). Never returns an empty
    /// list for a successful call: the Advisor's "[M] Review" placeholder covers unparseable
    /// output.
    ///
    /// # Errors
    /// Provider failure while planning.
    pub fn from_document(
        &self,
        title: &str,
        content: &str,
        stage: Option<&str>,
        code_context: Option<&str>,
    ) -> Result<Vec<TicketDraft>, LlmError> {
        let raw =
            self.advisor
                .generate_bulk_ticket_suggestions(content, title, stage, code_context)?;
        Ok(sanitize_batch(raw))
    }

    /// One ticket from a spec diff. An unusable title falls back to [`FALLBACK_TITLE`].
    ///
    /// # Errors
    /// Provider failure.
    pub fn from_diff(&self, diff: &str, context: Option<&str>) -> Result<TicketDraft, LlmError> {
        let d = self.advisor.generate_ticket_from_diff(diff, context)?;
        let description = d.description.clone();
        let labels = d.labels.clone();
        Ok(sanitize_draft(d).unwrap_or_else(|| TicketDraft {
            title: FALLBACK_TITLE.into(),
            description: description.trim().to_owned(),
            labels,
        }))
    }
}

/// Build a draft from a suggestion's parts, folding the priority into labels as
/// `priority:<value>` so it survives posting to trackers without a priority field.
#[must_use]
pub fn draft_from_parts(
    title: &str,
    description: &str,
    priority: &str,
    labels: &[String],
) -> TicketDraft {
    let mut labels = labels.to_vec();
    let p = priority.trim().to_lowercase();
    if !p.is_empty() {
        labels.push(format!("priority:{p}"));
    }
    TicketDraft {
        title: title.to_owned(),
        description: description.to_owned(),
        labels,
    }
}

/// View a change-analysis suggestion ([`crate::ai::Advisor::analyze_changes_for_tickets`]) as a
/// draft; see [`draft_from_parts`].
#[must_use]
pub fn draft_from_suggested(s: &SuggestedTicket) -> TicketDraft {
    draft_from_parts(&s.title, &s.description, &s.priority, &s.labels)
}

// -------------------------------------------------------------- dedupe

/// Word set of a title, lowercase alphanumerics only. Leading bracket tags such as the `[S]`,
/// `[M]`, `[L]` size markers the bulk prompt asks for are ignored, so "[M] Add login" and
/// "Add login" are the same ticket.
fn tokens(title: &str) -> Vec<String> {
    let mut t = title.trim();
    while t.starts_with('[') {
        match t.find(']') {
            Some(end) => t = t[end + 1..].trim_start(),
            None => break,
        }
    }
    t.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Jaccard similarity of two titles' word sets, 0.0 - 1.0 (two empty titles: 0.0).
#[must_use]
pub fn title_similarity(a: &str, b: &str) -> f64 {
    let (ta, tb): (HashSet<_>, HashSet<_>) = (tokens(a).into_iter().collect(), {
        tokens(b).into_iter().collect()
    });
    let union = ta.union(&tb).count();
    if union == 0 {
        return 0.0;
    }
    ta.intersection(&tb).count() as f64 / union as f64
}

/// Stable hash of a title's normalised words: equal for titles that differ only in case,
/// punctuation, spacing or a leading size tag. Stored on drafts for the unique index.
#[must_use]
pub fn dedupe_key(title: &str) -> String {
    let mut h = Sha256::new();
    h.update(tokens(title).join(" ").as_bytes());
    hex::encode(&h.finalize()[..16])
}

/// What a candidate duplicates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DuplicateOf {
    /// Title of the existing ticket / earlier draft.
    pub title: String,
    /// Similarity, 1.0 for an exact normalised match.
    pub similarity: f64,
    /// Index into the `existing` slice, or `None` when it duplicates an earlier candidate of the
    /// same batch.
    pub existing_index: Option<usize>,
}

/// Result of [`find_duplicates`].
#[derive(Debug, Clone, PartialEq)]
pub struct DedupeReport {
    /// Candidates to keep, in order.
    pub keep: Vec<TicketDraft>,
    /// Dropped candidates and what they duplicate.
    pub duplicates: Vec<(TicketDraft, DuplicateOf)>,
}

/// Split `candidates` into new and duplicate drafts against `existing` titles (tickets already
/// posted for the document, open drafts, remote issues) and against each other. Matching is by
/// word-set similarity >= `threshold` (use [`DUPLICATE_THRESHOLD`]); the best match is reported.
#[must_use]
pub fn find_duplicates(
    candidates: Vec<TicketDraft>,
    existing: &[String],
    threshold: f64,
) -> DedupeReport {
    let mut keep: Vec<TicketDraft> = Vec::new();
    let mut duplicates = Vec::new();
    for c in candidates {
        let mut best: Option<DuplicateOf> = None;
        let mut consider = |title: &str, idx: Option<usize>| {
            let exact = dedupe_key(&c.title) == dedupe_key(title);
            let s = if exact {
                1.0
            } else {
                title_similarity(&c.title, title)
            };
            if s >= threshold && best.as_ref().map_or(true, |b| s > b.similarity) {
                best = Some(DuplicateOf {
                    title: title.to_owned(),
                    similarity: s,
                    existing_index: idx,
                });
            }
        };
        for (i, e) in existing.iter().enumerate() {
            consider(e, Some(i));
        }
        for k in &keep {
            consider(&k.title, None);
        }
        match best {
            Some(d) => duplicates.push((c, d)),
            None => keep.push(c),
        }
    }
    DedupeReport { keep, duplicates }
}

// -------------------------------------------------------- traceability

/// Marker that ties a posted issue back to the Nyx document and draft.
pub const TRACE_MARKER: &str = "nyx-ref:";

/// Link back to the originating document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TraceRef {
    /// Document id.
    pub document_id: String,
    /// Draft id (empty when the ticket was not posted from a draft).
    pub draft_id: String,
}

/// Append the traceability footer (idempotent: a body that already carries one is returned
/// unchanged). The `nyx://document/<id>` link is what the desktop app's deep link handler opens.
#[must_use]
pub fn with_traceability(body: &str, document_title: &str, trace: &TraceRef) -> String {
    if parse_traceability(body).is_some() {
        return body.to_owned();
    }
    let title: String = document_title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('"', "'");
    let mut out = body.trim_end().to_owned();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    let _ = write!(
        out,
        "---\nGenerated by Nyx from \"{title}\" (nyx://document/{})\n{TRACE_MARKER}doc={};draft={}",
        trace.document_id, trace.document_id, trace.draft_id
    );
    out
}

/// Read the footer written by [`with_traceability`].
#[must_use]
pub fn parse_traceability(body: &str) -> Option<TraceRef> {
    let tail = &body[body.rfind(TRACE_MARKER)? + TRACE_MARKER.len()..];
    let line = tail.lines().next()?;
    let rest = line.strip_prefix("doc=")?;
    let (doc, draft) = rest.split_once(";draft=")?;
    let ok = |s: &str| {
        s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };
    (!doc.is_empty() && ok(doc) && ok(draft.trim())).then(|| TraceRef {
        document_id: doc.to_owned(),
        draft_id: draft.trim().to_owned(),
    })
}

#[cfg(test)]
#[allow(clippy::assert_is_empty, clippy::items_after_statements)]
mod tests {
    use super::*;
    use crate::ai::config::ModelPair;
    use crate::ai::provider::FakeLlm;

    fn d(title: &str) -> TicketDraft {
        TicketDraft {
            title: title.into(),
            description: "body".into(),
            labels: vec![],
        }
    }

    fn models() -> ModelPair {
        ModelPair {
            default: "m".into(),
            fast: "f".into(),
        }
    }

    // ---- generation parsing (through the real Advisor + FakeLlm)

    #[test]
    fn generation_parses_clean_json_and_caps_labels() {
        let outline = r#"[{"title":"[S] Add login","description":"d1","labels":["a","A"," b ","","c","d","e","f","g","h","i","j","k"]},
                          {"title":"[M] Add logout","description":"d2","labels":["x"]}]"#;
        let llm = FakeLlm::with_texts(&[outline, "Expanded one", "Expanded two"]);
        let m = models();
        let g = TicketGenerator::new(Advisor::new(&llm, &m));
        let out = g
            .from_document("Spec", "content", Some("definition"), None)
            .unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].description, "Expanded one");
        assert_eq!(out[0].labels.len(), MAX_LABELS);
        assert_eq!(&out[0].labels[..3], ["a", "b", "c"]); // case-insensitive dedupe, trimmed
        assert_eq!(out[1].title, "[M] Add logout");
    }

    #[test]
    fn generation_tolerates_fences_prose_and_truncation() {
        let fenced = "Here you go:\n```json\n[{\"title\":\"A one\",\"description\":\"x\",\"labels\":[]}]\n```\nHope it helps";
        let llm = FakeLlm::with_texts(&[fenced, "exp"]);
        let m = models();
        let out = TicketGenerator::new(Advisor::new(&llm, &m))
            .from_document("S", "c", None, None)
            .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "A one");

        // Truncated mid-second-object: the complete first object is salvaged.
        let cut = r#"[{"title":"First","description":"d","labels":["l"]},{"title":"Seco"#;
        let llm = FakeLlm::with_texts(&[cut, "exp"]);
        let out = TicketGenerator::new(Advisor::new(&llm, &m))
            .from_document("S", "c", None, None)
            .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "First");
    }

    #[test]
    fn generation_malformed_output_yields_review_placeholder() {
        let llm = FakeLlm::with_texts(&["I'm sorry, I cannot do that."]);
        let m = models();
        let out = TicketGenerator::new(Advisor::new(&llm, &m))
            .from_document("My Spec", "c", None, None)
            .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "[M] Review \"My Spec\"");
        assert_eq!(out[0].labels, ["spec-review"]);
    }

    #[test]
    fn generation_drops_untitled_and_repeated_entries() {
        let raw = r#"[{"title":"  ","description":"x"},{"description":"no title"},
                      {"title":"Same","description":"1"},{"title":"same!","description":"2"},{"title":"Other","description":"3"}]"#;
        let llm = FakeLlm::with_texts(&[raw, "e1", "e2", "e3", "e4", "e5"]);
        let m = models();
        let out = TicketGenerator::new(Advisor::new(&llm, &m))
            .from_document("S", "c", None, None)
            .unwrap();
        let titles: Vec<_> = out.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(titles, ["Same", "Other"]);
    }

    #[test]
    fn generation_provider_error_propagates() {
        let llm = FakeLlm::new(); // exhausted
        let m = models();
        assert!(TicketGenerator::new(Advisor::new(&llm, &m))
            .from_document("S", "c", None, None)
            .is_err());
    }

    #[test]
    fn from_diff_falls_back_on_garbage_and_empty_title() {
        let m = models();
        let llm = FakeLlm::with_texts(&["not json at all"]);
        let t = TicketGenerator::new(Advisor::new(&llm, &m))
            .from_diff("diff", None)
            .unwrap();
        assert_eq!(t.title, FALLBACK_TITLE);
        assert_eq!(t.description, "not json at all");
        assert_eq!(t.labels, ["spec-change", "implementation"]);

        let llm = FakeLlm::with_texts(&[r#"{"title":"","description":"desc","labels":["x"]}"#]);
        let t = TicketGenerator::new(Advisor::new(&llm, &m))
            .from_diff("diff", None)
            .unwrap();
        assert_eq!(t.title, FALLBACK_TITLE);
        assert_eq!(t.description, "desc");
        assert_eq!(t.labels, ["x"]);

        let llm = FakeLlm::with_texts(&[r#"{"title":"  Do   it ","description":"d","labels":[]}"#]);
        let t = TicketGenerator::new(Advisor::new(&llm, &m))
            .from_diff("diff", Some("ctx"))
            .unwrap();
        assert_eq!(t.title, "Do it");
    }

    #[test]
    fn long_titles_are_truncated_on_char_boundaries() {
        let t = sanitize_draft(d(&"é".repeat(400))).unwrap();
        assert_eq!(t.title.chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn suggested_ticket_priority_becomes_label() {
        let s = SuggestedTicket {
            title: "T".into(),
            description: "D".into(),
            priority: "High".into(),
            labels: vec!["a".into()],
        };
        assert_eq!(draft_from_suggested(&s).labels, ["a", "priority:high"]);
    }

    // ---- dedupe

    #[test]
    fn key_ignores_case_punctuation_and_size_tags() {
        assert_eq!(dedupe_key("[M] Add login!"), dedupe_key("add   LOGIN"));
        assert_eq!(dedupe_key("[S][x] Add login"), dedupe_key("Add login"));
        assert_ne!(dedupe_key("Add login"), dedupe_key("Add logout"));
        // Unclosed bracket is not a tag.
        assert_ne!(dedupe_key("[M Add login"), dedupe_key("Add login"));
    }

    #[test]
    fn similarity_bounds() {
        assert!((title_similarity("a b c", "a b c") - 1.0).abs() < 1e-9);
        assert!(title_similarity("a b", "c d").abs() < 1e-9);
        assert!(title_similarity("", "").abs() < 1e-9);
        assert!((title_similarity("a b c d", "a b c e") - 0.6).abs() < 1e-9);
    }

    #[test]
    fn duplicates_against_existing_and_within_batch() {
        let existing = vec![
            "Add OAuth login flow to the web app".to_string(),
            "Unrelated".to_string(),
        ];
        let cands = vec![
            d("[M] Add OAuth login flow to web app"), // 7/8 words overlap -> dup of existing 0
            d("Rate limit the API"),
            d("rate limit the api!"), // dup of batch item
            d("Write migration"),
        ];
        let r = find_duplicates(cands, &existing, DUPLICATE_THRESHOLD);
        let keep: Vec<_> = r.keep.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(keep, ["Rate limit the API", "Write migration"]);
        assert_eq!(r.duplicates.len(), 2);
        assert_eq!(r.duplicates[0].1.existing_index, Some(0));
        assert!(r.duplicates[0].1.similarity >= 0.8);
        assert_eq!(r.duplicates[1].1.existing_index, None);
        assert!((r.duplicates[1].1.similarity - 1.0).abs() < 1e-9);
    }

    #[test]
    fn near_miss_below_threshold_is_kept() {
        let r = find_duplicates(
            vec![d("Add login page")],
            &["Add logout page".to_string()],
            DUPLICATE_THRESHOLD,
        );
        assert_eq!(r.keep.len(), 1); // 2/4 = 0.5
        assert!(r.duplicates.is_empty());
        // Threshold 1.0 only accepts exact normalised matches.
        let r = find_duplicates(vec![d("Add login")], &["add LOGIN".to_string()], 1.0);
        assert_eq!(r.duplicates.len(), 1);
    }

    // ---- traceability

    #[test]
    fn traceability_footer_roundtrip_and_idempotence() {
        let t = TraceRef {
            document_id: "doc-1".into(),
            draft_id: "dr_2".into(),
        };
        let body = with_traceability("Do the thing.\n", "My \"Spec\"\nv2", &t);
        assert!(body.starts_with("Do the thing.\n\n---\n"));
        assert!(body.contains("nyx://document/doc-1"));
        assert!(body.contains("\"My 'Spec' v2\""));
        assert_eq!(parse_traceability(&body), Some(t.clone()));
        assert_eq!(with_traceability(&body, "x", &t), body);
        assert_eq!(parse_traceability("nothing here"), None);
        assert_eq!(parse_traceability("nyx-ref:doc=;draft=x"), None);
        assert_eq!(parse_traceability("nyx-ref:garbage"), None);
        // Empty body: footer only.
        assert!(with_traceability("", "T", &t).starts_with("---\n"));
    }
}
