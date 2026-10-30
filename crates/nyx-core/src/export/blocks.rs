//! Markdown to a small block/span tree, shared by the plain-text, PDF and DOCX exporters.
//!
//! Parsing is done by `pulldown-cmark` (`CommonMark` plus tables and strikethrough). The tree is
//! intentionally flat: lists become one [`Block::ListItem`] per item with a depth, block quotes
//! become [`Block::Quote`] paragraphs, which is all the three consumers can lay out.
//! (LaTeX and Jupyter export are line based, as in the TS originals, and do not use this.)

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

/// A run of inline text with style flags.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Span {
    /// Text of the run. May contain `\n` for hard line breaks.
    pub text: String,
    /// Strong emphasis.
    pub bold: bool,
    /// Emphasis.
    pub italic: bool,
    /// Inline code.
    pub code: bool,
}

/// A block-level element.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    /// Heading, level 1 to 6.
    Heading {
        /// Level (1 = top).
        level: u8,
        /// Inline content.
        spans: Vec<Span>,
    },
    /// Paragraph.
    Paragraph(Vec<Span>),
    /// Fenced or indented code block (verbatim).
    Code {
        /// Info string language, if any.
        lang: Option<String>,
        /// Code text without the trailing newline.
        text: String,
    },
    /// One list item (or a continuation paragraph inside one, with an empty marker).
    ListItem {
        /// Nesting depth, 0 for top level.
        depth: usize,
        /// Bullet (`\u{2022}`) or `N.`; empty for continuation paragraphs.
        marker: String,
        /// Inline content.
        spans: Vec<Span>,
    },
    /// Paragraph inside a block quote.
    Quote(Vec<Span>),
    /// Table: first row is the header.
    Table(Vec<Vec<Vec<Span>>>),
    /// Thematic break.
    Rule,
}

/// Concatenate the text of spans.
#[must_use]
pub fn spans_text(spans: &[Span]) -> String {
    spans.iter().map(|s| s.text.as_str()).collect()
}

struct ListCtx {
    ordered: bool,
    next: u64,
}

#[derive(Default)]
struct Builder {
    blocks: Vec<Block>,
    cur: Vec<Span>,
    bold: usize,
    italic: usize,
    quote: usize,
    heading: Option<u8>,
    lists: Vec<ListCtx>,
    /// Marker waiting to be attached to the next flushed list text.
    pending_marker: Option<String>,
    code: Option<(Option<String>, String)>,
    table: Option<Vec<Vec<Vec<Span>>>>,
    row: Vec<Vec<Span>>,
    in_table_cell: bool,
}

impl Builder {
    fn push_text(&mut self, text: &str, code: bool) {
        if text.is_empty() {
            return;
        }
        if let Some((_, buf)) = self.code.as_mut() {
            buf.push_str(text);
            return;
        }
        let span = Span {
            text: text.to_string(),
            bold: self.bold > 0,
            italic: self.italic > 0,
            code,
        };
        // Merge adjacent runs with identical style to keep output compact.
        if let Some(last) = self.cur.last_mut() {
            if last.bold == span.bold && last.italic == span.italic && last.code == span.code {
                last.text.push_str(&span.text);
                return;
            }
        }
        self.cur.push(span);
    }

    fn flush(&mut self) {
        let spans = std::mem::take(&mut self.cur);
        if self.in_table_cell {
            return;
        }
        if spans.is_empty() && self.heading.is_none() {
            return;
        }
        if let Some(level) = self.heading {
            self.blocks.push(Block::Heading { level, spans });
        } else if !self.lists.is_empty() {
            let marker = self.pending_marker.take().unwrap_or_default();
            self.blocks.push(Block::ListItem {
                depth: self.lists.len() - 1,
                marker,
                spans,
            });
        } else if self.quote > 0 {
            self.blocks.push(Block::Quote(spans));
        } else {
            self.blocks.push(Block::Paragraph(spans));
        }
    }
}

/// Parse Markdown into [`Block`]s.
#[must_use]
pub fn parse(markdown: &str) -> Vec<Block> {
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH;
    let mut b = Builder::default();
    for ev in Parser::new_ext(markdown, opts) {
        match ev {
            Event::Start(tag) => match tag {
                Tag::Heading { level, .. } => {
                    b.flush();
                    b.heading = Some(level as u8);
                }
                Tag::Paragraph => b.flush(),
                Tag::BlockQuote(_) => {
                    b.flush();
                    b.quote += 1;
                }
                Tag::CodeBlock(kind) => {
                    b.flush();
                    let lang = match kind {
                        CodeBlockKind::Fenced(info) => info
                            .split_whitespace()
                            .next()
                            .map(str::to_string)
                            .filter(|s| !s.is_empty()),
                        CodeBlockKind::Indented => None,
                    };
                    b.code = Some((lang, String::new()));
                }
                Tag::List(start) => {
                    // A nested list ends the parent item's own text.
                    b.flush();
                    b.lists.push(ListCtx {
                        ordered: start.is_some(),
                        next: start.unwrap_or(1),
                    });
                }
                Tag::Item => {
                    b.flush();
                    if let Some(l) = b.lists.last_mut() {
                        b.pending_marker = Some(if l.ordered {
                            let m = format!("{}.", l.next);
                            l.next += 1;
                            m
                        } else {
                            "\u{2022}".to_string()
                        });
                    }
                }
                Tag::Emphasis => b.italic += 1,
                Tag::Strong => b.bold += 1,
                Tag::Table(_) => {
                    b.flush();
                    b.table = Some(Vec::new());
                }
                Tag::TableHead | Tag::TableRow => b.row = Vec::new(),
                Tag::TableCell => {
                    b.in_table_cell = true;
                    b.cur.clear();
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Heading(_) => {
                    b.flush();
                    b.heading = None;
                }
                TagEnd::Paragraph => b.flush(),
                TagEnd::BlockQuote(_) => {
                    b.flush();
                    b.quote = b.quote.saturating_sub(1);
                }
                TagEnd::CodeBlock => {
                    if let Some((lang, mut text)) = b.code.take() {
                        while text.ends_with('\n') {
                            text.pop();
                        }
                        b.blocks.push(Block::Code { lang, text });
                    }
                }
                TagEnd::List(_) => {
                    b.flush();
                    b.lists.pop();
                }
                TagEnd::Item => {
                    b.flush();
                    b.pending_marker = None;
                }
                TagEnd::Emphasis => b.italic = b.italic.saturating_sub(1),
                TagEnd::Strong => b.bold = b.bold.saturating_sub(1),
                TagEnd::TableCell => {
                    let cell = std::mem::take(&mut b.cur);
                    b.row.push(cell);
                    b.in_table_cell = false;
                }
                TagEnd::TableHead | TagEnd::TableRow => {
                    let row = std::mem::take(&mut b.row);
                    if let Some(t) = b.table.as_mut() {
                        t.push(row);
                    }
                }
                TagEnd::Table => {
                    if let Some(t) = b.table.take() {
                        b.blocks.push(Block::Table(t));
                    }
                }
                _ => {}
            },
            Event::Text(t) | Event::Html(t) | Event::InlineHtml(t) => b.push_text(&t, false),
            Event::Code(t) => b.push_text(&t, true),
            Event::SoftBreak => b.push_text(" ", false),
            Event::HardBreak => b.push_text("\n", false),
            Event::Rule => {
                b.flush();
                b.blocks.push(Block::Rule);
            }
            _ => {}
        }
    }
    b.flush();
    b.blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_paragraphs_and_styles() {
        let blocks = parse("# Title\n\nHello **bold** and *it* and `code`.\n");
        assert_eq!(blocks.len(), 2);
        assert!(matches!(&blocks[0], Block::Heading { level: 1, .. }));
        let Block::Paragraph(spans) = &blocks[1] else {
            panic!("paragraph expected")
        };
        assert_eq!(spans_text(spans), "Hello bold and it and code.");
        assert!(spans.iter().any(|s| s.bold && s.text == "bold"));
        assert!(spans.iter().any(|s| s.italic && s.text == "it"));
        assert!(spans.iter().any(|s| s.code && s.text == "code"));
    }

    #[test]
    fn lists_nest_and_number() {
        let blocks = parse("1. one\n2. two\n   - sub\n");
        let items: Vec<_> = blocks
            .iter()
            .filter_map(|b| match b {
                Block::ListItem {
                    depth,
                    marker,
                    spans,
                } => Some((*depth, marker.clone(), spans_text(spans))),
                _ => None,
            })
            .collect();
        assert_eq!(
            items,
            vec![
                (0, "1.".to_string(), "one".to_string()),
                (0, "2.".to_string(), "two".to_string()),
                (1, "\u{2022}".to_string(), "sub".to_string()),
            ]
        );
    }

    #[test]
    fn code_and_table_and_quote_and_rule() {
        let md = "```python\nx = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n---\n";
        let blocks = parse(md);
        assert!(
            matches!(&blocks[0], Block::Code { lang: Some(l), text } if l == "python" && text == "x = 1")
        );
        let Block::Table(rows) = &blocks[1] else {
            panic!("table expected")
        };
        assert_eq!(rows.len(), 2);
        assert_eq!(spans_text(&rows[1][1]), "2");
        assert!(matches!(&blocks[2], Block::Quote(_)));
        assert_eq!(blocks[3], Block::Rule);
    }

    #[test]
    fn empty_input_is_empty() {
        assert_eq!(parse(""), vec![]);
        assert_eq!(parse("\n\n"), vec![]);
    }
}
