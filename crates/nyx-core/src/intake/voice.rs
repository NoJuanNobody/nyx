//! Meeting / voice-memo intelligence: the non-agent parts of `services/voice/*`.
//!
//! Ported: `diarization.service.ts` ([`diarize`]), `semantic-parser.service.ts` (prompt +
//! response parser; the LLM call is the caller's), `meeting-intelligence.service.ts`
//! ([`build_intelligence`]) and `doc-transformer.service.ts` ([`transform_to_document`],
//! [`create_meeting_document`]).
//!
//! Not ported (call/agent features removed upstream): `voice-agent`, `call-integration`,
//! `recall-adapter`, webhooks. The in-memory per-session store of the TS is the caller's concern.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use super::structuring::{strip_code_fences, StructuringPrompt};
use crate::error::Result;
use crate::model::{Document, NewDocument};
use crate::store::DocumentRepo;

/// One speaker-attributed transcript segment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    /// Speaker label.
    pub speaker: String,
    /// Spoken text.
    pub text: String,
    /// Start offset in milliseconds.
    pub start_ms: i64,
    /// End offset in milliseconds.
    pub end_ms: i64,
    /// Engine confidence, if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

/// A decision made in the meeting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// Id (`d-1`, ...).
    pub id: String,
    /// Decision text.
    pub text: String,
    /// Who made it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub made_by: Option<String>,
    /// Surrounding context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// Offset in the recording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<i64>,
}

/// Action item status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionStatus {
    /// Not started.
    Pending,
    /// Underway.
    InProgress,
    /// Finished.
    Done,
}

/// Action item priority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    /// Urgent.
    High,
    /// Normal.
    Medium,
    /// Nice to have.
    Low,
}

/// An action item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionItem {
    /// Id (`a-1`, ...).
    pub id: String,
    /// What to do.
    pub text: String,
    /// Owner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    /// Deadline (free text or ISO date).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    /// Priority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    /// Status.
    pub status: ActionStatus,
}

/// A reference to code mentioned in the meeting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeReference {
    /// Id (`c-1`, ...).
    pub id: String,
    /// File path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    /// Symbol name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    /// Repository.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// Context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// Offset in the recording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<i64>,
}

/// An open question.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenQuestion {
    /// Id (`q-1`, ...).
    pub id: String,
    /// The question.
    pub text: String,
    /// Who raised it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raised_by: Option<String>,
    /// Context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// Answered already?
    pub resolved: bool,
    /// Offset in the recording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<i64>,
}

/// What the semantic parser extracts (TS `ParsedIntelligence`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedIntelligence {
    /// Decisions.
    pub decisions: Vec<Decision>,
    /// Action items.
    pub action_items: Vec<ActionItem>,
    /// Code references.
    pub code_references: Vec<CodeReference>,
    /// Open questions.
    pub open_questions: Vec<OpenQuestion>,
    /// 2-3 sentence summary.
    pub summary: String,
    /// Participant names.
    pub participants: Vec<String>,
}

/// Full result for one session (TS `MeetingIntelligence`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingIntelligence {
    /// Session id.
    pub session_id: String,
    /// Diarized transcript.
    pub transcript: Vec<TranscriptSegment>,
    /// Decisions.
    pub decisions: Vec<Decision>,
    /// Action items.
    pub action_items: Vec<ActionItem>,
    /// Code references.
    pub code_references: Vec<CodeReference>,
    /// Open questions.
    pub open_questions: Vec<OpenQuestion>,
    /// Summary.
    pub summary: String,
    /// Duration in milliseconds (end of the last segment).
    pub duration: i64,
    /// Participants.
    pub participants: Vec<String>,
    /// RFC 3339 creation time.
    pub created_at: String,
}

// ---------------------------------------------------------------- diarization

const AVG_SEGMENT_MS: i64 = 5000;

fn colon_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    #[allow(clippy::expect_used)]
    R.get_or_init(|| Regex::new(r"(?i)^(Speaker\s*[A-Za-z0-9_]+)\s*:\s*").expect("valid regex"))
}

fn bracket_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    #[allow(clippy::expect_used)]
    R.get_or_init(|| Regex::new(r"^\[([^\]]+)\]\s*").expect("valid regex"))
}

fn lines(transcript: &str) -> Vec<&str> {
    transcript
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .collect()
}

fn diarize_by_pattern(transcript: &str, pattern: &Regex) -> Vec<TranscriptSegment> {
    let mut segments: Vec<TranscriptSegment> = Vec::new();
    let mut current_ms = 0;
    for line in lines(transcript) {
        let trimmed = line.trim();
        if let Some(m) = pattern.captures(trimmed) {
            let speaker = m[1].trim().to_string();
            let text = trimmed[m[0].len()..].trim().to_string();
            if !text.is_empty() {
                let end_ms = current_ms + AVG_SEGMENT_MS;
                segments.push(TranscriptSegment {
                    speaker,
                    text,
                    start_ms: current_ms,
                    end_ms,
                    confidence: None,
                });
                current_ms = end_ms;
            }
        } else if let Some(last) = segments.last_mut() {
            last.text.push(' ');
            last.text.push_str(trimmed);
            last.end_ms += AVG_SEGMENT_MS;
            current_ms = last.end_ms;
        } else {
            let end_ms = current_ms + AVG_SEGMENT_MS;
            segments.push(TranscriptSegment {
                speaker: "Unknown".into(),
                text: trimmed.to_string(),
                start_ms: current_ms,
                end_ms,
                confidence: None,
            });
            current_ms = end_ms;
        }
    }
    segments
}

/// Split transcript text into speaker-attributed segments (MVP diarization from the TS).
///
/// Strategy: if at least two lines start with `Speaker N:` use that; else if at least two start
/// with `[Name]` use that; otherwise alternate `Speaker 1`/`Speaker 2` per line. Timestamps are
/// synthetic (5 s per segment). Replace with real diarization when a whisper engine lands.
#[must_use]
pub fn diarize(transcript: &str) -> Vec<TranscriptSegment> {
    if transcript.trim().is_empty() {
        return Vec::new();
    }
    let all = lines(transcript);
    let colon = all.iter().filter(|l| colon_re().is_match(l.trim())).count();
    let bracket = all
        .iter()
        .filter(|l| bracket_re().is_match(l.trim()))
        .count();
    if colon >= 2 {
        return diarize_by_pattern(transcript, colon_re());
    }
    if bracket >= 2 {
        return diarize_by_pattern(transcript, bracket_re());
    }
    all.iter()
        .enumerate()
        .map(|(i, l)| {
            let start_ms = i64::try_from(i).unwrap_or(0) * AVG_SEGMENT_MS;
            TranscriptSegment {
                speaker: format!("Speaker {}", (i % 2) + 1),
                text: l.trim().to_string(),
                start_ms,
                end_ms: start_ms + AVG_SEGMENT_MS,
                confidence: None,
            }
        })
        .collect()
}

// ------------------------------------------------------------ semantic parser

const EXTRACTION_PROMPT: &str = r#"You are a meeting intelligence extraction engine. Given a meeting transcript, extract structured information.

Return ONLY valid JSON matching this exact schema:
{
  "decisions": [{ "id": "d-1", "text": "...", "madeBy": "...", "context": "...", "timestampMs": null }],
  "actionItems": [{ "id": "a-1", "text": "...", "assignee": "...", "deadline": null, "priority": "medium", "status": "pending" }],
  "codeReferences": [{ "id": "c-1", "filePath": "...", "symbol": "...", "repository": "...", "context": "...", "timestampMs": null }],
  "openQuestions": [{ "id": "q-1", "text": "...", "raisedBy": "...", "context": "...", "resolved": false, "timestampMs": null }],
  "summary": "A concise 2-3 sentence summary of the meeting.",
  "participants": ["Name1", "Name2"]
}

Rules:
- Generate unique IDs with prefixes: d- for decisions, a- for action items, c- for code references, q- for questions
- Extract code references from mentions of files, functions, classes, repos, PRs, commits
- Mark action items as "pending" status by default
- Infer priority from urgency cues: "ASAP", "blocker", "critical" = high; "nice to have", "eventually" = low; otherwise medium
- If no items found for a category, return an empty array
- Handle crosstalk and interruptions — extract the intended meaning
- Handle technical jargon — preserve exact terms used"#;

/// Prompt for the meeting-intelligence extraction (`max_tokens` 4096). `None` for blank input,
/// where the TS returned an empty result without calling the model.
#[must_use]
pub fn extraction_prompt(transcript: &str) -> Option<StructuringPrompt> {
    if transcript.trim().is_empty() {
        return None;
    }
    Some(StructuringPrompt {
        system: EXTRACTION_PROMPT.to_string(),
        user: format!("Extract meeting intelligence from this transcript:\n\n{transcript}"),
        max_tokens: 4096,
    })
}

fn typed_list<T: serde::de::DeserializeOwned>(v: &Value) -> Vec<T> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| serde_json::from_value(x.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Parse the extraction reply (port of `parseTranscript`'s tail). Malformed items are dropped;
/// unparseable output yields an empty result with the TS failure summary.
#[must_use]
pub fn parse_intelligence_response(text: &str) -> ParsedIntelligence {
    let text = strip_code_fences(text);
    #[allow(clippy::expect_used)]
    let re = Regex::new(r#"(?s)\{.*"summary"\s*:.*\}"#).expect("valid regex");
    let candidate = re.find(&text).map_or(text.as_str(), |m| m.as_str());
    match serde_json::from_str::<Value>(candidate) {
        Ok(v) if v.is_object() => ParsedIntelligence {
            decisions: typed_list(&v["decisions"]),
            action_items: typed_list(&v["actionItems"]),
            code_references: typed_list(&v["codeReferences"]),
            open_questions: typed_list(&v["openQuestions"]),
            summary: v["summary"].as_str().unwrap_or_default().to_string(),
            participants: typed_list(&v["participants"]),
        },
        _ => ParsedIntelligence {
            summary: "Failed to parse transcript. Raw AI output preserved.".into(),
            ..ParsedIntelligence::default()
        },
    }
}

// ------------------------------------------------------- meeting intelligence

/// Combine the diarized transcript with parsed entities (TS `processTranscript`, minus the LLM
/// call and the in-memory store). `created_at` is an RFC 3339 timestamp supplied by the caller.
#[must_use]
pub fn build_intelligence(
    session_id: &str,
    transcript: &str,
    parsed: ParsedIntelligence,
    created_at: &str,
) -> MeetingIntelligence {
    let segments = diarize(transcript);
    let duration = segments.last().map_or(0, |s| s.end_ms);
    MeetingIntelligence {
        session_id: session_id.to_string(),
        transcript: segments,
        decisions: parsed.decisions,
        action_items: parsed.action_items,
        code_references: parsed.code_references,
        open_questions: parsed.open_questions,
        summary: parsed.summary,
        duration,
        participants: parsed.participants,
        created_at: created_at.to_string(),
    }
}

// ------------------------------------------------------------ doc transformer

fn display_date(created_at: &str) -> String {
    if created_at.is_empty() {
        return "Unknown Date".into();
    }
    #[allow(clippy::expect_used)]
    let fmt = time::format_description::parse_borrowed::<2>(
        "[year]-[month]-[day] [hour]:[minute]:[second] UTC",
    )
    .expect("valid format");
    OffsetDateTime::parse(created_at, &Rfc3339)
        .ok()
        .and_then(|d| d.to_offset(time::UtcOffset::UTC).format(&fmt).ok())
        .unwrap_or_else(|| "Invalid Date".into())
}

/// Title and markdown of a meeting document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransformedDocument {
    /// `Meeting Notes: <date>`.
    pub title: String,
    /// Markdown body.
    pub content: String,
}

/// Render intelligence as a Nyx markdown document (port of `transformToDocument`). Dates are
/// formatted `YYYY-MM-DD HH:MM:SS UTC` instead of the TS's locale-dependent `toLocaleString()`.
#[must_use]
pub fn transform_to_document(i: &MeetingIntelligence) -> TransformedDocument {
    let date = display_date(&i.created_at);
    let mut sections = vec![format!("# Meeting Notes: {date}")];
    sections.push(format!(
        "## Summary\n\n{}",
        if i.summary.is_empty() {
            "_No summary available._"
        } else {
            &i.summary
        }
    ));

    let section = |title: &str, items: Vec<String>, empty: &str| {
        if items.is_empty() {
            format!("## {title}\n\n_{empty}_")
        } else {
            format!("## {title}\n\n{}", items.join("\n"))
        }
    };
    sections.push(section(
        "Decisions",
        i.decisions
            .iter()
            .map(|d| {
                let mut l = format!("- {}", d.text);
                if let Some(by) = d.made_by.as_deref().filter(|s| !s.is_empty()) {
                    l += &format!(" _(by {by})_");
                }
                l
            })
            .collect(),
        "No decisions recorded.",
    ));
    sections.push(section(
        "Action Items",
        i.action_items
            .iter()
            .map(|a| {
                let mark = if a.status == ActionStatus::Done {
                    'x'
                } else {
                    ' '
                };
                let mut l = format!("- [{mark}] {}", a.text);
                let mut meta = Vec::new();
                if let Some(x) = a.assignee.as_deref().filter(|s| !s.is_empty()) {
                    meta.push(format!("assignee: {x}"));
                }
                if let Some(x) = a.deadline.as_deref().filter(|s| !s.is_empty()) {
                    meta.push(format!("deadline: {x}"));
                }
                if let Some(p) = a.priority {
                    meta.push(format!(
                        "priority: {}",
                        serde_json::to_value(p)
                            .ok()
                            .and_then(|v| v.as_str().map(str::to_string))
                            .unwrap_or_default()
                    ));
                }
                if !meta.is_empty() {
                    l += &format!(" _({})_", meta.join(", "));
                }
                l
            })
            .collect(),
        "No action items recorded.",
    ));
    sections.push(section(
        "Code References",
        i.code_references
            .iter()
            .map(|c| {
                let mut parts = Vec::new();
                if let Some(x) = c.file_path.as_deref().filter(|s| !s.is_empty()) {
                    parts.push(format!("`{x}`"));
                }
                if let Some(x) = c.symbol.as_deref().filter(|s| !s.is_empty()) {
                    parts.push(format!("symbol: `{x}`"));
                }
                if let Some(x) = c.repository.as_deref().filter(|s| !s.is_empty()) {
                    parts.push(format!("repo: {x}"));
                }
                if let Some(x) = c.context.as_deref().filter(|s| !s.is_empty()) {
                    parts.push(x.to_string());
                }
                if parts.is_empty() {
                    "- _unnamed reference_".to_string()
                } else {
                    format!("- {}", parts.join(" — "))
                }
            })
            .collect(),
        "No code references recorded.",
    ));
    sections.push(section(
        "Open Questions",
        i.open_questions
            .iter()
            .map(|q| {
                let mut l = format!("- {}", q.text);
                if let Some(x) = q.raised_by.as_deref().filter(|s| !s.is_empty()) {
                    l += &format!(" _(raised by {x})_");
                }
                if q.resolved {
                    l += " **[RESOLVED]**";
                }
                l
            })
            .collect(),
        "No open questions recorded.",
    ));
    sections.push(section(
        "Participants",
        i.participants.iter().map(|p| format!("- {p}")).collect(),
        "No participants recorded.",
    ));

    TransformedDocument {
        title: format!("Meeting Notes: {date}"),
        content: sections.join("\n\n"),
    }
}

/// Persist the meeting as a document in the `definition` stage (port of `createMeetingDocument`).
/// The `meeting_documents` side table of the TS is not ported; the full intelligence JSON can be
/// kept on the intake record instead. Call inside a transaction.
pub fn create_meeting_document(
    docs: &impl DocumentRepo,
    intelligence: &MeetingIntelligence,
    team_id: &str,
    created_by_id: &str,
) -> Result<Document> {
    let t = transform_to_document(intelligence);
    docs.create(&NewDocument {
        title: t.title,
        content: t.content,
        path: String::new(),
        team_id: team_id.to_string(),
        created_by_id: created_by_id.to_string(),
        stage: Some("definition".into()),
        lifecycle_id: None,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn colon_labels() {
        let s = diarize("Speaker 1: Hello there\nSpeaker B: Hi\nstill talking\n\nSpeaker 1: Bye");
        assert_eq!(s.len(), 3);
        assert_eq!(
            (s[0].speaker.as_str(), s[0].start_ms, s[0].end_ms),
            ("Speaker 1", 0, 5000)
        );
        assert_eq!(s[1].speaker, "Speaker B");
        assert_eq!(s[1].text, "Hi still talking");
        assert_eq!((s[1].start_ms, s[1].end_ms), (5000, 15000));
        assert_eq!((s[2].start_ms, s[2].end_ms), (15000, 20000));
    }

    #[test]
    fn bracket_labels_and_unknown_prefix() {
        let s = diarize("preamble line\n[John] one\n[Mary] two");
        assert_eq!(s.len(), 3, "preamble is attributed to Unknown");
        assert_eq!(s[0].speaker, "Unknown");
        assert_eq!(s[1].speaker, "John");
        assert_eq!(s[2].text, "two");
    }

    #[test]
    fn alternating_fallback_and_empty() {
        let s = diarize("first\nsecond\nthird");
        assert_eq!(
            s.iter().map(|x| x.speaker.as_str()).collect::<Vec<_>>(),
            vec!["Speaker 1", "Speaker 2", "Speaker 1"]
        );
        assert_eq!(s[2].end_ms, 15000);
        assert!(diarize("  \n ").is_empty());
        // A single labelled line is not enough to pick the colon strategy.
        assert_eq!(
            diarize("Speaker 1: only one")[0].text,
            "Speaker 1: only one"
        );
    }

    #[test]
    fn extraction_prompt_and_parse() {
        assert!(extraction_prompt("   ").is_none());
        let p = extraction_prompt("hello").unwrap();
        assert_eq!(p.max_tokens, 4096);
        assert!(p.user.ends_with("transcript:\n\nhello"));

        let reply = r#"```json
{"decisions":[{"id":"d-1","text":"Use Rust","madeBy":"Ana"}],
 "actionItems":[{"id":"a-1","text":"Ship","priority":"high","status":"pending"},{"bogus":1}],
 "codeReferences":[],"openQuestions":[{"id":"q-1","text":"When?","resolved":false}],
 "summary":"We chose Rust.","participants":["Ana","Bo"]}
```"#;
        let r = parse_intelligence_response(reply);
        assert_eq!(r.decisions[0].made_by.as_deref(), Some("Ana"));
        assert_eq!(r.action_items.len(), 1, "malformed item dropped");
        assert_eq!(r.action_items[0].priority, Some(Priority::High));
        assert_eq!(r.participants, vec!["Ana", "Bo"]);
        let bad = parse_intelligence_response("nope");
        assert_eq!(
            bad.summary,
            "Failed to parse transcript. Raw AI output preserved."
        );
        assert!(bad.decisions.is_empty());
    }

    fn sample() -> MeetingIntelligence {
        let parsed = ParsedIntelligence {
            decisions: vec![Decision {
                id: "d1".into(),
                text: "Use Fastify".into(),
                made_by: Some("Alice".into()),
                context: None,
                timestamp_ms: None,
            }],
            action_items: vec![ActionItem {
                id: "a1".into(),
                text: "Set up CI".into(),
                assignee: Some("Bob".into()),
                deadline: Some("2026-04-01".into()),
                priority: Some(Priority::High),
                status: ActionStatus::Pending,
            }],
            code_references: vec![CodeReference {
                id: "c1".into(),
                file_path: Some("src/app.ts".into()),
                symbol: Some("buildApp".into()),
                repository: Some("nyx".into()),
                context: None,
                timestamp_ms: None,
            }],
            open_questions: vec![OpenQuestion {
                id: "q1".into(),
                text: "Which DB?".into(),
                raised_by: Some("Cy".into()),
                context: None,
                resolved: true,
                timestamp_ms: None,
            }],
            summary: "We met.".into(),
            participants: vec!["Alice".into()],
        };
        build_intelligence(
            "s1",
            "Speaker 1: hi\nSpeaker 2: yo",
            parsed,
            "2026-03-01T10:30:00Z",
        )
    }

    #[test]
    fn intelligence_duration_comes_from_the_last_segment() {
        let i = sample();
        assert_eq!(i.duration, 10_000);
        assert_eq!(i.transcript.len(), 2);
        assert_eq!(
            build_intelligence("x", "", ParsedIntelligence::default(), "").duration,
            0
        );
    }

    #[test]
    fn document_rendering() {
        let d = transform_to_document(&sample());
        assert_eq!(d.title, "Meeting Notes: 2026-03-01 10:30:00 UTC");
        assert!(d.content.contains("- Use Fastify _(by Alice)_"));
        assert!(d
            .content
            .contains("- [ ] Set up CI _(assignee: Bob, deadline: 2026-04-01, priority: high)_"));
        assert!(d
            .content
            .contains("- `src/app.ts` — symbol: `buildApp` — repo: nyx"));
        assert!(d
            .content
            .contains("- Which DB? _(raised by Cy)_ **[RESOLVED]**"));
        assert!(d.content.contains("## Participants\n\n- Alice"));
    }

    #[test]
    fn empty_sections_use_placeholders() {
        let e = build_intelligence("e", "", ParsedIntelligence::default(), "");
        let d = transform_to_document(&e);
        assert_eq!(d.title, "Meeting Notes: Unknown Date");
        assert!(d.content.contains("_No summary available._"));
        assert!(d
            .content
            .contains("## Decisions\n\n_No decisions recorded._"));
        assert!(d.content.contains("_No participants recorded._"));
        assert!(transform_to_document(&build_intelligence(
            "e",
            "",
            ParsedIntelligence::default(),
            "garbage"
        ))
        .title
        .ends_with("Invalid Date"));
    }

    #[test]
    fn serde_uses_camel_case_like_the_ts() {
        let v = serde_json::to_value(sample()).unwrap();
        assert!(v.get("sessionId").is_some() && v.get("createdAt").is_some());
        assert_eq!(v["actionItems"][0]["status"], "pending");
        assert!(v["decisions"][0].get("context").is_none());
    }
}
