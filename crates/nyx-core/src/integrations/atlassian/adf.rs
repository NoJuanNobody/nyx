//! Markdown-ish text to Atlassian Document Format (ADF) and back.
//!
//! Direct port of `textToAdf`, `parseInlineMarks` and `adfToText` from `atlassian.service.ts`
//! (same line-based algorithm, so output matches the TS version node for node). Supports headings
//! 1 to 6, bullet and numbered lists, fenced code blocks, and the inline marks `**bold**`,
//! `*italic*`, `` `code` `` and `[text](url)`.
//!
//! Differences from TS, all hardening: `\r\n` input is normalised, empty code blocks do not emit an
//! empty text node (Jira rejects those), and link marks are only emitted for `http`, `https` and
//! `mailto` targets (anything else stays plain text).

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).unwrap_or_else(|_| unreachable!("static pattern")))
}

fn inline_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))",
    )
}
fn fence_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^```(\w*)")
}
fn heading_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^(#{1,6})\s+(.+)$")
}
fn bullet_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[-*+]\s+")
}
fn ordered_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^\d+\.\s+")
}

fn text_node(text: &str, marks: Option<Value>) -> Value {
    match marks {
        Some(m) => json!({"type": "text", "text": text, "marks": [m]}),
        None => json!({"type": "text", "text": text}),
    }
}

fn safe_href(href: &str) -> bool {
    let h = href.trim().to_ascii_lowercase();
    h.starts_with("http://") || h.starts_with("https://") || h.starts_with("mailto:")
}

/// Parse inline marks into ADF text nodes. Never returns an empty vector for non-empty input.
#[must_use]
pub fn parse_inline_marks(text: &str) -> Vec<Value> {
    let mut nodes = Vec::new();
    let mut last = 0;
    for caps in inline_re().captures_iter(text) {
        let Some(whole) = caps.get(0) else { continue };
        if whole.start() > last {
            nodes.push(text_node(&text[last..whole.start()], None));
        }
        if let Some(m) = caps.get(2) {
            nodes.push(text_node(m.as_str(), Some(json!({"type": "strong"}))));
        } else if let Some(m) = caps.get(4) {
            nodes.push(text_node(m.as_str(), Some(json!({"type": "em"}))));
        } else if let Some(m) = caps.get(6) {
            nodes.push(text_node(m.as_str(), Some(json!({"type": "code"}))));
        } else if let (Some(label), Some(href)) = (caps.get(8), caps.get(9)) {
            if safe_href(href.as_str()) {
                nodes.push(text_node(
                    label.as_str(),
                    Some(json!({"type": "link", "attrs": {"href": href.as_str()}})),
                ));
            } else {
                nodes.push(text_node(whole.as_str(), None));
            }
        }
        last = whole.end();
    }
    if last < text.len() {
        nodes.push(text_node(&text[last..], None));
    }
    if nodes.is_empty() {
        nodes.push(text_node(text, None));
    }
    nodes
}

fn list_items(lines: &[&str], i: &mut usize, marker: &Regex) -> Vec<Value> {
    let mut items = Vec::new();
    while *i < lines.len() && marker.is_match(lines[*i]) {
        let item = marker.replace(lines[*i], "");
        items.push(json!({
            "type": "listItem",
            "content": [{"type": "paragraph", "content": parse_inline_marks(&item)}],
        }));
        *i += 1;
    }
    items
}

/// Convert Markdown-style text to an ADF document. `append_url` adds a trailing
/// "Source: <link>" paragraph (used for spec back-links).
#[must_use]
pub fn text_to_adf(text: &str, append_url: Option<&str>) -> Value {
    let normalized = text.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut content: Vec<Value> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            i += 1;
            continue;
        }
        if let Some(c) = fence_re().captures(line) {
            let language = c.get(1).map_or("", |m| m.as_str());
            let mut code = Vec::new();
            i += 1;
            while i < lines.len() && !lines[i].starts_with("```") {
                code.push(lines[i]);
                i += 1;
            }
            i += 1;
            let mut attrs = Map::new();
            if !language.is_empty() {
                attrs.insert("language".into(), json!(language));
            }
            let mut node = json!({"type": "codeBlock", "attrs": Value::Object(attrs)});
            let body = code.join("\n");
            if !body.is_empty() {
                node["content"] = json!([{"type": "text", "text": body}]);
            }
            content.push(node);
            continue;
        }
        if let Some(c) = heading_re().captures(line) {
            let level = c.get(1).map_or(1, |m| m.as_str().len());
            let body = c.get(2).map_or("", |m| m.as_str());
            content.push(json!({
                "type": "heading",
                "attrs": {"level": level},
                "content": parse_inline_marks(body),
            }));
            i += 1;
            continue;
        }
        if bullet_re().is_match(line) {
            let items = list_items(&lines, &mut i, bullet_re());
            content.push(json!({"type": "bulletList", "content": items}));
            continue;
        }
        if ordered_re().is_match(line) {
            let items = list_items(&lines, &mut i, ordered_re());
            content.push(json!({"type": "orderedList", "content": items}));
            continue;
        }
        content.push(json!({"type": "paragraph", "content": parse_inline_marks(line)}));
        i += 1;
    }
    if let Some(url) = append_url {
        content.push(json!({
            "type": "paragraph",
            "content": [
                {"type": "text", "text": "Source: "},
                {"type": "text", "text": url, "marks": [{"type": "link", "attrs": {"href": url}}]},
            ],
        }));
    }
    json!({"type": "doc", "version": 1, "content": content})
}

fn inline_text(node: &Value) -> String {
    node.get("content")
        .and_then(Value::as_array)
        .map(|c| {
            c.iter()
                .map(|n| n.get("text").and_then(Value::as_str).unwrap_or(""))
                .collect()
        })
        .unwrap_or_default()
}

/// Convert ADF back to Markdown-ish plain text (simplified, like the TS version: nested
/// structures are flattened to their direct text children).
#[must_use]
pub fn adf_to_text(adf: &Value) -> String {
    let Some(blocks) = adf.get("content").and_then(Value::as_array) else {
        return String::new();
    };
    blocks
        .iter()
        .map(|block| {
            let ty = block.get("type").and_then(Value::as_str).unwrap_or("");
            match ty {
                "heading" => {
                    let level = block
                        .pointer("/attrs/level")
                        .and_then(Value::as_u64)
                        .unwrap_or(1)
                        .clamp(1, 6);
                    format!("{} {}", "#".repeat(level as usize), inline_text(block))
                }
                "codeBlock" => {
                    let lang = block
                        .pointer("/attrs/language")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    format!("```{lang}\n{}\n```", inline_text(block))
                }
                "bulletList" | "orderedList" => {
                    let Some(items) = block.get("content").and_then(Value::as_array) else {
                        return String::new();
                    };
                    items
                        .iter()
                        .enumerate()
                        .map(|(idx, item)| {
                            let text = item
                                .pointer("/content/0")
                                .map(inline_text)
                                .unwrap_or_default();
                            if ty == "orderedList" {
                                format!("{}. {text}", idx + 1)
                            } else {
                                format!("- {text}")
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                }
                _ => inline_text(block),
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn types(adf: &Value) -> Vec<String> {
        adf["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["type"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn single_paragraph() {
        let adf = text_to_adf("Hello world", None);
        assert_eq!(adf["type"], "doc");
        assert_eq!(adf["version"], 1);
        assert_eq!(adf["content"].as_array().unwrap().len(), 1);
        assert_eq!(adf["content"][0]["type"], "paragraph");
        assert_eq!(adf["content"][0]["content"][0]["text"], "Hello world");
    }

    #[test]
    fn headings() {
        let adf = text_to_adf("# Heading 1\n\n## Heading 2\n\n### Heading 3", None);
        assert_eq!(adf["content"].as_array().unwrap().len(), 3);
        assert_eq!(adf["content"][0]["type"], "heading");
        assert_eq!(adf["content"][0]["attrs"]["level"], 1);
        assert_eq!(adf["content"][0]["content"][0]["text"], "Heading 1");
        assert_eq!(adf["content"][1]["attrs"]["level"], 2);
        assert_eq!(adf["content"][2]["attrs"]["level"], 3);
    }

    #[test]
    fn fenced_code_block() {
        let adf = text_to_adf("```typescript\nconst x = 1;\nconsole.log(x);\n```", None);
        assert_eq!(adf["content"].as_array().unwrap().len(), 1);
        assert_eq!(adf["content"][0]["type"], "codeBlock");
        assert_eq!(adf["content"][0]["attrs"]["language"], "typescript");
        assert_eq!(
            adf["content"][0]["content"][0]["text"],
            "const x = 1;\nconsole.log(x);"
        );
    }

    #[test]
    fn code_block_without_language_or_body() {
        let adf = text_to_adf("```\n```", None);
        assert_eq!(adf["content"][0]["attrs"], json!({}));
        assert!(adf["content"][0].get("content").is_none());
    }

    #[test]
    fn bullet_and_numbered_lists() {
        let b = text_to_adf("- Item one\n- Item two\n- Item three", None);
        assert_eq!(b["content"].as_array().unwrap().len(), 1);
        assert_eq!(b["content"][0]["type"], "bulletList");
        assert_eq!(b["content"][0]["content"].as_array().unwrap().len(), 3);
        assert_eq!(b["content"][0]["content"][0]["type"], "listItem");
        let o = text_to_adf("1. First\n2. Second\n3. Third", None);
        assert_eq!(o["content"][0]["type"], "orderedList");
        assert_eq!(o["content"][0]["content"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn multi_paragraph() {
        let adf = text_to_adf("Paragraph one\n\nParagraph two\n\nParagraph three", None);
        assert_eq!(adf["content"].as_array().unwrap().len(), 3);
        assert_eq!(adf["content"][2]["content"][0]["text"], "Paragraph three");
    }

    #[test]
    fn appends_source_url() {
        let adf = text_to_adf("Content", Some("https://nyx.io/spec/123"));
        assert_eq!(adf["content"].as_array().unwrap().len(), 2);
        let p = &adf["content"][1];
        assert_eq!(p["content"][0]["text"], "Source: ");
        assert_eq!(p["content"][1]["text"], "https://nyx.io/spec/123");
        assert_eq!(
            p["content"][1]["marks"][0]["attrs"]["href"],
            "https://nyx.io/spec/123"
        );
    }

    #[test]
    fn mixed_content() {
        let adf = text_to_adf(
            "# Title\nSome intro\n- Item 1\n- Item 2\n```js\nalert(1)\n```",
            None,
        );
        let t = types(&adf);
        for want in ["heading", "paragraph", "bulletList", "codeBlock"] {
            assert!(t.iter().any(|x| x == want), "{want} in {t:?}");
        }
    }

    #[test]
    fn crlf_is_normalised() {
        let adf = text_to_adf("# T\r\n- a\r\n- b\r\n", None);
        assert_eq!(adf["content"][0]["content"][0]["text"], "T");
        assert_eq!(
            adf["content"][1]["content"][1]["content"][0]["content"][0]["text"],
            "b"
        );
    }

    #[test]
    fn inline_bold_italic_code_link() {
        let n = parse_inline_marks("Hello **bold** world");
        assert_eq!(n.len(), 3);
        assert_eq!(n[0]["text"], "Hello ");
        assert_eq!(n[1]["text"], "bold");
        assert_eq!(n[1]["marks"][0]["type"], "strong");
        assert_eq!(n[2]["text"], " world");
        let n = parse_inline_marks("Hello *italic* world");
        assert_eq!(n[1]["marks"][0]["type"], "em");
        let n = parse_inline_marks("Run `npm install` now");
        assert_eq!(n[1]["text"], "npm install");
        assert_eq!(n[1]["marks"][0]["type"], "code");
        let n = parse_inline_marks("Visit [Nyx](https://nyx.io)");
        assert_eq!(n.len(), 2);
        assert_eq!(n[1]["marks"][0]["type"], "link");
        assert_eq!(n[1]["marks"][0]["attrs"]["href"], "https://nyx.io");
    }

    #[test]
    fn plain_text_single_node() {
        let n = parse_inline_marks("Just plain text");
        assert_eq!(n.len(), 1);
        assert_eq!(n[0]["text"], "Just plain text");
    }

    #[test]
    fn unsafe_link_targets_stay_text() {
        let n = parse_inline_marks("[x](javascript:alert(1))");
        assert!(n.iter().all(|x| x.get("marks").is_none()));
    }

    #[test]
    fn adf_to_text_paragraphs_and_empty() {
        let adf = json!({"content": [
            {"content": [{"text": "First paragraph"}]},
            {"content": [{"text": "Second paragraph"}]},
        ]});
        assert_eq!(adf_to_text(&adf), "First paragraph\n\nSecond paragraph");
        assert_eq!(adf_to_text(&json!({})), "");
        assert_eq!(adf_to_text(&json!({"content": []})), "");
    }

    #[test]
    fn adf_to_text_blocks() {
        assert_eq!(
            adf_to_text(
                &json!({"content": [{"type": "heading", "attrs": {"level": 2}, "content": [{"text": "My Heading"}]}]})
            ),
            "## My Heading"
        );
        assert_eq!(
            adf_to_text(
                &json!({"content": [{"type": "codeBlock", "attrs": {"language": "js"}, "content": [{"text": "alert(1)"}]}]})
            ),
            "```js\nalert(1)\n```"
        );
        let list = |ty: &str| {
            json!({"content": [{"type": ty, "content": [
                {"content": [{"content": [{"text": "A"}]}]},
                {"content": [{"content": [{"text": "B"}]}]},
            ]}]})
        };
        assert_eq!(adf_to_text(&list("bulletList")), "- A\n- B");
        assert_eq!(adf_to_text(&list("orderedList")), "1. A\n2. B");
    }

    #[test]
    fn adf_to_text_block_without_content() {
        let adf = json!({"content": [{"type": "paragraph"}, {"content": [{"text": "ok"}]}]});
        assert_eq!(adf_to_text(&adf), "\n\nok");
    }

    #[test]
    fn roundtrip_simple_document() {
        let md = "# Title\n\nSome text\n\n- a\n- b";
        assert_eq!(adf_to_text(&text_to_adf(md, None)), md);
    }
}
