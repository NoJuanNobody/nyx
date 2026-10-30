//! Historical context matching. Port of `context-matching.service.ts`: given new input (meeting
//! notes, a ticket, a request) find the existing specs it confirms, contradicts or expands, and
//! cross-cutting signals (recurring pattern, contradiction, scope creep).
//!
//! The model reply is untrusted: fences are stripped, the JSON object is located inside any
//! surrounding prose, entries with unknown document ids or enum values are dropped one by one,
//! and anything unparseable yields an empty result (as in the TS service) rather than an error.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai::{LlmError, LlmProvider, LlmRequest, ModelPair};
use crate::model::Document;

/// Characters of each document sent to the model.
pub const DOC_EXCERPT_CHARS: usize = 1500;

const SYSTEM: &str = r#"You are a spec history analyst for a product documentation platform. Given a new input and a set of existing documents, analyze semantic similarity and relationships.

For each related document, classify the relationship:
- "confirms": the new input reinforces or aligns with an existing spec
- "contradicts": the new input conflicts with an existing spec
- "expands": the new input extends scope beyond what an existing spec covers

Also detect cross-cutting signals:
- "recurring_pattern": the same idea or requirement has appeared multiple times
- "contradiction": conflicting requirements exist across specs
- "scope_creep": the new input significantly expands the project beyond existing boundaries

Respond ONLY with valid JSON in this exact format:
{
  "matches": [
    {
      "documentId": "<exact doc id>",
      "title": "<doc title>",
      "relevance": "high" | "medium" | "low",
      "relationship": "confirms" | "contradicts" | "expands",
      "summary": "<brief explanation of the relationship>"
    }
  ],
  "signals": [
    {
      "type": "recurring_pattern" | "contradiction" | "scope_creep",
      "description": "<explanation>",
      "relatedDocIds": ["<doc id 1>", "<doc id 2>"]
    }
  ]
}

Only include documents with meaningful relevance. Omit irrelevant documents."#;

/// How relevant a related spec is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Relevance {
    /// Strongly related.
    High,
    /// Related.
    Medium,
    /// Loosely related.
    Low,
}

/// How the input relates to a spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Relationship {
    /// Reinforces the spec.
    Confirms,
    /// Conflicts with the spec.
    Contradicts,
    /// Extends beyond the spec.
    Expands,
}

/// Kind of cross-cutting signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalType {
    /// The same idea keeps coming back.
    RecurringPattern,
    /// Specs conflict.
    Contradiction,
    /// The input widens the project.
    ScopeCreep,
}

/// One related spec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMatch {
    /// Document id (always one of the supplied documents).
    pub document_id: String,
    /// Title as reported by the model.
    pub title: String,
    /// Relevance.
    pub relevance: Relevance,
    /// Relationship.
    pub relationship: Relationship,
    /// Why.
    pub summary: String,
}

/// A cross-cutting signal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSignal {
    /// Kind.
    #[serde(rename = "type")]
    pub kind: SignalType,
    /// Explanation.
    pub description: String,
    /// Documents involved (unknown ids are kept, as in the TS).
    pub related_doc_ids: Vec<String>,
}

/// Result of a matching run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextMatchResult {
    /// Related specs.
    pub matches: Vec<ContextMatch>,
    /// Signals.
    pub signals: Vec<ContextSignal>,
}

fn enum_of<T: for<'de> Deserialize<'de>>(v: Option<&Value>) -> Option<T> {
    serde_json::from_value(v?.clone()).ok()
}

/// Parse and validate a model reply against the ids that were offered.
#[must_use]
pub fn parse_context(raw: &str, valid_ids: &HashSet<&str>) -> ContextMatchResult {
    let text: String = raw
        .lines()
        .filter(|l| !l.trim_start().starts_with("```"))
        .collect::<Vec<_>>()
        .join("\n");
    // First JSON object that looks like our reply, tolerant of prose before and after it.
    let root =
        text.match_indices('{').find_map(|(i, _)| {
            match serde_json::Deserializer::from_str(&text[i..])
                .into_iter::<Value>()
                .next()
            {
                Some(Ok(Value::Object(m)))
                    if m.contains_key("matches") || m.contains_key("signals") =>
                {
                    Some(m)
                }
                _ => None,
            }
        });
    let Some(root) = root else {
        return ContextMatchResult::default();
    };

    let matches = root
        .get("matches")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    let id = m.get("documentId")?.as_str()?;
                    if !valid_ids.contains(id) {
                        return None;
                    }
                    Some(ContextMatch {
                        document_id: id.to_owned(),
                        title: m
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        relevance: enum_of(m.get("relevance"))?,
                        relationship: enum_of(m.get("relationship"))?,
                        summary: m
                            .get("summary")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let signals = root
        .get("signals")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let ids = s.get("relatedDocIds")?.as_array()?;
                    Some(ContextSignal {
                        kind: enum_of(s.get("type"))?,
                        description: s
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        related_doc_ids: ids
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    ContextMatchResult { matches, signals }
}

/// Build the user message: new input plus numbered document excerpts.
#[must_use]
pub fn build_user_message(input: &str, docs: &[Document]) -> String {
    let summaries: Vec<String> = docs
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let excerpt: String = d.content.chars().take(DOC_EXCERPT_CHARS).collect();
            format!(
                "[Doc {}] id=\"{}\" title=\"{}\"\n{excerpt}",
                i + 1,
                d.id,
                d.title
            )
        })
        .collect();
    format!(
        "## New Input\n{input}\n\n## Existing Documents\n{}",
        summaries.join("\n\n---\n\n")
    )
}

/// Finds related specs for new input.
#[derive(Clone, Copy)]
pub struct ContextMatcher<'a> {
    llm: &'a dyn LlmProvider,
    models: &'a ModelPair,
}

impl<'a> ContextMatcher<'a> {
    /// Bind a provider and model pair.
    #[must_use]
    pub fn new(llm: &'a dyn LlmProvider, models: &'a ModelPair) -> Self {
        Self { llm, models }
    }

    /// Match `input` against `docs` (the caller decides which documents are in scope, normally
    /// the team's live documents). No documents means no model call.
    ///
    /// # Errors
    /// Provider failure. A garbled reply is *not* an error: it yields an empty result.
    pub fn find_related_specs(
        &self,
        input: &str,
        docs: &[Document],
    ) -> Result<ContextMatchResult, LlmError> {
        if docs.is_empty() {
            return Ok(ContextMatchResult::default());
        }
        let req = LlmRequest::simple(
            &self.models.default,
            SYSTEM,
            build_user_message(input, docs),
            2048,
        );
        let resp = self.llm.complete(&req)?;
        let ids: HashSet<&str> = docs.iter().map(|d| d.id.as_str()).collect();
        Ok(parse_context(&resp.text, &ids))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::FakeLlm;

    fn doc(id: &str, title: &str, content: &str) -> Document {
        Document {
            id: id.into(),
            title: title.into(),
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

    fn models() -> ModelPair {
        ModelPair {
            default: "m".into(),
            fast: "f".into(),
        }
    }

    const GOOD: &str = r#"{"matches":[{"documentId":"doc-1","title":"Auth Spec","relevance":"high","relationship":"confirms","summary":"aligned"}],"signals":[{"type":"recurring_pattern","description":"auth again","relatedDocIds":["doc-1"]}]}"#;

    #[test]
    fn empty_team_makes_no_call() {
        let llm = FakeLlm::new();
        let r = ContextMatcher::new(&llm, &models())
            .find_related_specs("x", &[])
            .unwrap();
        assert_eq!(r, ContextMatchResult::default());
        assert_eq!(llm.call_count(), 0);
    }

    #[test]
    fn parses_matches_and_signals_and_sends_excerpts() {
        let llm = FakeLlm::with_texts(&[GOOD]);
        let long = "x".repeat(5000);
        let docs = [
            doc("doc-1", "Auth Spec", &long),
            doc("doc-2", "API", "REST"),
        ];
        let r = ContextMatcher::new(&llm, &models())
            .find_related_specs("new login flow", &docs)
            .unwrap();
        assert_eq!(r.matches.len(), 1);
        assert_eq!(r.matches[0].relationship, Relationship::Confirms);
        assert_eq!(r.signals[0].kind, SignalType::RecurringPattern);
        let sent = &llm.requests()[0];
        let user = &sent.messages[0].content;
        assert!(user.contains("## New Input\nnew login flow"));
        assert!(user.contains("[Doc 1] id=\"doc-1\" title=\"Auth Spec\""));
        assert!(user.contains("\n\n---\n\n[Doc 2]"));
        assert!(!user.contains(&"x".repeat(1501)));
        assert_eq!(sent.max_tokens, 2048);
    }

    #[test]
    fn drops_unknown_ids_and_bad_enums_individually() {
        let ids: HashSet<&str> = ["doc-1"].into();
        let raw = r#"{"matches":[
            {"documentId":"ghost","title":"t","relevance":"high","relationship":"confirms","summary":"s"},
            {"documentId":"doc-1","title":"t","relevance":"huge","relationship":"confirms","summary":"s"},
            {"documentId":"doc-1","title":"t","relevance":"low","relationship":"nonsense","summary":"s"},
            {"documentId":"doc-1","title":"ok","relevance":"low","relationship":"expands","summary":"s"},
            "junk", 7],
          "signals":[{"type":"scope_creep","description":"d","relatedDocIds":["doc-1","x"]},
                     {"type":"mystery","description":"d","relatedDocIds":[]},
                     {"type":"contradiction","description":"d"}]}"#;
        let r = parse_context(raw, &ids);
        assert_eq!(r.matches.len(), 1);
        assert_eq!(r.matches[0].title, "ok");
        assert_eq!(r.signals.len(), 1);
        assert_eq!(r.signals[0].related_doc_ids, ["doc-1", "x"]);
    }

    #[test]
    fn tolerates_fences_prose_and_garbage() {
        let ids: HashSet<&str> = ["doc-1"].into();
        let fenced = format!("```json\n{GOOD}\n```");
        assert_eq!(parse_context(&fenced, &ids).matches.len(), 1);
        let prose = format!("Sure! Here is the analysis:\n{GOOD}\nHope that helps.");
        assert_eq!(parse_context(&prose, &ids).matches.len(), 1);
        for bad in [
            "",
            "not json",
            "{\"matches\": [",
            "[1,2]",
            "{\"matches\": 5}",
            "null",
        ] {
            assert_eq!(
                parse_context(bad, &ids),
                ContextMatchResult::default(),
                "{bad}"
            );
        }
        // matches missing entirely but signals present is still tolerated.
        let only = r#"{"signals":[{"type":"scope_creep","description":"d","relatedDocIds":[]}]}"#;
        assert_eq!(parse_context(only, &ids).signals.len(), 1);
    }

    #[test]
    fn provider_errors_propagate() {
        let llm = FakeLlm::new();
        let docs = [doc("doc-1", "A", "b")];
        assert!(ContextMatcher::new(&llm, &models())
            .find_related_specs("x", &docs)
            .is_err());
    }
}
