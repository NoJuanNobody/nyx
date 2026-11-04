//! Three-way text merge (diff3 style) with conflict markers and structured conflicts.
//!
//! This closes the gap AI-60 documented: branch merge used to be fail-or-overwrite. Given the
//! common ancestor (`base`), the current head (`ours`) and the branch (`theirs`), regions changed
//! on only one side merge cleanly; regions changed differently on both sides become [`Conflict`]s
//! that callers can render with markers ([`ThreeWayMerge::render`]) or resolve programmatically
//! ([`ThreeWayMerge::resolve`]).
//!
//! Granularity is whole lines. Two edits separated by at least one unchanged line merge cleanly,
//! matching git's behaviour.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use similar::{capture_diff_slices, Algorithm, DiffOp};

use crate::error::{Error, Result};

/// One unresolved region.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Conflict {
    /// 0-based index among the conflicts of this merge.
    pub index: usize,
    /// Text of the region in the common ancestor.
    pub base: String,
    /// Text of the region on our side (the current head).
    pub ours: String,
    /// Text of the region on their side (the branch).
    pub theirs: String,
}

/// A piece of the merged document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MergeHunk {
    /// Text that merged cleanly.
    Resolved {
        /// The merged text.
        text: String,
    },
    /// A region both sides changed differently.
    Conflict(Conflict),
}

/// How to settle one conflict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "choose", content = "text", rename_all = "snake_case")]
pub enum Resolution {
    /// Keep our side.
    Ours,
    /// Keep their side.
    Theirs,
    /// Revert to the common ancestor.
    Base,
    /// Our text followed by their text.
    Both,
    /// Replace the region with custom text.
    Custom(String),
}

/// Labels written on the marker lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeLabels {
    /// Label for our side.
    pub ours: String,
    /// Label for the ancestor (only used when `show_base` is set).
    pub base: String,
    /// Label for their side.
    pub theirs: String,
    /// Emit the ancestor section too (diff3 style).
    pub show_base: bool,
}

impl Default for MergeLabels {
    fn default() -> Self {
        Self {
            ours: "ours".into(),
            base: "base".into(),
            theirs: "theirs".into(),
            show_base: false,
        }
    }
}

/// Outcome of a three-way merge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreeWayMerge {
    /// Ordered hunks; concatenating them (with conflicts settled) yields the document.
    pub hunks: Vec<MergeHunk>,
}

fn lines(s: &str) -> Vec<&str> {
    s.split_inclusive('\n').collect()
}

/// For every base line, the index of the matching line on the other side, if unchanged.
fn matches<'a>(base: &[&'a str], other: &[&'a str]) -> Vec<Option<usize>> {
    let mut map = vec![None; base.len()];
    for op in capture_diff_slices(Algorithm::Myers, base, other) {
        if let DiffOp::Equal {
            old_index,
            new_index,
            len,
        } = op
        {
            for k in 0..len {
                map[old_index + k] = Some(new_index + k);
            }
        }
    }
    map
}

fn ensure_nl(s: &mut String) {
    if !s.is_empty() && !s.ends_with('\n') {
        s.push('\n');
    }
}

/// Merge `ours` and `theirs`, both derived from `base`.
pub fn merge3(base: &str, ours: &str, theirs: &str) -> ThreeWayMerge {
    // Trivial cases keep exact bytes (including a missing final newline).
    if ours == theirs || base == theirs {
        return clean(ours);
    }
    if base == ours {
        return clean(theirs);
    }
    let (b, o, t) = (lines(base), lines(ours), lines(theirs));
    let (mo, mt) = (matches(&b, &o), matches(&b, &t));

    // Base lines kept unchanged by both sides anchor the merge.
    let mut anchors: Vec<(usize, usize, usize)> = (0..b.len())
        .filter_map(|i| Some((i, mo[i]?, mt[i]?)))
        .collect();
    anchors.push((b.len(), o.len(), t.len()));

    let mut hunks: Vec<MergeHunk> = Vec::new();
    let mut buf = String::new();
    let mut conflicts = 0usize;
    let (mut bp, mut op, mut tp) = (0, 0, 0);
    for (bi, oi, ti) in anchors {
        let (br, or, tr) = (&b[bp..bi], &o[op..oi], &t[tp..ti]);
        if or == tr || tr == br {
            buf.push_str(&or.concat());
        } else if or == br {
            buf.push_str(&tr.concat());
        } else {
            if !buf.is_empty() {
                hunks.push(MergeHunk::Resolved {
                    text: std::mem::take(&mut buf),
                });
            }
            hunks.push(MergeHunk::Conflict(Conflict {
                index: conflicts,
                base: br.concat(),
                ours: or.concat(),
                theirs: tr.concat(),
            }));
            conflicts += 1;
        }
        if bi < b.len() {
            buf.push_str(b[bi]);
        }
        (bp, op, tp) = (bi + 1, oi + 1, ti + 1);
    }
    if !buf.is_empty() {
        hunks.push(MergeHunk::Resolved { text: buf });
    }
    ThreeWayMerge { hunks }
}

fn clean(text: &str) -> ThreeWayMerge {
    ThreeWayMerge {
        hunks: if text.is_empty() {
            Vec::new()
        } else {
            vec![MergeHunk::Resolved { text: text.into() }]
        },
    }
}

impl ThreeWayMerge {
    /// True when there are no conflicts.
    pub fn is_clean(&self) -> bool {
        !self
            .hunks
            .iter()
            .any(|h| matches!(h, MergeHunk::Conflict(_)))
    }

    /// The conflicts in document order.
    pub fn conflicts(&self) -> Vec<&Conflict> {
        self.hunks
            .iter()
            .filter_map(|h| match h {
                MergeHunk::Conflict(c) => Some(c),
                MergeHunk::Resolved { .. } => None,
            })
            .collect()
    }

    /// The merged text if clean.
    pub fn clean_text(&self) -> Option<String> {
        self.is_clean()
            .then(|| self.render(&MergeLabels::default()))
    }

    /// Merged text; conflicts are written with `<<<<<<<`/`=======`/`>>>>>>>` markers.
    pub fn render(&self, labels: &MergeLabels) -> String {
        let mut out = String::new();
        for h in &self.hunks {
            match h {
                MergeHunk::Resolved { text } => out.push_str(text),
                MergeHunk::Conflict(c) => {
                    ensure_nl(&mut out);
                    let _ = writeln!(out, "<<<<<<< {}", labels.ours);
                    out.push_str(&c.ours);
                    ensure_nl(&mut out);
                    if labels.show_base {
                        let _ = writeln!(out, "||||||| {}", labels.base);
                        out.push_str(&c.base);
                        ensure_nl(&mut out);
                    }
                    out.push_str("=======\n");
                    out.push_str(&c.theirs);
                    ensure_nl(&mut out);
                    let _ = writeln!(out, ">>>>>>> {}", labels.theirs);
                }
            }
        }
        out
    }

    /// Settle every conflict, one [`Resolution`] per conflict in order.
    pub fn resolve(&self, resolutions: &[Resolution]) -> Result<String> {
        let n = self.conflicts().len();
        if resolutions.len() != n {
            return Err(Error::Invalid(format!(
                "merge has {n} conflict(s) but {} resolution(s) were given",
                resolutions.len()
            )));
        }
        let mut out = String::new();
        for h in &self.hunks {
            match h {
                MergeHunk::Resolved { text } => out.push_str(text),
                MergeHunk::Conflict(c) => match &resolutions[c.index] {
                    Resolution::Ours => out.push_str(&c.ours),
                    Resolution::Theirs => out.push_str(&c.theirs),
                    Resolution::Base => out.push_str(&c.base),
                    Resolution::Both => {
                        out.push_str(&c.ours);
                        ensure_nl(&mut out);
                        out.push_str(&c.theirs);
                    }
                    Resolution::Custom(t) => out.push_str(t),
                },
            }
        }
        Ok(out)
    }

    /// Settle every conflict the same way.
    pub fn resolve_all(&self, r: &Resolution) -> Result<String> {
        self.resolve(&vec![r.clone(); self.conflicts().len()])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "a\nb\nc\nd\ne\n";

    #[test]
    fn disjoint_edits_merge_cleanly() {
        let m = merge3(BASE, "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n");
        assert!(m.is_clean());
        assert_eq!(m.clean_text().unwrap(), "A\nb\nc\nd\nE\n");
    }

    #[test]
    fn one_sided_change_wins() {
        assert_eq!(
            merge3(BASE, BASE, "a\nX\nc\nd\ne\n").clean_text().unwrap(),
            "a\nX\nc\nd\ne\n"
        );
        assert_eq!(
            merge3(BASE, "a\nX\nc\nd\ne\n", BASE).clean_text().unwrap(),
            "a\nX\nc\nd\ne\n"
        );
    }

    #[test]
    fn identical_changes_on_both_sides_are_not_conflicts() {
        let both = "a\nSAME\nc\nd\ne\n";
        assert_eq!(merge3(BASE, both, both).clean_text().unwrap(), both);
        // Same edit plus different edit elsewhere.
        let m = merge3(BASE, "a\nSAME\nc\nd\ne\n", "a\nSAME\nc\nd\nE\n");
        assert_eq!(m.clean_text().unwrap(), "a\nSAME\nc\nd\nE\n");
    }

    #[test]
    fn insertions_at_different_places_merge() {
        let m = merge3(BASE, "top\na\nb\nc\nd\ne\n", "a\nb\nc\nd\ne\nbottom\n");
        assert_eq!(m.clean_text().unwrap(), "top\na\nb\nc\nd\ne\nbottom\n");
    }

    #[test]
    fn same_line_edited_differently_conflicts() {
        let m = merge3(BASE, "a\nB-ours\nc\nd\ne\n", "a\nB-theirs\nc\nd\ne\n");
        assert!(!m.is_clean());
        assert!(m.clean_text().is_none());
        let cs = m.conflicts();
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0].base, "b\n");
        assert_eq!(cs[0].ours, "B-ours\n");
        assert_eq!(cs[0].theirs, "B-theirs\n");
        let text = m.render(&MergeLabels::default());
        assert_eq!(
            text,
            "a\n<<<<<<< ours\nB-ours\n=======\nB-theirs\n>>>>>>> theirs\nc\nd\ne\n"
        );
    }

    #[test]
    fn diff3_markers_include_base() {
        let m = merge3("x\n", "y\n", "z\n");
        let l = MergeLabels {
            ours: "head".into(),
            base: "v1".into(),
            theirs: "feature".into(),
            show_base: true,
        };
        assert_eq!(
            m.render(&l),
            "<<<<<<< head\ny\n||||||| v1\nx\n=======\nz\n>>>>>>> feature\n"
        );
    }

    #[test]
    fn delete_versus_edit_conflicts() {
        let m = merge3(BASE, "a\nc\nd\ne\n", "a\nBB\nc\nd\ne\n");
        let cs = m.conflicts();
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0].ours, "");
        assert_eq!(cs[0].theirs, "BB\n");
    }

    #[test]
    fn two_conflicts_resolve_independently() {
        let m = merge3(BASE, "a1\nb\nc\nd\ne1\n", "a2\nb\nc\nd\ne2\n");
        assert_eq!(m.conflicts().len(), 2);
        let out = m
            .resolve(&[Resolution::Ours, Resolution::Custom("final\n".into())])
            .unwrap();
        assert_eq!(out, "a1\nb\nc\nd\nfinal\n");
        assert_eq!(
            m.resolve_all(&Resolution::Theirs).unwrap(),
            "a2\nb\nc\nd\ne2\n"
        );
        assert_eq!(m.resolve_all(&Resolution::Base).unwrap(), BASE);
        assert_eq!(
            m.resolve_all(&Resolution::Both).unwrap(),
            "a1\na2\nb\nc\nd\ne1\ne2\n"
        );
        assert!(matches!(
            m.resolve(&[Resolution::Ours]),
            Err(Error::Invalid(_))
        ));
    }

    #[test]
    fn missing_trailing_newline_still_renders_markers_on_own_lines() {
        let m = merge3("x", "y", "z");
        assert_eq!(
            m.render(&MergeLabels::default()),
            "<<<<<<< ours\ny\n=======\nz\n>>>>>>> theirs\n"
        );
    }

    #[test]
    fn empty_inputs() {
        assert!(merge3("", "", "").is_clean());
        assert_eq!(merge3("", "one\n", "").clean_text().unwrap(), "one\n");
        let m = merge3("", "one\n", "two\n");
        assert_eq!(m.conflicts().len(), 1);
    }
}
