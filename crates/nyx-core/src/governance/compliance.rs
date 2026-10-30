//! Spec compliance checking (`compliance.service.ts`).
//!
//! Flow: retrieve the spec chunks most relevant to the code ([`SpecRetriever`]), ask a model
//! ([`ComplianceAnalyzer`]) to list violations, then parse and normalise its JSON answer. Both
//! collaborators are traits; the LLM impl belongs with `LlmProvider` (AI-75). The prompt and the
//! tolerant parser are pure and tested here.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;
use crate::model::Id;

/// Number of chunks retrieved and the similarity threshold used by the TS service.
pub const TOP_K: usize = 8;
/// Minimum similarity for a chunk to count as relevant.
pub const THRESHOLD: f32 = 0.2;
/// Characters of code used for the retrieval query.
pub const QUERY_CHARS: usize = 500;

/// Violation severity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Contradicts a requirement.
    Error,
    /// Partial or recommended-pattern deviation.
    Warning,
}

/// One compliance violation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComplianceViolation {
    /// Short rule name.
    pub rule: String,
    /// Severity.
    pub severity: Severity,
    /// What is wrong and what the spec requires.
    pub description: String,
    /// Which spec chunk it relates to.
    #[serde(default, rename = "specRef")]
    pub spec_ref: String,
}

/// Compliance verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComplianceResult {
    /// True iff there are no violations.
    pub compliant: bool,
    /// Violations found.
    pub violations: Vec<ComplianceViolation>,
}

/// A retrieved spec excerpt.
#[derive(Debug, Clone, PartialEq)]
pub struct SpecChunk {
    /// Source document.
    pub doc_id: Id,
    /// Excerpt text.
    pub content: String,
    /// Similarity score.
    pub score: f32,
}

/// Finds spec chunks relevant to a query (vector search over `doc_chunks`).
pub trait SpecRetriever {
    /// Top chunks for the query within the team.
    fn retrieve(
        &self,
        query: &str,
        team_id: &str,
        top_k: usize,
        threshold: f32,
    ) -> Result<Vec<SpecChunk>>;
}

/// Asks a model to judge code against specs and returns its raw text answer.
pub trait ComplianceAnalyzer {
    /// `system` and `user` are built by [`system_prompt`] and [`user_prompt`].
    fn analyze(&self, system: &str, user: &str) -> Result<String>;
}

/// System prompt (verbatim intent of the TS prompt).
#[must_use]
pub fn system_prompt() -> &'static str {
    "You are a spec compliance checker for a software product. You are given a set of specification excerpts and a piece of code. Analyze whether the code violates any requirements, conventions, or constraints described in the specs.\n\nFor each violation found, classify its severity:\n- \"error\": the code directly contradicts or fails to implement a spec requirement\n- \"warning\": the code partially implements a requirement or deviates from a recommended pattern\n\nRespond ONLY with valid JSON in this exact format:\n{\n  \"compliant\": <boolean>,\n  \"violations\": [\n    {\n      \"rule\": \"<short rule name>\",\n      \"severity\": \"error\" | \"warning\",\n      \"description\": \"<what the code does wrong and what the spec requires>\",\n      \"specRef\": \"<which spec chunk the violation relates to, e.g. 'Spec chunk 1'>\"\n    }\n  ]\n}\n\nIf the code is fully compliant, return {\"compliant\": true, \"violations\": []}.\nOnly report genuine violations \u{2014} do not invent issues."
}

/// User prompt: numbered spec chunks followed by the code.
#[must_use]
pub fn user_prompt(chunks: &[SpecChunk], code: &str, file_path: Option<&str>) -> String {
    let specs = chunks
        .iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                "[Spec chunk {} (doc {}, score {:.2})]\n{}",
                i + 1,
                c.doc_id,
                c.score,
                c.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    let label = file_path.map(|p| format!(" ({p})")).unwrap_or_default();
    format!("## Specifications\n{specs}\n\n## Code{label}\n```\n{code}\n```")
}

/// Retrieval query: the file path hint plus the first 500 characters of code.
#[must_use]
pub fn query_hint(code: &str, file_path: Option<&str>) -> String {
    let head: String = code.chars().take(QUERY_CHARS).collect();
    match file_path {
        Some(p) => format!("Code from file \"{p}\":\n{head}"),
        None => head,
    }
}

fn json_re() -> Option<&'static Regex> {
    static CELL: OnceLock<Option<Regex>> = OnceLock::new();
    // Greedy from the first `{` to the last `}` that contains a "compliant" key.
    CELL.get_or_init(|| Regex::new(r#"(?s)\{.*"compliant"\s*:.*\}"#).ok())
        .as_ref()
}

/// Parse a model answer tolerantly: strip code fences, extract the JSON object, drop malformed
/// violations, and derive `compliant` from the violation list. Unparseable output is treated as
/// compliant (TS behaviour: fail open).
#[must_use]
pub fn parse_response(text: &str) -> ComplianceResult {
    let stripped = text.replace("```json", "").replace("```", "");
    let stripped = stripped.trim();
    let candidate = json_re()
        .and_then(|re| re.find(stripped))
        .map_or(stripped, |m| m.as_str());
    let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(candidate) else {
        return ComplianceResult {
            compliant: true,
            violations: vec![],
        };
    };
    let violations: Vec<ComplianceViolation> = obj
        .get("violations")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|v| serde_json::from_value::<ComplianceViolation>(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    ComplianceResult {
        compliant: violations.is_empty(),
        violations,
    }
}

/// Check code against the team's specs. No relevant specs means compliant without calling the model.
pub fn check_compliance(
    retriever: &dyn SpecRetriever,
    analyzer: &dyn ComplianceAnalyzer,
    code: &str,
    team_id: &str,
    file_path: Option<&str>,
) -> Result<ComplianceResult> {
    let chunks = retriever.retrieve(&query_hint(code, file_path), team_id, TOP_K, THRESHOLD)?;
    if chunks.is_empty() {
        return Ok(ComplianceResult {
            compliant: true,
            violations: vec![],
        });
    }
    let answer = analyzer.analyze(system_prompt(), &user_prompt(&chunks, code, file_path))?;
    Ok(parse_response(&answer))
}

/// Retriever returning fixed chunks (tests).
#[derive(Debug, Default, Clone)]
pub struct FixedRetriever(pub Vec<SpecChunkOwned>);

/// Owned clone-friendly chunk for [`FixedRetriever`].
pub type SpecChunkOwned = (Id, String, f32);

impl SpecRetriever for FixedRetriever {
    fn retrieve(&self, _q: &str, _t: &str, top_k: usize, threshold: f32) -> Result<Vec<SpecChunk>> {
        Ok(self
            .0
            .iter()
            .filter(|(_, _, s)| *s >= threshold)
            .take(top_k)
            .map(|(d, c, s)| SpecChunk {
                doc_id: d.clone(),
                content: c.clone(),
                score: *s,
            })
            .collect())
    }
}

/// Analyzer returning a canned answer (tests).
#[derive(Debug, Clone)]
pub struct CannedAnalyzer(pub String);

impl ComplianceAnalyzer for CannedAnalyzer {
    fn analyze(&self, _system: &str, _user: &str) -> Result<String> {
        Ok(self.0.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regex_is_valid() {
        assert!(json_re().is_some());
    }

    #[test]
    fn parses_fenced_json_and_drops_bad_violations() {
        let text = "```json\n{\"compliant\": true, \"violations\": [\
            {\"rule\":\"A\",\"severity\":\"error\",\"description\":\"d\",\"specRef\":\"Spec chunk 1\"},\
            {\"rule\":\"B\",\"severity\":\"fatal\",\"description\":\"x\"},\
            {\"severity\":\"warning\",\"description\":\"no rule\"}]}\n```";
        let r = parse_response(text);
        assert!(
            !r.compliant,
            "compliant is derived from the violations, not trusted"
        );
        assert_eq!(r.violations.len(), 1);
        assert_eq!(r.violations[0].rule, "A");
    }

    #[test]
    fn garbage_fails_open() {
        assert!(parse_response("I could not do that").compliant);
        assert!(parse_response("{\"compliant\": ").compliant);
    }

    #[test]
    fn extracts_json_from_prose() {
        let r = parse_response("Sure! {\"compliant\": true, \"violations\": []} hope that helps");
        assert!(r.compliant);
    }

    #[test]
    fn query_hint_is_char_safe() {
        let code = "é".repeat(600);
        assert_eq!(query_hint(&code, None).chars().count(), QUERY_CHARS);
        assert!(query_hint("x", Some("a.rs")).starts_with("Code from file \"a.rs\":\n"));
    }
}
