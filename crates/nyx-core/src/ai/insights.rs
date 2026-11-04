//! Claude GitHub Action insights: parse the bot comment on a ticket's issue into a structured
//! record stored in `tickets.claude_insights`. Port of the pure half of
//! `claude-insights.service.ts`.
//!
//! The fetch half (listing issue comments with the integration's token) belongs to the GitHub
//! provider (`GitProvider`, AI-66): feed its comments into [`latest_insight`] and store the
//! result with [`ClaudeInsight::to_json`] via `TicketRepo::update`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Max summary lines kept.
pub const MAX_SUMMARY: usize = 10;
/// Max changed files kept.
pub const MAX_FILES: usize = 20;

/// A comment on a GitHub issue (the fields insights need).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueComment {
    /// GitHub comment id.
    pub id: i64,
    /// Permalink.
    pub html_url: String,
    /// Markdown body.
    pub body: String,
    /// ISO timestamp.
    pub created_at: String,
    /// Author login, e.g. `claude[bot]`.
    pub user_login: String,
    /// Author type, e.g. `Bot`.
    pub user_type: String,
}

/// Parsed sections of a Claude comment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedComment {
    /// First heading (or first non-empty line, or `Claude Action`).
    pub title: String,
    /// Up to [`MAX_SUMMARY`] summary lines.
    pub summary: Vec<String>,
    /// Up to [`MAX_FILES`] file paths.
    pub files_changed: Vec<String>,
}

/// Stored insight for a ticket (JSON shape matches the TS `ClaudeInsight`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeInsight {
    /// Title.
    pub title: String,
    /// Summary lines.
    pub summary: Vec<String>,
    /// Files changed.
    pub files_changed: Vec<String>,
    /// Source comment id.
    pub comment_id: i64,
    /// Source comment URL.
    pub comment_url: String,
    /// When the comment was posted.
    pub commented_at: String,
    /// When we fetched it.
    pub fetched_at: String,
}

impl ClaudeInsight {
    /// JSON value for `tickets.claude_insights`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

const CLAUDE_BOT_LOGINS: [&str; 4] = [
    "github-actions[bot]",
    "claude[bot]",
    "claude-code[bot]",
    "anthropic-claude[bot]",
];

/// Is this comment authored by the Claude GitHub Action (or any bot with `claude` in its name)?
#[must_use]
pub fn is_claude_comment(c: &IssueComment) -> bool {
    let login = c.user_login.to_lowercase();
    CLAUDE_BOT_LOGINS.contains(&login.as_str())
        || (c.user_type == "Bot" && login.contains("claude"))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Section {
    Header,
    Summary,
    Files,
    Other,
}

fn bullet_text(line: &str) -> Option<&str> {
    let mut chars = line.chars();
    let first = chars.next()?;
    if !matches!(first, '-' | '*' | '+') {
        return None;
    }
    let rest = chars.as_str();
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let t = rest.trim();
    (!t.is_empty()).then_some(t)
}

/// Parse a Claude bot markdown comment. Heading keywords decide the section: `file` / `change` /
/// `modified` start the files list, `summary` / `overview` / `what` the summary.
#[must_use]
pub fn parse_claude_comment(body: &str) -> ParsedComment {
    let mut title = String::new();
    let mut summary = Vec::new();
    let mut files = Vec::new();
    let mut section = Section::Header;

    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            let text = line.trim_start_matches('#').trim();
            if section == Section::Header && title.is_empty() {
                text.clone_into(&mut title);
                section = Section::Summary;
                continue;
            }
            let lower = text.to_lowercase();
            section =
                if lower.contains("file") || lower.contains("change") || lower.contains("modified")
                {
                    Section::Files
                } else if lower.contains("summary")
                    || lower.contains("overview")
                    || lower.contains("what")
                {
                    Section::Summary
                } else {
                    Section::Other
                };
            continue;
        }
        if let Some(text) = bullet_text(line) {
            match section {
                Section::Files => files.push(text.replace('`', "").trim().to_owned()),
                Section::Summary | Section::Other => summary.push(text.to_owned()),
                Section::Header => {}
            }
            continue;
        }
        if section == Section::Summary && !line.starts_with('|') && !line.starts_with("```") {
            summary.push(line.to_owned());
        }
    }

    if title.is_empty() {
        body.lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("Claude Action")
            .clone_into(&mut title);
    }
    summary.truncate(MAX_SUMMARY);
    files.truncate(MAX_FILES);
    ParsedComment {
        title,
        summary,
        files_changed: files,
    }
}

/// Build the insight from the most recent Claude comment in `comments` (oldest first, as the
/// GitHub API returns them). `fetched_at` is injected (ISO timestamp) so this stays pure.
#[must_use]
pub fn latest_insight(comments: &[IssueComment], fetched_at: &str) -> Option<ClaudeInsight> {
    let c = comments.iter().rev().find(|c| is_claude_comment(c))?;
    let p = parse_claude_comment(&c.body);
    Some(ClaudeInsight {
        title: p.title,
        summary: p.summary,
        files_changed: p.files_changed,
        comment_id: c.id,
        comment_url: c.html_url.clone(),
        commented_at: c.created_at.clone(),
        fetched_at: fetched_at.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(l: &[&str]) -> String {
        l.join("\n")
    }

    fn comment(login: &str, ty: &str, body: &str, id: i64) -> IssueComment {
        IssueComment {
            id,
            html_url: format!("https://x/{id}"),
            body: body.into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            user_login: login.into(),
            user_type: ty.into(),
        }
    }

    #[test]
    fn standard_comment() {
        let r = parse_claude_comment(&lines(&[
            "## Implement auth endpoints",
            "",
            "Added JWT middleware to all protected routes.",
            "",
            "- Created /api/auth/login endpoint",
            "- Created /api/auth/logout endpoint",
            "",
            "### Files changed",
            "",
            "- apps/api/src/middleware/auth.ts",
            "- apps/api/src/routes/auth.ts",
        ]));
        assert_eq!(r.title, "Implement auth endpoints");
        assert_eq!(
            r.summary,
            vec![
                "Added JWT middleware to all protected routes.",
                "Created /api/auth/login endpoint",
                "Created /api/auth/logout endpoint"
            ]
        );
        assert_eq!(
            r.files_changed,
            vec![
                "apps/api/src/middleware/auth.ts",
                "apps/api/src/routes/auth.ts"
            ]
        );
    }

    #[test]
    fn title_fallbacks() {
        let r = parse_claude_comment("# My Task Title\n\nSome summary text.");
        assert_eq!(r.title, "My Task Title");
        assert!(r.summary.contains(&"Some summary text.".to_owned()));
        assert_eq!(
            parse_claude_comment("Plain text without headings\nSecond line").title,
            "Plain text without headings"
        );
        let e = parse_claude_comment("");
        assert_eq!(e.title, "Claude Action");
        assert!(e.summary.is_empty() && e.files_changed.is_empty());
    }

    #[test]
    fn limits() {
        let bullets: Vec<String> = (1..=15).map(|i| format!("- Bullet {i}")).collect();
        assert_eq!(
            parse_claude_comment(&format!("## Title\n\n{}", bullets.join("\n")))
                .summary
                .len(),
            10
        );
        let files: Vec<String> = (1..=25).map(|i| format!("- file{i}.ts")).collect();
        assert_eq!(
            parse_claude_comment(&format!(
                "## Title\n\n### Files changed\n\n{}",
                files.join("\n")
            ))
            .files_changed
            .len(),
            20
        );
    }

    #[test]
    fn section_keywords_backticks_and_noise() {
        let r = parse_claude_comment(&lines(&[
            "## Fix bug",
            "",
            "- Fixed the issue",
            "",
            "### Modified files",
            "",
            "- src/index.ts",
        ]));
        assert_eq!(r.files_changed, vec!["src/index.ts"]);
        assert_eq!(r.summary, vec!["Fixed the issue"]);
        let r = parse_claude_comment(&lines(&[
            "## Task",
            "",
            "### Overview",
            "",
            "- Point A",
            "- Point B",
        ]));
        assert_eq!(r.summary, vec!["Point A", "Point B"]);
        let r = parse_claude_comment(&lines(&[
            "## Task",
            "",
            "### Files changed",
            "",
            "- `src/utils.ts`",
            "- `apps/web/src/App.tsx`",
        ]));
        assert_eq!(
            r.files_changed,
            vec!["src/utils.ts", "apps/web/src/App.tsx"]
        );
        let r = parse_claude_comment(&lines(&[
            "## Task",
            "",
            "Summary line.",
            "```",
            "| col1 | col2 |",
        ]));
        assert_eq!(r.summary, vec!["Summary line."]);
    }

    #[test]
    fn bot_detection() {
        for l in [
            "github-actions[bot]",
            "claude[bot]",
            "claude-code[bot]",
            "anthropic-claude[bot]",
            "Claude[bot]",
        ] {
            assert!(is_claude_comment(&comment(l, "Bot", "", 1)), "{l}");
        }
        assert!(is_claude_comment(&comment(
            "my-claude-helper",
            "Bot",
            "",
            1
        )));
        assert!(!is_claude_comment(&comment(
            "my-claude-helper",
            "User",
            "",
            1
        )));
        assert!(!is_claude_comment(&comment(
            "dependabot[bot]",
            "Bot",
            "",
            1
        )));
    }

    #[test]
    fn latest_insight_uses_most_recent_claude_comment() {
        let cs = vec![
            comment("claude[bot]", "Bot", "## Old", 1),
            comment("human", "User", "hi", 2),
            comment("claude[bot]", "Bot", "## New\n- did it", 3),
            comment("human", "User", "thanks", 4),
        ];
        let i = latest_insight(&cs, "2026-02-02T00:00:00Z").unwrap();
        assert_eq!(i.title, "New");
        assert_eq!(i.comment_id, 3);
        assert_eq!(i.fetched_at, "2026-02-02T00:00:00Z");
        let j = i.to_json();
        assert_eq!(j["commentUrl"], "https://x/3");
        assert_eq!(j["filesChanged"], serde_json::json!([]));
        assert!(latest_insight(&cs[1..2], "t").is_none());
        assert!(latest_insight(&[], "t").is_none());
    }
}
