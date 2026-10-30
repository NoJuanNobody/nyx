//! Structuring raw input into a spec draft. This is the LLM step, so this module only provides
//! the pieces around the call: prompt builders ([`StructuringPrompt`]) and tolerant response
//! parsers. The caller sends `system`/`user` to whatever provider it uses (the `LlmProvider`
//! trait owned by AI-75 once merged) and passes the reply text to the parser.
//!
//! Port of `intake.service.ts` (`SYSTEM_PROMPT`, `buildMarkdown`, `parseAIResponse`,
//! `processRawInput`, `processWithClarifications`) and of `transcriptionService.structureTranscript`.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `max_tokens` the TypeScript used for spec structuring.
pub const SPEC_MAX_TOKENS: u32 = 2048;
/// `max_tokens` the TypeScript used for transcript structuring.
pub const TRANSCRIPT_MAX_TOKENS: u32 = 4096;

/// A system + user prompt pair ready to hand to an LLM.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructuringPrompt {
    /// System prompt.
    pub system: String,
    /// User message.
    pub user: String,
    /// Suggested output token budget (the TS values).
    pub max_tokens: u32,
}

/// Confidence the model reports for a spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    /// Enough detail to build from.
    High,
    /// Mostly clear.
    Medium,
    /// Too vague; clarifying questions needed.
    Low,
}

/// Structured spec draft (TS `StructuredSpec`; JSON field names are unchanged).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredSpec {
    /// Feature title.
    pub title: String,
    /// "As a ..., I want ... so that ..."
    pub user_story: String,
    /// Testable criteria.
    pub acceptance_criteria: Vec<String>,
    /// Practical edge cases.
    pub edge_cases: Vec<String>,
    /// Questions the founder must answer.
    pub open_questions: Vec<String>,
    /// Model confidence.
    pub confidence: Confidence,
    /// Rendered markdown document.
    pub markdown: String,
}

const SPEC_SYSTEM_PROMPT: &str = r#"You are a product specification generator. Given raw, unstructured input from a founder or product manager, generate a structured specification.

Your output MUST be valid JSON with this exact format:
{
  "title": "<concise feature title>",
  "userStory": "As a [persona], I want to [action] so that [outcome]",
  "acceptanceCriteria": ["1. ...", "2. ...", ...],
  "edgeCases": ["What happens if...", ...],
  "openQuestions": ["Question that needs founder input before build..."],
  "confidence": "high|medium|low"
}

Rules:
- If the input is too vague to generate acceptance criteria, set confidence to "low" and add specific clarifying questions to openQuestions
- Never hallucinate requirements — if something is ambiguous, ask about it
- Edge cases should be practical, not theoretical
- Acceptance criteria must be testable and unambiguous"#;

const TRANSCRIPT_SYSTEM_PROMPT: &str = r#"You are a technical product manager. Given a transcript from a voice memo or meeting recording, extract and structure the key information into a product specification document. Identify: goals, requirements, constraints, decisions, action items, and any technical details mentioned. Respond ONLY with valid JSON in this exact format: {"title": "<document title>", "content": "<full markdown content>"}"#;

impl StructuringPrompt {
    /// Prompt for `processRawInput`.
    #[must_use]
    pub fn for_raw_input(raw_input: &str) -> Self {
        Self {
            system: SPEC_SYSTEM_PROMPT.to_string(),
            user: format!(
                "Transform the following raw input into a structured product specification:\n\n{raw_input}"
            ),
            max_tokens: SPEC_MAX_TOKENS,
        }
    }

    /// Prompt for `processWithClarifications`. Missing or empty answers become
    /// `(no answer provided)`; surplus answers are ignored.
    #[must_use]
    pub fn with_clarifications(raw_input: &str, questions: &[String], answers: &[String]) -> Self {
        let qa = questions
            .iter()
            .enumerate()
            .map(|(i, q)| {
                let a = answers
                    .get(i)
                    .map(String::as_str)
                    .filter(|a| !a.is_empty())
                    .unwrap_or("(no answer provided)");
                format!("Q: {q}\nA: {a}")
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        Self {
            system: SPEC_SYSTEM_PROMPT.to_string(),
            user: format!(
                "Transform the following raw input into a structured product specification. The founder has answered some clarifying questions — use these answers to produce a more complete spec.\n\n## Original Input\n{raw_input}\n\n## Clarifications\n{qa}"
            ),
            max_tokens: SPEC_MAX_TOKENS,
        }
    }

    /// Prompt for `structureTranscript` (title + markdown content).
    #[must_use]
    pub fn for_transcript(transcript: &str) -> Self {
        Self {
            system: TRANSCRIPT_SYSTEM_PROMPT.to_string(),
            user: format!(
                "Structure this transcript into a product specification:\n\n{transcript}"
            ),
            max_tokens: TRANSCRIPT_MAX_TOKENS,
        }
    }
}

/// Render a spec as markdown (port of `buildMarkdown`).
#[must_use]
pub fn build_markdown(spec: &StructuredSpec) -> String {
    let mut md = format!("# {}\n\n", spec.title);
    md += &format!("## User Story\n\n{}\n\n", spec.user_story);
    md += "## Acceptance Criteria\n\n";
    for c in &spec.acceptance_criteria {
        md += &format!("- {c}\n");
    }
    md += "\n## Edge Cases\n\n";
    for e in &spec.edge_cases {
        md += &format!("- {e}\n");
    }
    if !spec.open_questions.is_empty() {
        md += "\n## Open Questions\n\n";
        for q in &spec.open_questions {
            md += &format!("- {q}\n");
        }
    }
    md += &format!(
        "\n---\n\n*Confidence: {}*\n",
        match spec.confidence {
            Confidence::High => "high",
            Confidence::Medium => "medium",
            Confidence::Low => "low",
        }
    );
    md
}

/// Strip markdown code fences the way the TS did.
#[must_use]
pub fn strip_code_fences(text: &str) -> String {
    #[allow(clippy::expect_used)]
    let open = Regex::new(r"```(?:json)?\s*\n?").expect("valid regex");
    #[allow(clippy::expect_used)]
    let close = Regex::new(r"\n?\s*```").expect("valid regex");
    close
        .replace_all(&open.replace_all(text, ""), "")
        .trim()
        .to_string()
}

/// Find the JSON candidate: the greedy `{ ... "<key>": ... }` span, or the whole text.
fn json_candidate<'a>(text: &'a str, key: &str) -> &'a str {
    #[allow(clippy::expect_used)]
    let re = Regex::new(&format!(r#"(?s)\{{.*"{key}"\s*:.*\}}"#)).expect("valid regex");
    re.find(text).map_or(text, |m| m.as_str())
}

fn string_list(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn non_empty_str(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Parse the model's reply into a spec (port of `parseAIResponse`). Never fails: unparseable
/// output yields a low-confidence spec asking the user to retry. Non-string list items are
/// dropped, unknown confidence values become `low`.
#[must_use]
pub fn parse_spec_response(text: &str) -> StructuredSpec {
    let cleaned = strip_code_fences(text);
    let parsed: Option<Value> = serde_json::from_str(json_candidate(&cleaned, "title"))
        .ok()
        .filter(Value::is_object);
    let mut spec = if let Some(p) = parsed {
        StructuredSpec {
            title: non_empty_str(&p, "title").unwrap_or_else(|| "Untitled Spec".into()),
            user_story: non_empty_str(&p, "userStory").unwrap_or_default(),
            acceptance_criteria: string_list(&p["acceptanceCriteria"]),
            edge_cases: string_list(&p["edgeCases"]),
            open_questions: string_list(&p["openQuestions"]),
            confidence: match p["confidence"].as_str() {
                Some("high") => Confidence::High,
                Some("medium") => Confidence::Medium,
                _ => Confidence::Low,
            },
            markdown: String::new(),
        }
    } else {
        StructuredSpec {
            title: "Untitled Spec".into(),
            user_story: String::new(),
            acceptance_criteria: vec![],
            edge_cases: vec![],
            open_questions: vec![
                "AI response could not be parsed. Please try again with clearer input.".into(),
            ],
            confidence: Confidence::Low,
            markdown: String::new(),
        }
    };
    spec.markdown = build_markdown(&spec);
    spec
}

/// Title + markdown body produced by transcript structuring.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructuredTranscript {
    /// Document title.
    pub title: String,
    /// Markdown content.
    pub content: String,
}

/// Parse the transcript-structuring reply (port of the tail of `structureTranscript`): JSON
/// `{title, content}` when possible, else the first `# heading` as title and the text as content.
#[must_use]
pub fn parse_transcript_response(text: &str) -> StructuredTranscript {
    let text = strip_code_fences(text);
    if let Ok(v) = serde_json::from_str::<Value>(json_candidate(&text, "content")) {
        if v.is_object() {
            return StructuredTranscript {
                title: non_empty_str(&v, "title").unwrap_or_else(|| "Untitled Transcript".into()),
                content: non_empty_str(&v, "content").unwrap_or_else(|| text.clone()),
            };
        }
    }
    #[allow(clippy::expect_used)]
    let heading = Regex::new(r"(?m)^#\s+(.+)$").expect("valid regex");
    StructuredTranscript {
        title: heading
            .captures(&text)
            .map_or_else(|| "Untitled Transcript".into(), |c| c[1].trim().to_string()),
        content: text,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{"title":"Dark mode","userStory":"As a user, I want dark mode so that my eyes rest","acceptanceCriteria":["1. toggle exists","2. persists"],"edgeCases":["system theme changes"],"openQuestions":[],"confidence":"high"}"#;

    #[test]
    fn parses_clean_and_fenced_json() {
        let s = parse_spec_response(GOOD);
        assert_eq!(s.title, "Dark mode");
        assert_eq!(s.confidence, Confidence::High);
        assert_eq!(s.acceptance_criteria.len(), 2);
        assert!(s.markdown.starts_with("# Dark mode\n\n## User Story"));
        assert!(!s.markdown.contains("## Open Questions"));
        assert!(s.markdown.ends_with("---\n\n*Confidence: high*\n"));
        let fenced = format!("Here you go:\n```json\n{GOOD}\n```\nThanks");
        assert_eq!(parse_spec_response(&fenced).title, "Dark mode");
    }

    #[test]
    fn defaults_and_low_confidence_fallbacks() {
        let s = parse_spec_response(r#"{"title":"","confidence":"certain","edgeCases":"nope"}"#);
        assert_eq!(s.title, "Untitled Spec");
        assert_eq!(s.confidence, Confidence::Low);
        assert!(s.edge_cases.is_empty());
        let bad = parse_spec_response("I cannot do that");
        assert_eq!(bad.confidence, Confidence::Low);
        assert_eq!(bad.open_questions.len(), 1);
        assert!(bad.markdown.contains("## Open Questions"));
        assert!(bad.markdown.contains("*Confidence: low*"));
    }

    #[test]
    fn prompts_match_the_typescript() {
        let p = StructuringPrompt::for_raw_input("make it fast");
        assert!(p
            .system
            .starts_with("You are a product specification generator."));
        assert_eq!(
            p.user,
            "Transform the following raw input into a structured product specification:\n\nmake it fast"
        );
        let c = StructuringPrompt::with_clarifications(
            "raw",
            &["Who?".into(), "When?".into()],
            &["Admins".into()],
        );
        assert!(c.user.ends_with(
            "## Clarifications\nQ: Who?\nA: Admins\n\nQ: When?\nA: (no answer provided)"
        ));
        assert!(c.user.contains("## Original Input\nraw"));
        assert_eq!(StructuringPrompt::for_transcript("hi").max_tokens, 4096);
    }

    #[test]
    fn transcript_parsing() {
        let t = parse_transcript_response(
            r##"```json
{"title": "Sync notes", "content": "# Sync\n\n- a"}
```"##,
        );
        assert_eq!(
            (t.title.as_str(), t.content.as_str()),
            ("Sync notes", "# Sync\n\n- a")
        );
        let plain = parse_transcript_response("# Roadmap talk\n\nwe said things");
        assert_eq!(plain.title, "Roadmap talk");
        assert_eq!(plain.content, "# Roadmap talk\n\nwe said things");
        assert_eq!(
            parse_transcript_response("just words").title,
            "Untitled Transcript"
        );
    }
}
