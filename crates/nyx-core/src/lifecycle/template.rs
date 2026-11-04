//! Template rendering and markdown section handling.
//!
//! Built-in templates are markdown with two placeholder styles:
//!
//! - `{{name}}` / `{{name|default}}`: new, machine friendly variables. `\{{` escapes a literal `{{`.
//! - legacy bracket placeholders such as `[Feature Name]`, `[X.Y.Z]` and the literal `YYYY-MM-DD`,
//!   used by every template ported from TypeScript. [`instantiate`] fills them when a matching
//!   variable is supplied (`feature_name`, `version`, `date`), otherwise leaves them in place for
//!   the author, exactly like the original templates.
//!
//! [`MarkdownDoc`] splits markdown into heading sections (fence aware, lossless round trip) so
//! callers can read, replace and score sections ([`completeness`]).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::pipeline::TemplateDef;
use crate::error::{Error, Result};

/// Variables for rendering. Names are `[A-Za-z_][A-Za-z0-9_.-]*`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Vars(BTreeMap<String, String>);

impl Vars {
    /// Empty set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Builder style insert.
    #[must_use]
    pub fn with(mut self, name: &str, value: &str) -> Self {
        self.0.insert(name.to_owned(), value.to_owned());
        self
    }

    /// Insert or replace.
    pub fn set(&mut self, name: &str, value: &str) {
        self.0.insert(name.to_owned(), value.to_owned());
    }

    /// Look up.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }
}

/// Result of rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// Output text. Unresolved `{{name}}` placeholders are kept verbatim.
    pub content: String,
    /// Names of `{{variables}}` with neither a value nor a default, in first-seen order.
    pub unresolved: Vec<String>,
}

fn valid_name(n: &str) -> bool {
    let mut c = n.chars();
    matches!(c.next(), Some(ch) if ch.is_ascii_alphabetic() || ch == '_')
        && c.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
}

/// One parsed piece of a template.
enum Piece<'a> {
    Text(&'a str),
    Escaped,
    Var {
        raw: &'a str,
        name: &'a str,
        default: Option<&'a str>,
    },
}

fn parse(template: &str) -> std::result::Result<Vec<Piece<'_>>, String> {
    let mut out = Vec::new();
    let mut rest = template;
    loop {
        let Some(i) = rest.find("{{") else {
            out.push(Piece::Text(rest));
            return Ok(out);
        };
        if i > 0 && rest.as_bytes()[i - 1] == b'\\' {
            out.push(Piece::Text(&rest[..i - 1]));
            out.push(Piece::Escaped);
            rest = &rest[i + 2..];
            continue;
        }
        out.push(Piece::Text(&rest[..i]));
        let after = &rest[i + 2..];
        let Some(j) = after.find("}}") else {
            return Err(format!(
                "unclosed '{{{{' near '{}'",
                after.chars().take(20).collect::<String>()
            ));
        };
        let inner = &after[..j];
        let (name, default) = match inner.split_once('|') {
            Some((n, d)) => (n.trim(), Some(d)),
            None => (inner.trim(), None),
        };
        if !valid_name(name) {
            return Err(format!("invalid variable name '{name}'"));
        }
        out.push(Piece::Var {
            raw: &rest[i..i + 2 + j + 2],
            name,
            default,
        });
        rest = &after[j + 2..];
    }
}

/// Validate `{{ }}` syntax (balanced, valid names). Used by pipeline validation.
pub(crate) fn check_syntax(template: &str) -> std::result::Result<(), String> {
    parse(template).map(|_| ())
}

/// Names of `{{variables}}` used by a template, in first-seen order, without duplicates.
pub fn variables(template: &str) -> Result<Vec<String>> {
    let mut seen = Vec::new();
    for p in parse(template).map_err(Error::Invalid)? {
        if let Piece::Var { name, .. } = p {
            if !seen.iter().any(|s| s == name) {
                seen.push(name.to_owned());
            }
        }
    }
    Ok(seen)
}

/// Render `{{name}}` / `{{name|default}}` placeholders. Syntax errors yield [`Error::Invalid`].
pub fn render(template: &str, vars: &Vars) -> Result<Rendered> {
    let mut content = String::with_capacity(template.len());
    let mut unresolved: Vec<String> = Vec::new();
    for p in parse(template).map_err(Error::Invalid)? {
        match p {
            Piece::Text(t) => content.push_str(t),
            Piece::Escaped => content.push_str("{{"),
            Piece::Var { raw, name, default } => match (vars.get(name), default) {
                (Some(v), _) => content.push_str(v),
                (None, Some(d)) => content.push_str(d),
                (None, None) => {
                    content.push_str(raw);
                    if !unresolved.iter().any(|u| u == name) {
                        unresolved.push(name.to_owned());
                    }
                }
            },
        }
    }
    Ok(Rendered {
        content,
        unresolved,
    })
}

/// Variable name a legacy `[Label]` placeholder maps to: `X.Y.Z` is `version`, otherwise the
/// label lower-cased with runs of non-alphanumerics collapsed to `_` (`[Feature Name]` is
/// `feature_name`). `None` for checkboxes and empty labels.
fn bracket_key(label: &str) -> Option<String> {
    if label == "X.Y.Z" {
        return Some("version".into());
    }
    let mut key = String::new();
    for ch in label.chars() {
        if ch.is_alphanumeric() {
            key.extend(ch.to_lowercase());
        } else if !key.is_empty() && !key.ends_with('_') {
            key.push('_');
        }
    }
    let key = key.trim_end_matches('_').to_owned();
    (!key.is_empty() && key != "x").then_some(key)
}

/// Legacy bracket placeholder labels in `content` (`[Feature Name]`, not links or checkboxes).
pub fn bracket_placeholders(content: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for_each_bracket(content, |label, _, _| {
        if bracket_key(label).is_some() && !found.iter().any(|f| f == label) {
            found.push(label.to_owned());
        }
    });
    found
}

/// Calls `f(label, start, end)` for each `[label]` not followed by `(` (markdown link) or `:`.
fn for_each_bracket(content: &str, mut f: impl FnMut(&str, usize, usize)) {
    let b = content.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'[' {
            if let Some(len) = content[i + 1..].find([']', '\n', '[']) {
                let end = i + 1 + len;
                if b[end] == b']' && !matches!(b.get(end + 1), Some(b'(' | b':')) {
                    f(&content[i + 1..end], i, end + 1);
                    i = end + 1;
                    continue;
                }
            }
        }
        i += 1;
    }
}

/// Create document text from a template: render `{{variables}}`, then fill legacy placeholders
/// for which a variable exists (`date` fills `YYYY-MM-DD`). Unfilled placeholders stay put.
pub fn instantiate(template: &TemplateDef, vars: &Vars) -> Result<Rendered> {
    let mut r = render(&template.content, vars)?;
    let src = r.content;
    let mut out = String::with_capacity(src.len());
    let mut last = 0;
    for_each_bracket(&src, |label, start, end| {
        if let Some(v) = bracket_key(label).and_then(|k| vars.get(&k)) {
            out.push_str(&src[last..start]);
            out.push_str(v);
            last = end;
        }
    });
    out.push_str(&src[last..]);
    if let Some(date) = vars.get("date") {
        out = out.replace("YYYY-MM-DD", date);
    }
    r.content = out;
    Ok(r)
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

/// One heading and the text beneath it, up to the next heading of any level.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    /// Heading level, 1 to 6.
    pub level: u8,
    /// Heading text.
    pub title: String,
    /// Text after the heading line (includes its trailing newlines).
    pub body: String,
    raw_heading: String,
}

/// Markdown split into a preamble and heading sections. `to_markdown` returns the input exactly
/// (unless a body was replaced).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownDoc {
    /// Text before the first heading.
    pub preamble: String,
    /// Sections in document order.
    pub sections: Vec<Section>,
}

fn heading(line: &str) -> Option<(u8, &str)> {
    let t = line.trim_end_matches(['\n', '\r']);
    let hashes = t.bytes().take_while(|b| *b == b'#').count();
    if (1..=6).contains(&hashes) && t.as_bytes().get(hashes) == Some(&b' ') {
        Some((u8::try_from(hashes).unwrap_or(6), t[hashes + 1..].trim()))
    } else {
        None
    }
}

impl MarkdownDoc {
    /// Parse. Lines starting with `#` inside code fences (backticks or tildes) are not headings.
    pub fn parse(md: &str) -> Self {
        let mut doc = Self {
            preamble: String::new(),
            sections: Vec::new(),
        };
        let mut fence: Option<&str> = None;
        for line in md.split_inclusive('\n') {
            let trimmed = line.trim_start();
            let marker = if trimmed.starts_with("```") {
                Some("```")
            } else if trimmed.starts_with("~~~") {
                Some("~~~")
            } else {
                None
            };
            if let Some(m) = marker {
                match fence {
                    None => fence = Some(m),
                    Some(open) if open == m => fence = None,
                    Some(_) => {}
                }
            }
            if fence.is_none() && marker.is_none() {
                if let Some((level, title)) = heading(line) {
                    doc.sections.push(Section {
                        level,
                        title: title.to_owned(),
                        body: String::new(),
                        raw_heading: line.to_owned(),
                    });
                    continue;
                }
            }
            match doc.sections.last_mut() {
                Some(s) => s.body.push_str(line),
                None => doc.preamble.push_str(line),
            }
        }
        doc
    }

    /// Serialise back to markdown.
    pub fn to_markdown(&self) -> String {
        let mut out = self.preamble.clone();
        for s in &self.sections {
            out.push_str(&s.raw_heading);
            out.push_str(&s.body);
        }
        out
    }

    /// First section with this title (case-insensitive, trimmed).
    pub fn section(&self, title: &str) -> Option<&Section> {
        let want = title.trim().to_lowercase();
        self.sections
            .iter()
            .find(|s| s.title.to_lowercase() == want)
    }

    /// Replace the body of the first section titled `title`. Returns `false` if absent.
    /// A trailing newline is added when missing so the next heading stays on its own line.
    pub fn set_body(&mut self, title: &str, body: &str) -> bool {
        let want = title.trim().to_lowercase();
        let Some(s) = self
            .sections
            .iter_mut()
            .find(|s| s.title.to_lowercase() == want)
        else {
            return false;
        };
        if !s.raw_heading.ends_with('\n') {
            s.raw_heading.push('\n');
        }
        s.body = if body.is_empty() || body.ends_with('\n') {
            body.to_owned()
        } else {
            format!("{body}\n")
        };
        true
    }
}

/// Remove `<!-- ... -->` comments (also multi-line).
pub fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("<!--") {
        out.push_str(&rest[..i]);
        match rest[i..].find("-->") {
            Some(j) => rest = &rest[i + j + 3..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// True when a body has no real content: only comments, blank lines, empty list items/checkboxes
/// and empty table rows.
pub fn is_blank_body(body: &str) -> bool {
    strip_comments(body).lines().all(|l| {
        let t = l.trim();
        let t = t.trim_start_matches(['-', '*', '+']).trim();
        let t = t.strip_prefix("[ ]").unwrap_or(t).trim();
        let digits = t.trim_start_matches(|c: char| c.is_ascii_digit());
        let t = if digits.len() < t.len() {
            digits.strip_prefix('.').unwrap_or(t).trim()
        } else {
            t
        };
        t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ' | '\t'))
    })
}

/// How completely a document follows a template's structure.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Completeness {
    /// Template sections below the title (level 2 and deeper).
    pub expected: Vec<String>,
    /// Expected sections absent from the document.
    pub missing: Vec<String>,
    /// Present sections still empty or identical to the template's placeholder text.
    pub unfilled: Vec<String>,
    /// Fraction of expected sections present and filled, in `[0, 1]` (1 when nothing is expected).
    pub ratio: f64,
}

/// Compare a document with a template's section structure.
pub fn completeness(template_md: &str, doc_md: &str) -> Completeness {
    let tpl = MarkdownDoc::parse(template_md);
    let doc = MarkdownDoc::parse(doc_md);
    let mut used = vec![false; doc.sections.len()];
    let (mut expected, mut missing, mut unfilled) = (Vec::new(), Vec::new(), Vec::new());
    for (ti, ts) in tpl
        .sections
        .iter()
        .enumerate()
        .filter(|(_, s)| s.level >= 2)
    {
        expected.push(ts.title.clone());
        let want = ts.title.to_lowercase();
        let hit = doc
            .sections
            .iter()
            .enumerate()
            .find(|(i, s)| !used[*i] && s.title.to_lowercase() == want);
        let Some((i, ds)) = hit else {
            missing.push(ts.title.clone());
            continue;
        };
        used[i] = true;
        // A heading directly followed by a deeper heading is only a container: nothing to fill.
        let structural = tpl.sections.get(ti + 1).is_some_and(|n| n.level > ts.level);
        let same_as_template = strip_comments(&ds.body).trim() == strip_comments(&ts.body).trim();
        if !structural && (is_blank_body(&ds.body) || same_as_template) {
            unfilled.push(ts.title.clone());
        }
    }
    let ratio = if expected.is_empty() {
        1.0
    } else {
        (expected.len() - missing.len() - unfilled.len()) as f64 / expected.len() as f64
    };
    Completeness {
        expected,
        missing,
        unfilled,
        ratio,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tpl(content: &str) -> TemplateDef {
        TemplateDef {
            stage: "s".into(),
            name: "n".into(),
            description: String::new(),
            sort_order: 0,
            content: content.into(),
        }
    }

    #[test]
    fn renders_variables_defaults_and_escapes() {
        let v = Vars::new().with("title", "Search").with("owner", "Ana");
        let r = render("# {{title}} by {{ owner }}\nStatus: {{status|Draft}}\nKeep \\{{raw}} {{missing}} {{missing}}", &v).unwrap();
        assert_eq!(
            r.content,
            "# Search by Ana\nStatus: Draft\nKeep {{raw}} {{missing}} {{missing}}"
        );
        assert_eq!(r.unresolved, ["missing"]);
        // a supplied value beats the default; an empty default is allowed
        let v2 = Vars::new().with("status", "Done");
        assert_eq!(
            render("{{status|Draft}}/{{x|}}", &v2).unwrap().content,
            "Done/"
        );
    }

    #[test]
    fn syntax_errors_are_reported() {
        assert!(render("{{oops", &Vars::new()).is_err());
        assert!(render("{{1bad}}", &Vars::new()).is_err());
        assert!(render("{{ }}", &Vars::new()).is_err());
        assert_eq!(variables("{{a}} {{b|x}} {{a}}").unwrap(), ["a", "b"]);
    }

    #[test]
    fn instantiate_fills_legacy_placeholders_when_known() {
        let t = tpl("# Release Notes — v[X.Y.Z]\n\n**Date:** YYYY-MM-DD\n\n## [Feature Name]\n- [ ] todo\nSee [docs](http://x) and [Other Thing]\n");
        let v = Vars::new()
            .with("version", "1.2.0")
            .with("date", "2026-10-30")
            .with("feature_name", "Search");
        let r = instantiate(&t, &v).unwrap();
        assert_eq!(
            r.content,
            "# Release Notes — v1.2.0\n\n**Date:** 2026-10-30\n\n## Search\n- [ ] todo\nSee [docs](http://x) and [Other Thing]\n"
        );
        // nothing supplied: untouched
        assert_eq!(instantiate(&t, &Vars::new()).unwrap().content, t.content);
        assert_eq!(
            bracket_placeholders(&t.content),
            ["X.Y.Z", "Feature Name", "Other Thing"]
        );
    }

    #[test]
    fn sections_round_trip_and_ignore_fenced_headings() {
        let md = "intro\n# A\nbody a\n```\n# not a heading\n```\n## B\n\n### C\nlast";
        let d = MarkdownDoc::parse(md);
        assert_eq!(d.preamble, "intro\n");
        let titles: Vec<_> = d
            .sections
            .iter()
            .map(|s| (s.level, s.title.as_str()))
            .collect();
        assert_eq!(titles, [(1, "A"), (2, "B"), (3, "C")]);
        assert_eq!(d.to_markdown(), md);
        assert!(d.section("a").unwrap().body.contains("# not a heading"));
    }

    #[test]
    fn set_body_replaces_one_section() {
        let mut d = MarkdownDoc::parse("# T\n## Goals\n<!-- x -->\n## Risks\nold\n");
        assert!(d.set_body("goals", "Ship it"));
        assert!(!d.set_body("nope", "x"));
        assert_eq!(d.to_markdown(), "# T\n## Goals\nShip it\n## Risks\nold\n");
    }

    #[test]
    fn blank_body_detection() {
        assert!(is_blank_body("<!-- hint -->\n\n"));
        assert!(is_blank_body("- \n- [ ] \n1. \n"));
        assert!(is_blank_body("|   |   |\n|---|---|\n"));
        assert!(!is_blank_body("- real item\n"));
        assert!(!is_blank_body("text"));
    }

    #[test]
    fn completeness_scores_structure_and_content() {
        let t = "# Doc\n## Overview\n<!-- what -->\n## Goals\n- \n## Risks\n<!-- r -->\n";
        let full = "# Doc\n## Overview\nA thing\n## Goals\n- one\n## Risks\nnone\n";
        assert_eq!(completeness(t, full).ratio, 1.0);
        let partial = "# Doc\n## Overview\nA thing\n## Goals\n- \n";
        let c = completeness(t, partial);
        assert_eq!(c.missing, ["Risks"]);
        assert_eq!(c.unfilled, ["Goals"]);
        assert!((c.ratio - 1.0 / 3.0).abs() < 1e-9);
        // untouched template is entirely unfilled
        assert_eq!(completeness(t, t).ratio, 0.0);
    }
}
