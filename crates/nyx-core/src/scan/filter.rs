//! File filtering: ignore lists, size / binary limits and language detection.
//!
//! Ports the three overlapping filters of the TypeScript services into one configurable
//! [`FileFilter`] with three presets:
//!
//! | Preset | TS source | Max size | Notes |
//! |---|---|---|---|
//! | [`FileFilter::for_index`] | `code-embedding.service.ts` `isIndexableFile` | 50 KB | code, docs and config, no json/txt |
//! | [`FileFilter::for_specs`] | `codebase-scanner.service.ts` `isRelevantFile` | 50 KB | adds json/txt/env.example/Dockerfile/Makefile/Procfile |
//! | [`FileFilter::for_onboarding`] | `onboarding.service.ts` `shouldSkip`/`isSourceFile` | 100 KB | source + json/yaml/toml config + README, skips lockfiles, `.min.`, maps |

use std::collections::BTreeSet;
use std::fmt;

use serde::{Deserialize, Serialize};

/// Detected language of a file (drives the structural chunker).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    /// `.ts`, `.tsx`
    TypeScript,
    /// `.js`, `.jsx`, `.mjs`, `.cjs`
    JavaScript,
    /// `.py`
    Python,
    /// `.go`
    Go,
    /// `.rs`
    Rust,
    /// `.java`
    Java,
    /// `.rb`
    Ruby,
    /// `.php`
    Php,
    /// `.swift`
    Swift,
    /// `.kt`, `.kts`
    Kotlin,
    /// `.cs`
    CSharp,
    /// `.cpp`, `.cc`, `.hpp`
    Cpp,
    /// `.c`, `.h`
    C,
    /// `.scala`
    Scala,
    /// `.vue`
    Vue,
    /// `.svelte`
    Svelte,
    /// `.astro`
    Astro,
    /// `.sql`
    Sql,
    /// `.graphql`, `.gql`
    GraphQl,
    /// `.proto`
    Proto,
    /// `.yaml`, `.yml`
    Yaml,
    /// `.toml`
    Toml,
    /// `.json`
    Json,
    /// `.md`, `.mdx`
    Markdown,
    /// `.sh`, `.bash`, `.zsh`
    Shell,
    /// `Dockerfile`
    Dockerfile,
    /// `Makefile`
    Makefile,
    /// `.txt` and other plain text
    Text,
}

impl Language {
    /// Stable lowercase name (stored in the scan manifest).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript",
            Self::JavaScript => "javascript",
            Self::Python => "python",
            Self::Go => "go",
            Self::Rust => "rust",
            Self::Java => "java",
            Self::Ruby => "ruby",
            Self::Php => "php",
            Self::Swift => "swift",
            Self::Kotlin => "kotlin",
            Self::CSharp => "csharp",
            Self::Cpp => "cpp",
            Self::C => "c",
            Self::Scala => "scala",
            Self::Vue => "vue",
            Self::Svelte => "svelte",
            Self::Astro => "astro",
            Self::Sql => "sql",
            Self::GraphQl => "graphql",
            Self::Proto => "proto",
            Self::Yaml => "yaml",
            Self::Toml => "toml",
            Self::Json => "json",
            Self::Markdown => "markdown",
            Self::Shell => "shell",
            Self::Dockerfile => "dockerfile",
            Self::Makefile => "makefile",
            Self::Text => "text",
        }
    }

    /// True for languages with real program structure (not config / prose).
    #[must_use]
    pub fn is_code(self) -> bool {
        !matches!(
            self,
            Self::Yaml
                | Self::Toml
                | Self::Json
                | Self::Markdown
                | Self::Text
                | Self::Dockerfile
                | Self::Makefile
        )
    }

    /// Detect from a repo-relative path (extension or well-known file name).
    #[must_use]
    pub fn detect(path: &str) -> Option<Self> {
        let name = file_name(path);
        match name {
            "Dockerfile" => return Some(Self::Dockerfile),
            "Makefile" => return Some(Self::Makefile),
            "Procfile" => return Some(Self::Text),
            ".env.example" => return Some(Self::Shell),
            _ => {}
        }
        if name.to_ascii_lowercase().starts_with("readme") && !name.contains('.') {
            return Some(Self::Markdown);
        }
        let ext = extension(name)?;
        Some(match ext.as_str() {
            "ts" | "tsx" => Self::TypeScript,
            "js" | "jsx" | "mjs" | "cjs" => Self::JavaScript,
            "py" => Self::Python,
            "go" => Self::Go,
            "rs" => Self::Rust,
            "java" => Self::Java,
            "rb" => Self::Ruby,
            "php" => Self::Php,
            "swift" => Self::Swift,
            "kt" | "kts" => Self::Kotlin,
            "cs" => Self::CSharp,
            "cpp" | "cc" | "cxx" | "hpp" => Self::Cpp,
            "c" | "h" => Self::C,
            "scala" => Self::Scala,
            "vue" => Self::Vue,
            "svelte" => Self::Svelte,
            "astro" => Self::Astro,
            "sql" => Self::Sql,
            "graphql" | "gql" => Self::GraphQl,
            "proto" => Self::Proto,
            "yaml" | "yml" => Self::Yaml,
            "toml" => Self::Toml,
            "json" => Self::Json,
            "md" | "mdx" => Self::Markdown,
            "sh" | "bash" | "zsh" => Self::Shell,
            "dockerfile" => Self::Dockerfile,
            "txt" => Self::Text,
            _ => return None,
        })
    }
}

impl fmt::Display for Language {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Lowercased extension of a file name (`None` when there is no dot or only a leading dot).
fn extension(name: &str) -> Option<String> {
    let idx = name.rfind('.')?;
    if idx == 0 {
        return None;
    }
    Some(name[idx + 1..].to_ascii_lowercase())
}

/// Why a file was left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// Path escapes the repo (`..`, absolute, NUL) or is empty.
    BadPath,
    /// A path segment is on the ignored-directory list.
    IgnoredDir,
    /// Extension on the ignored list (images, fonts, archives, lockfiles ...).
    IgnoredExtension,
    /// Minified bundle (`.min.js`) or source map.
    Generated,
    /// Extension / name not on the allow list.
    UnsupportedType,
    /// Larger than the configured limit.
    TooLarge,
    /// Contains NUL bytes or is not valid UTF-8.
    Binary,
    /// Empty or whitespace only.
    Empty,
}

impl fmt::Display for SkipReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::BadPath => "bad path",
            Self::IgnoredDir => "ignored directory",
            Self::IgnoredExtension => "ignored extension",
            Self::Generated => "generated file",
            Self::UnsupportedType => "unsupported file type",
            Self::TooLarge => "too large",
            Self::Binary => "binary",
            Self::Empty => "empty",
        })
    }
}

/// Outcome of a filter check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Index it, with this language.
    Include(Language),
    /// Leave it out.
    Skip(SkipReason),
}

impl Decision {
    /// Language when included.
    #[must_use]
    pub fn language(&self) -> Option<Language> {
        match self {
            Self::Include(l) => Some(*l),
            Self::Skip(_) => None,
        }
    }
}

/// Directories never worth scanning (union of the TS lists).
pub const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    ".git",
    ".next",
    ".nuxt",
    "coverage",
    ".cache",
    ".turbo",
    "__pycache__",
    ".venv",
    "vendor",
    "target",
    "out",
    ".output",
];

/// Binary / media / archive / lock extensions (from `codebase-scanner.service.ts`).
pub const IGNORED_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "avif", "woff", "woff2", "ttf", "eot",
    "otf", "mp3", "mp4", "wav", "avi", "mov", "zip", "tar", "gz", "rar", "7z", "pdf", "doc",
    "docx", "xls", "xlsx", "lock", "map",
];

/// Default per-file limit for indexing and spec scans (TS `MAX_FILE_SIZE`).
pub const INDEX_MAX_FILE_BYTES: u64 = 50_000;
/// Per-file limit for the onboarding scan (TS `MAX_FILE_SIZE`).
pub const ONBOARDING_MAX_FILE_BYTES: u64 = 100_000;

/// Configurable file filter. Cheap to clone.
#[derive(Debug, Clone)]
pub struct FileFilter {
    ignored_dirs: BTreeSet<String>,
    ignored_extensions: BTreeSet<String>,
    allowed_extensions: BTreeSet<String>,
    allowed_names: BTreeSet<String>,
    skip_generated: bool,
    skip_lockfiles: bool,
    allow_readme: bool,
    /// Largest accepted file in bytes (a file of exactly this size is rejected, like the TS `>`/`<` checks).
    pub max_file_bytes: u64,
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

const INDEX_EXT: &[&str] = &[
    "ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "rb", "php", "swift", "kt", "cs", "cpp",
    "c", "h", "vue", "svelte", "astro", "sql", "graphql", "gql", "proto", "yaml", "yml", "toml",
    "md", "mdx", "sh", "bash",
];

impl FileFilter {
    /// Preset for embedding / code search indexing.
    #[must_use]
    pub fn for_index() -> Self {
        Self {
            ignored_dirs: set(IGNORED_DIRS),
            ignored_extensions: set(IGNORED_EXTENSIONS),
            allowed_extensions: set(INDEX_EXT),
            allowed_names: BTreeSet::new(),
            skip_generated: false,
            skip_lockfiles: false,
            allow_readme: false,
            max_file_bytes: INDEX_MAX_FILE_BYTES,
        }
    }

    /// Preset for the spec-completeness scan (wider allow list, includes json/txt and build files).
    #[must_use]
    pub fn for_specs() -> Self {
        let mut f = Self::for_index();
        f.allowed_extensions
            .extend(["json", "txt", "zsh", "dockerfile"].map(String::from));
        f.allowed_names
            .extend(["Dockerfile", "Makefile", "Procfile", ".env.example"].map(String::from));
        f
    }

    /// Preset for the onboarding module scan.
    #[must_use]
    pub fn for_onboarding() -> Self {
        let exts = [
            "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "rb", "php", "cs",
            "swift", "kt", "scala", "vue", "svelte", "astro", "json", "yaml", "yml", "toml",
        ];
        Self {
            ignored_dirs: set(&["node_modules", ".git", "dist", "build", ".next", "coverage"]),
            ignored_extensions: BTreeSet::new(),
            allowed_extensions: set(&exts),
            allowed_names: BTreeSet::new(),
            skip_generated: true,
            skip_lockfiles: true,
            allow_readme: true,
            max_file_bytes: ONBOARDING_MAX_FILE_BYTES,
        }
    }

    /// Override the size limit.
    #[must_use]
    pub fn with_max_file_bytes(mut self, n: u64) -> Self {
        self.max_file_bytes = n;
        self
    }

    /// Additionally ignore a directory name anywhere in the path.
    #[must_use]
    pub fn ignoring_dir(mut self, name: &str) -> Self {
        self.ignored_dirs.insert(name.to_string());
        self
    }

    /// Additionally allow an extension (without the dot, case-insensitive).
    #[must_use]
    pub fn allowing_extension(mut self, ext: &str) -> Self {
        self.allowed_extensions.insert(ext.to_ascii_lowercase());
        self
    }

    /// Check a tree entry by path (and size when the provider reports it).
    #[must_use]
    pub fn check_path(&self, path: &str, size: Option<u64>) -> Decision {
        if path.is_empty()
            || path.starts_with('/')
            || path.contains('\0')
            || path.contains('\\')
            || path.split('/').any(|p| p == ".." || p.is_empty())
        {
            return Decision::Skip(SkipReason::BadPath);
        }
        let mut parts = path.split('/').peekable();
        while let Some(part) = parts.next() {
            if parts.peek().is_some() && self.ignored_dirs.contains(part) {
                return Decision::Skip(SkipReason::IgnoredDir);
            }
        }
        let name = file_name(path);
        if self.ignored_dirs.contains(name) {
            // A file literally named like an ignored dir (e.g. `target`) is not source.
            return Decision::Skip(SkipReason::IgnoredDir);
        }
        let ext = extension(name);
        if let Some(e) = &ext {
            if self.ignored_extensions.contains(e) {
                return Decision::Skip(SkipReason::IgnoredExtension);
            }
        }
        if self.skip_generated && (name.contains(".min.") || ext.as_deref() == Some("map")) {
            return Decision::Skip(SkipReason::Generated);
        }
        if self.skip_lockfiles && (ext.as_deref() == Some("lock") || name.ends_with("lock.json")) {
            return Decision::Skip(SkipReason::Generated);
        }
        let by_name = self.allowed_names.contains(name);
        let by_ext = ext
            .as_ref()
            .is_some_and(|e| self.allowed_extensions.contains(e));
        let by_readme = self.allow_readme && name.to_ascii_lowercase().starts_with("readme");
        if !(by_name || by_ext || by_readme) {
            return Decision::Skip(SkipReason::UnsupportedType);
        }
        if let Some(sz) = size {
            if sz >= self.max_file_bytes {
                return Decision::Skip(SkipReason::TooLarge);
            }
        }
        match Language::detect(path) {
            Some(l) => Decision::Include(l),
            None => Decision::Skip(SkipReason::UnsupportedType),
        }
    }

    /// Check fetched bytes: size limit, NUL bytes / invalid UTF-8, empty. Returns the text on success.
    ///
    /// # Errors
    /// The [`SkipReason`] when the content must not be indexed.
    pub fn check_content(&self, bytes: Vec<u8>) -> Result<String, SkipReason> {
        if bytes.len() as u64 >= self.max_file_bytes {
            return Err(SkipReason::TooLarge);
        }
        if bytes.iter().take(8000).any(|b| *b == 0) {
            return Err(SkipReason::Binary);
        }
        let text = String::from_utf8(bytes).map_err(|_| SkipReason::Binary)?;
        if text.trim().is_empty() {
            return Err(SkipReason::Empty);
        }
        Ok(text)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn index_preset_matches_ts_rules() {
        let f = FileFilter::for_index();
        assert_eq!(
            f.check_path("src/a.ts", Some(10)),
            Decision::Include(Language::TypeScript)
        );
        assert_eq!(
            f.check_path("node_modules/x/index.js", None),
            Decision::Skip(SkipReason::IgnoredDir)
        );
        assert_eq!(
            f.check_path("a/target/b.rs", None),
            Decision::Skip(SkipReason::IgnoredDir)
        );
        assert_eq!(
            f.check_path("logo.png", None),
            Decision::Skip(SkipReason::IgnoredExtension)
        );
        // json / txt are specs-only
        assert_eq!(
            f.check_path("package.json", None),
            Decision::Skip(SkipReason::UnsupportedType)
        );
        assert_eq!(
            f.check_path("big.rs", Some(50_000)),
            Decision::Skip(SkipReason::TooLarge)
        );
        assert!(matches!(
            f.check_path("big.rs", Some(49_999)),
            Decision::Include(_)
        ));
    }

    #[test]
    fn specs_preset_adds_config_and_build_files() {
        let f = FileFilter::for_specs();
        assert_eq!(
            f.check_path("package.json", None).language(),
            Some(Language::Json)
        );
        assert_eq!(
            f.check_path("docker/Dockerfile", None).language(),
            Some(Language::Dockerfile)
        );
        assert_eq!(
            f.check_path("Makefile", None).language(),
            Some(Language::Makefile)
        );
        assert_eq!(
            f.check_path(".env.example", None).language(),
            Some(Language::Shell)
        );
        assert_eq!(
            f.check_path("notes.txt", None).language(),
            Some(Language::Text)
        );
        assert_eq!(
            f.check_path("yarn.lock", None),
            Decision::Skip(SkipReason::IgnoredExtension)
        );
    }

    #[test]
    fn onboarding_preset_skips_generated_and_keeps_readme() {
        let f = FileFilter::for_onboarding();
        assert_eq!(
            f.check_path("dist/app.js", None),
            Decision::Skip(SkipReason::IgnoredDir)
        );
        assert_eq!(
            f.check_path("static/app.min.js", None),
            Decision::Skip(SkipReason::Generated)
        );
        assert_eq!(
            f.check_path("package-lock.json", None),
            Decision::Skip(SkipReason::Generated)
        );
        assert_eq!(
            f.check_path("README", None).language(),
            Some(Language::Markdown)
        );
        assert_eq!(
            f.check_path("docs/README.md", None).language(),
            Some(Language::Markdown)
        );
        assert_eq!(
            f.check_path("src/x.rs", Some(100_000)),
            Decision::Skip(SkipReason::TooLarge)
        );
    }

    #[test]
    fn bad_paths_are_rejected() {
        let f = FileFilter::for_index();
        for p in [
            "",
            "/etc/passwd.rs",
            "../a.rs",
            "a/../b.rs",
            "a//b.rs",
            "a\\b.rs",
        ] {
            assert_eq!(
                f.check_path(p, None),
                Decision::Skip(SkipReason::BadPath),
                "{p}"
            );
        }
    }

    #[test]
    fn content_checks() {
        let f = FileFilter::for_index();
        assert_eq!(f.check_content(b"fn a() {}".to_vec()).unwrap(), "fn a() {}");
        assert_eq!(
            f.check_content(vec![b'a', 0, b'b']),
            Err(SkipReason::Binary)
        );
        assert_eq!(
            f.check_content(vec![0xff, 0xfe, b'a']),
            Err(SkipReason::Binary)
        );
        assert_eq!(f.check_content(b"  \n".to_vec()), Err(SkipReason::Empty));
        assert_eq!(
            f.check_content(vec![b'a'; 50_000]),
            Err(SkipReason::TooLarge)
        );
    }

    #[test]
    fn language_detection() {
        assert_eq!(Language::detect("a/b.TSX"), Some(Language::TypeScript));
        assert_eq!(Language::detect("x.gql"), Some(Language::GraphQl));
        assert_eq!(Language::detect(".gitignore"), None);
        assert_eq!(Language::detect("noext"), None);
        assert!(Language::Rust.is_code());
        assert!(!Language::Yaml.is_code());
    }
}
