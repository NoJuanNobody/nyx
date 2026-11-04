//! Plain-text export (TS `exportService.toPlainText`).
//!
//! Output shape is unchanged: `Title`, an `=` underline of the same length, a blank line, then the
//! body with Markdown syntax removed. The TS version used regexes; this one walks the
//! `pulldown-cmark` tree, which also handles nesting, tables and code fences correctly.

use super::blocks::{parse, spans_text, Block};

/// Render a document as plain text.
///
/// The underline is as wide as the title in `char`s (the TS used UTF-16 length; identical for BMP
/// text). Headings lose their `#`, emphasis/code/links keep only their text, images keep their alt
/// text, block-quote markers and horizontal rules disappear, code blocks are kept verbatim, list
/// items get `- ` or `N. ` markers, tables become tab-separated rows, and runs of blank lines
/// collapse to one.
#[must_use]
pub fn to_plain_text(title: &str, markdown: &str) -> String {
    format!(
        "{title}\n{}\n\n{}",
        "=".repeat(title.chars().count()),
        markdown_to_plain_text(markdown)
    )
}

/// Strip Markdown to plain text (no title). Result is trimmed.
#[must_use]
pub fn markdown_to_plain_text(markdown: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut prev_list = false;
    for block in parse(markdown) {
        let is_list = matches!(block, Block::ListItem { .. });
        // Consecutive list items stay tight; everything else is separated by a blank line.
        if !(out.is_empty() || is_list && prev_list) {
            out.push(String::new());
        }
        prev_list = is_list;
        match block {
            Block::Heading { spans, .. } | Block::Paragraph(spans) | Block::Quote(spans) => {
                out.push(spans_text(&spans));
            }
            Block::Code { text, .. } => out.push(text),
            Block::ListItem {
                depth,
                marker,
                spans,
            } => {
                let marker = if marker == "\u{2022}" {
                    "-"
                } else {
                    marker.as_str()
                };
                let indent = "  ".repeat(depth);
                if marker.is_empty() {
                    out.push(format!("{indent}  {}", spans_text(&spans)));
                } else {
                    out.push(format!("{indent}{marker} {}", spans_text(&spans)));
                }
            }
            Block::Table(rows) => {
                let lines: Vec<String> = rows
                    .iter()
                    .map(|r| {
                        r.iter()
                            .map(|c| spans_text(c))
                            .collect::<Vec<_>>()
                            .join("\t")
                    })
                    .collect();
                out.push(lines.join("\n"));
            }
            Block::Rule => {
                // Dropped; remove the separator we just added to avoid a double gap.
                if out.last().is_some_and(String::is_empty) {
                    out.pop();
                }
            }
        }
    }
    out.join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_underline_and_body() {
        let t = to_plain_text("My Doc", "# Heading\n\nSome **bold** text.");
        assert_eq!(t, "My Doc\n======\n\nHeading\n\nSome bold text.");
    }

    #[test]
    fn strips_inline_syntax() {
        let t = markdown_to_plain_text(
            "*i* and __b__ and `c` and [link](http://x.y) and ![alt](img.png)",
        );
        assert_eq!(t, "i and b and c and link and alt");
    }

    #[test]
    fn strips_quote_and_rule_and_collapses_blank_lines() {
        let t = markdown_to_plain_text("> quoted\n\n---\n\n\n\nafter");
        assert_eq!(t, "quoted\n\nafter");
    }

    #[test]
    fn lists_and_code_and_tables() {
        let md = "- a\n- b\n\npara\n\n1. x\n2. y\n\n```\ncode\n```\n\n| h1 | h2 |\n|---|---|\n| c1 | c2 |";
        let t = markdown_to_plain_text(md);
        assert_eq!(
            t,
            "- a\n- b\n\npara\n\n1. x\n2. y\n\ncode\n\nh1\th2\nc1\tc2"
        );
    }

    #[test]
    fn empty_body() {
        assert_eq!(to_plain_text("T", ""), "T\n=\n\n");
    }
}
