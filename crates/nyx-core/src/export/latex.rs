//! LaTeX export (TS `export-latex.service.ts`).
//!
//! Like the TS original this is a *line based* converter, not a Markdown parser: it recognises
//! fenced code, `$$` display math, pipe tables, headings, `-`/`*`/`+` and `1.` lists, and inline
//! `` `code` ``, `**bold**`, `*italic*`, `***both***`. Output is byte-compatible with the TS version
//! for the same input (the golden tests below were derived from it).
//!
//! Known limits carried over on purpose (parity): only `&` is escaped in running text (so `%`, `#`
//! and `_` outside math/code reach LaTeX unescaped), inline `$...$` math passes through, the
//! document title is not emitted, and block quotes / links / images are left as written.

use std::fmt;
use std::str::FromStr;

use crate::error::Error;

/// Preamble theme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum LatexTheme {
    /// `IEEEtran` conference.
    Ieee,
    /// `acmart` sigconf.
    Acm,
    /// `apa7` manuscript.
    Apa,
    /// Plain 12pt article with 1in margins (default).
    #[default]
    Plain,
}

impl LatexTheme {
    /// All themes.
    pub const ALL: &'static [Self] = &[Self::Ieee, Self::Acm, Self::Apa, Self::Plain];

    /// Lowercase name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ieee => "ieee",
            Self::Acm => "acm",
            Self::Apa => "apa",
            Self::Plain => "plain",
        }
    }

    fn preamble(self) -> &'static str {
        match self {
            Self::Ieee => {
                "\\documentclass[conference]{IEEEtran}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amsmath,amssymb,amsfonts}\n\\usepackage{graphicx}\n\\usepackage{textcomp}\n\\usepackage{listings}\n\\usepackage{hyperref}\n\\lstset{basicstyle=\\ttfamily\\small,breaklines=true}"
            }
            Self::Acm => {
                "\\documentclass[sigconf]{acmart}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amsmath,amssymb}\n\\usepackage{graphicx}\n\\usepackage{listings}\n\\usepackage{hyperref}\n\\lstset{basicstyle=\\ttfamily\\small,breaklines=true}"
            }
            Self::Apa => {
                "\\documentclass[man,12pt]{apa7}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amsmath,amssymb}\n\\usepackage{graphicx}\n\\usepackage{listings}\n\\usepackage{hyperref}\n\\lstset{basicstyle=\\ttfamily\\small,breaklines=true}"
            }
            Self::Plain => {
                "\\documentclass[12pt]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[margin=1in]{geometry}\n\\usepackage{amsmath,amssymb}\n\\usepackage{graphicx}\n\\usepackage{listings}\n\\usepackage{hyperref}\n\\lstset{basicstyle=\\ttfamily\\small,breaklines=true}"
            }
        }
    }
}

impl fmt::Display for LatexTheme {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for LatexTheme {
    type Err = Error;

    /// Case sensitive, like TS `isValidTheme`.
    fn from_str(s: &str) -> Result<Self, Error> {
        match s {
            "ieee" => Ok(Self::Ieee),
            "acm" => Ok(Self::Acm),
            "apa" => Ok(Self::Apa),
            "plain" => Ok(Self::Plain),
            other => Err(Error::Invalid(format!(
                "Invalid theme \"{other}\". Must be one of: ieee, acm, apa, plain"
            ))),
        }
    }
}

/// TS `isValidTheme`.
#[must_use]
pub fn is_valid_theme(theme: &str) -> bool {
    theme.parse::<LatexTheme>().is_ok()
}

/// Convert Markdown to a complete LaTeX document.
#[must_use]
pub fn markdown_to_latex(markdown: &str, theme: LatexTheme) -> String {
    format!(
        "{}\n\n\\begin{{document}}\n\n{}\n\n\\end{{document}}\n",
        theme.preamble(),
        convert_body(markdown)
    )
}

/// Escape LaTeX specials in plain text (TS `escapeLatex`; unused by the converter itself, exposed
/// for callers that build titles/metadata). `$` is deliberately not escaped.
#[must_use]
pub fn escape_latex(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\textbackslash{}"),
            '&' | '#' | '%' | '_' | '{' | '}' | '~' | '^' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// Replace `open_delim ... close_delim` pairs, mimicking the TS lazy regex
/// `delim(.+?)delim` applied with `g` (at least one char inside, no match across the end).
fn replace_pairs(s: &str, delim: &str, pre: &str, post: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find(delim) {
        let after = &rest[start + delim.len()..];
        // `.+?` needs at least one char, then the closing delimiter.
        let first_len = after.chars().next().map_or(0, char::len_utf8);
        let found = if first_len == 0 {
            None
        } else {
            after[first_len..].find(delim).map(|i| i + first_len)
        };
        if let Some(end) = found {
            out.push_str(&rest[..start]);
            out.push_str(pre);
            out.push_str(&after[..end]);
            out.push_str(post);
            rest = &after[end + delim.len()..];
        } else {
            // No match from this position: emit one char and retry later (regex advances by one).
            let c_len = rest[start..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&rest[..start + c_len]);
            rest = &rest[start + c_len..];
        }
    }
    out.push_str(rest);
    out
}

/// `` `([^`]+)` `` -> `\texttt{$1}`.
fn replace_inline_code(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('`') {
        let after = &rest[start + 1..];
        match after.find('`') {
            Some(end) if end > 0 => {
                out.push_str(&rest[..start]);
                out.push_str("\\texttt{");
                out.push_str(&after[..end]);
                out.push('}');
                rest = &after[end + 1..];
            }
            _ => {
                out.push_str(&rest[..=start]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn convert_inline(line: &str) -> String {
    let mut r = replace_inline_code(line);
    r = replace_pairs(&r, "***", "\\textbf{\\textit{", "}}");
    r = replace_pairs(&r, "**", "\\textbf{", "}");
    r = replace_pairs(&r, "*", "\\textit{", "}");
    // `(?<!\\)&` -> `\&`
    let mut out = String::with_capacity(r.len());
    let mut prev = '\0';
    for c in r.chars() {
        if c == '&' && prev != '\\' {
            out.push_str("\\&");
        } else {
            out.push(c);
        }
        prev = c;
    }
    out
}

/// `^```(\w*)` -> language.
fn fence_open(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("```")?;
    let end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(rest.len());
    Some(&rest[..end])
}

/// Strip a list marker. `^[-*+]\s+(.+)`.
fn ul_item(line: &str) -> Option<&str> {
    let mut chars = line.chars();
    let m = chars.next()?;
    if !matches!(m, '-' | '*' | '+') {
        return None;
    }
    let rest = chars.as_str();
    let trimmed = rest.trim_start();
    if trimmed.len() == rest.len() || trimmed.is_empty() {
        // no whitespace after the marker, or nothing after it
        // (`\s+(.+)` can still match when there are >=2 whitespace chars: keep the last one)
        let ws = rest.len() - trimmed.len();
        if ws >= 2 {
            return Some(&rest[rest.len() - last_char_len(rest)..]);
        }
        return None;
    }
    Some(trimmed)
}

/// `^\d+\.\s+(.+)`.
fn ol_item(line: &str) -> Option<&str> {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let rest = line[digits..].strip_prefix('.')?;
    let trimmed = rest.trim_start();
    if trimmed.len() == rest.len() {
        return None;
    }
    if trimmed.is_empty() {
        let ws = rest.len() - trimmed.len();
        if ws >= 2 {
            return Some(&rest[rest.len() - last_char_len(rest)..]);
        }
        return None;
    }
    Some(trimmed)
}

fn last_char_len(s: &str) -> usize {
    s.chars().next_back().map_or(0, char::len_utf8)
}

/// `^(#{1,6})\s+(.+)` -> (level, text).
fn heading(line: &str) -> Option<(usize, &str)> {
    let level = line.bytes().take_while(|b| *b == b'#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let rest = &line[level..];
    let trimmed = rest.trim_start();
    if trimmed.len() == rest.len() {
        return None;
    }
    if trimmed.is_empty() {
        let ws = rest.len() - trimmed.len();
        if ws >= 2 {
            return Some((level, &rest[rest.len() - last_char_len(rest)..]));
        }
        return None;
    }
    Some((level, trimmed))
}

fn is_table_line(line: &str) -> bool {
    line.contains('|') && line.trim().starts_with('|')
}

#[derive(PartialEq, Clone, Copy)]
enum ListKind {
    Ul,
    Ol,
}

fn close_list(out: &mut Vec<String>, list: &mut Option<ListKind>) {
    match list.take() {
        Some(ListKind::Ul) => out.push("\\end{itemize}".into()),
        Some(ListKind::Ol) => out.push("\\end{enumerate}".into()),
        None => {}
    }
}

fn convert_body(markdown: &str) -> String {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut list: Option<ListKind> = None;
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];

        // Fenced code block.
        if let Some(lang) = fence_open(line) {
            close_list(&mut out, &mut list);
            let mut code: Vec<&str> = Vec::new();
            i += 1;
            while i < lines.len() && !lines[i].starts_with("```") {
                code.push(lines[i]);
                i += 1;
            }
            i += 1; // closing fence
            let opt = if lang.is_empty() {
                String::new()
            } else {
                format!("[language={lang}]")
            };
            out.push(format!("\\begin{{lstlisting}}{opt}"));
            out.push(code.join("\n"));
            out.push("\\end{lstlisting}".into());
            continue;
        }

        // Display math ($$ ... $$).
        let t = line.trim();
        if t.starts_with("$$") {
            close_list(&mut out, &mut list);
            if t.ends_with("$$") && t.len() > 2 {
                let end = (t.len() - 2).max(2);
                out.push(format!("\\[{}\\]", &t[2..end]));
                i += 1;
                continue;
            }
            let mut math: Vec<String> = Vec::new();
            let first = t.strip_prefix("$$").unwrap_or(t);
            if !first.is_empty() {
                math.push(first.to_string());
            }
            i += 1;
            while i < lines.len() && !lines[i].trim().ends_with("$$") {
                math.push(lines[i].to_string());
                i += 1;
            }
            if i < lines.len() {
                let lt = lines[i].trim();
                let last = &lt[..lt.len() - 2];
                if !last.is_empty() {
                    math.push(last.to_string());
                }
                i += 1;
            }
            out.push(format!("\\[{}\\]", math.join("\n")));
            continue;
        }

        // Pipe table.
        if is_table_line(line) {
            close_list(&mut out, &mut list);
            let mut table = vec![line];
            i += 1;
            while i < lines.len() && is_table_line(lines[i]) {
                table.push(lines[i]);
                i += 1;
            }
            out.push(convert_table(&table));
            continue;
        }

        // Headings.
        if let Some((level, text)) = heading(line) {
            close_list(&mut out, &mut list);
            let cmd = [
                "\\section",
                "\\subsection",
                "\\subsubsection",
                "\\paragraph",
                "\\subparagraph",
                "\\subparagraph",
            ][level - 1];
            out.push(format!("{cmd}{{{}}}", convert_inline(text)));
            i += 1;
            continue;
        }

        if let Some(item) = ul_item(line) {
            if list != Some(ListKind::Ul) {
                close_list(&mut out, &mut list);
                out.push("\\begin{itemize}".into());
                list = Some(ListKind::Ul);
            }
            out.push(format!("  \\item {}", convert_inline(item)));
            i += 1;
            continue;
        }

        if let Some(item) = ol_item(line) {
            if list != Some(ListKind::Ol) {
                close_list(&mut out, &mut list);
                out.push("\\begin{enumerate}".into());
                list = Some(ListKind::Ol);
            }
            out.push(format!("  \\item {}", convert_inline(item)));
            i += 1;
            continue;
        }

        close_list(&mut out, &mut list);
        if t.is_empty() {
            out.push(String::new());
        } else {
            out.push(convert_inline(line));
        }
        i += 1;
    }

    close_list(&mut out, &mut list);
    out.join("\n")
}

fn parse_pipe_line(line: &str) -> Vec<String> {
    let s = line.strip_prefix('|').unwrap_or(line);
    let s = s.strip_suffix('|').unwrap_or(s);
    s.split('|').map(|c| c.trim().to_string()).collect()
}

fn is_separator_cell(c: &str) -> bool {
    let c = c.trim();
    !c.is_empty() && c.chars().all(|ch| ch == '-' || ch == ':')
}

fn convert_table(lines: &[&str]) -> String {
    let header = parse_pipe_line(lines[0]);
    let cols = header.len();
    let spec = vec!["l"; cols].join(" | ");

    let mut rows: Vec<String> = vec![
        format!("\\begin{{tabular}}{{| {spec} |}}"),
        "\\hline".into(),
        format!(
            "{} \\\\",
            header
                .iter()
                .map(|c| convert_inline(c))
                .collect::<Vec<_>>()
                .join(" & ")
        ),
        "\\hline".into(),
    ];

    for line in &lines[1..] {
        let cells = parse_pipe_line(line);
        if cells.iter().all(|c| is_separator_cell(c)) {
            continue;
        }
        let mut padded: Vec<String> = cells.into_iter().take(cols).collect();
        while padded.len() < cols {
            padded.push(String::new());
        }
        rows.push(format!(
            "{} \\\\",
            padded
                .iter()
                .map(|c| convert_inline(c))
                .collect::<Vec<_>>()
                .join(" & ")
        ));
        rows.push("\\hline".into());
    }
    rows.push("\\end{tabular}".into());
    rows.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(md: &str) -> String {
        markdown_to_latex(md, LatexTheme::Plain)
    }

    // ---- ported vitest cases ----

    #[test]
    fn headings() {
        assert!(plain("# Introduction").contains("\\section{Introduction}"));
        assert!(plain("## Methods").contains("\\subsection{Methods}"));
        assert!(plain("### Details").contains("\\subsubsection{Details}"));
        assert!(plain("#### Minor Point").contains("\\paragraph{Minor Point}"));
        assert!(plain("###### Deep").contains("\\subparagraph{Deep}"));
    }

    #[test]
    fn inline_formatting() {
        assert!(plain("This is **bold** text").contains("\\textbf{bold}"));
        assert!(plain("This is *italic* text").contains("\\textit{italic}"));
        assert!(plain("This is ***bold italic*** text").contains("\\textbf{\\textit{bold italic}}"));
        assert!(plain("Use `console.log()` here").contains("\\texttt{console.log()}"));
    }

    #[test]
    fn code_blocks() {
        let r = plain("```python\nprint(\"hello\")\n```");
        assert!(r.contains("\\begin{lstlisting}[language=python]"));
        assert!(r.contains("print(\"hello\")"));
        assert!(r.contains("\\end{lstlisting}"));

        let r = plain("```\nsome code\n```");
        assert!(r.contains("\\begin{lstlisting}\n"));
        assert!(!r.contains("[language=]"));
        assert!(r.contains("some code"));
    }

    #[test]
    fn tables() {
        let r = plain("| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |");
        for needle in [
            "\\begin{tabular}",
            "Name & Value",
            "Alpha & 1",
            "Beta & 2",
            "\\end{tabular}",
            "\\hline",
        ] {
            assert!(r.contains(needle), "{needle}");
        }
    }

    #[test]
    fn lists() {
        let r = plain("- Item one\n- Item two\n- Item three");
        assert!(r.contains("\\begin{itemize}"));
        assert!(r.contains("\\item Item one"));
        assert!(r.contains("\\item Item three"));
        assert!(r.contains("\\end{itemize}"));
        let r = plain("1. First\n2. Second\n3. Third");
        assert!(r.contains("\\begin{enumerate}"));
        assert!(r.contains("\\item Second"));
        assert!(r.contains("\\end{enumerate}"));
    }

    #[test]
    fn math_pass_through() {
        assert!(plain("$$E = mc^2$$").contains("\\[E = mc^2\\]"));
        let r = plain("$$\nx = \\frac{-b}{2a}\n$$");
        assert!(r.contains("\\[x = \\frac{-b}{2a}\\]"));
        assert!(plain("$$\na\nb\n$$").contains("\\[a\nb\\]"));
    }

    #[test]
    fn themes() {
        let t = |th| markdown_to_latex("# Test", th);
        assert!(t(LatexTheme::Ieee).contains("\\documentclass[conference]{IEEEtran}"));
        assert!(t(LatexTheme::Acm).contains("\\documentclass[sigconf]{acmart}"));
        assert!(t(LatexTheme::Apa).contains("\\documentclass[man,12pt]{apa7}"));
        assert!(t(LatexTheme::Plain).contains("\\documentclass[12pt]{article}"));
        assert!(t(LatexTheme::default()).contains("\\documentclass[12pt]{article}"));
        let r = plain("Hello world");
        assert!(r.contains("\\begin{document}") && r.contains("\\end{document}"));
    }

    #[test]
    fn escapes_ampersand() {
        assert!(plain("R&D department").contains("R\\&D department"));
    }

    #[test]
    fn theme_validation() {
        for t in ["ieee", "acm", "apa", "plain"] {
            assert!(is_valid_theme(t));
        }
        for t in ["invalid", "", "IEEE"] {
            assert!(!is_valid_theme(t));
        }
        let err = "bogus".parse::<LatexTheme>().unwrap_err().to_string();
        assert!(err.contains("ieee, acm, apa, plain"));
    }

    // ---- golden tests ----

    #[test]
    fn golden_full_document() {
        let md = "# Research Paper\n\n## Abstract\n\nThis paper explores **important** topics in *science*.\n\n## Methods\n\nWe used the following approach:\n\n1. Collect data\n2. Analyze results\n3. Draw conclusions\n\n$$E = mc^2$$\n\n```python\nimport numpy as np\n```\n\n| Metric | Value |\n| --- | --- |\n| Accuracy | 95% |";
        let expected = "\\documentclass[conference]{IEEEtran}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{graphicx}
\\usepackage{textcomp}
\\usepackage{listings}
\\usepackage{hyperref}
\\lstset{basicstyle=\\ttfamily\\small,breaklines=true}

\\begin{document}

\\section{Research Paper}

\\subsection{Abstract}

This paper explores \\textbf{important} topics in \\textit{science}.

\\subsection{Methods}

We used the following approach:

\\begin{enumerate}
  \\item Collect data
  \\item Analyze results
  \\item Draw conclusions
\\end{enumerate}

\\[E = mc^2\\]

\\begin{lstlisting}[language=python]
import numpy as np
\\end{lstlisting}

\\begin{tabular}{| l | l |}
\\hline
Metric & Value \\\\
\\hline
Accuracy & 95% \\\\
\\hline
\\end{tabular}

\\end{document}
";
        assert_eq!(markdown_to_latex(md, LatexTheme::Ieee), expected);
    }

    #[test]
    fn golden_list_closed_by_heading_and_nested_inline() {
        let md = "- a & b\n- `c`\n# After";
        let body = convert_body(md);
        assert_eq!(
            body,
            "\\begin{itemize}\n  \\item a \\& b\n  \\item \\texttt{c}\n\\end{itemize}\n\\section{After}"
        );
    }

    #[test]
    fn golden_plain_wrapper() {
        assert_eq!(
            plain(""),
            "\\documentclass[12pt]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[margin=1in]{geometry}\n\\usepackage{amsmath,amssymb}\n\\usepackage{graphicx}\n\\usepackage{listings}\n\\usepackage{hyperref}\n\\lstset{basicstyle=\\ttfamily\\small,breaklines=true}\n\n\\begin{document}\n\n\n\n\\end{document}\n"
        );
    }

    #[test]
    fn edge_cases() {
        // unterminated fence swallows the rest, like TS
        let r = convert_body("```rust\nfn x() {}");
        assert_eq!(
            r,
            "\\begin{lstlisting}[language=rust]\nfn x() {}\n\\end{lstlisting}"
        );
        // bare `#` and `-` are paragraphs, 7 hashes are not a heading
        assert_eq!(convert_body("#"), "#");
        assert_eq!(convert_body("-"), "-");
        assert_eq!(convert_body("####### x"), "####### x");
        // short table rows are padded, extra cells dropped
        let t = convert_body("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |");
        assert!(t.contains("1 &  \\\\"));
        assert!(t.contains("1 & 2 \\\\"));
        assert!(!t.contains('3'));
        // an unmatched star stays literal
        assert_eq!(convert_inline("2 * 3"), "2 * 3");
        // already escaped ampersand is not doubled
        assert_eq!(convert_inline("a \\& b"), "a \\& b");
    }

    #[test]
    fn escape_latex_helper() {
        assert_eq!(escape_latex("a_b & c%"), "a\\_b \\& c\\%");
        assert_eq!(escape_latex("\\"), "\\textbackslash{}");
        assert_eq!(escape_latex("$x$"), "$x$");
    }
}
