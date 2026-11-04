//! Feedback (`feedback.service.ts`, `routes/feedback.ts`): formatting, a rate limit and stored
//! records. Submission to GitHub sits behind [`IssueSubmitter`] and formatting behind
//! [`FeedbackFormatter`]; the in-app LLM formatter is dropped, so [`HeuristicFormatter`] provides
//! an offline default. A real GitHub impl is a TODO for the `GitProvider` ticket (AI-66).

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::model::{new_id, Id, Timestamp};
use crate::notify::Clock;
use crate::store::db_err;

/// Submissions allowed per user per rolling day.
pub const MAX_PER_DAY: u32 = 5;
/// Longest accepted raw message, in characters.
pub const MAX_MESSAGE_CHARS: usize = 5000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Categories the formatter may assign.
pub const CATEGORIES: &[&str] = &[
    "bug",
    "feature-request",
    "ux-improvement",
    "documentation",
    "other",
];

/// A formatted feedback item (becomes the issue title/body).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormattedFeedback {
    /// Issue title (under 80 characters).
    pub title: String,
    /// Markdown body.
    pub body: String,
    /// One of [`CATEGORIES`] (free text from an LLM is accepted).
    pub category: String,
}

/// Parse an LLM answer into [`FormattedFeedback`] with the TS fallbacks: strip code fences, and on
/// invalid JSON or empty fields use `User Feedback` / the raw message / `other`.
#[must_use]
pub fn parse_formatted(text: &str, raw_message: &str) -> FormattedFeedback {
    let cleaned = text.replace("```json", "").replace("```", "");
    let parsed: Option<serde_json::Value> = serde_json::from_str(cleaned.trim()).ok();
    let field = |k: &str| {
        parsed
            .as_ref()
            .and_then(|v| v.get(k))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
    };
    FormattedFeedback {
        title: field("title").unwrap_or_else(|| "User Feedback".into()),
        body: field("body").unwrap_or_else(|| raw_message.into()),
        category: field("category").unwrap_or_else(|| "other".into()),
    }
}

/// Turns raw feedback into an issue-shaped record.
pub trait FeedbackFormatter {
    /// Format a trimmed, validated message.
    fn format(&self, raw_message: &str) -> Result<FormattedFeedback>;
}

/// Offline formatter: first line as title (cut at 80 characters), keyword-based category.
#[derive(Debug, Default, Clone, Copy)]
pub struct HeuristicFormatter;

impl FeedbackFormatter for HeuristicFormatter {
    fn format(&self, raw: &str) -> Result<FormattedFeedback> {
        let first = raw
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or(raw)
            .trim();
        let title = if first.chars().count() > 80 {
            let cut: String = first.chars().take(77).collect();
            format!("{}...", cut.trim_end())
        } else {
            first.to_string()
        };
        let lower = raw.to_lowercase();
        let has = |words: &[&str]| words.iter().any(|w| lower.contains(w));
        let category = if has(&[
            "crash",
            "bug",
            "error",
            "broken",
            "doesn't work",
            "does not work",
        ]) {
            "bug"
        } else if has(&[
            "feature",
            "would be nice",
            "please add",
            "wish",
            "support for",
        ]) {
            "feature-request"
        } else if has(&["confusing", "ux", "hard to", "layout", "button"]) {
            "ux-improvement"
        } else if has(&["docs", "documentation", "readme", "typo"]) {
            "documentation"
        } else {
            "other"
        };
        Ok(FormattedFeedback {
            title,
            body: format!("## Description\n\n{raw}"),
            category: category.into(),
        })
    }
}

/// An issue created on the tracker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmittedIssue {
    /// Issue URL.
    pub url: String,
    /// Issue number.
    pub number: i64,
}

/// Creates a tracker issue from feedback. A real GitHub impl is left as a TODO (see module docs).
pub trait IssueSubmitter {
    /// Submit; `Err` is non-fatal for [`FeedbackService::submit`].
    fn submit(&self, title: &str, body: &str, category: &str, who: &str) -> Result<SubmittedIssue>;
}

/// Records submissions; optionally fails.
#[derive(Debug, Default)]
pub struct FakeIssueSubmitter {
    submitted: std::sync::Mutex<Vec<(String, String, String)>>,
    fail: bool,
}

impl FakeIssueSubmitter {
    /// Always succeeds with issue numbers 1, 2, ...
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Always fails.
    #[must_use]
    pub fn failing() -> Self {
        Self {
            submitted: std::sync::Mutex::default(),
            fail: true,
        }
    }

    /// `(title, body, category)` of every submission.
    #[must_use]
    pub fn submitted(&self) -> Vec<(String, String, String)> {
        self.submitted.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

impl IssueSubmitter for FakeIssueSubmitter {
    fn submit(
        &self,
        title: &str,
        body: &str,
        category: &str,
        _who: &str,
    ) -> Result<SubmittedIssue> {
        if self.fail {
            return Err(Error::Invalid("issue tracker unavailable".into()));
        }
        let mut g = self
            .submitted
            .lock()
            .map_err(|_| Error::Invalid("poisoned".into()))?;
        g.push((title.into(), body.into(), category.into()));
        let n = i64::try_from(g.len()).unwrap_or(i64::MAX);
        Ok(SubmittedIssue {
            url: format!("https://example.invalid/issues/{n}"),
            number: n,
        })
    }
}

/// Issue body with the submitter footer used by the TS service.
#[must_use]
pub fn build_issue_body(body: &str, category: &str, user_name: &str, user_email: &str) -> String {
    format!(
        "{body}\n\n---\n_Submitted by: {user_name} ({user_email})_\n_Category: {category}_\n_Submitted via Nyx feedback_"
    )
}

/// A stored feedback record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedbackRecord {
    /// Id.
    pub id: Id,
    /// Author.
    pub user_id: Id,
    /// Original message.
    pub raw_message: String,
    /// Formatted title.
    pub formatted_title: String,
    /// Formatted body.
    pub formatted_body: String,
    /// Category.
    pub category: String,
    /// Issue URL when submitted.
    pub github_issue_url: Option<String>,
    /// Issue number when submitted.
    pub github_issue_number: Option<i64>,
    /// Creation.
    pub created_at: Timestamp,
}

/// Rate-limit state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimit {
    /// Whether another submission is allowed.
    pub allowed: bool,
    /// Submissions left in the window.
    pub remaining: u32,
}

/// Result of [`FeedbackService::submit`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitOutcome {
    /// Saved record (saved even when the tracker call failed, like the TS route).
    pub record: FeedbackRecord,
    /// Error text if issue submission failed.
    pub submit_error: Option<String>,
}

fn row(r: &Row<'_>) -> rusqlite::Result<FeedbackRecord> {
    Ok(FeedbackRecord {
        id: r.get("id")?,
        user_id: r.get("user_id")?,
        raw_message: r.get("raw_message")?,
        formatted_title: r.get("formatted_title")?,
        formatted_body: r.get("formatted_body")?,
        category: r.get("category")?,
        github_issue_url: r.get("github_issue_url")?,
        github_issue_number: r.get("github_issue_number")?,
        created_at: r.get("created_at")?,
    })
}

/// Feedback service over a connection.
pub struct FeedbackService<'c> {
    conn: &'c Connection,
    clock: Clock,
}

impl<'c> FeedbackService<'c> {
    /// New service on the system clock.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self {
            conn,
            clock: Clock::system(),
        }
    }

    /// Override the clock (tests).
    #[must_use]
    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    /// Validate a raw message: non-blank and at most [`MAX_MESSAGE_CHARS`]. Returns it trimmed.
    pub fn validate_message(message: &str) -> Result<&str> {
        let m = message.trim();
        if m.is_empty() {
            return Err(Error::Invalid("message is required".into()));
        }
        if m.chars().count() > MAX_MESSAGE_CHARS {
            return Err(Error::Invalid(format!(
                "message must be under {MAX_MESSAGE_CHARS} characters"
            )));
        }
        Ok(m)
    }

    /// Validate then format with `formatter`.
    pub fn format(
        &self,
        formatter: &dyn FeedbackFormatter,
        message: &str,
    ) -> Result<FormattedFeedback> {
        formatter.format(Self::validate_message(message)?)
    }

    /// Submissions in the last 24 hours versus [`MAX_PER_DAY`].
    pub fn check_rate_limit(&self, user_id: &str) -> Result<RateLimit> {
        let since = self.clock.now() - DAY_MS;
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM feedback_submissions WHERE user_id=?1 AND created_at >= ?2",
            params![user_id, since],
            |r| r.get(0),
        )?;
        let used = u32::try_from(n).unwrap_or(u32::MAX);
        Ok(RateLimit {
            allowed: used < MAX_PER_DAY,
            remaining: MAX_PER_DAY.saturating_sub(used),
        })
    }

    /// Store a record (`saveFeedback`).
    pub fn save(
        &self,
        user_id: &str,
        raw_message: &str,
        formatted: &FormattedFeedback,
        issue: Option<&SubmittedIssue>,
    ) -> Result<FeedbackRecord> {
        let id = new_id();
        self.conn
            .execute(
                "INSERT INTO feedback_submissions (id,user_id,raw_message,formatted_title,formatted_body,category,github_issue_url,github_issue_number,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    id, user_id, raw_message, formatted.title, formatted.body, formatted.category,
                    issue.map(|i| i.url.as_str()), issue.map(|i| i.number), self.clock.now()
                ],
            )
            .map_err(db_err)?;
        self.get(&id)
    }

    /// Fetch one record.
    pub fn get(&self, id: &str) -> Result<FeedbackRecord> {
        self.conn
            .query_row("SELECT * FROM feedback_submissions WHERE id=?1", [id], row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("feedback {id}")))
    }

    /// A user's records, newest first.
    pub fn list_for_user(&self, user_id: &str) -> Result<Vec<FeedbackRecord>> {
        let mut s = self.conn.prepare(
            "SELECT * FROM feedback_submissions WHERE user_id=?1 ORDER BY created_at DESC, rowid DESC",
        )?;
        let v = s
            .query_map([user_id], row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(v)
    }

    /// Full submit flow of the TS route: validate, rate limit (`Conflict` when exceeded), try the
    /// tracker (failure is recorded in the outcome, not fatal), then save locally.
    pub fn submit(
        &self,
        submitter: Option<&dyn IssueSubmitter>,
        user_id: &str,
        raw_message: &str,
        formatted: &FormattedFeedback,
        user_name: &str,
        user_email: &str,
    ) -> Result<SubmitOutcome> {
        if raw_message.trim().is_empty()
            || formatted.title.trim().is_empty()
            || formatted.body.trim().is_empty()
            || formatted.category.trim().is_empty()
        {
            return Err(Error::Invalid(
                "rawMessage, title, body, and category are required".into(),
            ));
        }
        let limit = self.check_rate_limit(user_id)?;
        if !limit.allowed {
            return Err(Error::Conflict(format!(
                "Rate limit exceeded. Maximum {MAX_PER_DAY} feedback submissions per day."
            )));
        }
        let mut issue = None;
        let mut submit_error = None;
        if let Some(s) = submitter {
            let body =
                build_issue_body(&formatted.body, &formatted.category, user_name, user_email);
            match s.submit(&formatted.title, &body, &formatted.category, user_name) {
                Ok(i) => issue = Some(i),
                Err(e) => submit_error = Some(e.to_string()),
            }
        }
        let record = self.save(user_id, raw_message, formatted, issue.as_ref())?;
        Ok(SubmitOutcome {
            record,
            submit_error,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_formatted_falls_back() {
        let ok = parse_formatted(
            "```json\n{\"title\":\"T\",\"body\":\"B\",\"category\":\"bug\"}\n```",
            "raw",
        );
        assert_eq!(
            (ok.title.as_str(), ok.body.as_str(), ok.category.as_str()),
            ("T", "B", "bug")
        );
        let bad = parse_formatted("not json", "raw msg");
        assert_eq!(
            bad,
            FormattedFeedback {
                title: "User Feedback".into(),
                body: "raw msg".into(),
                category: "other".into()
            }
        );
        let partial = parse_formatted("{\"title\":\"\",\"body\":\"B\"}", "raw");
        assert_eq!(partial.title, "User Feedback");
        assert_eq!(partial.body, "B");
    }

    #[test]
    fn heuristic_title_and_category() {
        let f = HeuristicFormatter
            .format(&format!("App crashes on start {}", "x".repeat(100)))
            .unwrap();
        assert!(f.title.chars().count() <= 80);
        assert_eq!(f.category, "bug");
        assert_eq!(
            HeuristicFormatter.format("hello").unwrap().category,
            "other"
        );
    }

    #[test]
    fn message_validation() {
        assert!(FeedbackService::validate_message("   ").is_err());
        assert!(FeedbackService::validate_message(&"a".repeat(5001)).is_err());
        assert_eq!(FeedbackService::validate_message("  hi ").unwrap(), "hi");
    }
}
