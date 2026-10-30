//! Tolerant parsers for model output. Models wrap JSON in code fences, add prose, get truncated
//! or ignore the format entirely; every parser here has a defined fallback instead of failing,
//! matching the `try { JSON.parse } catch { fallback }` behaviour of the TS service.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Remove every code-fence marker (```` ``` ````, optionally followed by `json`, plus trailing
/// whitespace) and trim. Port of `/```(?:json)?\s*\n?/g` + `/\n?\s*```/g`.
#[must_use]
pub fn strip_fences(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("```") {
        out.push_str(&rest[..i]);
        rest = &rest[i + 3..];
        if let Some(r) = rest.strip_prefix("json") {
            rest = r;
        }
        rest = rest.trim_start();
    }
    out.push_str(rest);
    out.trim().to_owned()
}

/// Strip one leading and one trailing fence (for markdown outputs, where inner fences are
/// content). Port of `/^```(?:markdown)?\n?/` + `/\n?```$/`.
#[must_use]
pub fn strip_edge_fences(text: &str) -> String {
    let mut t = text;
    if let Some(r) = t.strip_prefix("```") {
        t = r.strip_prefix("markdown").unwrap_or(r);
        t = t.strip_prefix('\n').unwrap_or(t);
    }
    if let Some(r) = t.strip_suffix("```") {
        t = r.strip_suffix('\n').unwrap_or(r);
    }
    t.to_owned()
}

/// Like [`strip_edge_fences`] but also accepting a `json` language tag (for JSON outputs).
fn strip_edge_json_fences(text: &str) -> String {
    let mut t = text;
    if let Some(r) = t.strip_prefix("```") {
        t = r.strip_prefix("json").unwrap_or(r);
        t = t.strip_prefix('\n').unwrap_or(t);
    }
    if let Some(r) = t.strip_suffix("```") {
        t = r.strip_suffix('\n').unwrap_or(r);
    }
    t.to_owned()
}

/// Slice from the first `{` that is followed (in order) by each of `keys` as a JSON key
/// (`"key"` then optional whitespace then `:`) and a closing `}`, to the last `}`.
/// Port of `/\{[\s\S]*"score"\s*:[\s\S]*"suggestions"\s*:[\s\S]*\}/`.
#[must_use]
pub fn find_keyed_object<'a>(text: &'a str, keys: &[&str]) -> Option<&'a str> {
    let last_close = text.rfind('}')?;
    for (start, _) in text.match_indices('{') {
        if start > last_close {
            break;
        }
        let mut pos = start + 1;
        let mut ok = true;
        for key in keys {
            let needle = format!("\"{key}\"");
            let mut found = None;
            let mut from = pos;
            while let Some(rel) = text[from..].find(&needle) {
                let after = from + rel + needle.len();
                if text[after..].trim_start().starts_with(':') {
                    found = Some(after);
                    break;
                }
                from = from + rel + 1;
            }
            if let Some(p) = found {
                pos = p;
            } else {
                ok = false;
                break;
            }
        }
        if ok && pos <= last_close {
            return Some(&text[start..=last_close]);
        }
    }
    None
}

/// First `<digits> / 10` occurrence (spaces allowed around the slash), e.g. `7/10`, `8 / 10`.
#[must_use]
pub fn score_from_prose(text: &str) -> Option<f64> {
    let b: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            let mut j = i;
            while j < b.len() && b[j].is_whitespace() {
                j += 1;
            }
            if j < b.len() && b[j] == '/' {
                j += 1;
                while j < b.len() && b[j].is_whitespace() {
                    j += 1;
                }
                if j + 1 < b.len() && b[j] == '1' && b[j + 1] == '0' {
                    let s: String = b[start..i].iter().collect();
                    return s.parse().ok();
                }
            }
        } else {
            i += 1;
        }
    }
    None
}

fn clamp_score(n: f64) -> f64 {
    if n.is_finite() {
        n.clamp(0.0, 10.0)
    } else {
        5.0
    }
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn string_or(v: Option<&Value>, default: &str) -> String {
    v.and_then(Value::as_str)
        .map_or_else(|| default.to_owned(), str::to_owned)
}

fn non_empty_or(v: Option<&Value>, default: &str) -> String {
    match v.and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s.to_owned(),
        _ => default.to_owned(),
    }
}

#[allow(clippy::cast_sign_loss)] // filtered to >= 0 and clamped below
fn count(v: Option<&Value>) -> u32 {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map_or(0, |n| n.min(f64::from(u32::MAX)) as u32)
}

/// Quality assessment of a spec.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpecQuality {
    /// 0-10 (clamped; the model is asked for 1-10).
    pub score: f64,
    /// Actionable improvements.
    pub suggestions: Vec<String>,
}

/// Parse a spec-quality reply. Never fails:
/// valid JSON gives `score` (default 5 if not a number) and `suggestions`;
/// unparseable text gives the `N/10` score found in prose (default 5) and the raw text as the
/// single suggestion.
#[must_use]
pub fn spec_quality(raw: &str) -> SpecQuality {
    let text = strip_fences(raw);
    let candidate = find_keyed_object(&text, &["score", "suggestions"]).unwrap_or(&text);
    match serde_json::from_str::<Value>(candidate) {
        Ok(v) => SpecQuality {
            score: v
                .get("score")
                .and_then(Value::as_f64)
                .map_or(5.0, clamp_score),
            suggestions: strings(v.get("suggestions")),
        },
        Err(_) => SpecQuality {
            score: score_from_prose(&text).map_or(5.0, clamp_score),
            suggestions: vec![text],
        },
    }
}

/// Spec-vs-code drift report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftReport {
    /// Any drift found.
    pub has_drift: bool,
    /// 0-10.
    pub drift_score: f64,
    /// Description.
    pub details: String,
    /// Suggested fixes.
    pub suggestions: Vec<String>,
}

/// Parse a drift reply; non-JSON becomes "no drift, raw text as details" (TS fallback).
#[must_use]
pub fn drift(raw: &str) -> DriftReport {
    match serde_json::from_str::<Value>(raw) {
        Ok(v) if v.is_object() => DriftReport {
            has_drift: v.get("hasDrift").and_then(Value::as_bool).unwrap_or(false),
            drift_score: v
                .get("driftScore")
                .and_then(Value::as_f64)
                .map_or(0.0, clamp_score),
            details: string_or(v.get("details"), ""),
            suggestions: strings(v.get("suggestions")),
        },
        _ => DriftReport {
            has_drift: false,
            drift_score: 0.0,
            details: raw.to_owned(),
            suggestions: Vec::new(),
        },
    }
}

/// A draft ticket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketDraft {
    /// Title.
    pub title: String,
    /// Markdown description.
    pub description: String,
    /// Labels.
    pub labels: Vec<String>,
}

/// Parse a single-ticket reply; unparseable output becomes the generic spec-change ticket.
#[must_use]
pub fn ticket(raw: &str) -> TicketDraft {
    match serde_json::from_str::<Value>(raw) {
        Ok(v) if v.is_object() => TicketDraft {
            title: string_or(v.get("title"), ""),
            description: string_or(v.get("description"), ""),
            labels: strings(v.get("labels")),
        },
        _ => TicketDraft {
            title: "Implement code changes to match spec updates".into(),
            description: raw.to_owned(),
            labels: vec!["spec-change".into(), "implementation".into()],
        },
    }
}

/// A ticket proposed from a change analysis.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestedTicket {
    /// Title.
    pub title: String,
    /// Description.
    pub description: String,
    /// `high` / `medium` / `low` (verbatim from the model).
    pub priority: String,
    /// Labels.
    pub labels: Vec<String>,
}

/// Result of analysing version changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeAnalysis {
    /// Proposal title.
    pub title: String,
    /// Summary of the changes.
    pub description: String,
    /// Suggested tickets.
    pub suggested_tickets: Vec<SuggestedTicket>,
}

/// Parse a change-analysis reply; unparseable output yields one `Update <title>` ticket.
#[must_use]
pub fn change_analysis(raw: &str, document_title: &str) -> ChangeAnalysis {
    let text = strip_edge_json_fences(raw);
    match serde_json::from_str::<Value>(&text) {
        Ok(v) if v.is_object() => ChangeAnalysis {
            title: string_or(v.get("title"), ""),
            description: string_or(v.get("description"), ""),
            suggested_tickets: v
                .get("suggestedTickets")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|t| SuggestedTicket {
                            title: string_or(t.get("title"), ""),
                            description: string_or(t.get("description"), ""),
                            priority: string_or(t.get("priority"), "medium"),
                            labels: strings(t.get("labels")),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        _ => ChangeAnalysis {
            title: format!("Changes to {document_title}"),
            description: text.clone(),
            suggested_tickets: vec![SuggestedTicket {
                title: format!("Update {document_title}"),
                description: text,
                priority: "medium".into(),
                labels: vec!["spec-change".into()],
            }],
        },
    }
}

/// A missing section in a spec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissingSection {
    /// Section name.
    pub name: String,
    /// Why it matters.
    pub description: String,
    /// `high` / `medium` / `low`.
    pub priority: String,
}

/// Parse a missing-sections reply; anything unparseable is "nothing missing".
#[must_use]
pub fn missing_sections(raw: &str) -> Vec<MissingSection> {
    let text = strip_fences(raw);
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| {
            v.get("missingSections").and_then(Value::as_array).map(|a| {
                a.iter()
                    .map(|s| MissingSection {
                        name: string_or(s.get("name"), ""),
                        description: string_or(s.get("description"), ""),
                        priority: string_or(s.get("priority"), "medium"),
                    })
                    .collect()
            })
        })
        .unwrap_or_default()
}

/// Reply to an advisor notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationReply {
    /// Reply text.
    pub reply: String,
    /// Follow-up actions.
    pub suggested_actions: Vec<String>,
}

/// Parse a notification reply; plain text becomes the reply itself.
#[must_use]
pub fn notification_reply(raw: &str) -> NotificationReply {
    let text = strip_fences(raw);
    match serde_json::from_str::<Value>(&text) {
        Ok(v) if v.is_object() => NotificationReply {
            reply: non_empty_or(v.get("reply"), &text),
            suggested_actions: strings(v.get("suggestedActions")),
        },
        _ => NotificationReply {
            reply: text,
            suggested_actions: Vec::new(),
        },
    }
}

/// Parse a JSON array of tickets out of model text, tolerating fences, surrounding prose and
/// truncation (salvages every complete object before the cut). Empty on failure.
/// Port of `parseJsonArray`.
#[must_use]
pub fn ticket_array(raw: &str) -> Vec<TicketDraft> {
    let text = strip_fences(raw);
    let Some(first) = text.find('[') else {
        return Vec::new();
    };
    let tail = &text[first..];
    let to_tickets = |v: &Value| -> Vec<TicketDraft> {
        v.as_array()
            .map(|a| {
                a.iter()
                    .map(|t| TicketDraft {
                        title: string_or(t.get("title"), ""),
                        description: string_or(t.get("description"), ""),
                        labels: strings(t.get("labels")),
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    // 1. Clean array, possibly followed by prose.
    if let Some(last) = tail.rfind(']') {
        if let Ok(v) = serde_json::from_str::<Value>(&tail[..=last]) {
            return to_tickets(&v);
        }
    }
    // 2. Truncated: keep every complete object before the cut. (The TS version cut at the last
    //    `]` first, which lost the salvage whenever a label list closed after the last full
    //    object; salvaging from the whole tail fixes that.)
    tail.rfind("},")
        .and_then(|i| serde_json::from_str::<Value>(&format!("{}]", &tail[..=i])).ok())
        .map(|v| to_tickets(&v))
        .unwrap_or_default()
}

/// Breakdown of the five decision-weight signals.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeightBreakdown {
    /// TBDs, open questions, vague language.
    pub ambiguity: f64,
    /// External systems touched.
    pub integration_surface: f64,
    /// How hard correctness is to verify.
    pub validation_difficulty: f64,
    /// Number of distinct work items.
    pub scope_spread: f64,
    /// Lack of prior art.
    pub novelty: f64,
}

/// Human-judgment cost estimate for shipping a spec.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionWeight {
    /// Sum of the breakdown (recomputed; the model's own `weight` is ignored).
    pub weight: f64,
    /// Signals.
    pub breakdown: WeightBreakdown,
    /// Items driving the weight up.
    pub bottlenecks: Vec<String>,
    /// Expected human review passes.
    pub review_cycles: f64,
}

/// Parse a decision-weight reply. Each signal is clamped to 0-20. A missing or non-numeric
/// breakdown yields the TS fallback (weight 50, all signals 10, 3 review cycles).
#[must_use]
pub fn decision_weight(raw: &str) -> DecisionWeight {
    let fallback = || DecisionWeight {
        weight: 50.0,
        breakdown: WeightBreakdown {
            ambiguity: 10.0,
            integration_surface: 10.0,
            validation_difficulty: 10.0,
            scope_spread: 10.0,
            novelty: 10.0,
        },
        bottlenecks: vec!["Could not parse document for capacity estimation".into()],
        review_cycles: 3.0,
    };
    let text = strip_fences(raw);
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return fallback();
    };
    let Some(b) = v.get("breakdown") else {
        return fallback();
    };
    let sig = |k: &str| {
        b.get(k)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
            .map(|n| n.clamp(0.0, 20.0))
    };
    let (
        Some(ambiguity),
        Some(integration_surface),
        Some(validation_difficulty),
        Some(scope_spread),
        Some(novelty),
    ) = (
        sig("ambiguity"),
        sig("integrationSurface"),
        sig("validationDifficulty"),
        sig("scopeSpread"),
        sig("novelty"),
    )
    else {
        return fallback();
    };
    DecisionWeight {
        weight: ambiguity + integration_surface + validation_difficulty + scope_spread + novelty,
        breakdown: WeightBreakdown {
            ambiguity,
            integration_surface,
            validation_difficulty,
            scope_spread,
            novelty,
        },
        bottlenecks: strings(v.get("bottlenecks")),
        review_cycles: v.get("reviewCycles").and_then(Value::as_f64).unwrap_or(3.0),
    }
}

/// Counts extracted from meeting notes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingMetrics {
    /// Decisions recorded.
    pub decisions: u32,
    /// Action items.
    pub action_items: u32,
    /// Resolvable code references.
    pub code_references: u32,
    /// Open questions.
    pub open_questions: u32,
}

/// Meeting-note quality result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingQuality {
    /// 0-10.
    pub score: f64,
    /// Improvements.
    pub suggestions: Vec<String>,
    /// Extracted counts.
    pub meeting_metrics: MeetingMetrics,
}

/// Parse a meeting-quality reply (same fallbacks as [`spec_quality`], metrics zeroed).
#[must_use]
pub fn meeting_quality(raw: &str) -> MeetingQuality {
    let text = strip_fences(raw);
    let candidate =
        find_keyed_object(&text, &["score", "suggestions", "meetingMetrics"]).unwrap_or(&text);
    match serde_json::from_str::<Value>(candidate) {
        Ok(v) => {
            let m = v.get("meetingMetrics");
            let c = |k: &str| count(m.and_then(|m| m.get(k)));
            MeetingQuality {
                score: v
                    .get("score")
                    .and_then(Value::as_f64)
                    .map_or(5.0, clamp_score),
                suggestions: strings(v.get("suggestions")),
                meeting_metrics: MeetingMetrics {
                    decisions: c("decisions"),
                    action_items: c("actionItems"),
                    code_references: c("codeReferences"),
                    open_questions: c("openQuestions"),
                },
            }
        }
        Err(_) => MeetingQuality {
            score: score_from_prose(&text).map_or(5.0, clamp_score),
            suggestions: vec![text],
            meeting_metrics: MeetingMetrics::default(),
        },
    }
}

/// A generated markdown document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeneratedDocument {
    /// Title from the first `# ` heading, else `Untitled Document`.
    pub title: String,
    /// Full markdown.
    pub content: String,
}

/// Build a [`GeneratedDocument`] from markdown text (trimmed). The title is the first H1 line
/// anywhere in the text (`/^#\s+(.+)$/m`).
#[must_use]
pub fn document(raw: &str) -> GeneratedDocument {
    let content = raw.trim().to_owned();
    let title = content
        .lines()
        .find_map(|l| {
            let rest = l.strip_prefix('#')?;
            if !rest.starts_with(char::is_whitespace) {
                return None;
            }
            let t = rest.trim();
            (!t.is_empty()).then(|| t.to_owned())
        })
        .unwrap_or_else(|| "Untitled Document".into());
    GeneratedDocument { title, content }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fences_are_stripped_everywhere() {
        assert_eq!(strip_fences("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_fences("pre ```\nx\n``` post"), "pre x\npost");
        assert_eq!(strip_fences("  plain  "), "plain");
        assert_eq!(
            strip_edge_fences("```markdown\n# T\nbody\n```"),
            "# T\nbody"
        );
        assert_eq!(strip_edge_fences("```\nx\n```"), "x");
        assert_eq!(strip_edge_fences("no fences"), "no fences");
        assert_eq!(strip_edge_fences("a ```inner``` b"), "a ```inner``` b");
    }

    #[test]
    fn quality_valid_json_and_variants() {
        let q = spec_quality(r#"{"score": 8, "suggestions": ["a", "b"]}"#);
        assert_eq!(
            q,
            SpecQuality {
                score: 8.0,
                suggestions: vec!["a".into(), "b".into()]
            }
        );
        assert_eq!(
            spec_quality("```json\n{\"score\":10,\"suggestions\":[]}\n```").score,
            10.0
        );
        // Prose around the object.
        let q = spec_quality(
            "Sure! Here you go: {\"score\": 6, \"suggestions\": [\"x\"]} hope that helps",
        );
        assert_eq!(q.score, 6.0);
        assert_eq!(q.suggestions, vec!["x"]);
    }

    #[test]
    fn quality_malformed_output_falls_back() {
        let q = spec_quality("This spec deserves a 7/10 overall.");
        assert_eq!(q.score, 7.0);
        assert_eq!(q.suggestions, vec!["This spec deserves a 7/10 overall."]);
        assert_eq!(spec_quality("nothing numeric").score, 5.0);
        assert_eq!(spec_quality("").suggestions, vec![String::new()]);
        // Truncated JSON.
        let q = spec_quality("{\"score\": 9, \"suggestions\": [\"a\"");
        assert_eq!(q.score, 5.0);
        // Wrong types.
        let q = spec_quality(r#"{"score": "high", "suggestions": "none"}"#);
        assert_eq!(q.score, 5.0);
        assert!(q.suggestions.is_empty());
        // Not an object.
        assert_eq!(spec_quality("[1,2]").score, 5.0);
        // Out of range is clamped.
        assert_eq!(
            spec_quality(r#"{"score": 42, "suggestions": []}"#).score,
            10.0
        );
        assert_eq!(
            spec_quality(r#"{"score": -3, "suggestions": []}"#).score,
            0.0
        );
    }

    #[test]
    fn prose_score_variants() {
        assert_eq!(score_from_prose("score: 8 / 10"), Some(8.0));
        assert_eq!(score_from_prose("12 apples, 3/10"), Some(3.0));
        assert_eq!(score_from_prose("7/9"), None);
        assert_eq!(score_from_prose("no digits"), None);
    }

    #[test]
    fn keyed_object_requires_keys_in_order() {
        assert!(find_keyed_object(
            r#"x {"suggestions":[], "score": 1}"#,
            &["score", "suggestions"]
        )
        .is_none());
        assert_eq!(
            find_keyed_object(
                r#"a {"score" : 1, "suggestions": []} b"#,
                &["score", "suggestions"]
            ),
            Some(r#"{"score" : 1, "suggestions": []}"#)
        );
        assert!(find_keyed_object("{}", &["score"]).is_none());
        assert!(find_keyed_object("no braces", &["score"]).is_none());
    }

    #[test]
    fn drift_parse_and_fallback() {
        let d =
            drift(r#"{"hasDrift": true, "driftScore": 7, "details": "x", "suggestions": ["f"]}"#);
        assert!(d.has_drift);
        assert_eq!(d.drift_score, 7.0);
        assert_eq!(d.suggestions, vec!["f"]);
        let f = drift("garbage");
        assert!(
            !f.has_drift
                && f.drift_score == 0.0
                && f.details == "garbage"
                && f.suggestions.is_empty()
        );
        // Partial object gets defaults rather than failing.
        assert!(!drift(r#"{"details":"only"}"#).has_drift);
    }

    #[test]
    fn ticket_parse_and_fallback() {
        let t = ticket(r#"{"title":"Add X","description":"d","labels":["a"]}"#);
        assert_eq!(t.title, "Add X");
        let f = ticket("not json at all");
        assert_eq!(f.title, "Implement code changes to match spec updates");
        assert_eq!(f.description, "not json at all");
        assert_eq!(f.labels, vec!["spec-change", "implementation"]);
    }

    #[test]
    fn change_analysis_parse_and_fallback() {
        let r = change_analysis(
            "```json\n{\"title\":\"P\",\"description\":\"D\",\"suggestedTickets\":[{\"title\":\"T\",\"description\":\"x\",\"priority\":\"high\",\"labels\":[\"l\"]}]}\n```",
            "Doc",
        );
        assert_eq!(r.title, "P");
        assert_eq!(r.suggested_tickets[0].priority, "high");
        let f = change_analysis("oops", "Doc");
        assert_eq!(f.title, "Changes to Doc");
        assert_eq!(f.suggested_tickets[0].title, "Update Doc");
        assert_eq!(f.suggested_tickets[0].labels, vec!["spec-change"]);
        // Valid JSON but no tickets array.
        assert!(change_analysis("{}", "Doc").suggested_tickets.is_empty());
    }

    #[test]
    fn missing_sections_parse_and_fallback() {
        let m = missing_sections(
            r#"{"missingSections":[{"name":"Risks","description":"why","priority":"high"}]}"#,
        );
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].name, "Risks");
        assert!(missing_sections("nope").is_empty());
        assert!(missing_sections(r#"{"missingSections":"x"}"#).is_empty());
        assert!(missing_sections("{}").is_empty());
    }

    #[test]
    fn notification_reply_parse_and_fallback() {
        let r = notification_reply(r#"{"reply":"ok","suggestedActions":["a"]}"#);
        assert_eq!(r.reply, "ok");
        assert_eq!(r.suggested_actions, vec!["a"]);
        let r = notification_reply("just text");
        assert_eq!(r.reply, "just text");
        assert!(r.suggested_actions.is_empty());
        // Empty reply field falls back to the raw text.
        assert_eq!(
            notification_reply(r#"{"reply":""}"#).reply,
            r#"{"reply":""}"#
        );
    }

    #[test]
    fn ticket_array_variants() {
        let ok = r#"[{"title":"A","description":"d","labels":["x"]},{"title":"B","description":"e","labels":[]}]"#;
        assert_eq!(ticket_array(ok).len(), 2);
        assert_eq!(ticket_array(&format!("```json\n{ok}\n```")).len(), 2);
        assert_eq!(
            ticket_array(&format!("Here are tickets:\n{ok}\nEnjoy")).len(),
            2
        );
        // Truncated mid-second-object: salvage the first.
        let cut = r#"[{"title":"A","description":"d","labels":["x"]},{"title":"B","descr"#;
        let t = ticket_array(cut);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].title, "A");
        assert!(ticket_array("no array here").is_empty());
        assert!(ticket_array("[]").is_empty());
        assert!(ticket_array("").is_empty());
    }

    #[test]
    fn decision_weight_recomputes_sum() {
        let r = decision_weight(
            r#"{"weight": 99, "breakdown": {"ambiguity": 5, "integrationSurface": 4, "validationDifficulty": 3, "scopeSpread": 2, "novelty": 1}, "bottlenecks": ["b"], "reviewCycles": 4}"#,
        );
        assert_eq!(r.weight, 15.0);
        assert_eq!(r.review_cycles, 4.0);
        assert_eq!(r.bottlenecks, vec!["b"]);
        // Missing reviewCycles defaults to 3; out-of-range signal is clamped.
        let r = decision_weight(
            r#"{"breakdown": {"ambiguity": 99, "integrationSurface": 1, "validationDifficulty": 1, "scopeSpread": 1, "novelty": 1}}"#,
        );
        assert_eq!(r.breakdown.ambiguity, 20.0);
        assert_eq!(r.review_cycles, 3.0);
    }

    #[test]
    fn decision_weight_fallbacks() {
        for bad in [
            "junk",
            "{}",
            r#"{"breakdown":{"ambiguity":1}}"#,
            r#"{"breakdown":"x"}"#,
        ] {
            let r = decision_weight(bad);
            assert_eq!(r.weight, 50.0, "{bad}");
            assert_eq!(r.review_cycles, 3.0);
            assert_eq!(
                r.bottlenecks,
                vec!["Could not parse document for capacity estimation"]
            );
        }
    }

    #[test]
    fn meeting_quality_parse_and_fallback() {
        let q = meeting_quality(
            r#"{"score":7,"suggestions":["s"],"meetingMetrics":{"decisions":2,"actionItems":3,"codeReferences":1,"openQuestions":-4}}"#,
        );
        assert_eq!(q.score, 7.0);
        assert_eq!(
            q.meeting_metrics,
            MeetingMetrics {
                decisions: 2,
                action_items: 3,
                code_references: 1,
                open_questions: 0
            }
        );
        let f = meeting_quality("Rating: 4/10, needs owners");
        assert_eq!(f.score, 4.0);
        assert_eq!(f.meeting_metrics, MeetingMetrics::default());
        assert_eq!(f.suggestions, vec!["Rating: 4/10, needs owners"]);
        // Missing metrics object zeroes them.
        let q = meeting_quality(r#"{"score":9,"suggestions":[],"meetingMetrics":{}}"#);
        assert_eq!(q.meeting_metrics, MeetingMetrics::default());
    }

    #[test]
    fn document_title_extraction() {
        assert_eq!(document("# My Doc\n\nbody").title, "My Doc");
        assert_eq!(document("intro\n\n# Later Title\nx").title, "Later Title");
        assert_eq!(document("no heading").title, "Untitled Document");
        assert_eq!(document("## Not H1\nx").title, "Untitled Document");
        assert_eq!(document("#NoSpace\nx").title, "Untitled Document");
        assert_eq!(document("  \n# Padded  \n").content, "# Padded");
        assert_eq!(document("# Padded  ").title, "Padded");
    }
}
