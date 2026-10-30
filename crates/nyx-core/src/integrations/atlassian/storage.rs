//! Markdown to Confluence storage format (XHTML with `ac:` macros).
//!
//! The TS service sent ADF to Confluence (`atlas_doc_format`); the desktop port uses the storage
//! representation, which every Confluence version accepts and which keeps code blocks, tables and
//! images first-class. Built on `pulldown-cmark`, so it handles nested lists, block quotes, tables
//! and escapes correctly (the line-based [`super::adf`] converter is kept for Jira parity).
//!
//! Safety: raw HTML in the Markdown is escaped, never passed through; link and image targets are
//! restricted to `http`, `https`, `mailto`, fragments and relative paths.

use std::fmt::Write as _;

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            c => o.push(c),
        }
    }
    o
}

fn safe_target(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    if u.starts_with("http://") || u.starts_with("https://") || u.starts_with("mailto:") {
        return true;
    }
    // Relative paths and fragments have no scheme before the first '/', '?' or '#'.
    let head = u.split(['/', '?', '#']).next().unwrap_or("");
    !head.contains(':')
}

fn cdata(s: &str) -> String {
    format!("<![CDATA[{}]]>", s.replace("]]>", "]]]]><![CDATA[>"))
}

const fn heading_n(l: HeadingLevel) -> u8 {
    match l {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// Convert Markdown to Confluence storage-format XHTML.
#[must_use]
pub fn markdown_to_storage(md: &str) -> String {
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH;
    let mut out = String::new();
    let mut code: Option<(String, String)> = None; // (language, body)
    let mut in_head = false;
    // Stack of closing strings for links so unsafe links (dropped) close nothing.
    let mut link_close: Vec<bool> = Vec::new();
    let mut image_depth = 0u32;
    for ev in Parser::new_ext(md, opts) {
        if let Some((_, body)) = code.as_mut() {
            match ev {
                Event::Text(t) => body.push_str(&t),
                Event::End(TagEnd::CodeBlock) => {
                    let (lang, body) = code.take().unwrap_or_default();
                    out.push_str("<ac:structured-macro ac:name=\"code\">");
                    if !lang.is_empty() {
                        let _ = write!(
                            out,
                            "<ac:parameter ac:name=\"language\">{}</ac:parameter>",
                            esc(&lang)
                        );
                    }
                    let _ = write!(
                        out,
                        "<ac:plain-text-body>{}</ac:plain-text-body></ac:structured-macro>",
                        cdata(body.trim_end_matches('\n'))
                    );
                }
                _ => {}
            }
            continue;
        }
        match ev {
            Event::Start(tag) => match tag {
                Tag::Paragraph => out.push_str("<p>"),
                Tag::Heading { level, .. } => {
                    let _ = write!(out, "<h{}>", heading_n(level));
                }
                Tag::BlockQuote(_) => out.push_str("<blockquote>"),
                Tag::CodeBlock(kind) => {
                    let lang = match kind {
                        CodeBlockKind::Fenced(l) => {
                            l.split_whitespace().next().unwrap_or("").to_owned()
                        }
                        CodeBlockKind::Indented => String::new(),
                    };
                    code = Some((lang, String::new()));
                }
                Tag::List(Some(_)) => out.push_str("<ol>"),
                Tag::List(None) => out.push_str("<ul>"),
                Tag::Item => out.push_str("<li>"),
                Tag::Emphasis => out.push_str("<em>"),
                Tag::Strong => out.push_str("<strong>"),
                Tag::Strikethrough => out.push_str("<del>"),
                Tag::Link { dest_url, .. } => {
                    if safe_target(&dest_url) {
                        let _ = write!(out, "<a href=\"{}\">", esc(&dest_url));
                        link_close.push(true);
                    } else {
                        link_close.push(false);
                    }
                }
                Tag::Image { dest_url, .. } => {
                    if safe_target(&dest_url) {
                        let _ = write!(
                            out,
                            "<ac:image><ri:url ri:value=\"{}\" /></ac:image>",
                            esc(&dest_url)
                        );
                    }
                    // Alt text arrives as Text events; skipped until End(Image).
                    image_depth += 1;
                }
                Tag::Table(_) => out.push_str("<table><tbody>"),
                Tag::TableHead => {
                    in_head = true;
                    out.push_str("<tr>");
                }
                Tag::TableRow => out.push_str("<tr>"),
                Tag::TableCell => out.push_str(if in_head { "<th>" } else { "<td>" }),
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph => out.push_str("</p>"),
                TagEnd::Heading(level) => {
                    let _ = write!(out, "</h{}>", heading_n(level));
                }
                TagEnd::BlockQuote(_) => out.push_str("</blockquote>"),
                TagEnd::List(true) => out.push_str("</ol>"),
                TagEnd::List(false) => out.push_str("</ul>"),
                TagEnd::Item => out.push_str("</li>"),
                TagEnd::Emphasis => out.push_str("</em>"),
                TagEnd::Strong => out.push_str("</strong>"),
                TagEnd::Strikethrough => out.push_str("</del>"),
                TagEnd::Link => {
                    if link_close.pop().unwrap_or(false) {
                        out.push_str("</a>");
                    }
                }
                TagEnd::Image => image_depth = image_depth.saturating_sub(1),
                TagEnd::Table => out.push_str("</tbody></table>"),
                TagEnd::TableHead => {
                    in_head = false;
                    out.push_str("</tr>");
                }
                TagEnd::TableRow => out.push_str("</tr>"),
                TagEnd::TableCell => out.push_str(if in_head { "</th>" } else { "</td>" }),
                _ => {}
            },
            Event::Text(t) => {
                if image_depth == 0 {
                    out.push_str(&esc(&t));
                }
            }
            Event::Code(t) => {
                let _ = write!(out, "<code>{}</code>", esc(&t));
            }
            Event::Html(h) | Event::InlineHtml(h) => out.push_str(&esc(&h)),
            Event::SoftBreak => out.push('\n'),
            Event::HardBreak => out.push_str("<br />"),
            Event::Rule => out.push_str("<hr />"),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paragraph_inline_marks_and_escape() {
        assert_eq!(
            markdown_to_storage("Hello **bold** and *it* with `a<b` & more"),
            "<p>Hello <strong>bold</strong> and <em>it</em> with <code>a&lt;b</code> &amp; more</p>"
        );
    }

    #[test]
    fn headings_and_lists() {
        assert_eq!(
            markdown_to_storage("# T\n\n## S\n\n- a\n- b\n\n1. x\n2. y"),
            "<h1>T</h1><h2>S</h2><ul><li>a</li><li>b</li></ul><ol><li>x</li><li>y</li></ol>"
        );
    }

    #[test]
    fn code_block_becomes_macro_with_cdata() {
        let s = markdown_to_storage("```rust\nfn main() { let x = \"]]>\"; }\n```");
        assert!(s.starts_with("<ac:structured-macro ac:name=\"code\">"));
        assert!(s.contains("<ac:parameter ac:name=\"language\">rust</ac:parameter>"));
        assert!(s.contains("<![CDATA[fn main() { let x = \"]]]]><![CDATA[>\"; }]]>"));
        assert!(s.ends_with("</ac:plain-text-body></ac:structured-macro>"));
    }

    #[test]
    fn table_renders_header_and_body() {
        let s = markdown_to_storage("| a | b |\n|---|---|\n| 1 | 2 |");
        assert_eq!(
            s,
            "<table><tbody><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>"
        );
    }

    #[test]
    fn links_filtered_by_scheme() {
        assert_eq!(
            markdown_to_storage("[ok](https://nyx.io?a=1&b=2)"),
            "<p><a href=\"https://nyx.io?a=1&amp;b=2\">ok</a></p>"
        );
        assert_eq!(
            markdown_to_storage("[bad](javascript:alert(1))"),
            "<p>bad</p>"
        );
        assert_eq!(
            markdown_to_storage("[rel](/wiki/x)"),
            "<p><a href=\"/wiki/x\">rel</a></p>"
        );
    }

    #[test]
    fn raw_html_is_escaped() {
        let s = markdown_to_storage("<script>alert(1)</script>\n\ntext <b>x</b>");
        assert!(!s.contains("<script"));
        assert!(s.contains("&lt;script&gt;"));
        assert!(s.contains("&lt;b&gt;"));
    }

    #[test]
    fn images_blockquote_rule_and_breaks() {
        let s = markdown_to_storage("> q\n\n---\n\n![alt](https://x/y.png)\n\nline  \nbreak");
        assert!(s.contains("<blockquote><p>q</p></blockquote>"));
        assert!(s.contains("<hr />"));
        assert!(s.contains("<ac:image><ri:url ri:value=\"https://x/y.png\" /></ac:image>"));
        assert!(!s.contains("alt"));
        assert!(s.contains("line<br />break"));
    }

    #[test]
    fn empty_input() {
        assert_eq!(markdown_to_storage(""), "");
    }
}
