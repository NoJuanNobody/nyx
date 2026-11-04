//! HTML and markdown sanitisation policy.
//!
//! Port of the `DOMPurify` configuration from the web app (#258: allow `pre code span div br`,
//! attributes `class style`) generalised into explicit [`HtmlPolicy`] values, plus a markdown
//! link/image URL policy. Design rule: **escape, never "repair"**. Anything not on the allow-list
//! is emitted as inert escaped text, so there is no parser-differential mutation XSS surface.
//!
//! Intentional divergence from the TS config: `style` is NOT allowed by default (CSS can
//! exfiltrate via `url()` and overlay UI). Syntax highlighters should use classes.
//!
//! The webview must additionally enforce the CSP in `tauri.conf.json`; this is defence in depth.

use std::collections::BTreeSet;
use std::fmt::Write as _;

use super::redact::redact_text;

/// Allow-list for [`sanitize_html`].
#[derive(Debug, Clone)]
pub struct HtmlPolicy {
    /// Lowercase tag names that may appear.
    pub tags: BTreeSet<&'static str>,
    /// Lowercase attribute names allowed on any allowed tag (besides `href`/`src`, see below).
    pub attrs: BTreeSet<&'static str>,
    /// URL schemes allowed in `href` (and `src` if the tag/attr is allowed).
    pub url_schemes: BTreeSet<&'static str>,
}

impl HtmlPolicy {
    /// Exactly the tags of the old `DOMPurify` call, minus `style`.
    #[must_use]
    pub fn code_highlight() -> Self {
        Self {
            tags: ["pre", "code", "span", "div", "br"].into(),
            attrs: ["class"].into(),
            url_schemes: BTreeSet::new(),
        }
    }

    /// Rich-text subset for rendered markdown: no images, no forms, no scripts.
    #[must_use]
    pub fn rich_text() -> Self {
        Self {
            tags: [
                "p",
                "br",
                "hr",
                "b",
                "strong",
                "i",
                "em",
                "u",
                "s",
                "del",
                "code",
                "pre",
                "blockquote",
                "ul",
                "ol",
                "li",
                "h1",
                "h2",
                "h3",
                "h4",
                "h5",
                "h6",
                "table",
                "thead",
                "tbody",
                "tr",
                "th",
                "td",
                "a",
                "span",
                "div",
                "sup",
                "sub",
            ]
            .into(),
            attrs: ["class", "href", "title", "colspan", "rowspan"].into(),
            url_schemes: ["http", "https", "mailto"].into(),
        }
    }
}

/// Escape text for HTML body/attribute context.
#[must_use]
pub fn escape_html(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            c => o.push(c),
        }
    }
    o
}

/// True if `url` uses one of `schemes` (or is a safe relative/fragment reference when
/// `allow_relative`). Strips the whitespace/control characters browsers ignore inside the scheme
/// (`java\tscript:`), and treats entity-encoded colons conservatively by rejecting `&`-led schemes.
#[must_use]
pub fn is_safe_url(url: &str, schemes: &BTreeSet<&'static str>, allow_relative: bool) -> bool {
    let cleaned: String = url
        .chars()
        .filter(|c| !c.is_control() && !c.is_whitespace())
        .collect();
    if cleaned.is_empty() {
        return false;
    }
    let lower = cleaned.to_ascii_lowercase();
    // Browsers entity-decode attribute values before resolving them: `&#106;avascript:`,
    // `javascript&colon;`. No legitimate allow-listed URL needs these.
    if lower.contains("&#")
        || lower.contains("&colon")
        || lower.contains("&tab;")
        || lower.contains("&newline;")
    {
        return false;
    }
    if let Some(colon) = lower.find(':') {
        let head = &lower[..colon];
        let looks_like_scheme = !head.is_empty()
            && head.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && head
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
        if looks_like_scheme {
            return schemes.contains(head);
        }
        // `:` appears but not as a scheme (e.g. in a query string after `/` or `?`).
        let first_delim = lower.find(['/', '?', '#']).unwrap_or(lower.len());
        if colon < first_delim {
            return false; // weird head such as `&#106;avascript:`
        }
    }
    if lower.starts_with("//") {
        return false; // protocol-relative: host unknown
    }
    allow_relative
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':')
}

/// Sanitise `input` per `policy`. Output only ever contains allow-listed tags rebuilt from parsed
/// parts with escaped attribute values; everything else becomes escaped text.
#[must_use]
pub fn sanitize_html(input: &str, policy: &HtmlPolicy) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '<' {
            if let Some((emitted, next)) = parse_tag(&chars, i, policy) {
                out.push_str(&emitted);
                i = next;
                continue;
            }
            out.push_str("&lt;");
            i += 1;
        } else if c == '>' {
            out.push_str("&gt;");
            i += 1;
        } else if c == '&' {
            // Keep well-formed entities, escape stray ampersands.
            let mut j = i + 1;
            while j < chars.len()
                && j - i <= 10
                && (chars[j].is_ascii_alphanumeric() || chars[j] == '#')
            {
                j += 1;
            }
            if j < chars.len() && chars[j] == ';' && j > i + 1 {
                out.extend(&chars[i..=j]);
                i = j + 1;
            } else {
                out.push_str("&amp;");
                i += 1;
            }
        } else if c == '\0' {
            i += 1;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// Try to parse an allow-listed tag at `chars[start] == '<'`. Returns (html, index after `>`).
fn parse_tag(chars: &[char], start: usize, policy: &HtmlPolicy) -> Option<(String, usize)> {
    let mut i = start + 1;
    let closing = chars.get(i) == Some(&'/');
    if closing {
        i += 1;
    }
    let name_start = i;
    while i < chars.len() && is_name_char(chars[i]) {
        i += 1;
    }
    let name: String = chars[name_start..i]
        .iter()
        .collect::<String>()
        .to_ascii_lowercase();
    if name.is_empty() {
        return None;
    }
    let tag = *policy.tags.get(name.as_str())?;

    if closing {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        return (chars.get(i) == Some(&'>')).then(|| (format!("</{tag}>"), i + 1));
    }

    let mut attrs: Vec<(String, String)> = Vec::new();
    loop {
        while i < chars.len() && (chars[i].is_whitespace() || chars[i] == '/') {
            i += 1;
        }
        match chars.get(i) {
            None => return None,
            Some('>') => {
                i += 1;
                break;
            }
            Some(_) => {}
        }
        let an_start = i;
        while i < chars.len() && is_name_char(chars[i]) {
            i += 1;
        }
        if i == an_start {
            return None; // garbage inside tag: refuse the whole tag
        }
        let an: String = chars[an_start..i]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        let mut val = String::new();
        if chars.get(i) == Some(&'=') {
            i += 1;
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            match chars.get(i) {
                Some(&q) if q == '"' || q == '\'' => {
                    i += 1;
                    let vs = i;
                    while i < chars.len() && chars[i] != q {
                        i += 1;
                    }
                    if i >= chars.len() {
                        return None;
                    }
                    val = chars[vs..i].iter().collect();
                    i += 1;
                }
                Some(_) => {
                    let vs = i;
                    while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '>' {
                        i += 1;
                    }
                    val = chars[vs..i].iter().collect();
                }
                None => return None,
            }
        }
        attrs.push((an, val));
    }

    let mut o = format!("<{tag}");
    let mut seen = BTreeSet::new();
    for (an, v) in attrs {
        let Some(&allowed) = policy.attrs.get(an.as_str()) else {
            continue;
        };
        if !seen.insert(allowed) {
            continue;
        }
        if matches!(allowed, "href" | "src")
            && !is_safe_url(&v, &policy.url_schemes, allowed == "href")
        {
            continue;
        }
        let _ = write!(o, " {allowed}=\"{}\"", escape_html(&v));
        if allowed == "href" {
            o.push_str(" rel=\"noopener noreferrer\"");
        }
    }
    o.push('>');
    Some((o, i))
}

/// Markdown URL/HTML policy.
#[derive(Debug, Clone)]
pub struct MarkdownPolicy {
    /// Schemes allowed in links and autolinks.
    pub link_schemes: BTreeSet<&'static str>,
    /// Schemes allowed in images (default: https only; no `data:`).
    pub image_schemes: BTreeSet<&'static str>,
    /// Allow relative links (`./a.md`, `#frag`).
    pub allow_relative: bool,
}

impl Default for MarkdownPolicy {
    fn default() -> Self {
        Self {
            link_schemes: ["http", "https", "mailto"].into(),
            image_schemes: ["https"].into(),
            allow_relative: true,
        }
    }
}

/// Neutralise untrusted markdown before rendering: raw HTML is escaped (outside code), link and
/// image destinations with disallowed schemes become `#`, reference definitions are checked too.
/// Fenced and inline code are left untouched. Output is still markdown.
#[must_use]
pub fn sanitize_markdown(md: &str, policy: &MarkdownPolicy) -> String {
    let mut out = String::with_capacity(md.len());
    let mut fence: Option<(char, usize)> = None;
    for line in md.split_inclusive('\n') {
        let t = line.trim_start();
        let run = t.chars().take_while(|c| *c == '`' || *c == '~').count();
        let fc = t.chars().next().unwrap_or(' ');
        if run >= 3 && (fc == '`' || fc == '~') {
            match fence {
                None => fence = Some((fc, run)),
                Some((c, n)) if c == fc && run >= n => fence = None,
                _ => {}
            }
            out.push_str(line);
            continue;
        }
        if fence.is_some() {
            out.push_str(line);
            continue;
        }
        out.push_str(&sanitize_md_line(line, policy));
    }
    out
}

fn sanitize_md_line(line: &str, policy: &MarkdownPolicy) -> String {
    // Reference definition: `[id]: url "title"`.
    let tl = line.trim_start();
    if tl.starts_with('[') {
        if let Some(pos) = tl.find("]:") {
            let (head, rest) = tl.split_at(pos + 2);
            let url = rest.split_whitespace().next().unwrap_or("");
            if !url.is_empty()
                && !is_safe_url(
                    url.trim_matches(['<', '>']),
                    &policy.link_schemes,
                    policy.allow_relative,
                )
            {
                return format!("{head} #\n");
            }
            return line.to_string();
        }
    }
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '`' => {
                // inline code span: copy verbatim through matching run
                let n = chars[i..].iter().take_while(|c| **c == '`').count();
                let mut j = i + n;
                let mut close = None;
                while j < chars.len() {
                    if chars[j] == '`' {
                        let m = chars[j..].iter().take_while(|c| **c == '`').count();
                        if m == n {
                            close = Some(j + m);
                            break;
                        }
                        j += m;
                    } else {
                        j += 1;
                    }
                }
                let end = close.unwrap_or(i + n);
                out.extend(&chars[i..end]);
                i = end;
            }
            '\\' => {
                out.push(c);
                if let Some(nc) = chars.get(i + 1) {
                    out.push(*nc);
                }
                i += 2;
            }
            '<' => {
                // Autolink `<scheme:...>` is kept if safe; everything else is raw HTML => escape.
                if let Some(rel) = chars[i + 1..].iter().position(|c| *c == '>') {
                    let inner: String = chars[i + 1..i + 1 + rel].iter().collect();
                    let autolink = !inner.contains(char::is_whitespace)
                        && inner.contains(':')
                        && is_safe_url(&inner, &policy.link_schemes, false);
                    if autolink {
                        out.push('<');
                        out.push_str(&inner);
                        out.push('>');
                        i += rel + 2;
                        continue;
                    }
                }
                out.push_str("&lt;");
                i += 1;
            }
            ']' if chars.get(i + 1) == Some(&'(') => {
                // Link/image destination: find matching ')' with paren balancing.
                let image = is_image_open(&chars, i);
                let ds = i + 2;
                let mut depth = 1;
                let mut j = ds;
                while j < chars.len() {
                    match chars[j] {
                        '\\' => j += 1,
                        '(' => depth += 1,
                        ')' => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                    j += 1;
                }
                if j >= chars.len() {
                    out.push(']');
                    i += 1;
                    continue;
                }
                let inner: String = chars[ds..j].iter().collect();
                let url = destination(&inner);
                let schemes = if image {
                    &policy.image_schemes
                } else {
                    &policy.link_schemes
                };
                out.push_str("](");
                if is_safe_url(&url, schemes, policy.allow_relative) {
                    out.push_str(&inner);
                } else {
                    out.push('#');
                }
                out.push(')');
                i = j + 1;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

fn is_image_open(chars: &[char], close: usize) -> bool {
    // Walk back to the matching '[' and check for a preceding '!'.
    let mut depth = 0;
    let mut k = close;
    while k > 0 {
        k -= 1;
        match chars[k] {
            ']' => depth += 1,
            '[' => {
                if depth == 0 {
                    return k > 0 && chars[k - 1] == '!';
                }
                depth -= 1;
            }
            _ => {}
        }
    }
    false
}

fn destination(inner: &str) -> String {
    let t = inner.trim();
    if let Some(rest) = t.strip_prefix('<') {
        return rest.split('>').next().unwrap_or("").to_string();
    }
    t.split_whitespace().next().unwrap_or("").to_string()
}

/// Strip all markup and return plain text (for notifications, window titles, logs): tags removed,
/// entities left escaped, secrets redacted.
#[must_use]
pub fn strip_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            c if !in_tag && !c.is_control() || c == '\n' => out.push(c),
            _ => {}
        }
    }
    redact_text(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hl(s: &str) -> String {
        sanitize_html(s, &HtmlPolicy::code_highlight())
    }
    fn rich(s: &str) -> String {
        sanitize_html(s, &HtmlPolicy::rich_text())
    }

    #[test]
    fn highlight_output_survives() {
        let src =
            r#"<pre class="shiki"><code><span class="line">let x = 1;</span><br></code></pre>"#;
        assert_eq!(hl(src), src);
    }

    #[test]
    fn scripts_and_handlers_are_neutralised() {
        for (input, banned) in [
            ("<script>alert(1)</script>", "<script"),
            ("<img src=x onerror=alert(1)>", "<img"),
            ("<span onclick=\"x()\" class=a>t</span>", "onclick"),
            ("<span style=\"background:url(//e)\">t</span>", "style"),
            ("<iframe src=//evil></iframe>", "<iframe"),
            ("<svg/onload=alert(1)>", "<svg"),
            ("<!-- <script> -->", "<!--"),
            ("<scr<script>ipt>alert(1)</scr</script>ipt>", "<script"),
            ("<span class=\"a\" onmouseover=\"x\"", "onmouseover"),
            ("<a href=\"javascript:alert(1)\">x</a>", "javascript"),
        ] {
            for o in [hl(input), rich(input)] {
                // Only real (unescaped) tags matter: escaped text is inert.
                for tag in o.split('<').skip(1) {
                    let tag = tag.split('>').next().unwrap_or("").to_lowercase();
                    assert!(
                        !tag.contains(banned.trim_start_matches('<')),
                        "{input} -> {o}"
                    );
                }
            }
        }
    }

    #[test]
    fn no_unescaped_angle_brackets_from_disallowed() {
        let o = hl("<script>alert('x')</script>");
        assert_eq!(o, "&lt;script&gt;alert('x')&lt;/script&gt;");
    }

    #[test]
    fn href_policy() {
        assert_eq!(
            rich("<a href=\"https://e.com/a?x=1&y=2\" title='t' onclick=z>go</a>"),
            "<a href=\"https://e.com/a?x=1&amp;y=2\" rel=\"noopener noreferrer\" title=\"t\">go</a>"
        );
        for bad in [
            "javascript:alert(1)",
            "JaVa\tScRiPt:alert(1)",
            " javascript:alert(1)",
            "&#106;avascript:alert(1)",
            "data:text/html;base64,AAAA",
            "vbscript:x",
            "//evil.com",
        ] {
            let o = rich(&format!("<a href=\"{bad}\">x</a>"));
            assert_eq!(o, "<a>x</a>", "{bad}");
        }
        assert!(rich("<a href=\"/rel/path\">x</a>").contains("href=\"/rel/path\""));
        assert!(rich("<a href=\"mailto:a@b.co\">x</a>").contains("mailto:"));
    }

    #[test]
    fn quotes_in_values_cannot_break_out() {
        let o = rich("<a href='https://e.com/\"onmouseover=\"x'>t</a>");
        assert!(!o.contains("onmouseover=\"x\""), "{o}");
        assert!(o.contains("&quot;"));
    }

    #[test]
    fn duplicate_attrs_and_case() {
        assert_eq!(
            hl("<SPAN CLASS=a CLASS=b>x</SPAN>"),
            "<span class=\"a\">x</span>"
        );
    }

    #[test]
    fn entities_preserved_stray_amp_escaped() {
        assert_eq!(hl("a &amp; b &lt; c & d"), "a &amp; b &lt; c &amp; d");
    }

    #[test]
    fn malformed_tags_are_text() {
        assert_eq!(hl("<span"), "&lt;span");
        assert_eq!(hl("a < b > c"), "a &lt; b &gt; c");
        assert_eq!(hl("<span class=\"x>t"), "&lt;span class=\"x&gt;t");
    }

    #[test]
    fn markdown_links_and_images() {
        let p = MarkdownPolicy::default();
        let md = "[ok](https://e.com) [bad](javascript:alert(1)) ![i](data:image/png;base64,AA) ![ok](https://e.com/a.png) [rel](./a.md) [mail](mailto:a@b.co)\n";
        let o = sanitize_markdown(md, &p);
        assert!(o.contains("[ok](https://e.com)"));
        assert!(o.contains("[bad](#)"));
        assert!(o.contains("![i](#)"));
        assert!(o.contains("![ok](https://e.com/a.png)"));
        assert!(o.contains("[rel](./a.md)"));
        assert!(o.contains("[mail](mailto:a@b.co)"));
        assert!(!o.contains("javascript"));
    }

    #[test]
    fn markdown_image_http_not_allowed_and_titles_ok() {
        let p = MarkdownPolicy::default();
        assert!(sanitize_markdown("![x](http://e.com/a.png)", &p).contains("![x](#)"));
        assert!(sanitize_markdown("[x](https://e.com \"title\")", &p)
            .contains("(https://e.com \"title\")"));
        assert!(sanitize_markdown("[x](<javascript:alert(1)>)", &p).contains("[x](#)"));
        assert!(sanitize_markdown("[x](JAVASCRIPT:1)", &p).contains("[x](#)"));
    }

    #[test]
    fn markdown_raw_html_escaped_but_code_untouched() {
        let p = MarkdownPolicy::default();
        let md = "<script>x</script>\n`<b>`\n```html\n<script>kept</script>\n```\n<https://e.com> <javascript:x>\n";
        let o = sanitize_markdown(md, &p);
        assert!(o.starts_with("&lt;script>x&lt;/script>"));
        assert!(o.contains("`<b>`"));
        assert!(o.contains("<script>kept</script>"));
        assert!(o.contains("<https://e.com>"));
        assert!(o.contains("&lt;javascript:x>"));
    }

    #[test]
    fn markdown_reference_definitions() {
        let p = MarkdownPolicy::default();
        assert_eq!(
            sanitize_markdown("[a]: javascript:alert(1)\n", &p),
            "[a]: #\n"
        );
        assert_eq!(
            sanitize_markdown("[a]: https://e.com\n", &p),
            "[a]: https://e.com\n"
        );
    }

    #[test]
    fn strip_text() {
        assert_eq!(strip_to_text("<b>hi</b> there"), "hi there");
    }
}
