//! Line and word diffs (backed by the `similar` crate).
//!
//! The TypeScript API returned both sides of a comparison and left diffing to the client. The
//! Rust core computes the diff itself so CLI, MCP and desktop all see the same result.

use serde::{Deserialize, Serialize};
use similar::{Algorithm, ChangeTag, TextDiff};

/// What happened to a line or word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    /// Present on both sides.
    Equal,
    /// Only on the new side.
    Insert,
    /// Only on the old side.
    Delete,
}

impl From<ChangeTag> for ChangeKind {
    fn from(t: ChangeTag) -> Self {
        match t {
            ChangeTag::Equal => Self::Equal,
            ChangeTag::Insert => Self::Insert,
            ChangeTag::Delete => Self::Delete,
        }
    }
}

/// One line of a diff. Line numbers are 1-based.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffLine {
    /// Kind of change.
    pub kind: ChangeKind,
    /// Line number on the old side (`None` for inserts).
    pub old_line: Option<usize>,
    /// Line number on the new side (`None` for deletes).
    pub new_line: Option<usize>,
    /// Line text without its trailing newline.
    pub text: String,
}

/// A contiguous group of changes plus surrounding context (like a unified-diff hunk).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffHunk {
    /// First old line covered (1-based; 0 when the old side is empty).
    pub old_start: usize,
    /// Number of old lines covered.
    pub old_len: usize,
    /// First new line covered (1-based; 0 when the new side is empty).
    pub new_start: usize,
    /// Number of new lines covered.
    pub new_len: usize,
    /// Lines of the hunk in order.
    pub lines: Vec<DiffLine>,
}

/// Counts over a whole diff.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffStats {
    /// Inserted lines.
    pub added: usize,
    /// Deleted lines.
    pub removed: usize,
    /// Unchanged lines.
    pub unchanged: usize,
}

/// Result of a line diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineDiff {
    /// True when both sides are identical.
    pub identical: bool,
    /// Totals.
    pub stats: DiffStats,
    /// Changed regions with context.
    pub hunks: Vec<DiffHunk>,
}

/// A run of words (or whitespace) in a word diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WordChange {
    /// Kind of change.
    pub kind: ChangeKind,
    /// The text of the token, whitespace included.
    pub text: String,
}

/// Result of a word diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WordDiff {
    /// True when both sides are identical.
    pub identical: bool,
    /// Tokens added.
    pub added: usize,
    /// Tokens removed.
    pub removed: usize,
    /// Ordered changes covering both sides.
    pub changes: Vec<WordChange>,
}

/// Default number of context lines around a change.
pub const DEFAULT_CONTEXT: usize = 3;

fn trim_nl(s: &str) -> String {
    s.strip_suffix('\n')
        .map_or(s, |s| s.strip_suffix('\r').unwrap_or(s))
        .to_string()
}

/// Line diff of `old` against `new` with `context` lines around each change.
pub fn diff_lines(old: &str, new: &str, context: usize) -> LineDiff {
    let diff = TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .diff_lines(old, new);
    let mut stats = DiffStats::default();
    for c in diff.iter_all_changes() {
        match c.tag() {
            ChangeTag::Equal => stats.unchanged += 1,
            ChangeTag::Insert => stats.added += 1,
            ChangeTag::Delete => stats.removed += 1,
        }
    }
    let mut hunks = Vec::new();
    for group in diff.grouped_ops(context) {
        let mut lines = Vec::new();
        for op in &group {
            for c in diff.iter_changes(op) {
                lines.push(DiffLine {
                    kind: c.tag().into(),
                    old_line: c.old_index().map(|i| i + 1),
                    new_line: c.new_index().map(|i| i + 1),
                    text: trim_nl(c.value()),
                });
            }
        }
        let old_len = lines.iter().filter(|l| l.old_line.is_some()).count();
        let new_len = lines.iter().filter(|l| l.new_line.is_some()).count();
        hunks.push(DiffHunk {
            old_start: lines.iter().find_map(|l| l.old_line).unwrap_or(0),
            old_len,
            new_start: lines.iter().find_map(|l| l.new_line).unwrap_or(0),
            new_len,
            lines,
        });
    }
    LineDiff {
        identical: stats.added == 0 && stats.removed == 0,
        stats,
        hunks,
    }
}

/// Word-level diff. Tokens are words and the whitespace runs between them.
pub fn diff_words(old: &str, new: &str) -> WordDiff {
    let diff = TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .diff_words(old, new);
    let (mut added, mut removed) = (0, 0);
    let mut changes: Vec<WordChange> = Vec::new();
    for c in diff.iter_all_changes() {
        let kind = ChangeKind::from(c.tag());
        match kind {
            ChangeKind::Insert => added += 1,
            ChangeKind::Delete => removed += 1,
            ChangeKind::Equal => {}
        }
        // Coalesce adjacent tokens of the same kind into one run.
        match changes.last_mut() {
            Some(last) if last.kind == kind => last.text.push_str(c.value()),
            _ => changes.push(WordChange {
                kind,
                text: c.value().to_string(),
            }),
        }
    }
    WordDiff {
        identical: added == 0 && removed == 0,
        added,
        removed,
        changes,
    }
}

/// Classic unified diff text (`--- a`, `+++ b`, `@@` hunks).
pub fn unified(old: &str, new: &str, old_label: &str, new_label: &str, context: usize) -> String {
    TextDiff::from_lines(old, new)
        .unified_diff()
        .context_radius(context)
        .header(old_label, new_label)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_inputs_have_no_hunks() {
        let d = diff_lines("a\nb\n", "a\nb\n", 3);
        assert!(d.identical);
        assert_eq!(d.hunks.len(), 0);
        assert_eq!(
            d.stats,
            DiffStats {
                added: 0,
                removed: 0,
                unchanged: 2
            }
        );
    }

    #[test]
    fn line_diff_reports_replace_with_numbers() {
        let d = diff_lines("one\ntwo\nthree\n", "one\n2\nthree\n", 1);
        assert!(!d.identical);
        assert_eq!(
            (d.stats.added, d.stats.removed, d.stats.unchanged),
            (1, 1, 2)
        );
        assert_eq!(d.hunks.len(), 1);
        let h = &d.hunks[0];
        assert_eq!(
            (h.old_start, h.old_len, h.new_start, h.new_len),
            (1, 3, 1, 3)
        );
        let del = h
            .lines
            .iter()
            .find(|l| l.kind == ChangeKind::Delete)
            .unwrap();
        assert_eq!(
            (del.old_line, del.new_line, del.text.as_str()),
            (Some(2), None, "two")
        );
        let ins = h
            .lines
            .iter()
            .find(|l| l.kind == ChangeKind::Insert)
            .unwrap();
        assert_eq!(
            (ins.old_line, ins.new_line, ins.text.as_str()),
            (None, Some(2), "2")
        );
    }

    #[test]
    fn distant_changes_split_into_hunks() {
        let old: String = (1..=30).fold(String::new(), |a, i| a + &format!("l{i}\n"));
        let new = old.replace("l2\n", "L2\n").replace("l29\n", "L29\n");
        let d = diff_lines(&old, &new, 2);
        assert_eq!(d.hunks.len(), 2);
        assert_eq!(d.stats.added, 2);
    }

    #[test]
    fn pure_insert_and_delete_from_empty() {
        let d = diff_lines("", "x\ny\n", 3);
        assert_eq!((d.stats.added, d.stats.removed), (2, 0));
        assert_eq!(d.hunks[0].old_start, 0);
        assert_eq!(d.hunks[0].new_len, 2);
        let d = diff_lines("x\n", "", 3);
        assert_eq!((d.stats.added, d.stats.removed), (0, 1));
    }

    #[test]
    fn word_diff_marks_only_changed_words() {
        let d = diff_words("the quick brown fox", "the slow brown fox");
        assert!(!d.identical);
        let del: Vec<_> = d
            .changes
            .iter()
            .filter(|c| c.kind == ChangeKind::Delete)
            .map(|c| c.text.as_str())
            .collect();
        let ins: Vec<_> = d
            .changes
            .iter()
            .filter(|c| c.kind == ChangeKind::Insert)
            .map(|c| c.text.as_str())
            .collect();
        assert_eq!(del, ["quick"]);
        assert_eq!(ins, ["slow"]);
        // Reconstruct both sides from the runs.
        let old: String = d
            .changes
            .iter()
            .filter(|c| c.kind != ChangeKind::Insert)
            .map(|c| c.text.as_str())
            .collect();
        let new: String = d
            .changes
            .iter()
            .filter(|c| c.kind != ChangeKind::Delete)
            .map(|c| c.text.as_str())
            .collect();
        assert_eq!(old, "the quick brown fox");
        assert_eq!(new, "the slow brown fox");
        assert!(diff_words("same text", "same text").identical);
    }

    #[test]
    fn unified_output_has_headers_and_markers() {
        let u = unified("a\nb\n", "a\nc\n", "v1", "v2", 1);
        assert!(u.contains("--- v1"));
        assert!(u.contains("+++ v2"));
        assert!(u.contains("-b"));
        assert!(u.contains("+c"));
    }
}
