//! Code chunking per language: a simple structural splitter.
//!
//! Port of `chunkCodeFile` (`code-embedding.service.ts`), which prefixed each chunk with
//! `// File: <path>` and used the generic text chunker (1500 chars, 150 overlap). This version
//! keeps that prefix and sizes but first splits on declaration boundaries so chunks start at a
//! function / type / heading instead of mid-body:
//!
//! 1. Lines at column 0 that look like a top-level declaration (per-language regex) start a new
//!    *segment*; contiguous comment / attribute / decorator lines directly above stay with it.
//!    Markdown splits on headings. Languages without a structural pattern (YAML, JSON, TOML, text)
//!    are one segment.
//! 2. Consecutive segments are packed greedily into chunks of at most `max_chars`.
//! 3. A segment larger than the budget falls back to the overlapping text chunker
//!    ([`crate::intake::chunking::chunk_text`]).
//!
//! `tree-sitter` was deliberately not used: it needs one C grammar crate per language (build time,
//! binary size, `cc` toolchain). The regex splitter is the documented stopgap; a grammar-backed
//! implementation can replace [`segments`] without changing the public API.

use std::sync::OnceLock;

use regex::Regex;

use super::filter::Language;
use crate::intake::chunking::{chunk_text, ChunkOptions};

/// Default chunk size in characters (TS: 1500).
pub const DEFAULT_MAX_CHARS: usize = 1500;
/// Default overlap for oversized segments (TS: 150).
pub const DEFAULT_OVERLAP: usize = 150;

/// Chunker settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodeChunkOptions {
    /// Maximum characters per chunk including the `// File:` prefix.
    pub max_chars: usize,
    /// Overlap used when a single declaration exceeds `max_chars`.
    pub overlap: usize,
}

impl Default for CodeChunkOptions {
    fn default() -> Self {
        Self {
            max_chars: DEFAULT_MAX_CHARS,
            overlap: DEFAULT_OVERLAP,
        }
    }
}

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).unwrap_or_else(|_| unreachable_regex()))
}

#[allow(clippy::panic)]
fn unreachable_regex() -> Regex {
    // Patterns are compile-time constants covered by tests.
    panic!("invalid built-in regex")
}

static RUST: OnceLock<Regex> = OnceLock::new();
static JS: OnceLock<Regex> = OnceLock::new();
static PY: OnceLock<Regex> = OnceLock::new();
static GO: OnceLock<Regex> = OnceLock::new();
static JAVA: OnceLock<Regex> = OnceLock::new();
static RUBY: OnceLock<Regex> = OnceLock::new();
static PHP: OnceLock<Regex> = OnceLock::new();
static SWIFT: OnceLock<Regex> = OnceLock::new();
static CPP: OnceLock<Regex> = OnceLock::new();
static SQL: OnceLock<Regex> = OnceLock::new();
static MD: OnceLock<Regex> = OnceLock::new();
static SHELL: OnceLock<Regex> = OnceLock::new();
static GQL: OnceLock<Regex> = OnceLock::new();
static MARKUP: OnceLock<Regex> = OnceLock::new();

fn boundary_regex(lang: Language) -> Option<&'static Regex> {
    Some(match lang {
        Language::Rust => re(
            &RUST,
            r"^(pub(\([^)]*\))?\s+)?(async\s+|unsafe\s+|const\s+|extern\s+(\x22[^\x22]*\x22\s+)?)*(fn|struct|enum|impl|trait|mod|type|static|const|union|macro_rules!)\b",
        ),
        Language::TypeScript | Language::JavaScript => re(
            &JS,
            r"^(export\s+)?(default\s+)?(declare\s+)?(async\s+)?(function\*?|class|interface|type|enum|namespace|abstract\s+class|const|let|var)\b",
        ),
        Language::Python => re(&PY, r"^(async\s+def|def|class)\b"),
        Language::Go => re(&GO, r"^(func|type|var|const)\b"),
        Language::Java | Language::Kotlin | Language::CSharp | Language::Scala => re(
            &JAVA,
            r"^((public|private|protected|internal|static|final|abstract|sealed|open|data|partial|override|suspend)\s+)*(class|interface|enum|record|object|trait|fun|def|struct|namespace)\b",
        ),
        Language::Ruby => re(&RUBY, r"^(def|class|module)\b"),
        Language::Php => re(
            &PHP,
            r"^((abstract|final)\s+)?(function|class|interface|trait|enum|namespace)\b",
        ),
        Language::Swift => re(
            &SWIFT,
            r"^((public|private|internal|open|final)\s+)*(func|class|struct|enum|protocol|extension|actor)\b",
        ),
        Language::C | Language::Cpp => re(
            &CPP,
            r"^(template\s*<|namespace\b|class\b|struct\b|enum\b|typedef\b|#define\b|[A-Za-z_][\w:<>*&\s]*\s+\**[A-Za-z_][\w:]*\s*\([^;]*$)",
        ),
        Language::Sql => re(&SQL, r"(?i)^(create|alter|drop|insert|select|with|grant)\b"),
        Language::Markdown => re(&MD, r"^#{1,6}\s"),
        Language::Shell => re(&SHELL, r"^(function\s+\w+|\w+\s*\(\)\s*\{)"),
        Language::GraphQl | Language::Proto => re(
            &GQL,
            r"^(type|input|enum|interface|union|scalar|query|mutation|subscription|message|service|syntax|extend)\b",
        ),
        Language::Vue | Language::Svelte | Language::Astro => {
            re(&MARKUP, r"^<(script|template|style)\b")
        }
        Language::Yaml
        | Language::Toml
        | Language::Json
        | Language::Dockerfile
        | Language::Makefile
        | Language::Text => return None,
    })
}

fn is_leading_trivia(line: &str, lang: Language) -> bool {
    let t = line.trim_start();
    if t.is_empty() {
        return false;
    }
    match lang {
        Language::Python | Language::Ruby | Language::Shell => {
            t.starts_with('#') || t.starts_with('@')
        }
        Language::Sql => t.starts_with("--"),
        Language::Markdown => false,
        _ => {
            t.starts_with("//")
                || t.starts_with("#[")
                || t.starts_with("#!")
                || t.starts_with("/*")
                || t.starts_with('*')
                || t.starts_with("*/")
                || t.starts_with('@')
        }
    }
}

/// Split `content` into declaration-aligned segments (each a run of whole lines, joined back with
/// their original newlines). The concatenation of all segments equals `content`.
#[must_use]
pub fn segments(content: &str, lang: Language) -> Vec<String> {
    let Some(rx) = boundary_regex(lang) else {
        return vec![content.to_string()];
    };
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let mut starts: Vec<usize> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        // Column-0 only: indented declarations belong to their parent.
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        if !rx.is_match(line.trim_end_matches(['\n', '\r'])) {
            continue;
        }
        let mut s = i;
        while s > 0 && is_leading_trivia(lines[s - 1], lang) && !starts.contains(&(s - 1)) {
            s -= 1;
        }
        // Do not reach back past the previous segment start.
        if starts.last().map_or(true, |last| s > *last) {
            starts.push(s);
        }
    }
    if starts.is_empty() {
        return vec![content.to_string()];
    }
    if starts[0] != 0 {
        starts.insert(0, 0);
    }
    let mut out = Vec::with_capacity(starts.len());
    for (k, s) in starts.iter().enumerate() {
        let end = starts.get(k + 1).copied().unwrap_or(lines.len());
        out.push(lines[*s..end].concat());
    }
    out
}

/// One chunk of a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeChunkPiece {
    /// Chunk text including the `// File: <path>` prefix.
    pub content: String,
    /// 0-based position within the file.
    pub index: usize,
}

/// Prefix prepended to each chunk so embeddings carry file context.
#[must_use]
pub fn file_prefix(path: &str) -> String {
    format!("// File: {path}\n")
}

fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// Chunk one file. Empty / whitespace-only content yields no chunks.
#[must_use]
pub fn chunk_code_file(
    path: &str,
    content: &str,
    lang: Language,
    opts: &CodeChunkOptions,
) -> Vec<CodeChunkPiece> {
    let prefix = file_prefix(path);
    let budget = opts.max_chars.saturating_sub(char_len(&prefix)).max(1);
    let overlap = opts.overlap.min(budget.saturating_sub(1));

    let mut bodies: Vec<String> = Vec::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, bodies: &mut Vec<String>| {
        if !cur.trim().is_empty() {
            bodies.push(cur.trim_end().to_string());
        }
        cur.clear();
    };
    for seg in segments(content, lang) {
        if seg.trim().is_empty() {
            cur.push_str(&seg);
            continue;
        }
        if char_len(&seg) > budget {
            flush(&mut cur, &mut bodies);
            let o = ChunkOptions {
                chunk_size: budget,
                overlap,
                drop_covered_tail: true,
            };
            bodies.extend(chunk_text(&seg, &o));
        } else if char_len(&cur) + char_len(&seg) > budget {
            flush(&mut cur, &mut bodies);
            cur.push_str(&seg);
        } else {
            cur.push_str(&seg);
        }
    }
    flush(&mut cur, &mut bodies);

    bodies
        .into_iter()
        .filter(|b| !b.trim().is_empty())
        .enumerate()
        .map(|(index, b)| CodeChunkPiece {
            content: format!("{prefix}{b}"),
            index,
        })
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn opts(n: usize) -> CodeChunkOptions {
        CodeChunkOptions {
            max_chars: n,
            overlap: 10,
        }
    }

    #[test]
    fn segments_roundtrip_and_attach_doc_comments() {
        let src = "use a;\n\n/// Doc\n#[inline]\npub fn one() {\n    x();\n}\n\nstruct S;\nimpl S {\n    fn m(&self) {}\n}\n";
        let segs = segments(src, Language::Rust);
        assert_eq!(segs.concat(), src);
        assert_eq!(segs.len(), 4, "{segs:?}");
        assert!(segs[1].starts_with("/// Doc\n#[inline]\npub fn one"));
        assert!(segs[3].starts_with("impl S"));
        assert!(segs[3].contains("fn m"), "indented fn stays in impl");
    }

    #[test]
    fn python_and_typescript_boundaries() {
        let py =
            "import os\n\n@dec\ndef a():\n    pass\n\nclass B:\n    def m(self):\n        pass\n";
        let segs = segments(py, Language::Python);
        assert_eq!(segs.len(), 3, "{segs:?}");
        assert!(segs[1].starts_with("@dec\ndef a"));
        let ts = "import x from 'y';\nexport async function f() {}\nexport class C {\n  m() {}\n}\nexport interface I {}\n";
        assert_eq!(segments(ts, Language::TypeScript).len(), 4);
    }

    #[test]
    fn markdown_splits_on_headings_and_config_is_one_segment() {
        let md = "# A\ntext\n## B\nmore\n";
        assert_eq!(segments(md, Language::Markdown).len(), 2);
        assert_eq!(segments("a: 1\nb: 2\n", Language::Yaml).len(), 1);
    }

    #[test]
    fn small_file_is_one_prefixed_chunk() {
        let c = chunk_code_file(
            "src/a.rs",
            "fn a() {}\nfn b() {}\n",
            Language::Rust,
            &opts(500),
        );
        assert_eq!(c.len(), 1);
        assert!(c[0].content.starts_with("// File: src/a.rs\nfn a()"));
        assert_eq!(c[0].index, 0);
    }

    #[test]
    fn packs_whole_declarations_without_splitting_them() {
        let f = |n: &str| format!("fn {n}() {{\n    body();\n    body();\n}}\n\n");
        let src: String = (0..8).map(|i| f(&format!("f{i}"))).collect();
        let c = chunk_code_file("a.rs", &src, Language::Rust, &opts(120));
        assert!(c.len() > 1);
        for p in &c {
            assert!(char_len(&p.content) <= 120, "{}", char_len(&p.content));
            // every chunk begins at a declaration and closes it
            let body = p.content.strip_prefix("// File: a.rs\n").unwrap();
            assert!(body.starts_with("fn f"), "{body:?}");
            assert!(body.trim_end().ends_with('}'));
        }
        let all: String = c.iter().map(|p| p.content.clone()).collect();
        for i in 0..8 {
            assert!(all.contains(&format!("fn f{i}()")));
        }
        assert_eq!(
            c.iter().map(|p| p.index).collect::<Vec<_>>(),
            (0..c.len()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn oversized_declaration_falls_back_to_overlapping_text_chunks() {
        let body = "    step();\n".repeat(60);
        let src = format!("fn big() {{\n{body}}}\n");
        let c = chunk_code_file("a.rs", &src, Language::Rust, &opts(200));
        assert!(c.len() >= 4);
        assert!(c.iter().all(|p| char_len(&p.content) <= 200));
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert!(chunk_code_file(
            "a.rs",
            " \n\n",
            Language::Rust,
            &CodeChunkOptions::default()
        )
        .is_empty());
    }

    #[test]
    fn every_boundary_regex_compiles() {
        for l in [
            Language::Rust,
            Language::TypeScript,
            Language::Python,
            Language::Go,
            Language::Java,
            Language::Ruby,
            Language::Php,
            Language::Swift,
            Language::Cpp,
            Language::Sql,
            Language::Markdown,
            Language::Shell,
            Language::GraphQl,
            Language::Vue,
        ] {
            assert!(boundary_regex(l).is_some());
        }
    }
}
